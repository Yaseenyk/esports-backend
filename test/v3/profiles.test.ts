import { beforeAll, describe, expect, it, vi } from "vitest";
import { uniq } from "../helpers";
import { makeStaff } from "../admin/helpers";
import { addBr, addMatch, addRegistration, api, captainToken, db, flagsOn, ownTeamPage, prodLikeOn, publishTeamPage, tournament, user, type U } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
beforeAll(() => prodLikeOn("v3.profiles"));

const PUBLIC_PLAYER_KEYS = ["battleRoyale", "bio", "certificates", "city", "games", "handle", "indexable", "kind", "languages", "matches", "slug", "state", "stats", "teams", "updatedAt", "visibility"];
const PUBLIC_TEAM_KEYS = ["battleRoyale", "blurb", "certificates", "indexable", "kind", "links", "matches", "name", "slug", "tournaments", "updatedAt", "visibility"];

async function claim(u: U, slug: string, eventId: string, team: string) {
  const r = await api(`/v3/tournaments/${slug}/captain-claim`, { token: u.token, body: { token: await captainToken(eventId, team) } });
  expect(r.status, r.text).toBe(200);
}

/** A completed tournament where `me` captained "Alpha Wolves" (approved) against "Beta Hawks": one finished match and two battle royale rows. */
async function world(opts: { consent?: boolean; status?: string } = {}) {
  const me = await user("Captain");
  if (opts.consent !== false) expect((await api("/v3/me/resume-consent", { token: me.token, body: { consent: true } })).status).toBe(200);
  const slug = `p-${uniq()}`.toLowerCase();
  expect((await api("/v3/me/profile", { method: "PUT", token: me.token, body: { slug, handle: "Ravi", bio: "IGL", city: "Pune" } })).status).toBe(200);
  const t = await tournament({}, "live");
  await addRegistration(t.eventId, "Alpha Wolves");
  await addRegistration(t.eventId, "Beta Hawks");
  await addMatch(t.eventId, "Alpha Wolves", "Beta Hawks", { score_a: 13, score_b: 9, winner: "a" });
  await addBr(t.eventId, 1, "Alpha Wolves", 2, 7);
  await addBr(t.eventId, 2, "Alpha Wolves", 1, 11);
  await claim(me, t.slug, t.eventId, "Alpha Wolves");
  const to = opts.status ?? "completed";
  if (to === "completed") expect((await api(`/v3/events/${t.eventId}/tournament/status`, { token: t.owner.token, body: { to: "completed" } })).status).toBe(200);
  return { me, slug, t, itemKey: `${t.slug}:alpha wolves` };
}
const vis = (u: U, visibility: string) => api("/v3/me/player-page/visibility", { method: "PUT", token: u.token, body: { visibility } });

describe("player profiles: privacy per profile", () => {
  it("is private by default: the public page is a 404, the owner sees everything and why it is not indexable", async () => {
    const w = await world();
    expect((await api(`/public/profiles/players/${w.slug}`)).status).toBe(404);
    const own = await api("/v3/me/player-page", { token: w.me.token });
    expect(own.status, own.text).toBe(200);
    expect(own.json.page).toMatchObject({ slug: w.slug, visibility: "private", indexable: false, path: `/players/view/?s=${w.slug}` });
    expect(own.json.page.indexBlockers).toEqual(["not_public"]);
    expect(own.json.page.entries).toHaveLength(1);
    expect(own.json.page.certificates).toHaveLength(1);
    expect(own.headers.get("cache-control")).toBe("no-store");
  });

  it("Link only and Public need 18+ and resume consent", async () => {
    const w = await world({ consent: false });
    expect((await vis(w.me, "unlisted")).json.code).toBe("consent_required");
    expect((await vis(w.me, "public")).json.code).toBe("consent_required");
    const kid = await user("NoAdult", false);
    await api("/v3/me/profile", { method: "PUT", token: kid.token, body: { slug: `k-${uniq()}`.toLowerCase(), handle: "Kid" } });
    expect((await vis(kid, "unlisted")).json.code).toBe("adult_required");
    expect((await vis(await user("NoProfile"), "public")).json.code).toBe("profile_required");
    expect((await vis(w.me, "secret")).status).toBe(400);
  });

  it("Link only: readable by link, never indexable", async () => {
    const w = await world();
    expect((await vis(w.me, "unlisted")).status).toBe(200);
    const r = await api(`/public/profiles/players/${w.slug}`);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ visibility: "unlisted", indexable: false });
    expect(r.headers.get("cache-control")).toBe("public, max-age=0");
    // the legacy resume endpoint keeps its old rule (unlisted is private there)
    expect((await api(`/public/players/${w.slug}`)).status).toBe(404);
  });

  it("Public with verified results is indexable; payload has teams, matches and certificates and nothing private", async () => {
    const w = await world();
    expect((await vis(w.me, "public")).status).toBe(200);
    const r = await api(`/public/profiles/players/${w.slug}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(PUBLIC_PLAYER_KEYS);
    expect(r.json).toMatchObject({ kind: "player", visibility: "public", indexable: true });
    expect(r.json.teams).toEqual([{ name: "Alpha Wolves", games: ["bgmi"], tournaments: 1, teamPageSlug: null }]);
    expect(r.json.matches).toEqual([expect.objectContaining({ tournament: { slug: w.t.slug, title: expect.any(String) }, team: "Alpha Wolves", opponent: "Unlisted team", scoreFor: 13, scoreAgainst: 9, result: "win", corrected: false })]);
    expect(r.json.battleRoyale).toHaveLength(2);
    expect(r.json.certificates).toEqual([expect.objectContaining({ id: w.itemKey, team: "Alpha Wolves", source: "verified_results", record: { played: 1, wins: 1, draws: 0, losses: 0 }, battleRoyale: { matches: 2, wins: 1, bestPlacement: 1, kills: 18 } })]);
    expect(r.json.stats).toMatchObject({ source: "verified_results", tournaments: 1, matches: { played: 1, wins: 1 } });
    for (const needle of [w.me.id, w.me.email, w.t.eventId, "secret-contact@example.com", "hidden"]) expect(r.text, needle).not.toContain(needle);
    // an opponent that published a team page is named
    await publishTeamPage(w.t.eventId, "Beta Hawks");
    expect((await api(`/public/profiles/players/${w.slug}`)).json.matches[0].opponent).toBe("Beta Hawks");
  });

  it("Public without verified results is not indexable; certificates need a completed tournament", async () => {
    const w = await world({ status: "live" });
    await vis(w.me, "public");
    const r = await api(`/public/profiles/players/${w.slug}`);
    expect(r.json.certificates).toEqual([]);
    expect(r.json.matches).toHaveLength(1);
    expect(r.json.indexable).toBe(true); // verified results exist even before the tournament ends
    const empty = await user("Empty");
    await api("/v3/me/resume-consent", { token: empty.token, body: { consent: true } });
    const s2 = `e-${uniq()}`.toLowerCase();
    await api("/v3/me/profile", { method: "PUT", token: empty.token, body: { slug: s2, handle: "Empty", visibility: "public" } });
    const e = await api(`/public/profiles/players/${s2}`);
    expect(e.json).toMatchObject({ indexable: false, matches: [], certificates: [], teams: [] });
    expect((await api("/v3/me/player-page", { token: empty.token })).json.page.indexBlockers).toEqual(["no_verified_results"]);
  });

  it("results of a registration the organiser did not approve never count", async () => {
    const me = await user("Unapproved");
    await api("/v3/me/resume-consent", { token: me.token, body: { consent: true } });
    const slug = `u-${uniq()}`.toLowerCase();
    await api("/v3/me/profile", { method: "PUT", token: me.token, body: { slug, handle: "Unapproved", visibility: "public" } });
    const t = await tournament({}, "live");
    const rid = await addRegistration(t.eventId, "Gamma");
    await addBr(t.eventId, 1, "Gamma", 1, 20);
    await claim(me, t.slug, t.eventId, "Gamma");
    const before = await api(`/public/profiles/players/${slug}`);
    expect(before.status, before.text).toBe(200);
    expect(before.json.battleRoyale).toHaveLength(1);
    await db.prepare("UPDATE registrations SET status = 'rejected' WHERE id = ?1").bind(rid).run(); // the organiser no longer approves it
    const r = await api(`/public/profiles/players/${slug}`);
    expect(r.json).toMatchObject({ battleRoyale: [], certificates: [], indexable: false });
  });

  it("the owner can hide one tournament from the page and show it again", async () => {
    const w = await world();
    await vis(w.me, "public");
    const h = await api("/v3/me/player-page/hidden", { method: "PUT", token: w.me.token, body: { itemKey: w.itemKey, hidden: true } });
    expect(h.status, h.text).toBe(200);
    expect(h.json.page.entries[0].hidden).toBe(true);
    expect(h.json.page.certificates[0].hidden).toBe(true);
    const r = await api(`/public/profiles/players/${w.slug}`);
    expect(r.json).toMatchObject({ matches: [], battleRoyale: [], certificates: [], teams: [], indexable: false });
    expect(r.json.stats.tournaments).toBe(0);
    await api("/v3/me/player-page/hidden", { method: "PUT", token: w.me.token, body: { itemKey: w.itemKey, hidden: false } });
    expect((await api(`/public/profiles/players/${w.slug}`)).json.certificates).toHaveLength(1);
    expect((await api("/v3/me/player-page/hidden", { method: "PUT", token: w.me.token, body: { itemKey: "nope:thing", hidden: true } })).status).toBe(404);
    expect((await api("/v3/me/player-page/hidden", { method: "PUT", token: w.me.token, body: { itemKey: w.itemKey } })).status).toBe(400);
  });

  it("withdrawing consent or deleting the profile removes the page at once", async () => {
    const w = await world();
    await vis(w.me, "public");
    expect((await api(`/public/profiles/players/${w.slug}`)).status).toBe(200);
    await api("/v3/me/resume-consent", { method: "DELETE", token: w.me.token });
    expect((await api(`/public/profiles/players/${w.slug}`)).status).toBe(404);
    await api("/v3/me/resume-consent", { token: w.me.token, body: { consent: true } });
    await vis(w.me, "public");
    await api("/v3/me/profile", { method: "DELETE", token: w.me.token });
    expect((await api(`/public/profiles/players/${w.slug}`)).status).toBe(404);
    expect((await api("/v3/me/player-page", { token: w.me.token })).json).toEqual({ page: null });
  });

  it("needs sign-in for the owner routes; odd slugs are a 404; kill.directory stops public reads", async () => {
    expect((await api("/v3/me/player-page")).status).toBe(401);
    expect((await api("/public/profiles/players/NOT%20A%20SLUG")).status).toBe(404);
    expect((await api("/public/profiles/teams/abc")).status).toBe(404);
    await prodLikeOn("v3.profiles", "kill.directory");
    expect((await api("/public/profiles/players/anything-here")).status).toBe(503);
    await prodLikeOn("v3.profiles");
  });
});

describe("team pages: privacy per team", () => {
  const tvis = (u: U, id: string, body: Record<string, unknown>) => api(`/v3/me/team-pages/${id}/visibility`, { method: "PUT", token: u.token, body });

  it("private by default; Link only and Public need the captain-permission statement and 18+; the legacy published bit follows", async () => {
    const o = await user("TeamOwner");
    const tp = await ownTeamPage(o.id, "Delta Squad");
    expect((await api(`/public/profiles/teams/${tp.slug}`)).status).toBe(404);
    const list = await api("/v3/me/team-pages", { token: o.token });
    expect(list.json.items).toEqual([expect.objectContaining({ id: tp.id, visibility: "private", indexable: false, path: `/teams/view/?s=${tp.slug}` })]);
    expect(list.json.consentStatement).toMatch(/captain's permission/);
    const noConsent = await tvis(o, tp.id, { visibility: "unlisted" });
    expect([noConsent.status, noConsent.json.code]).toEqual([400, "consent_required"]);
    const ok = await tvis(o, tp.id, { visibility: "unlisted", consent: true });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.page.visibility).toBe("unlisted");
    expect(await db.prepare("SELECT published, consent_at IS NOT NULL AS c FROM team_profiles WHERE id = ?1").bind(tp.id).first()).toEqual({ published: 1, c: 1 });
    const r = await api(`/public/profiles/teams/${tp.slug}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(PUBLIC_TEAM_KEYS);
    expect(r.json).toMatchObject({ kind: "team", name: "Delta Squad", visibility: "unlisted", indexable: false });
    expect(r.text).not.toContain(o.id);
    await tvis(o, tp.id, { visibility: "public", consent: true });
    expect((await api(`/public/profiles/teams/${tp.slug}`)).json.visibility).toBe("public");
    await tvis(o, tp.id, { visibility: "private" });
    expect((await api(`/public/profiles/teams/${tp.slug}`)).status).toBe(404);
    expect(await db.prepare("SELECT published, consent_at FROM team_profiles WHERE id = ?1").bind(tp.id).first()).toEqual({ published: 0, consent_at: null });
    expect((await api(`/public/team/${tp.slug}`)).status).toBe(404); // the legacy page agrees
    const kid = await user("KidOwner", false);
    const kt = await ownTeamPage(kid.id);
    expect((await tvis(kid, kt.id, { visibility: "public", consent: true })).json.code).toBe("adult_required");
    expect((await tvis(await user("Stranger"), tp.id, { visibility: "public", consent: true })).status).toBe(404);
  });

  it("a captain adds a tournament they captained; the page then shows its matches and certificate", async () => {
    const w = await world();
    const tp = await ownTeamPage(w.me.id, "Alpha Wolves");
    const detail = await api(`/v3/me/team-pages/${tp.id}`, { token: w.me.token });
    expect(detail.json.page.claimable).toEqual([{ tournament: { slug: w.t.slug, title: expect.any(String) }, team: "Alpha Wolves" }]);
    const add = await api(`/v3/me/team-pages/${tp.id}/claims`, { token: w.me.token, body: { tournamentSlug: w.t.slug } });
    expect(add.status, add.text).toBe(200);
    expect(add.json.page.claimable).toEqual([]);
    expect(add.json.page.certificates).toHaveLength(1);
    await tvis(w.me, tp.id, { visibility: "public", consent: true });
    const r = await api(`/public/profiles/teams/${tp.slug}`);
    expect(r.json).toMatchObject({ indexable: true, tournaments: [expect.objectContaining({ team: "Alpha Wolves" })] });
    expect(r.json.matches[0]).toMatchObject({ result: "win", opponent: "Unlisted team" });
    // the player page now links to the team page
    await vis(w.me, "public");
    expect((await api(`/public/profiles/players/${w.slug}`)).json.teams[0].teamPageSlug).toBe(tp.slug);
    // someone who did not captain that team cannot add it
    const other = await user("NotCaptain");
    const otp = await ownTeamPage(other.id);
    const no = await api(`/v3/me/team-pages/${otp.id}/claims`, { token: other.token, body: { tournamentSlug: w.t.slug } });
    expect([no.status, no.json.code]).toEqual([403, "not_captain"]);
    expect((await api(`/v3/me/team-pages/${otp.id}/claims`, { token: other.token, body: { tournamentSlug: "no-such-cup" } })).status).toBe(404);
    // hide on the team page
    const hid = await api(`/v3/me/team-pages/${tp.id}/hidden`, { method: "PUT", token: w.me.token, body: { itemKey: w.itemKey, hidden: true } });
    expect(hid.status).toBe(200);
    expect((await api(`/public/profiles/teams/${tp.slug}`)).json).toMatchObject({ tournaments: [], certificates: [], indexable: false });
  });
});

describe("reports, moderation and limits", () => {
  const report = (u: U, kind: string, slug: string, reason = "spam") => api(`/v3/profiles/${kind}/${slug}/report`, { token: u.token, body: { reason, note: "x" } });

  it("signed in only; not your own; a listed reason; never says whether it hid the page", async () => {
    const w = await world();
    await vis(w.me, "public");
    expect((await api(`/v3/profiles/players/${w.slug}/report`, { body: { reason: "spam" } })).status).toBe(401);
    expect((await report(w.me, "players", w.slug)).json.code).toBe("own_page");
    const u = await user("Reporter");
    expect((await report(u, "players", w.slug, "nonsense")).json.code).toBe("invalid_reason");
    const ok = await report(u, "players", w.slug);
    expect([ok.status, ok.json]).toEqual([202, { ok: true }]);
    expect((await report(u, "players", "no-such-player")).status).toBe(404);
    expect((await api(`/public/profiles/players/${w.slug}`)).status).toBe(200); // takedown.enforce is off: recorded, not hidden
  });

  it("three distinct reporters hide a page (with takedown.enforce on); a minor report hides at once; staff restore or remove", async () => {
    await prodLikeOn("v3.profiles", "takedown.enforce");
    const staff = await makeStaff();
    const token = (await staff.login()).token;
    const w = await world();
    await vis(w.me, "public");
    for (let i = 0; i < 3; i++) await report(await user(`R${i}`), "players", w.slug);
    expect((await api(`/public/profiles/players/${w.slug}`)).status).toBe(404);
    expect((await api("/v3/me/player-page", { token: w.me.token })).json.page).toMatchObject({ hiddenByModeration: true, indexable: false });
    const o = await user("TeamO");
    const tp = await ownTeamPage(o.id);
    await api(`/v3/me/team-pages/${tp.id}/visibility`, { method: "PUT", token: o.token, body: { visibility: "public", consent: true } });
    await report(await user("Careful"), "teams", tp.slug, "minor_exposed");
    expect((await api(`/public/profiles/teams/${tp.slug}`)).status).toBe(404);

    expect((await api("/admin/v1/v3/profiles/hidden")).status).toBe(404);
    const list = await api("/admin/v1/v3/profiles/hidden", { token });
    expect(list.status, list.text).toBe(200);
    expect(list.json.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "player", slug: w.slug, reportCount: 3 }), expect.objectContaining({ kind: "team", slug: tp.slug })]));
    expect(list.text).not.toContain(w.me.id);
    const restore = await api(`/admin/v1/v3/profiles/player/${w.slug}/decide`, { token, body: { decision: "restore" } });
    expect([restore.status, restore.json]).toEqual([200, { ok: true, decision: "restore" }]);
    expect((await api(`/public/profiles/players/${w.slug}`)).status).toBe(200);
    const remove = await api(`/admin/v1/v3/profiles/team/${tp.slug}/decide`, { token, body: { decision: "remove" } });
    expect(remove.status).toBe(200);
    expect(await db.prepare("SELECT published FROM team_profiles WHERE id = ?1").bind(tp.id).first()).toEqual({ published: 0 });
    expect((await api(`/admin/v1/v3/profiles/player/${w.slug}/decide`, { token, body: { decision: "restore" } })).json.code).toBe("not_hidden");
    expect((await api(`/admin/v1/v3/profiles/robot/${w.slug}/decide`, { token, body: { decision: "restore" } })).status).toBe(404);
    await prodLikeOn("v3.profiles");
  });

  it("report rate limit: 20 per hour per account", async () => {
    const w = await world();
    await vis(w.me, "public");
    const u = await user("Spammer");
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await report(u, "players", w.slug)).status);
    expect(codes.slice(0, 20).every((c) => c === 202)).toBe(true);
    expect(codes[20]).toBe(429);
  });

  it("writes stop while kill.public_writes is on (503); reads still work", async () => {
    const w = await world();
    await prodLikeOn("v3.profiles", "kill.public_writes");
    expect((await vis(w.me, "public")).status).toBe(503);
    expect((await api("/v3/me/player-page", { token: w.me.token })).status).toBe(200);
    await prodLikeOn("v3.profiles");
    await flagsOn("v3.tournaments", "v3.resume", "v3.lft", "v3.disputes", "v3.profiles");
  });
});
