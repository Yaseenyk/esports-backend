import { beforeAll, describe, expect, it, vi } from "vitest";
import { call, newEvent, uniq } from "../helpers";
import { addBr, addMatch, addRegistration, allV3On, api, db, flagsOn, nowSec, publishTeamPage, tBody, tournament, user } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
beforeAll(allV3On);

describe("organiser: create, read, edit", () => {
  it("creates a draft wrapper around an event I own", async () => {
    const o = await user("Org");
    const ev = await newEvent(o.token);
    const r = await api(`/v3/events/${ev.id}/tournament`, { token: o.token, body: tBody({ slug: "gokte-cup-a1" }) });
    expect(r.status, r.text).toBe(201);
    expect(r.json).toMatchObject({ eventId: ev.id, slug: "gokte-cup-a1", status: "draft", game: "bgmi", seoReady: false, publishedAt: null });
    expect(r.json.seoFailures).toContain("published");
    expect(r.json.startsAt).toBe("2026-12-20T04:30:00.000Z");
    const g = await api(`/v3/events/${ev.id}/tournament`, { token: o.token });
    expect(g.status).toBe(200);
    expect(g.json.id).toBe(r.json.id);
    expect(g.headers.get("cache-control")).toBe("no-store");
  });

  it("derives a slug from the title; a collision gets a suffix", async () => {
    const o = await user();
    const e1 = await newEvent(o.token);
    const e2 = await newEvent(o.token, "Other");
    const title = `Derived Slug Cup ${uniq()}`;
    const a = await api(`/v3/events/${e1.id}/tournament`, { token: o.token, body: tBody({ title }) });
    const b = await api(`/v3/events/${e2.id}/tournament`, { token: o.token, body: tBody({ title }) });
    expect(a.json.slug).toMatch(/^derived-slug-cup-/);
    expect(b.json.slug).not.toBe(a.json.slug);
    expect(b.json.slug.startsWith(a.json.slug.slice(0, 20))).toBe(true);
  });

  it("slug rules: format, reserved, duplicate, one wrapper per event", async () => {
    const o = await user();
    const ev = await newEvent(o.token);
    const post = (over: Record<string, unknown>, id = ev.id) => api(`/v3/events/${id}/tournament`, { token: o.token, body: tBody(over) });
    for (const [slug, code] of [["ab", "slug_format"], ["Has Space", "slug_format"], ["a--b", "slug_double_hyphen"], ["admin", "slug_reserved"], ["tournaments", "slug_reserved"]] as const) {
      const r = await post({ slug });
      expect([r.status, r.json.code], slug).toEqual([400, code]);
    }
    const first = await post({ slug: "unique-slug-1" });
    expect(first.status).toBe(201);
    const again = await post({ slug: "another-slug-1" });
    expect([again.status, again.json.code]).toEqual([409, "tournament_exists"]);
    const e2 = await newEvent(o.token);
    const dup = await post({ slug: "unique-slug-1" }, e2.id);
    expect([dup.status, dup.json.code]).toEqual([409, "slug_taken"]);
  });

  it("validates fields", async () => {
    const o = await user();
    const ev = await newEvent(o.token);
    const bad: [Record<string, unknown>, string][] = [
      [{ game: "chess" }, "invalid_game"], [{ format: "x" }, "invalid_format"], [{ venue: "moon" }, "invalid_venue"], [{ title: "ab" }, "invalid_title"],
      [{ summary: "a".repeat(301) }, "invalid_summary"], [{ description: "<script>" }, "invalid_description"], [{ maxTeams: 1 }, "invalid_maxTeams"],
      [{ startsAt: "tomorrow" }, "invalid_startsAt"], [{ startsAt: "2026-12-20", endsAt: "2026-12-01" }, "invalid_endsAt"],
    ];
    for (const [over, code] of bad) {
      const r = await api(`/v3/events/${ev.id}/tournament`, { token: o.token, body: tBody(over) });
      expect([r.status, r.json.code], JSON.stringify(over)).toEqual([400, code]);
    }
    const missing = await api(`/v3/events/${ev.id}/tournament`, { token: o.token, body: { title: "Only a title" } });
    expect(missing.status).toBe(400);
  });

  it("authorisation: anonymous 401, stranger 404, viewer 403 on writes but can read", async () => {
    const t = await tournament();
    const stranger = await user("Stranger");
    expect((await api(`/v3/events/${t.eventId}/tournament`)).status).toBe(401);
    for (const [m, p, b] of [["GET", "", undefined], ["PUT", "", {}], ["POST", "/status", { to: "published" }]] as const) {
      const r = await api(`/v3/events/${t.eventId}/tournament${p}`, { method: m, token: stranger.token, body: b });
      expect([r.status, r.json.error], `${m}${p}`).toEqual([404, "Event not found"]);
    }
    const c = await api(`/v3/events/${t.eventId}/tournament`, { token: stranger.token, body: tBody() });
    expect(c.status).toBe(404);

    const viewer = await user("Viewer");
    await db.prepare("INSERT INTO event_members (event_id, user_id, role, added_at) VALUES (?1, ?2, 'viewer', ?3)").bind(t.eventId, viewer.id, new Date().toISOString()).run();
    expect((await api(`/v3/events/${t.eventId}/tournament`, { token: viewer.token })).status).toBe(200);
    expect((await api(`/v3/events/${t.eventId}/tournament`, { method: "PUT", token: viewer.token, body: { title: "Hacked title" } })).status).toBe(403);
    expect((await api(`/v3/events/${t.eventId}/tournament/status`, { token: viewer.token, body: { to: "published" } })).status).toBe(403);

    const editor = await user("Editor");
    await db.prepare("INSERT INTO event_members (event_id, user_id, role, added_at) VALUES (?1, ?2, 'editor', ?3)").bind(t.eventId, editor.id, new Date().toISOString()).run();
    const ok = await api(`/v3/events/${t.eventId}/tournament`, { method: "PUT", token: editor.token, body: { summary: "Edited by an editor" } });
    expect([ok.status, ok.json.summary]).toEqual([200, "Edited by an editor"]);
  });

  it("edits partially, clears with null, keeps slug stable after publish", async () => {
    const t = await tournament({ slug: `edit-${uniq()}`.slice(0, 20) });
    const g = await api(`/v3/events/${t.eventId}/tournament`, { method: "PUT", token: t.owner.token, body: { city: null, maxTeams: 32, slug: "renamed-before-publish" } });
    expect([g.status, g.json.city, g.json.maxTeams, g.json.slug]).toEqual([200, null, 32, "renamed-before-publish"]);
    await api(`/v3/events/${t.eventId}/tournament/status`, { token: t.owner.token, body: { to: "published" } });
    const locked = await api(`/v3/events/${t.eventId}/tournament`, { method: "PUT", token: t.owner.token, body: { slug: "after-publish-slug" } });
    expect([locked.status, locked.json.code]).toEqual([409, "slug_locked"]);
    const same = await api(`/v3/events/${t.eventId}/tournament`, { method: "PUT", token: t.owner.token, body: { slug: "renamed-before-publish", title: "Renamed Title Cup" } });
    expect([same.status, same.json.title]).toEqual([200, "Renamed Title Cup"]);
  });
});

describe("state machine", () => {
  it("walks the whole ladder, sets publishedAt once, and refuses illegal moves", async () => {
    const t = await tournament();
    const move = (to: string) => api(`/v3/events/${t.eventId}/tournament/status`, { token: t.owner.token, body: { to } });
    const bad = await move("live");
    expect([bad.status, bad.json.code, bad.json.from]).toEqual([409, "bad_transition", "draft"]);
    expect((await move("nonsense")).status).toBe(400);
    const p = await move("published");
    expect(p.json.status).toBe("published");
    const stamp = p.json.publishedAt;
    expect(stamp).toBeTruthy();
    for (const to of ["registration_open", "registration_closed", "live", "completed"]) expect((await move(to)).status, to).toBe(200);
    const after = await move("cancelled");
    expect(after.status).toBe(409);
    expect((await api(`/v3/events/${t.eventId}/tournament`, { token: t.owner.token })).json.publishedAt).toBe(stamp);
  });

  it("cannot reach registration_open without a description and a start date", async () => {
    const t = await tournament({ description: undefined, startsAt: undefined, endsAt: undefined });
    await api(`/v3/events/${t.eventId}/tournament/status`, { token: t.owner.token, body: { to: "published" } });
    const r = await api(`/v3/events/${t.eventId}/tournament/status`, { token: t.owner.token, body: { to: "registration_open" } });
    expect([r.status, r.json.code]).toEqual([409, "needs_description_and_start"]);
    await api(`/v3/events/${t.eventId}/tournament`, { method: "PUT", token: t.owner.token, body: { description: "Real text about the event." } });
    expect((await api(`/v3/events/${t.eventId}/tournament/status`, { token: t.owner.token, body: { to: "registration_open" } })).json.code).toBe("needs_description_and_start");
    await api(`/v3/events/${t.eventId}/tournament`, { method: "PUT", token: t.owner.token, body: { startsAt: "2026-12-20" } });
    expect((await api(`/v3/events/${t.eventId}/tournament/status`, { token: t.owner.token, body: { to: "registration_open" } })).status).toBe(200);
    // and an open tournament cannot lose them
    const strip = await api(`/v3/events/${t.eventId}/tournament`, { method: "PUT", token: t.owner.token, body: { description: null } });
    expect([strip.status, strip.json.code]).toEqual([409, "needs_description_and_start"]);
  });

  it("cannot complete while a dispute is undecided; cancelled and completed are final", async () => {
    const t = await tournament({}, "live");
    await db.prepare("INSERT INTO disputes (id, tournament_id, type, status, summary, due_at, created_at, updated_at) VALUES (?1, ?2, 'other', 'under_review', 'x', ?3, ?3, ?3)").bind(`d${uniq()}`.padEnd(32, "0"), t.id, nowSec()).run();
    const r = await api(`/v3/events/${t.eventId}/tournament/status`, { token: t.owner.token, body: { to: "completed" } });
    expect([r.status, r.json.code]).toEqual([409, "disputes_open"]);
    await db.prepare("UPDATE disputes SET status = 'withdrawn' WHERE tournament_id = ?1").bind(t.id).run();
    expect((await api(`/v3/events/${t.eventId}/tournament/status`, { token: t.owner.token, body: { to: "completed" } })).status).toBe(200);
    const edit = await api(`/v3/events/${t.eventId}/tournament`, { method: "PUT", token: t.owner.token, body: { title: "Cannot edit now" } });
    expect([edit.status, edit.json.code]).toEqual([409, "tournament_final"]);
  });

  it("seoReady turns true only when the thin-page guard passes, and drops again", async () => {
    const t = await tournament({}, "registration_open");
    const g = await api(`/v3/events/${t.eventId}/tournament`, { token: t.owner.token });
    expect([g.json.seoReady, g.json.seoFailures]).toEqual([true, []]);
    const thin = await api(`/v3/events/${t.eventId}/tournament`, { method: "PUT", token: t.owner.token, body: { summary: "Too short." } });
    expect([thin.json.seoReady, thin.json.seoFailures]).toEqual([false, ["summary_80"]]);
    const pub = await api(`/public/tournaments/${t.slug}`);
    expect(pub.json.tournament.seoReady).toBe(false);
  });

  it("two tournaments with the same published title are not both seo-ready", async () => {
    const title = `Same Title Cup ${uniq()}`;
    const a = await tournament({ title }, "registration_open");
    const b = await tournament({ title }, "registration_open");
    const ga = await api(`/v3/events/${a.eventId}/tournament`, { token: a.owner.token });
    const gb = await api(`/v3/events/${b.eventId}/tournament`, { token: b.owner.token });
    expect([ga.json.seoReady, gb.json.seoFailures]).toEqual([true, ["title_unique"]]);
  });
});

describe("public reads", () => {
  it("list: only public statuses, filters, limit, ETag and 304, exact key set", async () => {
    const draft = await tournament({ title: `Hidden Draft ${uniq()}` });
    const open = await tournament({ title: `Visible Open ${uniq()}`, game: "valorant" }, "registration_open");
    const r = await api("/public/tournaments?limit=50");
    expect(r.status).toBe(200);
    const slugs = r.json.items.map((x: { slug: string }) => x.slug);
    expect(slugs).toContain(open.slug);
    expect(slugs).not.toContain(draft.slug);
    expect(Object.keys(r.json.items[0]).sort()).toEqual(["city", "endsAt", "format", "game", "maxTeams", "publishedAt", "seoReady", "slug", "startsAt", "state", "status", "summary", "title", "venue"]);
    expect(r.headers.get("cache-control")).toContain("public, max-age=60");
    const etag = r.headers.get("etag")!;
    expect(etag).toMatch(/^W\//);
    const again = await api("/public/tournaments?limit=50", { headers: { "if-none-match": etag } });
    expect([again.status, again.text]).toEqual([304, ""]);
    const f = await api("/public/tournaments?game=valorant&status=registration_open");
    expect(f.json.items.every((x: { game: string; status: string }) => x.game === "valorant" && x.status === "registration_open")).toBe(true);
    expect((await api("/public/tournaments?limit=1")).json.items.length).toBe(1);
    expect((await api("/public/tournaments?status=draft")).status).toBe(400);
    expect((await api("/public/tournaments?game=chess")).status).toBe(400);
    expect((await api("/public/tournaments?limit=0")).status).toBe(400);
  });

  it("detail: 404 for draft, unknown, cancelled and bad slugs", async () => {
    const draft = await tournament();
    expect((await api(`/public/tournaments/${draft.slug}`)).status).toBe(404);
    expect((await api("/public/tournaments/does-not-exist-1")).status).toBe(404);
    expect((await api("/public/tournaments/BAD_SLUG!")).status).toBe(404);
    const c = await tournament({}, "published");
    await api(`/v3/events/${c.eventId}/tournament/status`, { token: c.owner.token, body: { to: "cancelled" } });
    expect((await api(`/public/tournaments/${c.slug}`)).status).toBe(404);
  });

  it("detail: public teams only, others masked, results and schedule, nothing private", async () => {
    const t = await tournament({}, "live");
    await addRegistration(t.eventId, "Alpha Wolves");
    await addRegistration(t.eventId, "Secret Squad");
    await addRegistration(t.eventId, "Pending Crew", "pending");
    await publishTeamPage(t.eventId, "Alpha Wolves");
    const m1 = await addMatch(t.eventId, "Alpha Wolves", "Secret Squad", { score_a: 13, score_b: 9 });
    await addMatch(t.eventId, "Alpha Wolves", "Secret Squad", { status: "scheduled" });
    await addBr(t.eventId, 1, "Alpha Wolves", 1, 11);
    await addBr(t.eventId, 1, "Secret Squad", 2, 7);
    await db.prepare("UPDATE matches SET starts_at = '2026-12-20T05:00:00Z' WHERE id = ?1").bind(m1).run();

    const r = await api(`/public/tournaments/${t.slug}`);
    expect(r.status, r.text).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(["hasResults", "registration", "results", "schedule", "teams", "tournament"]);
    expect(r.json.teams).toEqual([{ name: "Alpha Wolves", teamSlug: expect.stringMatching(/^tm-/) }]);
    expect(r.json.registration).toMatchObject({ registered: 3, approved: 2, open: false });
    expect(r.json.results.matches).toHaveLength(1);
    expect(r.json.results.matches[0]).toMatchObject({ teamA: "Alpha Wolves", teamB: "Unlisted team", scoreA: 13, scoreB: 9, corrected: false });
    expect(r.json.results.battleRoyale.map((x: { team: string }) => x.team)).toEqual(["Alpha Wolves", "Unlisted team"]);
    expect(r.json.schedule).toHaveLength(2);
    expect(r.json.hasResults).toBe(true);
    const text = r.text;
    for (const secret of ["Secret Squad", "Pending Crew", "secret-contact", "@example.com", t.owner.id, t.eventId, t.id, "lobby", "password"]) expect(text, secret).not.toContain(secret);
    expect(Object.keys(r.json.tournament).sort()).toEqual(["city", "description", "endsAt", "format", "game", "maxTeams", "publishedAt", "rules", "seoReady", "slug", "startsAt", "state", "status", "summary", "title", "venue"]);
  });

  it("a hidden team page or a takedown removes the team / the whole page (takedown.enforce)", async () => {
    const t = await tournament({}, "registration_open");
    await addRegistration(t.eventId, "Visible Team");
    const pid = await publishTeamPage(t.eventId, "Visible Team");
    expect((await api(`/public/tournaments/${t.slug}`)).json.teams).toHaveLength(1);
    await db.prepare("INSERT INTO takedowns (target_type, target_id, state, reason_code, by_staff, at) VALUES ('team_profile', ?1, 'hidden', 'other', 'test', ?2)").bind(pid, new Date().toISOString()).run();
    expect((await api(`/public/tournaments/${t.slug}`)).json.teams).toEqual([]);

    await db.prepare("INSERT INTO takedowns (target_type, target_id, state, reason_code, by_staff, at, event_id) VALUES ('event', ?1, 'hidden', 'other', 'test', ?2, ?1)").bind(t.eventId, new Date().toISOString()).run();
    expect((await api(`/public/tournaments/${t.slug}`)).status).toBe(200); // rollout flag off: recorded, not enforced
    await flagsOn("v3.tournaments", "v3.resume", "v3.lft", "v3.disputes", "takedown.enforce");
    expect((await api(`/public/tournaments/${t.slug}`)).status).toBe(404);
    expect((await api(`/public/tournaments/${t.slug}/live`)).status).toBe(404);
    expect((await api("/public/tournaments?limit=50")).json.items.map((x: { slug: string }) => x.slug)).not.toContain(t.slug);
    await allV3On();
  });

  it("kill.directory answers 503 on public reads; writes stay available", async () => {
    const t = await tournament({}, "published");
    await flagsOn("v3.tournaments", "kill.directory");
    for (const p of ["/public/tournaments", `/public/tournaments/${t.slug}`, `/public/tournaments/${t.slug}/live`]) {
      const r = await api(p);
      expect([r.status, r.json.code], p).toEqual([503, "temporarily_disabled"]);
    }
    expect((await api(`/v3/events/${t.eventId}/tournament`, { token: t.owner.token })).status).toBe(200);
    await allV3On();
  });

  it("live endpoint: count and status only", async () => {
    const t = await tournament({ maxTeams: 4 }, "registration_open");
    await addRegistration(t.eventId, "One");
    await addRegistration(t.eventId, "Two", "pending");
    await addRegistration(t.eventId, "Three", "rejected");
    const r = await api(`/public/tournaments/${t.slug}/live`);
    expect(r.json).toEqual({ slug: t.slug, status: "registration_open", registered: 2, spotsLeft: 2, open: true });
    expect(r.headers.get("cache-control")).toContain("max-age=15");
    await addRegistration(t.eventId, "Four");
    await addRegistration(t.eventId, "Five");
    expect((await api(`/public/tournaments/${t.slug}/live`)).json).toMatchObject({ registered: 4, spotsLeft: 0, open: false });
  });

  it("a corrected result shows the new value with a corrected marker and the original; the legacy row is untouched", async () => {
    const t = await tournament({}, "live");
    await addRegistration(t.eventId, "Alpha Wolves");
    await publishTeamPage(t.eventId, "Alpha Wolves");
    const mid = await addMatch(t.eventId, "Alpha Wolves", "Beta", { score_a: 5, score_b: 7, winner: "b" });
    await addBr(t.eventId, 2, "Alpha Wolves", 2, 5);
    const did = `d${uniq()}`.padEnd(32, "0");
    await db.prepare("INSERT INTO disputes (id, tournament_id, type, status, summary, due_at, created_at, updated_at, resolved_at) VALUES (?1, ?2, 'wrong_score', 'resolved', 'x', ?3, ?3, ?3, ?3)").bind(did, t.id, nowSec()).run();
    for (const [ref, nv] of [[`match:${mid}`, { scoreA: 9, scoreB: 7, winner: "a" }], ["br:2:Alpha Wolves", { placement: 1, kills: 5 }]] as const) {
      await db.prepare("INSERT INTO v3_result_corrections (id, dispute_id, event_id, match_ref, old_value, new_value, created_at) VALUES (?1, ?2, ?3, ?4, '{}', ?5, ?6)").bind(`c${uniq()}`.padEnd(32, "0"), did, t.eventId, ref, JSON.stringify(nv), nowSec()).run();
    }
    const r = await api(`/public/tournaments/${t.slug}`);
    expect(r.json.results.matches[0]).toMatchObject({ scoreA: 9, scoreB: 7, winner: "a", corrected: true, original: { scoreA: 5, scoreB: 7, winner: "b" } });
    expect(r.json.results.battleRoyale[0]).toMatchObject({ placement: 1, corrected: true, original: { placement: 2, kills: 5 } });
    expect(await db.prepare("SELECT score_a FROM matches WHERE id = ?1").bind(mid).first()).toEqual({ score_a: 5 });
    expect(await db.prepare("SELECT placement FROM br_results WHERE event_id = ?1").bind(t.eventId).first()).toEqual({ placement: 2 });
  });

  it("an ordinary legacy route is unaffected (sanity)", async () => {
    expect((await call("/")).json).toEqual({ ok: true, name: "esports-api" });
  });
});
