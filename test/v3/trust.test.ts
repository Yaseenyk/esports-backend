import { describe, expect, it, vi } from "vitest";
import { makeStaff, auditRows } from "../admin/helpers";
import { uniq } from "../helpers";
import { TRUST, trustScore, ratingWindow, displayNameProblem, tokenFromLink, organiserKeyOf } from "../../src/v3/lib/community";
import { api, communityOn, db, org, pastTournament, playedTeam, rateBody, rosterPass, user } from "./community-helpers";

vi.setConfig({ testTimeout: 120_000 });

const rate = (slug: string, token: string | undefined, body: unknown) => api(`/v3/tournaments/${slug}/trust/ratings`, { token, body });
const pub = (slug: string) => api(`/public/tournaments/${slug}/trust`);

/** A finished tournament with one checked-in pass per new player. */
async function rated(n: number, t: Awaited<ReturnType<typeof pastTournament>>, starsOf: (i: number) => number = () => 4) {
  const out: { id: string; u: Awaited<ReturnType<typeof user>> }[] = [];
  for (let i = 0; i < n; i++) {
    const u = await user(`Rater${i}`);
    const p = await rosterPass(t);
    const r = await rate(t.slug, u.token, rateBody({ kind: "pass", link: p.link }, { stars: starsOf(i), displayName: `Player ${uniq()}` }));
    if (r.status !== 201) throw new Error(`rate ${r.status} ${r.text}`);
    out.push({ id: r.json.id, u });
  }
  return out;
}

describe("trust score maths and rules (pure)", () => {
  it("no average, aspects or breakdown below the minimum; a plain one-decimal average from it", () => {
    const r = (s: number) => ({ stars: s, onTime: s, fair: 5, communication: 1 });
    expect(trustScore([r(5), r(4), r(3), r(5)])).toEqual({ count: 4, minimum: TRUST.MIN_RATINGS, average: null, aspects: null, distribution: null });
    const s = trustScore([r(5), r(4), r(3), r(5), r(4)]);
    expect(s.average).toBe(4.2);
    expect(s.aspects).toEqual({ onTime: 4.2, fair: 5, communication: 1 });
    expect(s.distribution).toEqual({ 1: 0, 2: 0, 3: 1, 4: 2, 5: 2 });
  });
  it("the window opens at the end of the event and closes 30 days later", () => {
    expect(ratingWindow({ startsAt: null, endsAt: null }, 100).state).toBe("no_dates");
    expect(ratingWindow({ startsAt: 1000, endsAt: 2000 }, 1500).state).toBe("not_yet");
    expect(ratingWindow({ startsAt: 1000, endsAt: 2000 }, 2000).state).toBe("open");
    expect(ratingWindow({ startsAt: 1000, endsAt: null }, 1000 + 30 * 86_400).state).toBe("open");
    expect(ratingWindow({ startsAt: 1000, endsAt: 2000 }, 2001 + 30 * 86_400).state).toBe("closed");
  });
  it("refuses names that read as anonymous, reads pass links, keys organisers", () => {
    for (const n of ["Anonymous", "anon", "Guest", "user123", "Admin", "Esports Hub"]) expect(displayNameProblem(n), n).toBe("name_anonymous");
    expect(displayNameProblem("Riya K")).toBeNull();
    expect(tokenFromLink("https://esports.streamerosai.com/pass/?t=abcDEF123_-xyz")).toBe("abcDEF123_-xyz");
    expect(tokenFromLink("abcDEF123_-xyz")).toBe("abcDEF123_-xyz");
    expect(tokenFromLink("https://x.test/?t=<script>")).toBeNull();
    expect(organiserKeyOf({ orgId: "o1", eventId: "e1" })).toBe("org:o1");
    expect(organiserKeyOf({ orgId: null, eventId: "e1" })).toBe("event:e1");
  });
});

describe("who may rate (v3.trust on)", () => {
  it("only a signed-in, 18+ player with proof for THIS event, not the organiser, inside the window", async () => {
    await communityOn("v3.trust", "v3.tournaments");
    const t = await pastTournament(1);
    const other = await pastTournament(1);
    const good = await rosterPass(t);
    const notIn = await rosterPass(t, { checkedIn: false });
    const minor = await rosterPass(t, { minor: true });
    const elsewhere = await rosterPass(other);
    const u = await user("Player");
    const kid = await user("NoAdult", false);

    expect((await rate(t.slug, undefined, rateBody({ kind: "pass", link: good.link }))).status).toBe(401);
    expect((await rate(t.slug, kid.token, rateBody({ kind: "pass", link: good.link }))).json.code).toBe("adult_required");
    expect((await rate(t.slug, t.owner.token, rateBody({ kind: "pass", link: good.link }))).json.code).toBe("own_event");
    expect((await rate(t.slug, u.token, rateBody({}))).status).toBe(400);
    expect((await rate(t.slug, u.token, rateBody({ kind: "pass", link: "not a link at all" }))).json.code).toBe("invalid_proof");
    const wrongEvent = await rate(t.slug, u.token, rateBody({ kind: "pass", link: elsewhere.link }));
    expect([wrongEvent.status, wrongEvent.json.code]).toEqual([403, "proof_not_found"]);
    expect((await rate(t.slug, u.token, rateBody({ kind: "pass", link: notIn.link }))).json.code).toBe("not_checked_in");
    expect((await rate(t.slug, u.token, rateBody({ kind: "pass", link: minor.link }))).json.code).toBe("minor_roster");
    expect((await rate(t.slug, u.token, rateBody({ kind: "pass", link: good.link }, { displayName: "Anonymous" }))).json.code).toBe("name_anonymous");
    expect((await rate(t.slug, u.token, rateBody({ kind: "pass", link: good.link }, { stars: 6 }))).json.code).toBe("invalid_stars");
    expect((await rate(t.slug, u.token, rateBody({ kind: "pass", link: good.link }, { review: "short" }))).json.code).toBe("invalid_review");

    const ok = await rate(t.slug, u.token, rateBody({ kind: "pass", link: good.link }));
    expect(ok.status, ok.text).toBe(201);
    expect(ok.json).toMatchObject({ stars: 4, verifiedAs: "checked_in", displayName: "Riya K", hidden: false });
    expect(ok.text).not.toContain(good.token); // the presented link is never echoed or stored
    expect(JSON.stringify((await db.prepare("SELECT * FROM organiser_ratings WHERE id = ?1").bind(ok.json.id).first())!)).not.toContain(good.token);
  });

  it("a captain of a team that played may rate (captain link or an earlier captain claim); a team without a result may not", async () => {
    await communityOn("v3.trust", "v3.tournaments", "v3.disputes");
    const t = await pastTournament(2);
    const played = await playedTeam(t.eventId, "Alpha Wolves");
    const { addRegistration, captainToken } = await import("./helpers");
    await addRegistration(t.eventId, "Idle Squad");
    const idle = await captainToken(t.eventId, "Idle Squad");
    const cap = await user("Captain");
    expect((await rate(t.slug, cap.token, rateBody({ kind: "captain", link: `https://esports.streamerosai.com/report/?t=${idle}` }))).json.code).toBe("team_not_played");
    expect((await rate(t.slug, cap.token, rateBody({ kind: "captain" }))).json.code).toBe("proof_not_found");
    const ok = await rate(t.slug, cap.token, rateBody({ kind: "captain", link: played.token }));
    expect(ok.status, ok.text).toBe(201);
    expect(ok.json.verifiedAs).toBe("played");

    // the dispute portal's captain claim also counts as proof (no link needed)
    const beta = await playedTeam(t.eventId, "Beta Hawks");
    const cap2 = await user("Captain2");
    const claim = await api(`/v3/tournaments/${t.slug}/captain-claim`, { token: cap2.token, body: { token: beta.token } });
    expect(claim.status, claim.text).toBe(200);
    const viaClaim = await rate(t.slug, cap2.token, rateBody({ kind: "captain" }));
    expect(viaClaim.status, viaClaim.text).toBe(201);
  });

  it("one rating per player per event, and one per pass / team per event", async () => {
    await communityOn("v3.trust", "v3.tournaments");
    const t = await pastTournament(1);
    const a = await rosterPass(t);
    const b = await rosterPass(t);
    const u = await user("Once");
    const v = await user("Twice");
    expect((await rate(t.slug, u.token, rateBody({ kind: "pass", link: a.link }))).status).toBe(201);
    const again = await rate(t.slug, u.token, rateBody({ kind: "pass", link: b.link }));
    expect([again.status, again.json.code]).toEqual([409, "already_rated"]);
    const reuse = await rate(t.slug, v.token, rateBody({ kind: "pass", link: a.link }));
    expect([reuse.status, reuse.json.code]).toEqual([409, "proof_used"]);
    // the same player may rate a DIFFERENT event of the same organiser
    const t2 = await pastTournament(1);
    expect((await rate(t2.slug, u.token, rateBody({ kind: "pass", link: (await rosterPass(t2)).link }))).status).toBe(201);
  });

  it("the window: not before the event ends, not after 30 days, not without dates", async () => {
    await communityOn("v3.trust", "v3.tournaments");
    const future = await pastTournament(-2, "live");
    const old = await pastTournament(TRUST.WINDOW_DAYS + 1);
    const undated = await pastTournament(1);
    await db.prepare("UPDATE tournaments SET starts_at = NULL, ends_at = NULL WHERE id = ?1").bind(undated.id).run();
    const u = await user("Timely");
    for (const [t, code] of [[future, "window_not_yet"], [old, "window_closed"], [undated, "window_no_dates"]] as const) {
      const r = await rate(t.slug, u.token, rateBody({ kind: "pass", link: (await rosterPass(t)).link }));
      expect([r.status, r.json.code], code).toEqual([409, code]);
    }
    expect((await pub(old.slug)).json.window.state).toBe("closed");
    expect((await pub(future.slug)).json.window.state).toBe("not_yet");
  });
});

describe("the public score", () => {
  it("shows no number below 5 ratings, then the average, the count and the breakdown, across all events of the organiser", async () => {
    await communityOn("v3.trust", "v3.tournaments");
    const owner = await user("CollegeAdmin");
    const o = await org([{ u: owner }], { name: `Pune Institute ${uniq()}` });
    const t1 = await pastTournament(1, "completed", o.id);
    const t2 = await pastTournament(3, "completed", o.id);
    await rated(4, t1, (i) => [5, 4, 3, 5][i]!);
    let s = (await pub(t1.slug)).json;
    expect(s.score).toEqual({ count: 4, minimum: 5, average: null, aspects: null, distribution: null });
    expect(s.reviews).toHaveLength(4);
    expect(s.reviews.every((r: { stars: unknown }) => r.stars === null)).toBe(true); // no per-review stars before the minimum either
    expect(s.organiser).toEqual({ name: expect.stringContaining("Pune Institute"), verified: true });
    await rated(1, t2, () => 4);
    s = (await pub(t1.slug)).json;
    expect(s.score.count).toBe(5);
    expect(s.score.average).toBe(4.2);
    expect(s.score.distribution).toEqual({ 1: 0, 2: 0, 3: 1, 4: 2, 5: 2 });
    expect(s.score.aspects).toEqual({ onTime: 4, fair: 5, communication: 3 });
    expect((await pub(t2.slug)).json.score.average).toBe(4.2); // same organiser, same score
    expect(s.reviews[0].stars).not.toBeNull();
    expect(s.reviews[0]).toMatchObject({ verifiedAs: "checked_in", review: expect.any(String), tournament: { slug: expect.any(String) } });
    // nothing private in the public payload
    const text = JSON.stringify(s);
    for (const k of ["user_id", "userId", "proof", "person:", "organiser_key", "org:", "reporter", "email"]) expect(text, k).not.toContain(k);
  });

  it("a draft or taken-down tournament has no trust page", async () => {
    await communityOn("v3.trust", "v3.tournaments");
    const { tournament } = await import("./helpers");
    const draft = await tournament();
    expect((await pub(draft.slug)).status).toBe(404);
    expect((await pub("no-such-thing")).status).toBe(404);
  });
});

describe("reviews: replies, reports, moderation", () => {
  it("the organiser replies once; others cannot; the reply is public", async () => {
    await communityOn("v3.trust", "v3.tournaments");
    const t = await pastTournament(1);
    const [r] = await rated(1, t);
    const stranger = await user("Stranger");
    expect((await api(`/v3/trust/ratings/${r!.id}/reply`, { token: stranger.token, body: { text: "Not mine" } })).status).toBe(404);
    expect((await api(`/v3/trust/ratings/${r!.id}/reply`, { token: r!.u.token, body: { text: "Self reply" } })).status).toBe(404);
    const ok = await api(`/v3/trust/ratings/${r!.id}/reply`, { token: t.owner.token, body: { text: "Thanks, we will start the next one on time too." } });
    expect(ok.status, ok.text).toBe(200);
    const again = await api(`/v3/trust/ratings/${r!.id}/reply`, { token: t.owner.token, body: { text: "Edit" } });
    expect([again.status, again.json.code]).toEqual([409, "already_replied"]);
    expect((await pub(t.slug)).json.reviews[0].reply.text).toBe("Thanks, we will start the next one on time too.");
    const me = (await api(`/v3/tournaments/${t.slug}/trust/me`, { token: t.owner.token })).json;
    expect(me).toMatchObject({ isOrganiser: true, canReply: true, myRating: null });
  });

  it("reports are recorded once per person and never hide anything by themselves; staff hide and restore with a reason, logged and audited", async () => {
    await communityOn("v3.trust", "v3.tournaments", "admin.enabled");
    const t = await pastTournament(1);
    const rows = await rated(5, t);
    const target = rows[0]!;
    await api(`/v3/trust/ratings/${target.id}/reply`, { token: t.owner.token, body: { text: "We disagree, the schedule was shared a week before." } });
    const reporter = await user("Reporter");
    expect((await api(`/v3/trust/ratings/${target.id}/report`, { token: target.u.token, body: { reason: "abuse" } })).json.code).toBe("own_review");
    expect((await api(`/v3/trust/ratings/${target.id}/report`, { body: { reason: "abuse" } })).status).toBe(401);
    expect((await api(`/v3/trust/ratings/${target.id}/report`, { token: reporter.token, body: { reason: "made_up" } })).json.code).toBe("invalid_reason");
    const rep = await api(`/v3/trust/ratings/${target.id}/report`, { token: reporter.token, body: { reason: "false_claim", note: "They were not at the event" } });
    expect(rep.status, rep.text).toBe(201);
    expect((await api(`/v3/trust/ratings/${target.id}/report`, { token: reporter.token, body: { reason: "spam" } })).json.code).toBe("already_reported");
    const orgReport = await api(`/v3/trust/ratings/${target.id}/report`, { token: t.owner.token, body: { reason: "false_claim" } });
    expect(orgReport.status).toBe(201); // the organiser may report a review too; staff decide
    const replyReport = await api(`/v3/trust/ratings/${target.id}/report`, { token: target.u.token, body: { target: "reply", reason: "abuse" } });
    expect(replyReport.status).toBe(201);
    expect((await pub(t.slug)).json.score.count).toBe(5); // nothing hidden by reports

    // staff only
    const staff = await makeStaff();
    const token = (await staff.login()).token;
    expect((await api("/admin/v1/v3/trust/reports")).status).toBe(404);
    expect((await api("/admin/v1/v3/trust/reports", { token: reporter.token })).status).toBe(404);
    const q = await api("/admin/v1/v3/trust/reports", { token });
    expect(q.status, q.text).toBe(200);
    const mine = q.json.items.filter((x: { ratingId: string }) => x.ratingId === target.id);
    expect(mine.map((x: { target: string }) => x.target).sort()).toEqual(["reply", "review", "review"]);
    expect(JSON.stringify(q.json)).not.toContain(reporter.id); // the reporter is not shown, even to staff in the queue

    expect((await api(`/admin/v1/v3/trust/ratings/${target.id}/hide`, { token, body: {} })).json.code).toBe("invalid_reason");
    const hid = await api(`/admin/v1/v3/trust/ratings/${target.id}/hide`, { token, body: { reason: "false_claim", note: "Organiser showed the gate log" } });
    expect(hid.status, hid.text).toBe(200);
    expect(hid.json.rating.hidden).toBe(true);
    expect(hid.json.actions).toEqual([expect.objectContaining({ target: "review", action: "hidden", reason: "false_claim", note: "Organiser showed the gate log", staffId: staff.id })]);
    expect(hid.json.reports.filter((x: { target: string }) => x.target === "review").every((x: { status: string }) => x.status === "actioned")).toBe(true);
    expect((await api(`/admin/v1/v3/trust/ratings/${target.id}/hide`, { token, body: { reason: "abuse" } })).json.code).toBe("already_hidden");
    let s = (await pub(t.slug)).json;
    expect(s.score.count).toBe(4);
    expect(s.score.average).toBeNull(); // back under the minimum
    expect(s.reviews.map((r: { id: string }) => r.id)).not.toContain(target.id);
    // the rater still sees their own row, marked hidden with the reason
    const own = (await api(`/v3/tournaments/${t.slug}/trust/me`, { token: target.u.token })).json.myRating;
    expect(own).toMatchObject({ hidden: true, hiddenReason: "false_claim" });
    expect((await auditRows("trust.hidden", target.id))[0]).toMatchObject({ actor_type: "staff", actor_id: staff.id, target_type: "organiser_rating", reason_code: "false_claim", meta: '{"target":"review"}' });

    const back = await api(`/admin/v1/v3/trust/ratings/${target.id}/restore`, { token, body: { reason: "appeal_upheld" } });
    expect(back.status, back.text).toBe(200);
    expect(back.json.actions.map((a: { action: string }) => a.action)).toEqual(["hidden", "restored"]);
    s = (await pub(t.slug)).json;
    expect(s.score.count).toBe(5);
    expect((await auditRows("trust.restored", target.id))).toHaveLength(1);
    expect((await api(`/admin/v1/v3/trust/ratings/${target.id}/restore`, { token, body: { reason: "appeal_upheld" } })).json.code).toBe("not_hidden");

    // hide only the reply: the review and its stars stay
    const hr = await api(`/admin/v1/v3/trust/ratings/${target.id}/hide`, { token, body: { target: "reply", reason: "abuse" } });
    expect(hr.status, hr.text).toBe(200);
    s = (await pub(t.slug)).json;
    const shown = s.reviews.find((r: { id: string }) => r.id === target.id);
    expect(shown).toMatchObject({ reply: null, replyHidden: true });
    expect(s.score.count).toBe(5);

    // dismiss an open report (the organiser's own one was actioned by the hide above; file a fresh one on another review)
    const r2 = rows[1]!;
    const fresh = await api(`/v3/trust/ratings/${r2.id}/report`, { token: reporter.token, body: { reason: "spam" } });
    expect(fresh.status).toBe(201);
    const open = (await api("/admin/v1/v3/trust/reports", { token })).json.items.find((x: { ratingId: string }) => x.ratingId === r2.id);
    const dis = await api(`/admin/v1/v3/trust/reports/${open.id}/dismiss`, { token, body: { note: "Normal review" } });
    expect(dis.status, dis.text).toBe(200);
    expect(dis.json.actions[0]).toMatchObject({ action: "report_dismissed", reason: "report_unfounded" });
    expect((await api(`/admin/v1/v3/trust/reports/${open.id}/dismiss`, { token, body: {} })).json.code).toBe("report_decided");
    expect(await auditRows("trust.report_dismissed", r2.id)).toHaveLength(1);
    // the moderation log is append-only
    await expect(db.prepare("UPDATE organiser_rating_actions SET note = 'x' WHERE rating_id = ?1").bind(target.id).run()).rejects.toThrow();
  });

  it("the rater can delete their rating; deleting the account removes ratings and the reports they filed", async () => {
    await communityOn("v3.trust", "v3.tournaments");
    const t = await pastTournament(1);
    const [a, b] = await rated(2, t);
    expect((await api(`/v3/trust/ratings/${a!.id}`, { method: "DELETE", token: b!.u.token })).status).toBe(404);
    expect((await api(`/v3/trust/ratings/${a!.id}`, { method: "DELETE", token: a!.u.token })).status).toBe(200);
    expect(await db.prepare("SELECT 1 FROM organiser_ratings WHERE id = ?1").bind(a!.id).first()).toBeNull();
    const mine = await api("/v3/me/trust/ratings", { token: b!.u.token });
    expect(mine.json.items).toHaveLength(1);
    const reporter = await user("Leaver");
    await api(`/v3/trust/ratings/${b!.id}/report`, { token: reporter.token, body: { reason: "spam" } });
    await api(`/v3/trust/ratings/${b!.id}/reply`, { token: t.owner.token, body: { text: "Thanks for coming." } });
    for (const who of [reporter, b!.u]) expect((await api("/auth/delete-account", { token: who.token, body: { password: "correct horse" } })).status).toBe(200);
    expect(await db.prepare("SELECT 1 FROM organiser_ratings WHERE id = ?1").bind(b!.id).first()).toBeNull();
    expect((await db.prepare("SELECT COUNT(*) AS n FROM organiser_rating_reports WHERE reporter_user_id = ?1").bind(reporter.id).first<{ n: number }>())!.n).toBe(0);
  });

  it("v3.trust off: every trust route is the unknown-route 404, even with v3.tournaments on", async () => {
    await communityOn("v3.tournaments");
    const t = await pastTournament(1);
    const u = await user("Off");
    const unknown = await api("/v3/definitely-not-a-route");
    for (const [path, method] of [[`/public/tournaments/${t.slug}/trust`, "GET"], [`/v3/tournaments/${t.slug}/trust/me`, "GET"], [`/v3/tournaments/${t.slug}/trust/ratings`, "POST"], ["/v3/me/trust/ratings", "GET"], ["/v3/trust/ratings/x1/reply", "POST"]] as const) {
      const r = await api(path, { method, token: u.token, body: method === "POST" ? {} : undefined });
      expect(r.status, path).toBe(404);
      expect(r.json, path).toEqual(unknown.json);
    }
  });
});
