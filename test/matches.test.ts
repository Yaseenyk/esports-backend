import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { call, freshIp, newUser, setupEvent } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

// Match ids are global primary keys, so tests that reuse readable ids start from an empty table (tests in a file run one after another).
async function world() {
  await env.DB.prepare("DELETE FROM matches").run();
  const o = await setupEvent("Match Cup");
  const editor = await newUser("Ed");
  const viewer = await newUser("Vi");
  const stranger = await newUser("Str");
  expect((await call(`/events/${o.ev.id}/members`, { token: o.token, body: { email: editor.email, role: "editor" } })).status).toBe(201);
  expect((await call(`/events/${o.ev.id}/members`, { token: o.token, body: { email: viewer.email, role: "viewer" } })).status).toBe(201);
  return { o, id: o.ev.id, editor, viewer, stranger };
}
const put = (id: string, token: string, body: unknown) => call(`/events/${id}/matches`, { method: "PUT", token, body });
const list = async (id: string, token: string) => (await call(`/events/${id}/matches`, { token })).json.matches as any[];
const result = (id: string, token: string, mid: string, body: unknown) => call(`/events/${id}/matches/${mid}/result`, { method: "POST", token, body });

/** 4 teams: semis s1, s2 feed final f. */
async function bracket(w: Awaited<ReturnType<typeof world>>) {
  const r = await put(w.id, w.o.token, {
    matches: [
      { id: "s1", stage: "knockout", round: 1, slot: 1, a: "Alpha", b: "Beta", nextId: "f", nextSide: "a" },
      { id: "s2", stage: "knockout", round: 1, slot: 2, a: "Gamma", b: "Delta", nextId: "f", nextSide: "b" },
      { id: "f", stage: "knockout", round: 2, slot: 1 },
    ],
  });
  expect(r.status).toBe(200);
  return r;
}
const byId = (ms: any[], id: string) => ms.find((m) => m.id === id);

describe("matches: roles", () => {
  it("owner and editor read and write; viewer reads only; stranger 404; anonymous 401", async () => {
    const w = await world();
    const a = await put(w.id, w.o.token, { matches: [{ a: "Alpha", b: "Beta" }] });
    expect(a.status).toBe(200);
    const m = a.json.matches[0];
    expect(Object.keys(m).sort()).toEqual(["a", "b", "id", "nextId", "nextSide", "round", "scoreA", "scoreB", "slot", "stage", "startsAt", "status", "updatedAt", "winner"]);
    expect(m).toMatchObject({ stage: "main", round: 1, slot: 1, status: "scheduled", scoreA: null, winner: null, nextId: null });
    expect((await put(w.id, w.editor.token, { matches: [{ id: m.id, a: "Alpha 2" }] })).status).toBe(200);
    const g = await call(`/events/${w.id}/matches`, { token: w.viewer.token });
    expect(g.status).toBe(200);
    expect(g.json.matches[0].a).toBe("Alpha 2");
    expect(g.json.br).toEqual([]);
    expect((await put(w.id, w.viewer.token, { matches: [] })).status).toBe(403);
    expect((await result(w.id, w.viewer.token, m.id, { scoreA: 1, scoreB: 0 })).status).toBe(403);
    expect((await call(`/events/${w.id}/matches`, { method: "DELETE", token: w.viewer.token })).status).toBe(403);
    expect((await call(`/events/${w.id}/br-results`, { method: "PUT", token: w.viewer.token, body: { results: [] } })).status).toBe(403);
    expect((await call(`/events/${w.id}/br-results`, { token: w.viewer.token })).status).toBe(200);
    for (const [method, path] of [["GET", "matches"], ["PUT", "matches"], ["DELETE", "matches"], ["GET", "br-results"], ["PUT", "br-results"]] as const) {
      expect((await call(`/events/${w.id}/${path}`, { method, token: w.stranger.token, body: method === "PUT" ? {} : undefined })).status, `${method} ${path}`).toBe(404);
      expect((await call(`/events/${w.id}/${path}`, { method, body: method === "PUT" ? {} : undefined })).status).toBe(401);
    }
    expect((await result(w.id, w.stranger.token, m.id, { scoreA: 1, scoreB: 0 })).status).toBe(404);
    expect((await call(`/events/${w.id}/matches/${m.id}/result`, { method: "POST", body: {} })).status).toBe(401);
  });

  it("match ids cannot be hijacked across events", async () => {
    const w1 = await world();
    const w2 = await world();
    await put(w1.id, w1.o.token, { matches: [{ id: "shared1", a: "Mine" }] });
    const r = await put(w2.id, w2.o.token, { matches: [{ id: "shared1", a: "Theirs" }] });
    expect(r.status).toBe(409);
    expect((await list(w1.id, w1.o.token))[0].a).toBe("Mine");
    expect(await list(w2.id, w2.o.token)).toEqual([]);
    expect((await result(w2.id, w2.o.token, "shared1", { scoreA: 1, scoreB: 0 })).status).toBe(404);
  });
});

describe("matches: validation", () => {
  it("rejects bad shapes with 400 and changes nothing", async () => {
    const w = await world();
    const bads: unknown[] = [
      { matches: "x" }, {}, { matches: [1] }, { matches: [[]] },
      { matches: [{ stage: "x".repeat(41) }] }, { matches: [{ stage: "" }] }, { matches: [{ a: "x".repeat(61) }] }, { matches: [{ a: 5 }] },
      { matches: [{ round: 0 }] }, { matches: [{ round: 1.5 }] }, { matches: [{ slot: 1000 }] }, { matches: [{ round: "1" }] },
      { matches: [{ status: "done" }] }, { matches: [{ scoreA: -1 }] }, { matches: [{ scoreA: "3" }] }, { matches: [{ winner: "c" }] },
      { matches: [{ startsAt: "tomorrow" }] }, { matches: [{ id: "bad id!" }] }, { matches: [{ id: "x".repeat(49) }] },
      { matches: [{ id: "dup" }, { id: "dup" }] },
      { matches: [{ id: "n1", nextId: "n1", nextSide: "a" }] }, { matches: [{ id: "n2", nextId: "missing", nextSide: "a" }] },
      { matches: [{ id: "n3", nextId: "n4" }, { id: "n4" }] }, { matches: [{ id: "n5", nextSide: "a" }] }, { matches: [{ id: "n6", nextId: "n7", nextSide: "c" }, { id: "n7" }] },
      { matches: [{ id: "l1", nextId: "l2", nextSide: "a" }, { id: "l2", nextId: "l1", nextSide: "a" }] },
      { matches: [{ id: "fin", status: "finished" }] }, { matches: [{ id: "ff", status: "forfeit" }] }, { matches: [{ id: "fw", status: "finished", scoreA: 1, scoreB: 0, winner: "b" }] },
      { matches: [], replaceStage: 5 },
    ];
    for (const b of bads) {
      const r = await put(w.id, w.o.token, b);
      expect(r.status, JSON.stringify(b)).toBe(400);
      expect(r.json.error).toBeTruthy();
    }
    expect(await list(w.id, w.o.token)).toEqual([]);
    expect((await call(`/events/${w.id}/matches`, { method: "PUT", token: w.o.token, raw: "{nope", headers: { "content-type": "application/json" } })).status).toBe(400);
  });

  it("trims strings, keeps untouched fields on update, and stores injection text as plain text", async () => {
    const w = await world();
    const evil = `x'); DROP TABLE matches;--`;
    const a = await put(w.id, w.o.token, { matches: [{ id: "m1", stage: "  group:A ", a: `  ${evil}  `, b: "B", startsAt: "2026-12-01T10:00:00Z" }] });
    expect(a.json.matches[0]).toMatchObject({ stage: "group:A", a: evil, startsAt: "2026-12-01T10:00:00Z" });
    const b = await put(w.id, w.o.token, { matches: [{ id: "m1", b: "C" }] });
    expect(b.json.matches[0]).toMatchObject({ a: evil, b: "C", stage: "group:A" });
    expect(b.json.matches.length).toBe(1);
    const clr = await put(w.id, w.o.token, { matches: [{ id: "m1", startsAt: null }] });
    expect(clr.json.matches[0].startsAt).toBeNull();
  });

  it("allows at most 512 matches per event", async () => {
    const w = await world();
    const many = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, slot: (i % 999) + 1 }));
    expect((await put(w.id, w.o.token, { matches: many(513, "a") })).status).toBe(400);
    expect((await put(w.id, w.o.token, { matches: many(512, "a") })).status).toBe(200);
    expect((await list(w.id, w.o.token)).length).toBe(512);
    expect((await put(w.id, w.o.token, { matches: [{ id: "extra" }] })).status).toBe(400);
    expect((await put(w.id, w.o.token, { matches: [{ id: "a0", a: "still ok" }] })).status).toBe(200); // updating an existing one is fine at the cap
    // replacing a stage frees room
    const r = await put(w.id, w.o.token, { matches: [{ id: "z1", stage: "other" }], replaceStage: "main" });
    expect(r.status).toBe(200);
    expect(r.json.matches.map((m: any) => m.id)).toEqual(["z1"]);
  });

  it("replaceStage replaces only that stage; DELETE removes a stage or everything", async () => {
    const w = await world();
    await put(w.id, w.o.token, { matches: [{ id: "g1", stage: "group:A" }, { id: "g2", stage: "group:A" }, { id: "k1", stage: "knockout" }] });
    const r = await put(w.id, w.o.token, { matches: [{ id: "g9", stage: "group:A", a: "New" }], replaceStage: "group:A" });
    expect(r.json.matches.map((m: any) => m.id).sort()).toEqual(["g9", "k1"]);
    const d1 = await call(`/events/${w.id}/matches?stage=knockout`, { method: "DELETE", token: w.editor.token });
    expect(d1.json).toEqual({ ok: true, deleted: 1 });
    expect((await list(w.id, w.o.token)).map((m) => m.id)).toEqual(["g9"]);
    expect((await call(`/events/${w.id}/matches?stage=`, { method: "DELETE", token: w.o.token })).status).toBe(400);
    expect((await call(`/events/${w.id}/matches`, { method: "DELETE", token: w.o.token })).json.deleted).toBe(1);
    expect(await list(w.id, w.o.token)).toEqual([]);
  });

  it("PUT is rate limited per user", async () => {
    const w = await world();
    let last = 0;
    for (let i = 0; i < 121; i++) last = (await put(w.id, w.o.token, { matches: [] })).status;
    expect(last).toBe(429);
  });
});

describe("matches: results and advancement", () => {
  it("advances winners through three rounds", async () => {
    const w = await world();
    await put(w.id, w.o.token, {
      matches: [
        { id: "q1", stage: "ko", round: 1, slot: 1, a: "A", b: "B", nextId: "s1", nextSide: "a" },
        { id: "q2", stage: "ko", round: 1, slot: 2, a: "C", b: "D", nextId: "s1", nextSide: "b" },
        { id: "q3", stage: "ko", round: 1, slot: 3, a: "E", b: "F", nextId: "s2", nextSide: "a" },
        { id: "q4", stage: "ko", round: 1, slot: 4, a: "G", b: "H", nextId: "s2", nextSide: "b" },
        { id: "s1", stage: "ko", round: 2, slot: 1, nextId: "fin", nextSide: "a" },
        { id: "s2", stage: "ko", round: 2, slot: 2, nextId: "fin", nextSide: "b" },
        { id: "fin", stage: "ko", round: 3, slot: 1 },
      ],
    });
    const r1 = await result(w.id, w.o.token, "q1", { scoreA: 2, scoreB: 1 });
    expect(r1.status).toBe(200);
    expect(r1.json.match).toMatchObject({ id: "q1", status: "finished", winner: "a", scoreA: 2, scoreB: 1 });
    expect(r1.json.changed.map((m: any) => m.id)).toEqual(["s1"]);
    for (const [id, sa, sb] of [["q2", 0, 3], ["q3", 5, 0], ["q4", 1, 2]] as const) expect((await result(w.id, w.o.token, id, { scoreA: sa, scoreB: sb })).status).toBe(200);
    let ms = await list(w.id, w.o.token);
    expect(byId(ms, "s1")).toMatchObject({ a: "A", b: "D", status: "scheduled" });
    expect(byId(ms, "s2")).toMatchObject({ a: "E", b: "H" });
    expect((await result(w.id, w.editor.token, "s1", { scoreA: 3, scoreB: 0 })).status).toBe(200);
    expect((await result(w.id, w.o.token, "s2", { scoreA: 0, scoreB: 1 })).status).toBe(200);
    ms = await list(w.id, w.o.token);
    expect(byId(ms, "fin")).toMatchObject({ a: "A", b: "H", status: "scheduled" });
    const fin = await result(w.id, w.o.token, "fin", { scoreA: 4, scoreB: 2 });
    expect(fin.json.match.winner).toBe("a");
    expect(fin.json.changed).toEqual([]);
  });

  it("is idempotent: the same result again changes nothing downstream", async () => {
    const w = await world();
    await bracket(w);
    await result(w.id, w.o.token, "s1", { scoreA: 1, scoreB: 0 });
    await result(w.id, w.o.token, "s2", { scoreA: 1, scoreB: 0 });
    await result(w.id, w.o.token, "f", { scoreA: 2, scoreB: 1 });
    const again = await result(w.id, w.o.token, "s1", { scoreA: 1, scoreB: 0 });
    expect(again.json.changed).toEqual([]);
    const ms = await list(w.id, w.o.token);
    expect(byId(ms, "f")).toMatchObject({ a: "Alpha", b: "Gamma", status: "finished", scoreA: 2, scoreB: 1, winner: "a" });
  });

  it("changing a result re-advances and clears downstream results that depended on it", async () => {
    const w = await world();
    await put(w.id, w.o.token, {
      matches: [
        { id: "a1", stage: "k", round: 1, slot: 1, a: "A", b: "B", nextId: "b1", nextSide: "a" },
        { id: "a2", stage: "k", round: 1, slot: 2, a: "C", b: "D", nextId: "b1", nextSide: "b" },
        { id: "b1", stage: "k", round: 2, slot: 1, nextId: "c1", nextSide: "a" },
        { id: "c1", stage: "k", round: 3, slot: 1 },
      ],
    });
    await result(w.id, w.o.token, "a1", { scoreA: 1, scoreB: 0 }); // A
    await result(w.id, w.o.token, "a2", { scoreA: 1, scoreB: 0 }); // C
    await result(w.id, w.o.token, "b1", { scoreA: 3, scoreB: 1 }); // A advances to c1
    expect(byId(await list(w.id, w.o.token), "c1").a).toBe("A");
    // the referee corrects a1: B won
    const fix = await result(w.id, w.o.token, "a1", { scoreA: 0, scoreB: 2 });
    expect(fix.json.match.winner).toBe("b");
    expect(fix.json.changed.map((m: any) => m.id).sort()).toEqual(["b1", "c1"]);
    const ms = await list(w.id, w.o.token);
    expect(byId(ms, "b1")).toMatchObject({ a: "B", b: "C", status: "scheduled", scoreA: null, scoreB: null, winner: null });
    expect(byId(ms, "c1")).toMatchObject({ a: "", status: "scheduled" });
    // a1 itself is kept, and the other side is untouched
    expect(byId(ms, "a1")).toMatchObject({ status: "finished", winner: "b" });
    expect(byId(ms, "a2")).toMatchObject({ status: "finished", winner: "a" });
  });

  it("draws are stored and do not advance anyone (and empty the slot if a winner was there)", async () => {
    const w = await world();
    await bracket(w);
    await result(w.id, w.o.token, "s1", { scoreA: 2, scoreB: 1 });
    expect(byId(await list(w.id, w.o.token), "f").a).toBe("Alpha");
    const d = await result(w.id, w.o.token, "s1", { scoreA: 1, scoreB: 1 });
    expect(d.json.match).toMatchObject({ status: "finished", winner: "draw" });
    expect(byId(await list(w.id, w.o.token), "f").a).toBe("");
    // a league draw with no next match
    await put(w.id, w.o.token, { matches: [{ id: "lg", stage: "league", a: "X", b: "Y" }] });
    expect((await result(w.id, w.o.token, "lg", { scoreA: 0, scoreB: 0 })).json.match.winner).toBe("draw");
  });

  it("forfeits need an explicit winner, scores are optional, and the winner advances", async () => {
    const w = await world();
    await bracket(w);
    expect((await result(w.id, w.o.token, "s1", { status: "forfeit" })).status).toBe(400);
    expect((await result(w.id, w.o.token, "s1", { status: "forfeit", winner: "draw" })).status).toBe(400);
    const r = await result(w.id, w.o.token, "s1", { status: "forfeit", winner: "b" });
    expect(r.status).toBe(200);
    expect(r.json.match).toMatchObject({ status: "forfeit", winner: "b", scoreA: null, scoreB: null });
    expect(byId(await list(w.id, w.o.token), "f").a).toBe("Beta");
    const r2 = await result(w.id, w.o.token, "s2", { status: "forfeit", winner: "a", scoreA: 3, scoreB: 0 });
    expect(r2.json.match).toMatchObject({ winner: "a", scoreA: 3, scoreB: 0 });
  });

  it("validates result input and unknown matches", async () => {
    const w = await world();
    await bracket(w);
    for (const b of [{}, { scoreA: 1 }, { scoreA: -1, scoreB: 0 }, { scoreA: 1.5, scoreB: 0 }, { scoreA: "1", scoreB: 0 }, { scoreA: 1, scoreB: 0, status: "live" }, { scoreA: 1, scoreB: 0, winner: "b" }, { scoreA: 1, scoreB: 0, winner: "draw" }, { scoreA: 100001, scoreB: 0 }]) {
      expect((await result(w.id, w.o.token, "s1", b)).status, JSON.stringify(b)).toBe(400);
    }
    expect((await result(w.id, w.o.token, "ghost", { scoreA: 1, scoreB: 0 })).status).toBe(404);
    expect((await result(w.id, w.o.token, "bad id!", { scoreA: 1, scoreB: 0 })).status).toBe(400);
    expect(byId(await list(w.id, w.o.token), "s1").status).toBe("scheduled");
  });

  it("a PUT that sets a status away from finished clears the winner", async () => {
    const w = await world();
    await put(w.id, w.o.token, { matches: [{ id: "x1", a: "A", b: "B" }] });
    await result(w.id, w.o.token, "x1", { scoreA: 1, scoreB: 0 });
    const r = await put(w.id, w.o.token, { matches: [{ id: "x1", status: "live" }] });
    expect(r.json.matches[0]).toMatchObject({ status: "live", winner: null });
  });
});

describe("battle royale results", () => {
  it("upserts by (match, team), replaces on request, validates and caps", async () => {
    const w = await world();
    const url = `/events/${w.id}/br-results`;
    const put2 = (token: string, body: unknown) => call(url, { method: "PUT", token, body });
    const a = await put2(w.o.token, { results: [{ matchNo: 1, team: "Alpha", placement: 2, kills: 5 }, { matchNo: 1, team: "Beta", placement: 1, kills: 9 }, { matchNo: 2, team: "Alpha", placement: 1 }] });
    expect(a.status).toBe(200);
    expect(a.json.results).toEqual([
      { matchNo: 1, team: "Beta", placement: 1, kills: 9 },
      { matchNo: 1, team: "Alpha", placement: 2, kills: 5 },
      { matchNo: 2, team: "Alpha", placement: 1, kills: 0 },
    ]);
    const b = await put2(w.editor.token, { results: [{ matchNo: 1, team: "Alpha", placement: 1, kills: 12 }] });
    expect(b.json.results.length).toBe(3);
    expect(b.json.results.find((r: any) => r.matchNo === 1 && r.team === "Alpha")).toMatchObject({ placement: 1, kills: 12 });
    expect((await call(`/events/${w.id}/matches`, { token: w.viewer.token })).json.br.length).toBe(3);
    const c = await put2(w.o.token, { results: [{ matchNo: 3, team: "Gamma", placement: 1 }], replace: true });
    expect(c.json.results).toEqual([{ matchNo: 3, team: "Gamma", placement: 1, kills: 0 }]);
    for (const bad of [{}, { results: "x" }, { results: [1] }, { results: [{ matchNo: 0, team: "A", placement: 1 }] }, { results: [{ matchNo: 1, team: "", placement: 1 }] }, { results: [{ matchNo: 1, team: "A", placement: 0 }] }, { results: [{ matchNo: 1, team: "A", placement: 1, kills: -1 }] }, { results: [{ matchNo: 1, team: "x".repeat(61), placement: 1 }] }, { results: [], replace: "yes" }]) {
      expect((await put2(w.o.token, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const many = Array.from({ length: 4001 }, (_, i) => ({ matchNo: (i % 9999) + 1, team: `T${i}`, placement: 1 }));
    expect((await put2(w.o.token, { results: many })).status).toBe(400);
    expect((await call(url, { token: w.o.token })).json.results.length).toBe(1);
  });
});

describe("public live page includes matches", () => {
  async function published(w: Awaited<ReturnType<typeof world>>, publish: boolean) {
    const r = await call(`/events/${w.id}/live`, { method: "PUT", token: w.o.token, body: { published: publish, snapshot: { views: [], announcements: [], sponsors: [], ticker: [] } } });
    return r.json.slug as string;
  }

  it("only when published and only when the event has matches; public subset only; ETag follows matches", async () => {
    const w = await world();
    const slug = await published(w, true);
    const none = await call(`/public/live/${slug}`);
    expect(none.status).toBe(200);
    expect(none.json.matches).toBeUndefined();
    expect(Object.keys(none.json).sort()).toEqual(["event", "snapshot", "updatedAt"]);
    await put(w.id, w.o.token, { matches: [{ id: "p1", stage: "group:A", round: 1, slot: 1, a: "Alpha", b: "Beta", startsAt: "2026-12-01T10:00:00Z", nextId: "p2", nextSide: "a" }, { id: "p2", stage: "knockout" }] });
    const a = await call(`/public/live/${slug}`);
    expect(a.json.matches.length).toBe(2);
    expect(Object.keys(a.json.matches[0]).sort()).toEqual(["a", "b", "id", "round", "scoreA", "scoreB", "slot", "stage", "startsAt", "status"]);
    expect(a.text).not.toContain("nextId");
    expect(a.text).not.toContain(w.o.id);
    const etag = a.headers.get("etag")!;
    expect((await call(`/public/live/${slug}`, { headers: { "if-none-match": etag } })).status).toBe(304);
    await result(w.id, w.o.token, "p1", { scoreA: 2, scoreB: 0 });
    const b = await call(`/public/live/${slug}`, { headers: { "if-none-match": etag } });
    expect(b.status).toBe(200);
    expect(b.headers.get("etag")).not.toBe(etag);
    expect(b.json.matches.find((m: any) => m.id === "p1")).toMatchObject({ status: "finished", scoreA: 2, scoreB: 0 });
    expect(b.json.matches.find((m: any) => m.id === "p2").a).toBe("Alpha");
    // unpublished: nothing at all
    await published(w, false);
    expect((await call(`/public/live/${slug}`)).status).toBe(404);
  });

  it("matches of one event never appear on another event's page", async () => {
    const w1 = await world();
    const w2 = await world();
    const s2 = await published(w2, true);
    await put(w1.id, w1.o.token, { matches: [{ a: "Only mine" }] });
    expect((await call(`/public/live/${s2}`)).text).not.toContain("Only mine");
  });
});

describe("cascade", () => {
  it("deleting the event removes its matches and battle royale rows", async () => {
    const w = await world();
    await put(w.id, w.o.token, { matches: [{ id: "c1" }] });
    await call(`/events/${w.id}/br-results`, { method: "PUT", token: w.o.token, body: { results: [{ matchNo: 1, team: "A", placement: 1 }] } });
    expect((await call(`/events/${w.id}`, { method: "DELETE", token: w.o.token })).status).toBe(200);
    const n = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM matches WHERE event_id = ?1) AS m, (SELECT COUNT(*) FROM br_results WHERE event_id = ?1) AS b").bind(w.id).first<{ m: number; b: number }>();
    expect(n).toEqual({ m: 0, b: 0 });
    void freshIp;
  });
});
