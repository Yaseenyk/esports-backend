import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { call, newUser, setupEvent } from "./helpers";
import { createCaptainLink } from "../src/captains";
import { graceDeadline, inReadyWindow } from "../src/features/ready";

vi.setConfig({ testTimeout: 120_000 });

const iso = (min: number) => new Date(Date.now() + min * 60_000).toISOString();

async function world(startMin: number | null = 30) {
  const o = await setupEvent("Ready Cup");
  const editor = await newUser("Ed");
  const viewer = await newUser("Vi");
  const stranger = await newUser("Str");
  await call(`/events/${o.ev.id}/members`, { token: o.token, body: { email: editor.email, role: "editor" } });
  await call(`/events/${o.ev.id}/members`, { token: o.token, body: { email: viewer.email, role: "viewer" } });
  const put = await call(`/events/${o.ev.id}/matches`, { method: "PUT", token: o.token, body: { matches: [
    { id: `rdy-${o.ev.id.slice(0, 12)}`, a: "Alpha Wolves", b: "Beta Hawks", startsAt: startMin === null ? null : iso(startMin) },
  ] } });
  const mid = put.json.matches[0].id as string;
  const alpha = await createCaptainLink(env, o.ev.id, "Alpha Wolves");
  const beta = await createCaptainLink(env, o.ev.id, "beta  hawks");
  return { o, id: o.ev.id, editor, viewer, stranger, mid, alpha: alpha.token, beta: beta.token };
}
type W = Awaited<ReturnType<typeof world>>;
const mark = (token: string, mid: string, ready: unknown) => call(`/public/ready/${token}/matches/${mid}`, { body: { ready } });
const board = (id: string, token: string) => call(`/events/${id}/ready`, { token });
const status = async (w: W) => (await call(`/events/${w.id}/matches`, { token: w.o.token })).json.matches.find((m: any) => m.id === w.mid).status;

describe("ready: pure helpers", () => {
  it("deadline and window", () => {
    expect(graceDeadline(null, 10)).toBeNull();
    expect(graceDeadline("2026-12-01T10:00:00Z", 10)).toBe(Date.parse("2026-12-01T10:10:00Z"));
    const now = Date.parse("2026-12-01T10:00:00Z");
    expect(inReadyWindow({ status: "scheduled", startsAt: "2026-12-01T10:59:00Z" }, now)).toBe(true);
    expect(inReadyWindow({ status: "scheduled", startsAt: "2026-12-01T11:01:00Z" }, now)).toBe(false);
    expect(inReadyWindow({ status: "live", startsAt: "2026-12-01T10:00:00Z" }, now)).toBe(false);
    expect(inReadyWindow({ status: "scheduled", startsAt: null }, now)).toBe(false);
  });
});

describe("ready: organiser routes", () => {
  it("roles, settings and board", async () => {
    const w = await world();
    expect((await board(w.id, w.viewer.token)).status).toBe(403);
    expect((await board(w.id, w.stranger.token)).status).toBe(404);
    expect((await call(`/events/${w.id}/ready`)).status).toBe(401);
    const b = await board(w.id, w.editor.token);
    expect(b.status).toBe(200);
    expect(b.json.settings.graceMinutes).toBe(10);
    expect(b.json.matches[0]).toMatchObject({ a: "Alpha Wolves", aReady: false, bReady: false, late: [] });
    const set = (token: string, body: unknown) => call(`/events/${w.id}/ready/settings`, { method: "PUT", token, body });
    expect((await set(w.viewer.token, { graceMinutes: 5 })).status).toBe(403);
    expect((await set(w.o.token, { graceMinutes: 500 })).status).toBe(400);
    expect((await set(w.o.token, { graceMinutes: 1.5 })).status).toBe(400);
    expect((await set(w.o.token, { graceMinutes: 5 })).status).toBe(200);
    expect((await board(w.id, w.o.token)).json.settings.graceMinutes).toBe(5);
  });

  it("late teams show once the grace deadline has passed", async () => {
    const w = await world(-30);
    const b = await board(w.id, w.o.token);
    expect(b.json.matches[0].late).toEqual(["a", "b"]);
    expect(b.json.matches[0].graceDeadline).toBeTruthy();
  });
});

describe("ready: captain routes", () => {
  it("rejects bad tokens and shows only own matches", async () => {
    const w = await world();
    expect((await call("/public/ready/short")).status).toBe(404);
    expect((await call(`/public/ready/${"x".repeat(30)}`)).status).toBe(404);
    const g = await call(`/public/ready/${w.alpha}`);
    expect(g.status).toBe(200);
    expect(g.json.team).toBe("Alpha Wolves");
    expect(g.json.matches).toHaveLength(1);
    expect(g.json.matches[0]).toMatchObject({ opponent: "Beta Hawks", youReady: false, opponentReady: false, canMark: true });
    expect(Object.keys(g.json.matches[0]).sort()).toEqual(["canMark", "id", "minutesToGrace", "opponent", "opponentReady", "round", "stage", "startsAt", "status", "youReady"]);
    const other = await createCaptainLink(env, w.id, "Gamma");
    expect((await call(`/public/ready/${other.token}`)).json.matches).toEqual([]);
    expect((await mark(other.token, w.mid, true)).status).toBe(404);
  });

  it("both ready moves the match to ready; un-ready moves it back", async () => {
    const w = await world();
    const a = await mark(w.alpha, w.mid, true);
    expect(a.json).toMatchObject({ youReady: true, opponentReady: false, status: "scheduled" });
    expect((await call(`/public/ready/${w.beta}`)).json.matches[0].opponentReady).toBe(true);
    const b = await mark(w.beta, w.mid, true);
    expect(b.json).toMatchObject({ youReady: true, opponentReady: true, status: "ready" });
    expect(await status(w)).toBe("ready");
    expect((await mark(w.alpha, w.mid, true)).status).toBe(200); // idempotent
    expect((await mark(w.alpha, w.mid, false)).json.status).toBe("scheduled");
    expect(await status(w)).toBe("scheduled");
    expect((await mark(w.alpha, w.mid, "yes")).status).toBe(400);
  });

  it("window: too early, live and no start time are refused", async () => {
    const early = await world(120);
    expect((await mark(early.alpha, early.mid, true)).status).toBe(409);
    expect((await call(`/public/ready/${early.alpha}`)).json.matches[0].canMark).toBe(false);
    const live = await world(5);
    await call(`/events/${live.id}/matches`, { method: "PUT", token: live.o.token, body: { matches: [{ id: live.mid, status: "live" }] } });
    expect((await mark(live.alpha, live.mid, true)).status).toBe(409);
    const none = await world(null);
    expect((await mark(none.alpha, none.mid, true)).status).toBe(409);
    expect((await call(`/public/ready/${none.alpha}`)).json.matches).toEqual([]);
  });

  it("a replaced link stops working", async () => {
    const w = await world();
    await createCaptainLink(env, w.id, "Alpha Wolves");
    expect((await call(`/public/ready/${w.alpha}`)).status).toBe(404);
  });
});

describe("ready: forfeit and clear", () => {
  it("needs the opponent present or the no-show flag, and is never automatic", async () => {
    const w = await world(-30);
    const forfeit = (token: string, body: unknown) => call(`/events/${w.id}/ready/${w.mid}/forfeit`, { token, body });
    expect((await forfeit(w.viewer.token, { team: "Alpha Wolves" })).status).toBe(403);
    expect((await forfeit(w.stranger.token, { team: "Alpha Wolves" })).status).toBe(404);
    expect(await status(w)).toBe("scheduled"); // lateness alone changes nothing
    expect((await forfeit(w.o.token, { team: "Nobody" })).status).toBe(400);
    expect((await forfeit(w.o.token, { team: "Alpha Wolves" })).status).toBe(409);
    expect((await mark(w.beta, w.mid, true)).status).toBe(200);
    const r = await forfeit(w.editor.token, { team: "alpha wolves" });
    expect(r.status).toBe(200);
    expect(r.json.match).toMatchObject({ status: "forfeit", winner: "b" });
    expect((await forfeit(w.o.token, { team: "Alpha Wolves", noShow: true })).status).toBe(409);
  });

  it("no-show forfeit when neither team is ready", async () => {
    const w = await world(-30);
    const f = (body: unknown) => call(`/events/${w.id}/ready/${w.mid}/forfeit`, { token: w.o.token, body });
    expect((await f({ team: "Beta Hawks", noShow: "yes" })).status).toBe(400);
    expect((await f({ team: "Beta Hawks", noShow: true })).json.match).toMatchObject({ status: "forfeit", winner: "a" });
  });

  it("clear removes ready marks and resets the status", async () => {
    const w = await world();
    await mark(w.alpha, w.mid, true);
    await mark(w.beta, w.mid, true);
    expect(await status(w)).toBe("ready");
    const c = await call(`/events/${w.id}/ready/${w.mid}/clear`, { token: w.editor.token, body: {} });
    expect(c.json).toMatchObject({ ok: true, cleared: 2 });
    expect(await status(w)).toBe("scheduled");
    expect((await call(`/events/${w.id}/ready/nope/clear`, { token: w.o.token, body: {} })).status).toBe(404);
    expect((await call(`/events/${w.id}/ready/${w.mid}/clear`, { token: w.viewer.token, body: {} })).status).toBe(403);
  });
});
