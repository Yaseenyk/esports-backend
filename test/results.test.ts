import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { call, newUser, pngDataUrl, setupEvent, uniq } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

async function world() {
  const o = await setupEvent("Results Cup");
  const ev = o.ev.id;
  const u = uniq();
  const ids = { s1: `${u}s1`, s2: `${u}s2`, f: `${u}f`, tbd: `${u}t` };
  const r = await call(`/events/${ev}/matches`, {
    method: "PUT", token: o.token,
    body: { matches: [
      { id: ids.s1, stage: "knockout", round: 1, slot: 1, a: "Alpha", b: "Beta", nextId: ids.f, nextSide: "a" },
      { id: ids.s2, stage: "knockout", round: 1, slot: 2, a: "Gamma", b: "Delta", nextId: ids.f, nextSide: "b" },
      { id: ids.f, stage: "knockout", round: 2, slot: 1 },
      { id: ids.tbd, stage: "extra", round: 1, slot: 1, a: "Alpha", b: "" },
    ] },
  });
  expect(r.status).toBe(200);
  const editor = await newUser("Ed");
  const viewer = await newUser("Vi");
  const stranger = await newUser("Str");
  expect((await call(`/events/${ev}/members`, { token: o.token, body: { email: editor.email, role: "editor" } })).status).toBe(201);
  expect((await call(`/events/${ev}/members`, { token: o.token, body: { email: viewer.email, role: "viewer" } })).status).toBe(201);
  const all = await call(`/events/${ev}/captain-links`, { token: o.token, body: { all: true } });
  expect(all.status).toBe(201);
  const tok: Record<string, string> = {};
  for (const l of all.json.links) tok[l.team] = l.token;
  return { o, ev, ids, editor, viewer, stranger, tok, all };
}
type W = Awaited<ReturnType<typeof world>>;
const submit = (token: string, mid: string, body: unknown, ip?: string) => call(`/public/report/${token}/matches/${mid}`, { body, ip });
const listSubs = async (w: W, q = "") => (await call(`/events/${w.ev}/result-submissions${q}`, { token: w.o.token })).json;
const match = async (w: W, id: string) => (await call(`/events/${w.ev}/matches`, { token: w.o.token })).json.matches.find((m: any) => m.id === id);

describe("results: captain links", () => {
  it("creates one link per team found in the matches, tokens only once, revocable", async () => {
    const w = await world();
    expect(Object.keys(w.tok).sort()).toEqual(["Alpha", "Beta", "Delta", "Gamma"]);
    expect(w.all.json.skipped).toEqual([]);
    for (const t of Object.values(w.tok)) expect(t.length).toBeGreaterThanOrEqual(20);
    const g = await call(`/events/${w.ev}/captain-links`, { token: w.o.token });
    expect(g.status).toBe(200);
    expect(g.json.links).toHaveLength(4);
    for (const t of Object.values(w.tok)) expect(g.text).not.toContain(t);
    expect(g.json.links[0]).not.toHaveProperty("token");
    // "all" again only fills gaps
    const again = await call(`/events/${w.ev}/captain-links`, { token: w.o.token, body: { all: true } });
    expect(again.json.links).toEqual([]);
    expect(again.json.skipped).toHaveLength(4);
    // one named team gets a fresh link and the old one stops working
    const fresh = await call(`/events/${w.ev}/captain-links`, { token: w.o.token, body: { team: "Alpha" } });
    expect(fresh.status).toBe(201);
    expect((await call(`/public/report/${w.tok.Alpha}`)).status).toBe(404);
    expect((await call(`/public/report/${fresh.json.token}`)).status).toBe(200);
    // revoke
    const id = fresh.json.id as string;
    expect((await call(`/events/${w.ev}/captain-links/${id}`, { method: "DELETE", token: w.o.token })).status).toBe(200);
    expect((await call(`/public/report/${fresh.json.token}`)).status).toBe(404);
    expect((await call(`/events/${w.ev}/captain-links/${id}`, { method: "DELETE", token: w.o.token })).status).toBe(404);
    expect((await call(`/events/${w.ev}/captain-links`, { token: w.o.token, body: {} })).status).toBe(400);
  });

  it("roles: editor yes, viewer reads only, stranger 404", async () => {
    const w = await world();
    expect((await call(`/events/${w.ev}/captain-links`, { token: w.editor.token, body: { team: "Beta" } })).status).toBe(201);
    expect((await call(`/events/${w.ev}/captain-links`, { token: w.viewer.token, body: { team: "Beta" } })).status).toBe(403);
    expect((await call(`/events/${w.ev}/captain-links`, { token: w.viewer.token })).status).toBe(200);
    expect((await call(`/events/${w.ev}/captain-links`, { token: w.stranger.token })).status).toBe(404);
    expect((await call(`/events/${w.ev}/result-submissions`, { token: w.stranger.token })).status).toBe(404);
    expect((await call(`/events/${w.ev}/result-settings`, { method: "PUT", token: w.viewer.token, body: { autoApprove: true } })).status).toBe(403);
  });
});

describe("results: the captain view and submitting", () => {
  it("shows only the team's own matches and leaks nothing else", async () => {
    const w = await world();
    const r = await call(`/public/report/${w.tok.Alpha}`);
    expect(r.status).toBe(200);
    expect(r.json.team).toBe("Alpha");
    expect(r.json.matches.map((m: any) => m.id).sort()).toEqual([w.ids.s1, w.ids.tbd].sort());
    const m1 = r.json.matches.find((m: any) => m.id === w.ids.s1);
    expect(m1).toMatchObject({ opponent: "Beta", side: "a", canReport: true, submission: null });
    expect(r.json.matches.find((m: any) => m.id === w.ids.tbd).canReport).toBe(false);
    for (const t of Object.values(w.tok)) expect(r.text).not.toContain(t);
    for (const secret of ["Asha", "Ravi", "Mira", "signing", "Gamma", "Delta"]) expect(r.text).not.toContain(secret);
    expect((await call(`/public/report/${"x".repeat(30)}`)).status).toBe(404);
    expect((await call(`/public/report/${"x".repeat(80)}`)).status).toBe(404);
  });

  it("only for the captain's own matches", async () => {
    const w = await world();
    expect((await submit(w.tok.Gamma!, w.ids.s1, { scoreA: 1, scoreB: 0 })).status).toBe(404);
    expect((await submit(w.tok.Alpha!, w.ids.s2, { scoreA: 1, scoreB: 0 })).status).toBe(404);
    expect((await submit(w.tok.Alpha!, "nope-match", { scoreA: 1, scoreB: 0 })).status).toBe(404);
    expect((await submit(w.tok.Alpha!, w.ids.tbd, { scoreA: 1, scoreB: 0 })).status).toBe(409); // opponent undecided
    expect((await submit("x".repeat(30), w.ids.s1, { scoreA: 1, scoreB: 0 })).status).toBe(404);
    expect((await listSubs(w)).submissions).toEqual([]);
  });

  it("a new submission replaces the old pending one", async () => {
    const w = await world();
    expect((await submit(w.tok.Alpha!, w.ids.s1, { scoreA: 1, scoreB: 0, note: "first" })).status).toBe(201);
    expect((await submit(w.tok.Alpha!, w.ids.s1, { scoreA: 2, scoreB: 0, note: "second" })).status).toBe(201);
    const l = await listSubs(w, "?status=pending");
    expect(l.submissions).toHaveLength(1);
    expect(l.submissions[0]).toMatchObject({ team: "Alpha", scoreA: 2, scoreB: 0, note: "second", disputed: false, hasProof: false });
    const mine = await call(`/public/report/${w.tok.Alpha}`);
    expect(mine.json.matches.find((m: any) => m.id === w.ids.s1).submission).toMatchObject({ status: "pending", scoreA: 2, scoreB: 0 });
  });

  it("flags a dispute when both teams disagree, and approving one closes the other", async () => {
    const w = await world();
    await submit(w.tok.Alpha!, w.ids.s1, { scoreA: 2, scoreB: 1 });
    const b = await submit(w.tok.Beta!, w.ids.s1, { scoreA: 1, scoreB: 2 });
    expect(b.json).toMatchObject({ status: "pending", disputed: true });
    const l = await listSubs(w, "?status=pending");
    expect(l.submissions).toHaveLength(2);
    for (const s of l.submissions) { expect(s.disputed).toBe(true); expect(s.rivals).toHaveLength(1); expect(s.match).toMatchObject({ a: "Alpha", b: "Beta" }); }
    expect((await call(`/public/report/${w.tok.Alpha}`)).json.matches.find((m: any) => m.id === w.ids.s1).disputed).toBe(true);
    const alpha = l.submissions.find((s: any) => s.team === "Alpha");
    const ap = await call(`/events/${w.ev}/result-submissions/${alpha.id}/approve`, { method: "POST", token: w.o.token, body: {} });
    expect(ap.status).toBe(200);
    const m = await match(w, w.ids.s1);
    expect(m).toMatchObject({ status: "finished", scoreA: 2, scoreB: 1, winner: "a" });
    expect((await match(w, w.ids.f)).a).toBe("Alpha"); // advanced
    const all = (await listSubs(w)).submissions;
    expect(all.find((s: any) => s.team === "Alpha")).toMatchObject({ status: "approved" });
    expect(all.find((s: any) => s.team === "Beta")).toMatchObject({ status: "rejected" });
    expect(all.find((s: any) => s.team === "Beta").rejectReason).toMatch(/different score/);
    expect((await call(`/events/${w.ev}/result-submissions/${alpha.id}/approve`, { method: "POST", token: w.o.token, body: {} })).status).toBe(409);
    // the match is finished now: no more reports
    expect((await submit(w.tok.Beta!, w.ids.s1, { scoreA: 1, scoreB: 2 })).status).toBe(409);
    const stamp = await env.DB.prepare("SELECT updated_by FROM matches WHERE id = ?").bind(w.ids.s1).first<{ updated_by: string }>();
    expect(stamp?.updated_by).toBe("captain:Alpha, approved by organiser");
  });

  it("agreeing claims stay pending by default and are both approved together", async () => {
    const w = await world();
    await submit(w.tok.Gamma!, w.ids.s2, { scoreA: 3, scoreB: 1 });
    const d = await submit(w.tok.Delta!, w.ids.s2, { scoreA: 3, scoreB: 1 });
    expect(d.json).toMatchObject({ status: "pending", disputed: false });
    const l = await listSubs(w, "?status=pending");
    expect(l.submissions.every((s: any) => !s.disputed)).toBe(true);
    const first = l.submissions[0];
    expect((await call(`/events/${w.ev}/result-submissions/${first.id}/approve`, { method: "POST", token: w.editor.token, body: {} })).status).toBe(200);
    expect((await listSubs(w, "?status=approved")).submissions).toHaveLength(2);
    expect((await match(w, w.ids.f)).b).toBe("Gamma");
  });

  it("auto-approve when both captains agree (setting)", async () => {
    const w = await world();
    expect((await call(`/events/${w.ev}/result-settings`, { token: w.o.token })).json).toEqual({ autoApprove: false });
    expect((await call(`/events/${w.ev}/result-settings`, { method: "PUT", token: w.o.token, body: { autoApprove: "yes" } })).status).toBe(400);
    expect((await call(`/events/${w.ev}/result-settings`, { method: "PUT", token: w.o.token, body: { autoApprove: true } })).json).toEqual({ autoApprove: true });
    // a dispute is never auto-approved
    await submit(w.tok.Alpha!, w.ids.s1, { scoreA: 1, scoreB: 0 });
    expect((await submit(w.tok.Beta!, w.ids.s1, { scoreA: 0, scoreB: 1 })).json).toMatchObject({ status: "pending", disputed: true });
    expect((await match(w, w.ids.s1)).status).toBe("scheduled");
    // agreement is
    await submit(w.tok.Gamma!, w.ids.s2, { scoreA: 0, scoreB: 2 });
    const r = await submit(w.tok.Delta!, w.ids.s2, { scoreA: 0, scoreB: 2 });
    expect(r.json).toMatchObject({ status: "approved", disputed: false });
    expect(await match(w, w.ids.s2)).toMatchObject({ status: "finished", winner: "b" });
    expect((await match(w, w.ids.f)).b).toBe("Delta");
    expect((await listSubs(w, "?status=approved")).submissions.map((s: any) => s.decidedBy)).toEqual(["auto", "auto"]);
  });

  it("reject keeps the reason, drops the proof, and lets the captain send again", async () => {
    const w = await world();
    await submit(w.tok.Alpha!, w.ids.s1, { scoreA: 5, scoreB: 0, proof: pngDataUrl(80) });
    const s = (await listSubs(w, "?status=pending")).submissions[0];
    expect(s.hasProof).toBe(true);
    expect((await call(`/events/${w.ev}${s.proofUrl.replace(`/events/${w.ev}`, "")}`, { token: w.o.token })).status).toBe(200);
    expect((await call(`/events/${w.ev}/result-submissions/${s.id}/reject`, { method: "POST", token: w.viewer.token, body: {} })).status).toBe(403);
    const rj = await call(`/events/${w.ev}/result-submissions/${s.id}/reject`, { method: "POST", token: w.o.token, body: { reason: "The screenshot is blurry" } });
    expect(rj.status).toBe(200);
    expect((await call(`/events/${w.ev}/result-submissions/${s.id}/reject`, { method: "POST", token: w.o.token, body: {} })).status).toBe(409);
    expect((await call(`/events/${w.ev}/result-submissions/${s.id}/proof`, { token: w.o.token })).status).toBe(404);
    expect((await match(w, w.ids.s1)).status).toBe("scheduled");
    const view = (await call(`/public/report/${w.tok.Alpha}`)).json.matches.find((m: any) => m.id === w.ids.s1);
    expect(view.submission).toMatchObject({ status: "rejected", rejectReason: "The screenshot is blurry" });
    expect((await submit(w.tok.Alpha!, w.ids.s1, { scoreA: 5, scoreB: 1 })).status).toBe(201);
    expect((await listSubs(w, "?status=pending")).submissions).toHaveLength(1);
  });
});

describe("results: proof and input limits", () => {
  it("checks scores, note, proof size, type and signature; proof is served to staff only", async () => {
    const w = await world();
    const t = w.tok.Alpha!;
    const s1 = w.ids.s1;
    for (const bad of [{}, { scoreA: -1, scoreB: 0 }, { scoreA: 1.5, scoreB: 0 }, { scoreA: "3", scoreB: 0 }, { scoreA: 1000, scoreB: 0 }, { scoreA: 1 }]) {
      expect((await submit(t, s1, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await submit(t, s1, { scoreA: 1, scoreB: 0, note: "n".repeat(201) })).status).toBe(400);
    expect((await submit(t, s1, { scoreA: 1, scoreB: 0, proof: "data:image/png;base64," + "A".repeat(200_001) })).status).toBe(413);
    expect((await submit(t, s1, { scoreA: 1, scoreB: 0, proof: "data:image/png;base64," + "A".repeat(300_000) })).status).toBe(413);
    expect((await submit(t, s1, { scoreA: 1, scoreB: 0, proof: "data:image/gif;base64,R0lGODlh" })).status).toBe(415);
    expect((await submit(t, s1, { scoreA: 1, scoreB: 0, proof: "data:text/html;base64,PGI+aGk8L2I+" })).status).toBe(415);
    expect((await submit(t, s1, { scoreA: 1, scoreB: 0, proof: "data:image/png;base64,AAAAAAAAAAAA" })).status).toBe(415); // not a png inside
    expect((await submit(t, s1, { scoreA: 1, scoreB: 0, proof: 12 })).status).toBe(400);
    expect((await call(`/public/report/${t}/matches/${s1}`, { raw: "not json", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await listSubs(w)).submissions).toEqual([]);
    const ok = await submit(t, s1, { scoreA: 1, scoreB: 0, note: "gg", proof: pngDataUrl(100) });
    expect(ok.status).toBe(201);
    const s = (await listSubs(w)).submissions[0];
    expect(JSON.stringify(s)).not.toContain("base64");
    const img = await call(`/events/${w.ev}/result-submissions/${s.id}/proof`, { token: w.editor.token });
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(img.bytes.length).toBe(100);
    expect((await call(`/events/${w.ev}/result-submissions/${s.id}/proof`, { token: w.viewer.token })).status).toBe(403);
    expect((await call(`/events/${w.ev}/result-submissions/${s.id}/proof`, { token: w.stranger.token })).status).toBe(404);
    expect((await call(`/events/${w.ev}/result-submissions/${s.id}/proof`)).status).toBe(401);
    // the captain's own view only says a proof exists
    expect((await call(`/public/report/${t}`)).text).not.toContain("base64");
  });
});

describe("results: rate limits", () => {
  it("throttles submissions per token and address, and guessing of tokens", async () => {
    const w = await world();
    const ip = "10.201.1.1";
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await submit(w.tok.Alpha!, w.ids.s1, { scoreA: -1, scoreB: 0 }, ip)).status;
    expect(last).toBe(429);
    // another address is not affected by that bucket
    expect((await submit(w.tok.Alpha!, w.ids.s1, { scoreA: 1, scoreB: 0 }, "10.201.1.2")).status).toBe(201);
    const ip2 = "10.201.2.2";
    let g = 0;
    for (let i = 0; i < 21; i++) g = (await call(`/public/report/${"g".repeat(20)}${i}`, { ip: ip2 })).status;
    expect(g).toBe(429);
  });
});
