import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { call, newUser, setupEvent, uniq } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

const ALL = { teams: true, people: true, registrationForm: true, liveExtras: true, members: true, matches: true };
const dup = (id: string, token: string, body: unknown) => call(`/events/${id}/duplicate`, { token, body });
const q = async (sql: string, ...b: unknown[]) => (await env.DB.prepare(sql).bind(...b).all<any>()).results;

/** A rich source event: roster with photo and consent, check-ins, gate key, invite, registration form and submission, live page, matches with results, members. */
async function world() {
  const o = await setupEvent(`Source ${uniq()}`);
  const id = o.ev.id;
  const editor = await newUser("Ed");
  const viewer = await newUser("Vi");
  const stranger = await newUser("Str");
  expect((await call(`/events/${id}/members`, { token: o.token, body: { email: editor.email, role: "editor" } })).status).toBe(201);
  expect((await call(`/events/${id}/members`, { token: o.token, body: { email: viewer.email, role: "viewer" } })).status).toBe(201);
  await env.DB.prepare("INSERT INTO checkins (event_id, person_id, at, door) VALUES (?, 'ALP-001', ?, 'Door 1')").bind(id, new Date().toISOString()).run();
  await call(`/events/${id}/gate-keys`, { token: o.token, body: { label: "Door 1" } });
  const t = uniq();
  await env.DB.prepare("INSERT INTO invites (id, event_id, team_id, token, label, uses, revoked, created_at) VALUES (?, ?, 't1', ?, 'x', 0, 0, ?)").bind(`inv${t}`, id, `tok${t}`, new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO share_links (id, event_id, person_id, token, created_at, revoked) VALUES (?, ?, 'ALP-001', ?, ?, 0)").bind(`sl${t}`, id, `shr${t}`, new Date().toISOString()).run();
  expect((await call(`/events/${id}/registration`, { method: "PUT", token: o.token, body: { acknowledge: true, title: "Join the cup", intro: "Welcome", maxTeams: 16, teamSize: 5, subs: 2, open: true, closesAt: "2026-11-30T00:00:00Z" } })).status).toBe(201);
  const form = (await call(`/events/${id}/registration`, { token: o.token })).json.form;
  await env.DB.prepare("INSERT INTO registrations (id, event_id, team_name, captain_name, captain_contact, players, notes, status, created_at) VALUES (?, ?, 'Zed Team', 'Zed', 'zed@example.com', '[]', '', 'pending', ?)").bind(`reg${t}`, id, new Date().toISOString()).run();
  const live = await call(`/events/${id}/live`, { method: "PUT", token: o.token, body: { published: true, snapshot: { views: [], announcements: [{ text: "Doors open", at: "2026-11-01T10:00:00Z" }], sponsors: [{ name: "Acme" }], ticker: ["Hello"] } } });
  expect(live.status).toBe(200);
  const s1 = `s1${t}`, s2 = `s2${t}`, f = `f${t}`;
  expect((await call(`/events/${id}/matches`, { method: "PUT", token: o.token, body: { matches: [
    { id: s1, stage: "knockout", round: 1, slot: 1, a: "Alpha", b: "Beta", nextId: f, nextSide: "a" },
    { id: s2, stage: "knockout", round: 1, slot: 2, a: "Gamma", b: "Delta", nextId: f, nextSide: "b" },
    { id: f, stage: "knockout", round: 2, slot: 1 },
  ] } })).status).toBe(200);
  expect((await call(`/events/${id}/matches/${s1}/result`, { token: o.token, body: { scoreA: 2, scoreB: 1 } })).status).toBe(200);
  return { o, id, editor, viewer, stranger, live: live.json, form, s1, f };
}

describe("duplicate: permissions", () => {
  it("owner and editor can copy, viewer 403, stranger 404, anonymous 401, validation 400", async () => {
    const w = await world();
    expect((await dup(w.id, w.o.token, { name: `A ${uniq()}`, include: {} })).status).toBe(201);
    expect((await dup(w.id, w.editor.token, { name: `B ${uniq()}`, include: {} })).status).toBe(201);
    expect((await dup(w.id, w.viewer.token, { name: "C", include: {} })).status).toBe(403);
    const s = await dup(w.id, w.stranger.token, { name: "D", include: {} });
    expect(s.status).toBe(404);
    expect(s.json).toEqual({ error: "Event not found" });
    expect((await call(`/events/${w.id}/duplicate`, { body: { name: "E" } })).status).toBe(401);
    expect((await dup(w.id, w.o.token, { name: "", include: {} })).status).toBe(400);
    expect((await dup(w.id, w.o.token, { name: "x", include: { teams: "yes" } })).status).toBe(400);
    expect((await dup(w.id, w.o.token, { name: "x", include: { directory: true } })).status).toBe(400);
    expect((await dup(w.id, w.o.token, { name: "x", include: { people: true } })).status).toBe(400);
  });

  it("the caller becomes the owner; an editor cannot bring members over", async () => {
    const w = await world();
    const r = await dup(w.id, w.editor.token, { name: `Mine ${uniq()}`, include: { teams: true } });
    expect(r.status).toBe(201);
    expect(Object.keys(r.json).sort()).toEqual(["createdAt", "date", "emergency", "game", "id", "key", "name", "organiser", "rules", "settings", "startsOn", "updatedAt", "venue"]);
    expect((await q("SELECT owner_id FROM events WHERE id = ?", r.json.id))[0].owner_id).toBe(w.editor.id);
    expect((await dup(w.id, w.editor.token, { name: `M2 ${uniq()}`, include: { members: true } })).status).toBe(403);
    // the people of an event are its personal data: an editor cannot copy them into an account of their own (the owner can)
    expect((await dup(w.id, w.editor.token, { name: `M3 ${uniq()}`, include: { teams: true, people: true } })).status).toBe(403);
    expect((await dup(w.id, w.o.token, { name: `M4 ${uniq()}`, include: { teams: true, people: true } })).status).toBe(201);
    const list = (await call("/events", { token: w.editor.token })).json as any[];
    expect(list.find((e) => e.id === r.json.id).role).toBe("owner");
  });
});

describe("duplicate: what is copied and what never is", () => {
  it("copies event fields, date override, teams, minimal people, members, matches", async () => {
    const w = await world();
    const name = `Copy ${uniq()}`;
    const r = await dup(w.id, w.o.token, { name, date: "2026-12-08", include: ALL });
    expect(r.status).toBe(201);
    const n = r.json.id as string;
    expect(r.json).toMatchObject({ name, date: "2026-12-08", game: "BGMI", organiser: "Org", venue: "Hall 1", emergency: "112", rules: "Be nice", settings: { a: 1 } });
    expect(r.json.id).not.toBe(w.id);
    const ev = await q("SELECT signing_secret FROM events WHERE id IN (?, ?)", w.id, n);
    expect(new Set(ev.map((e) => e.signing_secret)).size).toBe(2);
    expect(await q("SELECT id, name FROM teams WHERE event_id = ? ORDER BY id", n)).toEqual([{ id: "t1", name: "Alpha Wolves" }, { id: "t2", name: "Beta Hawks" }]);
    expect(await q("SELECT id, team_id, name, role, zones, minor, guardian FROM people WHERE event_id = ? ORDER BY id", n)).toEqual([
      { id: "ALP-001", team_id: "t1", name: "Asha", role: "Player", zones: '["Stage"]', minor: 0, guardian: 0 },
      { id: "ALP-002", team_id: "t1", name: "Ravi", role: "Coach", zones: "[]", minor: 1, guardian: 0 }, // consent reset, child stays flagged
      { id: "BET-001", team_id: "t2", name: "Mira", role: "Player", zones: "[]", minor: 0, guardian: 0 },
    ]);
    expect((await q("SELECT user_id, role FROM event_members WHERE event_id = ? ORDER BY role", n)).map((m) => [m.user_id, m.role])).toEqual([[w.editor.id, "editor"], [w.viewer.id, "viewer"]]);
    const ms = await q("SELECT * FROM matches WHERE event_id = ? ORDER BY round, slot", n);
    expect(ms).toHaveLength(3);
    for (const m of ms) expect(m).toMatchObject({ status: "scheduled", score_a: null, score_b: null, winner: null, starts_at: null, stage: "knockout" });
    expect(ms.map((m) => [m.a, m.b])).toEqual([["Alpha", "Beta"], ["Gamma", "Delta"], ["", ""]]);
    expect(ms[0].next_id).toBe(ms[2].id);
    expect(ms[0].next_side).toBe("a");
    expect(ms[1].next_side).toBe("b");
    const srcIds = new Set((await q("SELECT id FROM matches WHERE event_id = ?", w.id)).map((m) => m.id));
    for (const m of ms) expect(srcIds.has(m.id)).toBe(false);
    expect((await q("SELECT score_a FROM matches WHERE id = ?", w.s1))[0].score_a).toBe(2);
    expect(await q("SELECT 1 FROM br_results WHERE event_id = ?", n)).toHaveLength(0);
  });

  it("never copies photos, check-ins, consent, gate keys, invites, share links, submissions, announcements, old passes", async () => {
    const w = await world();
    const r = await dup(w.id, w.o.token, { name: `Priv ${uniq()}`, include: ALL });
    const n = r.json.id as string;
    expect(await q("SELECT 1 FROM photos WHERE event_id = ?", n)).toHaveLength(0);
    expect((await q("SELECT 1 FROM photos WHERE event_id = ?", w.id)).length).toBeGreaterThan(0);
    for (const t of ["checkins", "gate_keys", "invites", "share_links", "submissions", "registrations"]) {
      expect(await q(`SELECT 1 FROM ${t} WHERE event_id = ?`, n), t).toHaveLength(0);
    }
    expect((await q("SELECT 1 FROM people WHERE event_id = ? AND guardian = 1", w.id)).length).toBe(1);
    expect(await q("SELECT 1 FROM people WHERE event_id = ? AND guardian = 1", n)).toHaveLength(0);
    const snap = JSON.parse((await q("SELECT snapshot FROM live_pages WHERE event_id = ?", n))[0].snapshot);
    expect(snap).toEqual({ views: [], announcements: [], sponsors: [{ name: "Acme" }], ticker: ["Hello"] });
    const oldPasses = (await call(`/events/${w.id}/passes`, { token: w.o.token })).json as { code: string }[];
    const newPasses = (await call(`/events/${n}/passes`, { token: w.o.token })).json as { code: string }[];
    expect(newPasses.length).toBe(3);
    for (const p of newPasses) expect(oldPasses.map((x) => x.code)).not.toContain(p.code);
  });

  it("registration form: text and settings copied, new token, closed, no deadline, no submissions", async () => {
    const w = await world();
    const r = await dup(w.id, w.o.token, { name: `Reg ${uniq()}`, include: { registrationForm: true } });
    const f = (await call(`/events/${r.json.id}/registration`, { token: w.o.token })).json;
    expect(f.form).toMatchObject({ title: "Join the cup", intro: "Welcome", maxTeams: 16, teamSize: 5, subs: 2, open: false, closesAt: null });
    expect(f.form.token).toBeTruthy();
    expect(f.form.token).not.toBe(w.form.token);
    expect(f.counts).toEqual({ pending: 0, approved: 0, rejected: 0 });
    expect((await call(`/events/${w.id}/registration`, { token: w.o.token })).json.counts.pending).toBe(1);
  });

  it("live page: new slug, unpublished; nothing created when not asked for", async () => {
    const w = await world();
    const r = await dup(w.id, w.o.token, { name: `Live ${uniq()}`, include: { liveExtras: true } });
    const lp = (await call(`/events/${r.json.id}/live`, { token: w.o.token })).json;
    expect(lp.published).toBe(false);
    expect(lp.slug).toMatch(/^[a-z2-7]{12}$/);
    expect(lp.slug).not.toBe(w.live.slug);
    expect((await call(`/public/live/${lp.slug}`)).status).toBe(404);
    const bare = await dup(w.id, w.o.token, { name: `Bare ${uniq()}`, include: {} });
    expect((await call(`/events/${bare.json.id}/live`, { token: w.o.token })).json.slug).toBeNull();
    expect(await q("SELECT 1 FROM teams WHERE event_id = ?", bare.json.id)).toHaveLength(0);
    expect(await q("SELECT 1 FROM matches WHERE event_id = ?", bare.json.id)).toHaveLength(0);
  });

  it("slug is unique per owner", async () => {
    const w = await world();
    const a = await dup(w.id, w.o.token, { name: "Same Slug Cup" });
    const b = await dup(w.id, w.o.token, { name: "Same Slug Cup!" });
    expect(a.json.key).not.toBe(b.json.key);
  });
});

describe("duplicate: guard, caps, rate limit, atomicity", () => {
  it("same name by the same user within 10 seconds returns the first result", async () => {
    const w = await world();
    const name = `Twice ${uniq()}`;
    const a = await dup(w.id, w.o.token, { name, include: { teams: true } });
    const b = await dup(w.id, w.o.token, { name, include: { teams: true } });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.json.id).toBe(a.json.id);
    expect(await q("SELECT 1 FROM events WHERE owner_id = ? AND name = ?", w.o.id, name)).toHaveLength(1);
  });

  it("caps: matches at most 512, people equal to the source", async () => {
    const w = await world();
    const rows = Array.from({ length: 509 }, (_, i) => ({ id: `cap${uniq()}${i}`, stage: "league", round: 1, slot: i + 1, a: `A${i}`, b: `B${i}` }));
    for (let i = 0; i < rows.length; i += 200) expect((await call(`/events/${w.id}/matches`, { method: "PUT", token: w.o.token, body: { matches: rows.slice(i, i + 200) } })).status).toBe(200);
    const r = await dup(w.id, w.o.token, { name: `Cap ${uniq()}`, include: { matches: true, teams: true, people: true } });
    expect(r.status).toBe(201);
    const count = (await q("SELECT COUNT(*) AS n FROM matches WHERE event_id = ?", r.json.id))[0].n;
    expect(count).toBe(512);
    expect((await q("SELECT COUNT(*) AS n FROM people WHERE event_id = ?", r.json.id))[0].n).toBe(3);
  });

  it("rate limit: 20 per hour per user", async () => {
    const w = await world();
    for (let i = 0; i < 20; i++) expect((await dup(w.id, w.o.token, { name: `RL ${uniq()}`, include: {} })).status).toBe(201);
    expect((await dup(w.id, w.o.token, { name: `RL ${uniq()}`, include: {} })).status).toBe(429);
    expect((await dup(w.id, w.editor.token, { name: `RL ${uniq()}`, include: {} })).status).toBe(201);
  });

  it("atomic: a failure part-way through leaves no half-made event", async () => {
    const w = await world();
    try {
      // the source row is made first; the trigger is added afterwards so only the copy hits it
      expect((await call(`/events/${w.id}/matches`, { method: "PUT", token: w.o.token, body: { matches: [{ id: `boom${uniq()}`, stage: "x", a: "BOOM-DUP", b: "Z" }] } })).status).toBe(200);
      await env.DB.prepare("CREATE TRIGGER dup_boom BEFORE INSERT ON matches WHEN NEW.a = 'BOOM-DUP' BEGIN SELECT RAISE(ABORT, 'boom'); END").run();
      const name = `Fail ${uniq()}`;
      const r = await dup(w.id, w.o.token, { name, include: ALL });
      expect(r.status).toBe(500);
      expect(await q("SELECT 1 FROM events WHERE name = ?", name)).toHaveLength(0);
      expect(await q("SELECT 1 FROM teams WHERE event_id NOT IN (SELECT id FROM events)")).toHaveLength(0);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS dup_boom").run();
    }
  });
});
