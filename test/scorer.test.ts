import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { call, newUser, setupEvent, uniq } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

async function world() {
  const o = await setupEvent("Scorer Cup");
  const editor = await newUser("Ed");
  const viewer = await newUser("Vi");
  const stranger = await newUser("Str");
  expect((await call(`/events/${o.ev.id}/members`, { token: o.token, body: { email: editor.email, role: "editor" } })).status).toBe(201);
  expect((await call(`/events/${o.ev.id}/members`, { token: o.token, body: { email: viewer.email, role: "viewer" } })).status).toBe(201);
  const p = uniq();
  const ids = { s1: `s1-${p}`, s2: `s2-${p}`, f: `f-${p}`, g1: `g1-${p}`, tbd: `tbd-${p}` };
  const r = await call(`/events/${o.ev.id}/matches`, {
    method: "PUT", token: o.token,
    body: { matches: [
      { id: ids.s1, stage: "knockout", round: 1, slot: 1, a: "Alpha", b: "Beta", nextId: ids.f, nextSide: "a" },
      { id: ids.s2, stage: "knockout", round: 1, slot: 2, a: "Gamma", b: "Delta", nextId: ids.f, nextSide: "b" },
      { id: ids.f, stage: "knockout", round: 2, slot: 1 },
      { id: ids.g1, stage: "group:A", a: "Echo", b: "Fox" },
      { id: ids.tbd, stage: "group:A", round: 2 },
    ] },
  });
  expect(r.status).toBe(200);
  return { o, id: o.ev.id, editor, viewer, stranger, ids };
}
type W = Awaited<ReturnType<typeof world>>;
const make = (w: W, body: unknown, token = w.o.token) => call(`/events/${w.id}/scorer-links`, { token, body });
const view = (t: string) => call(`/public/score/${t}`);
const post = (t: string, mid: string, body: unknown) => call(`/public/score/${t}/matches/${mid}/result`, { body });
const matchRow = async (mid: string) => await env.DB.prepare("SELECT status, score_a, score_b, winner, a, b, updated_by FROM matches WHERE id = ?").bind(mid).first<any>();

describe("scorer: organiser routes", () => {
  it("owner and editor manage links; viewer, stranger, anonymous are refused; token is returned once and stored hashed", async () => {
    const w = await world();
    const a = await make(w, { label: "Lobby A referee" });
    expect(a.status).toBe(201);
    expect(a.json.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(a.json.link).toMatchObject({ label: "Lobby A referee", stage: null, state: "active", revokedAt: null });
    const hours = (Date.parse(a.json.link.expiresAt) - Date.now()) / 3600_000;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThan(12.1);
    expect((await make(w, { label: "By editor" }, w.editor.token)).status).toBe(201);
    const l = await call(`/events/${w.id}/scorer-links`, { token: w.o.token });
    expect(l.status).toBe(200);
    expect(l.json.links.length).toBe(2);
    expect(JSON.stringify(l.json)).not.toContain(a.json.token);
    expect(Object.keys(l.json.links[0]).sort()).toEqual(["createdAt", "expiresAt", "id", "label", "revokedAt", "stage", "state"]);
    const stored = await env.DB.prepare("SELECT token_hash FROM scorer_links WHERE id = ?").bind(a.json.link.id).first<{ token_hash: string }>();
    expect(stored!.token_hash).not.toBe(a.json.token);
    expect((await make(w, { label: "x" }, w.viewer.token)).status).toBe(403);
    expect((await call(`/events/${w.id}/scorer-links`, { token: w.viewer.token })).status).toBe(403);
    expect((await make(w, { label: "x" }, w.stranger.token)).status).toBe(404);
    expect((await call(`/events/${w.id}/scorer-links`)).status).toBe(401);
    expect((await call(`/events/${w.id}/scorer-links/${a.json.link.id}`, { method: "DELETE", token: w.viewer.token })).status).toBe(403);
    expect((await call(`/events/${w.id}/scorer-links/${a.json.link.id}`, { method: "DELETE", token: w.stranger.token })).status).toBe(404);
  });

  it("validates label, hours and stage", async () => {
    const w = await world();
    for (const body of [{}, { label: "" }, { label: "x".repeat(41) }, { label: 5 }, { label: "ok", hours: 73 }, { label: "ok", hours: 0 }, { label: "ok", hours: "2" }, { label: "ok", stage: "s".repeat(41) }]) {
      expect((await make(w, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await make(w, { label: "ok", hours: 72, stage: "knockout" })).status).toBe(201);
  });

  it("revoking works, is idempotent, and cannot touch another event's link", async () => {
    const w = await world();
    const w2 = await world();
    const a = await make(w, { label: "R" });
    const other = await make(w2, { label: "Other" });
    expect((await view(a.json.token)).status).toBe(200);
    expect((await call(`/events/${w.id}/scorer-links/${other.json.link.id}`, { method: "DELETE", token: w.o.token })).status).toBe(404);
    expect((await view(other.json.token)).status).toBe(200);
    expect((await call(`/events/${w.id}/scorer-links/${a.json.link.id}`, { method: "DELETE", token: w.editor.token })).status).toBe(200);
    expect((await call(`/events/${w.id}/scorer-links/${a.json.link.id}`, { method: "DELETE", token: w.o.token })).status).toBe(200);
    expect((await view(a.json.token)).status).toBe(404);
    expect((await call(`/events/${w.id}/scorer-links`, { token: w.o.token })).json.links[0].state).toBe("revoked");
  });
});

describe("scorer: public view", () => {
  it("shows event name, in-scope matches and team names, nothing else; unknown, revoked and expired look identical", async () => {
    const w = await world();
    const all = await make(w, { label: "Everything" });
    const v = await view(all.json.token);
    expect(v.status).toBe(200);
    expect(Object.keys(v.json).sort()).toEqual(["battleRoyale", "event", "expiresAt", "label", "matches", "stage"]);
    expect(v.json.event).toEqual({ name: "Scorer Cup" });
    expect(v.json.matches.length).toBe(5);
    expect(Object.keys(v.json.matches[0]).sort()).toEqual(["a", "b", "id", "round", "scoreA", "scoreB", "slot", "stage", "startsAt", "status", "winner"]);
    expect(v.json.battleRoyale.teams).toEqual(expect.arrayContaining(["Alpha", "Alpha Wolves", "Beta Hawks"]));
    for (const secret of ["Asha", "Ravi", "Mira", "ALP-001", "EH1.", "signing"]) expect(v.text).not.toContain(secret);
    expect(v.headers.get("cache-control")).toBe("no-store");

    const scoped = await make(w, { label: "Groups", stage: "group:A" });
    const sv = await view(scoped.json.token);
    expect(sv.json.matches.map((m: any) => m.stage)).toEqual(["group:A", "group:A"]);
    expect(sv.json.battleRoyale.allowed).toBe(false);
    expect(sv.json.battleRoyale.teams).toEqual([]);

    const expired = await make(w, { label: "Old" });
    await env.DB.prepare("UPDATE scorer_links SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), expired.json.link.id).run();
    const unknown = await view("A".repeat(32));
    const garbage = await view("short");
    const exp = await view(expired.json.token);
    expect(unknown.status).toBe(404);
    expect(exp.status).toBe(404);
    expect(garbage.status).toBe(404);
    expect(exp.text).toBe(unknown.text);
    expect(garbage.text).toBe(unknown.text);
    const list = await call(`/events/${w.id}/scorer-links`, { token: w.o.token });
    expect(list.json.links.find((x: any) => x.id === expired.json.link.id).state).toBe("expired");
    expect((await post(expired.json.token, w.ids.s1, { scoreA: 1, scoreB: 0 })).status).toBe(404);
  });

  it("a link never shows or writes another event", async () => {
    const w = await world();
    const w2 = await world();
    const l = await make(w, { label: "Mine" });
    const r = await view(l.json.token);
    expect(r.text).not.toContain(w2.ids.s1);
    expect((await post(l.json.token, w2.ids.s1, { scoreA: 1, scoreB: 0 })).status).toBe(404);
    expect((await matchRow(w2.ids.s1)).status).toBe("scheduled");
  });
});

describe("scorer: entering results", () => {
  it("finishes a match through applyResult: attribution, advancement and correction flag", async () => {
    const w = await world();
    const l = await make(w, { label: "Lobby A referee" });
    const r = await post(l.json.token, w.ids.s1, { scoreA: 13, scoreB: 9 });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ match: { status: "finished", scoreA: 13, scoreB: 9, winner: "a" }, correction: false, previous: null, downstreamReset: false });
    expect(r.json.changed.map((m: any) => m.id)).toEqual([w.ids.f]);
    expect((await matchRow(w.ids.s1)).updated_by).toBe("scorer:Lobby A referee");
    expect((await matchRow(w.ids.f)).a).toBe("Alpha");
    const fix = await post(l.json.token, w.ids.s1, { scoreA: 9, scoreB: 13 });
    expect(fix.status).toBe(200);
    expect(fix.json).toMatchObject({ correction: true, previous: { status: "finished", scoreA: 13, scoreB: 9 }, match: { winner: "b" } });
    expect((await matchRow(w.ids.f)).a).toBe("Beta");
  });

  it("a correction that resets a finished downstream match is flagged", async () => {
    const w = await world();
    const l = await make(w, { label: "Ref" });
    await post(l.json.token, w.ids.s1, { scoreA: 2, scoreB: 1 });
    await post(l.json.token, w.ids.s2, { scoreA: 2, scoreB: 1 });
    expect((await post(l.json.token, w.ids.f, { scoreA: 3, scoreB: 0 })).status).toBe(200);
    const fix = await post(l.json.token, w.ids.s1, { scoreA: 0, scoreB: 5 });
    expect(fix.json.downstreamReset).toBe(true);
    expect((await matchRow(w.ids.f)).status).toBe("scheduled");
  });

  it("allows live (with running score) and forfeit, rejects anything else", async () => {
    const w = await world();
    const l = await make(w, { label: "Ref" });
    const live = await post(l.json.token, w.ids.g1, { status: "live", scoreA: 4, scoreB: 2 });
    expect(live.status).toBe(200);
    expect(live.json.match).toMatchObject({ status: "live", scoreA: 4, scoreB: 2, winner: null });
    expect((await matchRow(w.ids.g1)).updated_by).toBe("scorer:Ref");
    expect((await post(l.json.token, w.ids.g1, { status: "scheduled" })).status).toBe(400);
    expect((await post(l.json.token, w.ids.g1, { status: "ready" })).status).toBe(400);
    expect((await post(l.json.token, w.ids.g1, { status: "forfeit" })).status).toBe(400);
    const ff = await post(l.json.token, w.ids.g1, { status: "forfeit", winner: "b" });
    expect(ff.status).toBe(200);
    expect(ff.json.match).toMatchObject({ status: "forfeit", winner: "b" });
    expect((await post(l.json.token, w.ids.g1, { status: "live" })).status).toBe(409);
  });

  it("undo reopens a fresh result and takes the winner back out of the next round, unless that was already played", async () => {
    const w = await world();
    const l = await make(w, { label: "Ref" });
    await post(l.json.token, w.ids.s1, { scoreA: 3, scoreB: 1 });
    expect((await matchRow(w.ids.f)).a).toBe("Alpha");
    const u = await post(l.json.token, w.ids.s1, { status: "live", undo: true });
    expect(u.status).toBe(200);
    expect(u.json).toMatchObject({ match: { status: "live", scoreA: null, winner: null }, correction: true });
    expect((await matchRow(w.ids.f)).a).toBe("");
    // without undo: true a finished match cannot be reopened
    await post(l.json.token, w.ids.s1, { scoreA: 3, scoreB: 1 });
    expect((await post(l.json.token, w.ids.s1, { status: "live" })).status).toBe(409);
    // too late
    await env.DB.prepare("UPDATE matches SET updated_at = ? WHERE id = ?").bind(new Date(Date.now() - 10 * 60_000).toISOString(), w.ids.s1).run();
    expect((await post(l.json.token, w.ids.s1, { status: "live", undo: true })).status).toBe(409);
    // the winner has been played on
    await post(l.json.token, w.ids.s2, { scoreA: 1, scoreB: 0 });
    await post(l.json.token, w.ids.f, { scoreA: 2, scoreB: 0 });
    await post(l.json.token, w.ids.s2, { scoreA: 1, scoreB: 0 });
    expect((await post(l.json.token, w.ids.s2, { status: "live", undo: true })).status).toBe(409);
  });

  it("validates scores and refuses undecided teams", async () => {
    const w = await world();
    const l = await make(w, { label: "Ref" });
    for (const body of [{}, { scoreA: -1, scoreB: 0 }, { scoreA: 1.5, scoreB: 0 }, { scoreA: "1", scoreB: 0 }, { scoreA: 1 }, { scoreA: 1e9, scoreB: 0 }]) {
      expect((await post(l.json.token, w.ids.g1, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect((await post(l.json.token, w.ids.tbd, { scoreA: 1, scoreB: 0 })).status).toBe(409);
    expect((await post(l.json.token, "no-such-match", { scoreA: 1, scoreB: 0 })).status).toBe(404);
    expect((await matchRow(w.ids.g1)).status).toBe("scheduled");
  });

  it("a scoped link can only touch matches of its stage", async () => {
    const w = await world();
    const l = await make(w, { label: "Groups ref", stage: "group:A" });
    expect((await post(l.json.token, w.ids.s1, { scoreA: 1, scoreB: 0 })).status).toBe(404);
    expect((await matchRow(w.ids.s1)).status).toBe("scheduled");
    expect((await post(l.json.token, w.ids.g1, { scoreA: 1, scoreB: 0 })).status).toBe(200);
    const br = await call(`/public/score/${l.json.token}/br`, { body: { matchNo: 1, rows: [{ team: "Echo", placement: 1, kills: 1 }] } });
    expect(br.status).toBe(403);
  });

  it("a revoked link stops writing", async () => {
    const w = await world();
    const l = await make(w, { label: "Ref" });
    await call(`/events/${w.id}/scorer-links/${l.json.link.id}`, { method: "DELETE", token: w.o.token });
    expect((await post(l.json.token, w.ids.g1, { scoreA: 1, scoreB: 0 })).status).toBe(404);
    expect((await matchRow(w.ids.g1)).status).toBe("scheduled");
  });
});

describe("scorer: battle royale", () => {
  it("saves rows for known teams, rejects duplicates and unknown teams", async () => {
    const w = await world();
    const l = await make(w, { label: "BR host" });
    const br = (body: unknown) => call(`/public/score/${l.json.token}/br`, { body });
    const ok = await br({ matchNo: 1, rows: [{ team: "Alpha Wolves", placement: 1, kills: 7 }, { team: "Beta Hawks", placement: 2, kills: 3 }] });
    expect(ok.status).toBe(200);
    expect(ok.json.rows.length).toBe(2);
    expect((await view(l.json.token)).json.battleRoyale.rows).toEqual([
      { matchNo: 1, team: "Alpha Wolves", placement: 1, kills: 7 }, { matchNo: 1, team: "Beta Hawks", placement: 2, kills: 3 },
    ]);
    expect((await br({ matchNo: 1, rows: [{ team: "Alpha Wolves", placement: 1 }, { team: "Beta Hawks", placement: 1 }] })).status).toBe(400);
    expect((await br({ matchNo: 1, rows: [{ team: "Alpha Wolves", placement: 1 }, { team: "Alpha Wolves", placement: 2 }] })).status).toBe(400);
    expect((await br({ matchNo: 1, rows: [{ team: "Nobody", placement: 1 }] })).status).toBe(400);
    expect((await br({ matchNo: 0, rows: [{ team: "Alpha Wolves", placement: 1 }] })).status).toBe(400);
    expect((await br({ matchNo: 1, rows: [] })).status).toBe(400);
    expect((await br({ matchNo: 1, rows: [{ team: "Alpha Wolves", placement: 1, kills: -2 }] })).status).toBe(400);
    expect((await view(l.json.token)).json.battleRoyale.rows.length).toBe(2);
  });
});

describe("scorer: rate limits", () => {
  it("limits each token to 120 calls per 10 minutes", async () => {
    const w = await world();
    const l = await make(w, { label: "Busy" });
    const other = await make(w, { label: "Quiet" });
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await post(l.json.token, w.ids.g1, { status: "bogus" })).status;
    expect(last).toBe(429);
    expect((await post(other.json.token, w.ids.g1, { status: "bogus" })).status).toBe(400);
  });

  it("throttles one address that keeps guessing tokens", async () => {
    const ip = "203.0.113.77";
    let last = 0;
    for (let i = 0; i < 22; i++) last = (await call(`/public/score/${"B".repeat(30)}${i}x`, { ip })).status;
    expect(last).toBe(429);
  });
});
