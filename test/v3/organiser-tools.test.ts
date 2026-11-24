import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { newEvent } from "../helpers";
import { openRoomSecret, roomKeyConfigured, sealRoomSecret } from "../../src/v3/lib/room-crypto";
import { cleanCredential, roomPhase } from "../../src/v3/lib/rooms";
import { runRetention } from "../../src/v3/services/retention-service";
import { addBr, addMatch, addRegistration, api, captainToken, db, flagsOn, nowSec, user, type U } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
afterEach(() => vi.restoreAllMocks());

const KEY = "test-room-key-test-room-key-test-room-key";
const iso = (sec: number) => new Date(sec * 1000).toISOString();

/** An event with two confirmed teams (approved registrations), one pending team, and claimed captains for each. */
async function roomWorld() {
  const owner = await user("Organiser");
  const ev = await newEvent(owner.token, "Room Cup");
  await addRegistration(ev.id, "Alpha Wolves");
  await addRegistration(ev.id, "Beta Hawks");
  await addRegistration(ev.id, "Gamma Pending", "pending");
  const a = await user("CaptainA");
  const b = await user("CaptainB");
  for (const [u, team] of [[a, "Alpha Wolves"], [b, "Beta Hawks"]] as const) {
    const r = await api("/v3/rooms/captain-claim", { token: u.token, body: { token: await captainToken(ev.id, team) } });
    if (r.status !== 200) throw new Error(`claim ${r.status} ${r.text}`);
  }
  return { owner, eventId: ev.id, a, b };
}
const createRoom = (w: { owner: U; eventId: string }, over: Record<string, unknown> = {}) =>
  api(`/v3/events/${w.eventId}/rooms`, { token: w.owner.token, body: { label: "Match 3 lobby", startsAt: iso(nowSec() + 600), revealMinutesBefore: 15, roomId: "ROOM-778812", password: "tiger42", ...over } });

describe("organiser tools: flags off", () => {
  it("every route answers 404 with the three flags off, even for the organiser", async () => {
    await flagsOn("v3.tournaments", "v3.resume", "v3.lft", "v3.disputes");
    const owner = await user("Off");
    const ev = await newEvent(owner.token, "Off Cup");
    const id = "0".repeat(32);
    const calls: [string, string, unknown?][] = [
      ["GET", `/v3/events/${ev.id}/rooms`], ["POST", `/v3/events/${ev.id}/rooms`, {}], ["PUT", `/v3/events/${ev.id}/rooms/${id}`, {}], ["POST", `/v3/events/${ev.id}/rooms/${id}/rotate`, {}],
      ["DELETE", `/v3/events/${ev.id}/rooms/${id}`], ["GET", `/v3/events/${ev.id}/rooms/${id}/views`], ["POST", "/v3/rooms/captain-claim", {}], ["GET", "/v3/me/rooms"], ["POST", `/v3/me/rooms/${id}/reveal`],
      ["GET", `/v3/events/${ev.id}/recap`], ["GET", `/v3/events/${ev.id}/tools`], ["GET", `/v3/events/${ev.id}/screenshot-results`], ["POST", `/v3/events/${ev.id}/screenshot-results`, {}],
    ];
    for (const [method, path, body] of calls) {
      const r = await api(path, { method, token: owner.token, body });
      expect([r.status, r.json], `${method} ${path}`).toEqual([404, { error: "Not found" }]);
    }
  });

  it("each flag opens only its own routes", async () => {
    const owner = await user("One");
    const ev = await newEvent(owner.token, "One Cup");
    await flagsOn("v3.recaps");
    expect((await api(`/v3/events/${ev.id}/recap`, { token: owner.token })).status).toBe(200);
    expect((await api(`/v3/events/${ev.id}/rooms`, { token: owner.token })).status).toBe(404);
    expect((await api(`/v3/events/${ev.id}/screenshot-results`, { token: owner.token })).status).toBe(404);
    expect((await api(`/v3/events/${ev.id}/tools`, { token: owner.token })).json).toEqual({ rooms: false, recaps: true, screenshots: false, canEdit: true });
    expect((await api(`/v3/events/${ev.id}/tools`, { token: (await user("Nobody")).token })).status).toBe(404);
    await flagsOn("v3.screenshots");
    expect((await api(`/v3/events/${ev.id}/screenshot-results`, { token: owner.token })).status).toBe(200);
    expect((await api(`/v3/events/${ev.id}/recap`, { token: owner.token })).status).toBe(404);
  });
});

describe("room credential encryption", () => {
  it("round-trips, is bound to the room and event, and refuses another key or a tampered text", async () => {
    const ids = { roomId: "r1", eventId: "e1" };
    const sealed = await sealRoomSecret(KEY, ids, { roomId: "ROOM-1", password: "pw" });
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(sealed).not.toContain("ROOM-1");
    expect(await openRoomSecret(KEY, ids, sealed)).toEqual({ roomId: "ROOM-1", password: "pw" });
    expect(await sealRoomSecret(KEY, ids, { roomId: "ROOM-1", password: "pw" })).not.toBe(sealed); // fresh IV each time
    expect(await openRoomSecret(KEY, { roomId: "r2", eventId: "e1" }, sealed)).toBeNull();
    expect(await openRoomSecret(KEY, { roomId: "r1", eventId: "e2" }, sealed)).toBeNull();
    expect(await openRoomSecret(`${KEY}x`, ids, sealed)).toBeNull();
    expect(await openRoomSecret(KEY, ids, sealed.slice(0, -2) + (sealed.endsWith("A") ? "BB" : "AA"))).toBeNull();
    expect(await openRoomSecret(KEY, ids, "garbage")).toBeNull();
    expect(roomKeyConfigured(undefined)).toBe(false);
    expect(roomKeyConfigured("short")).toBe(false);
    expect(roomKeyConfigured(KEY)).toBe(true);
  });

  it("pure rules: credentials and phases", () => {
    expect(cleanCredential("  abc  ")).toBe("abc");
    expect(cleanCredential("")).toBeNull();
    expect(cleanCredential("a\nb")).toBeNull();
    expect(cleanCredential("x".repeat(41))).toBeNull();
    expect(roomPhase({ revealAt: 100, startsAt: 200, purgedAt: null }, 99)).toBe("waiting");
    expect(roomPhase({ revealAt: 100, startsAt: 200, purgedAt: null }, 100)).toBe("revealed");
    expect(roomPhase({ revealAt: 100, startsAt: 200, purgedAt: null }, 200 + 86_400)).toBe("expired");
    expect(roomPhase({ revealAt: 100, startsAt: 200, purgedAt: 150 }, 150)).toBe("expired");
  });
});

describe("match rooms (flag v3.rooms)", () => {
  it("the organiser stores credentials once; they are encrypted in D1 and never come back in any organiser payload", async () => {
    await flagsOn("v3.rooms");
    const w = await roomWorld();
    const c = await createRoom(w);
    expect(c.status, c.text).toBe(201);
    expect(c.headers.get("cache-control")).toBe("no-store");
    expect(c.json).toMatchObject({ label: "Match 3 lobby", hasCredentials: true, version: 1, revealMinutesBefore: 15, phase: "revealed", match: null });
    expect(c.text).not.toMatch(/ROOM-778812|tiger42|secret/i);
    const row = await db.prepare("SELECT * FROM v3_match_rooms WHERE id = ?1").bind(c.json.id).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toMatch(/ROOM-778812|tiger42/);
    expect(String(row!.secret_enc)).toMatch(/^v1\./);
    const list = await api(`/v3/events/${w.eventId}/rooms`, { token: w.owner.token });
    expect(list.status).toBe(200);
    expect(list.json.rooms).toHaveLength(1);
    expect(list.text).not.toMatch(/ROOM-778812|tiger42|v1\./);
  });

  it("validates input and refuses changing credentials through edit", async () => {
    await flagsOn("v3.rooms");
    const w = await roomWorld();
    expect((await createRoom(w, { roomId: "" })).json.code).toBe("invalid_roomId");
    expect((await createRoom(w, { password: "x".repeat(41) })).json.code).toBe("invalid_password");
    expect((await createRoom(w, { revealMinutesBefore: 181 })).json.code).toBe("invalid_revealMinutesBefore");
    expect((await createRoom(w, { startsAt: iso(nowSec() - 2 * 86_400) })).json.code).toBe("invalid_startsAt");
    expect((await createRoom(w, { matchId: "nope" })).json.code).toBe("invalid_matchId");
    const c = await createRoom(w);
    const put = await api(`/v3/events/${w.eventId}/rooms/${c.json.id}`, { method: "PUT", token: w.owner.token, body: { password: "new" } });
    expect([put.status, put.json.code]).toEqual([400, "use_rotate"]);
    const ok = await api(`/v3/events/${w.eventId}/rooms/${c.json.id}`, { method: "PUT", token: w.owner.token, body: { label: "Match 4 lobby", revealMinutesBefore: 30 } });
    expect(ok.json).toMatchObject({ label: "Match 4 lobby", revealMinutesBefore: 30 });
  });

  it("strangers get 404 and view-only members get 403 on changes", async () => {
    await flagsOn("v3.rooms");
    const w = await roomWorld();
    const stranger = await user("Stranger");
    expect((await api(`/v3/events/${w.eventId}/rooms`, { token: stranger.token })).status).toBe(404);
    expect((await createRoom({ owner: stranger, eventId: w.eventId })).status).toBe(404);
    const viewer = await user("Viewer");
    const add = await api(`/events/${w.eventId}/members`, { token: w.owner.token, body: { email: viewer.email, role: "viewer" } });
    expect(add.status, add.text).toBeLessThan(300);
    expect((await api(`/v3/events/${w.eventId}/rooms`, { token: viewer.token })).json.canEdit).toBe(false);
    expect((await createRoom({ owner: viewer, eventId: w.eventId })).status).toBe(403);
    expect((await api(`/v3/events/${w.eventId}/rooms`)).status).toBe(401);
  });

  it("only captains of confirmed teams see the room, only from the reveal time, and every reveal is logged", async () => {
    await flagsOn("v3.rooms");
    const w = await roomWorld();
    const later = await createRoom(w, { label: "Final lobby", startsAt: iso(nowSec() + 3600), revealMinutesBefore: 15 });
    const now = await createRoom(w, { label: "Match 1 lobby", startsAt: iso(nowSec() + 300), revealMinutesBefore: 15 });

    // the captain list shows both rooms, with no credentials in it
    const mine = await api("/v3/me/rooms", { token: w.a.token });
    expect(mine.status).toBe(200);
    expect(mine.json.rooms.map((r: { label: string; phase: string }) => [r.label, r.phase])).toEqual([["Match 1 lobby", "revealed"], ["Final lobby", "waiting"]]);
    expect(mine.text).not.toMatch(/ROOM-778812|tiger42/);

    // before the reveal time: refused by the server, not just hidden
    const early = await api(`/v3/me/rooms/${later.json.id}/reveal`, { method: "POST", token: w.a.token });
    expect([early.status, early.json.code]).toEqual([403, "not_yet"]);
    expect(early.text).not.toMatch(/ROOM-778812|tiger42/);
    expect(early.json.revealAt).toBe(later.json.revealAt);

    // from the reveal time: the credentials, logged
    const logSpy = vi.spyOn(console, "log");
    const errSpy = vi.spyOn(console, "error");
    const warnSpy = vi.spyOn(console, "warn");
    const r = await api(`/v3/me/rooms/${now.json.id}/reveal`, { method: "POST", token: w.a.token });
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.json).toMatchObject({ roomId: "ROOM-778812", password: "tiger42", team: "Alpha Wolves", version: 1 });
    for (const s of [logSpy, errSpy, warnSpy]) expect(JSON.stringify(s.mock.calls)).not.toMatch(/ROOM-778812|tiger42/);
    await api(`/v3/me/rooms/${now.json.id}/reveal`, { method: "POST", token: w.b.token });

    const views = await api(`/v3/events/${w.eventId}/rooms/${now.json.id}/views`, { token: w.owner.token });
    expect(views.status).toBe(200);
    expect(views.json.views.map((v: { team: string }) => v.team).sort()).toEqual(["Alpha Wolves", "Beta Hawks"]);
    expect(views.text).not.toContain(w.a.id);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM v3_room_views WHERE room_id = ?1 AND user_id = ?2").bind(now.json.id, w.a.id).first<{ n: number }>())!.n).toBe(1);
    expect((await api(`/v3/events/${w.eventId}/rooms`, { token: w.owner.token })).json.rooms.find((x: { id: string }) => x.id === now.json.id).teamsSeenCurrent).toBe(2);
    // a captain cannot read the organiser's view log
    expect((await api(`/v3/events/${w.eventId}/rooms/${now.json.id}/views`, { token: w.a.token })).status).toBe(404);

    // nobody else: a stranger, the captain of a pending team, a captain whose team was later rejected, the organiser (no captain claim)
    const stranger = await user("Stranger");
    expect((await api(`/v3/me/rooms/${now.json.id}/reveal`, { method: "POST", token: stranger.token })).status).toBe(404);
    expect((await api("/v3/me/rooms", { token: stranger.token })).json.rooms).toEqual([]);
    const pending = await user("Pending");
    const claim = await api("/v3/rooms/captain-claim", { token: pending.token, body: { token: await captainToken(w.eventId, "Gamma Pending") } });
    expect([claim.status, claim.json.code]).toEqual([409, "team_not_confirmed"]);
    expect((await api(`/v3/me/rooms/${now.json.id}/reveal`, { method: "POST", token: pending.token })).status).toBe(404);
    await db.prepare("UPDATE registrations SET status = 'rejected' WHERE event_id = ?1 AND team_name = 'Beta Hawks'").bind(w.eventId).run();
    expect((await api(`/v3/me/rooms/${now.json.id}/reveal`, { method: "POST", token: w.b.token })).status).toBe(404);
    expect((await api(`/v3/me/rooms/${now.json.id}/reveal`, { method: "POST", token: w.owner.token })).status).toBe(404);
    expect((await api(`/v3/me/rooms/${now.json.id}/reveal`, { method: "POST" })).status).toBe(401);
  });

  it("a match room is only for the two teams of that match", async () => {
    await flagsOn("v3.rooms");
    const w = await roomWorld();
    await addRegistration(w.eventId, "Delta Owls");
    const d = await user("CaptainD");
    expect((await api("/v3/rooms/captain-claim", { token: d.token, body: { token: await captainToken(w.eventId, "Delta Owls") } })).status).toBe(200);
    const mid = await addMatch(w.eventId, "Alpha Wolves", "Beta Hawks", { status: "scheduled" });
    const room = await createRoom(w, { matchId: mid });
    expect(room.status, room.text).toBe(201);
    expect(room.json.match).toEqual({ id: mid, teamA: "Alpha Wolves", teamB: "Beta Hawks" });
    expect((await api(`/v3/me/rooms/${room.json.id}/reveal`, { method: "POST", token: w.a.token })).status).toBe(200);
    expect((await api(`/v3/me/rooms/${room.json.id}/reveal`, { method: "POST", token: d.token })).status).toBe(404);
    expect((await api("/v3/me/rooms", { token: d.token })).json.rooms).toEqual([]);
  });

  it("claiming needs a valid captain link and an 18+ confirmation", async () => {
    await flagsOn("v3.rooms");
    const w = await roomWorld();
    const young = await user("NoConfirm", false);
    const tok = await captainToken(w.eventId, "Alpha Wolves");
    expect((await api("/v3/rooms/captain-claim", { token: young.token, body: { token: tok } })).json.code).toBe("adult_required");
    expect((await api("/v3/rooms/captain-claim", { token: young.token, body: { token: tok, adult: true } })).status).toBe(200);
    expect((await api("/v3/rooms/captain-claim", { token: young.token, body: { token: "x".repeat(30) } })).json.code).toBe("bad_token");
  });

  it("rotating the password re-encrypts it, bumps the version and captains see the new one", async () => {
    await flagsOn("v3.rooms");
    const w = await roomWorld();
    const room = await createRoom(w);
    await api(`/v3/me/rooms/${room.json.id}/reveal`, { method: "POST", token: w.a.token });
    const before = (await db.prepare("SELECT secret_enc FROM v3_match_rooms WHERE id = ?1").bind(room.json.id).first<{ secret_enc: string }>())!.secret_enc;
    const rot = await api(`/v3/events/${w.eventId}/rooms/${room.json.id}/rotate`, { token: w.owner.token, body: { password: "lion99" } });
    expect(rot.status, rot.text).toBe(200);
    expect(rot.json).toMatchObject({ version: 2, hasCredentials: true });
    expect(rot.text).not.toMatch(/lion99|ROOM-778812/);
    const after = (await db.prepare("SELECT secret_enc FROM v3_match_rooms WHERE id = ?1").bind(room.json.id).first<{ secret_enc: string }>())!.secret_enc;
    expect(after).not.toBe(before);
    const r = await api(`/v3/me/rooms/${room.json.id}/reveal`, { method: "POST", token: w.a.token });
    expect(r.json).toMatchObject({ roomId: "ROOM-778812", password: "lion99", version: 2 });
    const rot2 = await api(`/v3/events/${w.eventId}/rooms/${room.json.id}/rotate`, { token: w.owner.token, body: { password: "x1", roomId: "ROOM-NEW" } });
    expect(rot2.json.version).toBe(3);
    expect((await api(`/v3/me/rooms/${room.json.id}/reveal`, { method: "POST", token: w.a.token })).json).toMatchObject({ roomId: "ROOM-NEW", password: "x1" });
    const views = await api(`/v3/events/${w.eventId}/rooms/${room.json.id}/views`, { token: w.owner.token });
    expect(views.json.views.map((v: { version: number }) => v.version).sort()).toEqual([1, 2, 3]);
    expect((await api(`/v3/events/${w.eventId}/rooms/${room.json.id}/rotate`, { token: w.a.token, body: { password: "hack" } })).status).toBe(404);
  });

  it("without the Worker secret nothing is stored or revealed (503 rooms_not_configured)", async () => {
    await flagsOn("v3.rooms");
    const w = await roomWorld();
    const room = await createRoom(w);
    const noKey = { ...env, ROOM_CREDENTIALS_KEY: undefined };
    const c = await api(`/v3/events/${w.eventId}/rooms`, { token: w.owner.token, env: noKey, body: { label: "L", startsAt: iso(nowSec() + 600), roomId: "R", password: "P" } });
    expect([c.status, c.json.code]).toEqual([503, "rooms_not_configured"]);
    const r = await api(`/v3/me/rooms/${room.json.id}/reveal`, { method: "POST", token: w.a.token, env: { ...env, ROOM_CREDENTIALS_KEY: "short" } });
    expect([r.status, r.json.code]).toEqual([503, "rooms_not_configured"]);
    const wrong = await api(`/v3/me/rooms/${room.json.id}/reveal`, { method: "POST", token: w.a.token, env: { ...env, ROOM_CREDENTIALS_KEY: `${KEY}-rotated` } });
    expect([wrong.status, wrong.json.code]).toEqual([410, "unavailable"]);
  });

  it("credentials are deleted 24 hours after the start; deleting a room removes its log", async () => {
    await flagsOn("v3.rooms");
    const w = await roomWorld();
    const room = await createRoom(w);
    await api(`/v3/me/rooms/${room.json.id}/reveal`, { method: "POST", token: w.a.token });
    const startsAt = (await db.prepare("SELECT starts_at FROM v3_match_rooms WHERE id = ?1").bind(room.json.id).first<{ starts_at: number }>())!.starts_at;
    expect((await runRetention(env.DB, { daily: false, now: startsAt + 3600 })).roomSecretsPurged).toBe(0);
    const tick = await runRetention(env.DB, { daily: false, now: startsAt + 86_400 + 1 });
    expect(tick.roomSecretsPurged).toBeGreaterThanOrEqual(1);
    expect((await db.prepare("SELECT secret_enc, purged_at FROM v3_match_rooms WHERE id = ?1").bind(room.json.id).first<{ secret_enc: string | null; purged_at: number | null }>())).toMatchObject({ secret_enc: null });
    const gone = await api(`/v3/me/rooms/${room.json.id}/reveal`, { method: "POST", token: w.a.token });
    expect([gone.status, gone.json.code]).toEqual([410, "expired"]);
    expect((await api("/v3/me/rooms", { token: w.a.token })).json.rooms.find((r: { id: string }) => r.id === room.json.id)).toBeUndefined();
    const rot = await api(`/v3/events/${w.eventId}/rooms/${room.json.id}/rotate`, { token: w.owner.token, body: { password: "again" } });
    expect(rot.json.code).toBe("room_id_required");
    const del = await api(`/v3/events/${w.eventId}/rooms/${room.json.id}`, { method: "DELETE", token: w.owner.token });
    expect(del.status).toBe(200);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM v3_room_views WHERE room_id = ?1").bind(room.json.id).first<{ n: number }>())!.n).toBe(0);
    expect((await api(`/v3/events/${w.eventId}/rooms/${room.json.id}`, { method: "DELETE", token: w.owner.token })).status).toBe(404);
  });

  it("room details never appear in any public endpoint", async () => {
    await flagsOn("v3.rooms", "v3.tournaments");
    const w = await roomWorld();
    await createRoom(w);
    for (const p of ["/public/tournaments", `/events/${w.eventId}`, `/events/${w.eventId}/matches`]) {
      const r = await api(p, { token: p.startsWith("/events") ? w.owner.token : undefined });
      expect(r.text, p).not.toMatch(/ROOM-778812|tiger42/);
    }
  });
});

describe("match recap facts (flag v3.recaps)", () => {
  it("returns only entered results (with the organiser's scoring or null) to people with a role on the event", async () => {
    await flagsOn("v3.recaps");
    const owner = await user("Org");
    const ev = await newEvent(owner.token, "Recap Cup");
    const empty = await api(`/v3/events/${ev.id}/recap`, { token: owner.token });
    expect(empty.json).toMatchObject({ publicPath: null, scoring: null, matches: [], battleRoyale: [] });
    await addBr(ev.id, 1, "Alpha", 1, 12);
    await addBr(ev.id, 1, "Beta", 2, 5);
    await addMatch(ev.id, "Alpha", "Beta", { status: "finished", score_a: 2, score_b: 1, winner: "a" });
    await addMatch(ev.id, "Gamma", "Delta", { status: "scheduled" });
    await db.prepare("INSERT INTO league_settings (event_id, slug, published, title, scale, per_kill, win_pts, draw_pts, loss_pts, days, updated_at) VALUES (?1, ?2, 0, 'Season', '[10,6,5]', 1, 3, 1, 0, '[]', ?3)").bind(ev.id, "abcdefghijkl".slice(0, 12), new Date().toISOString()).run();
    const r = await api(`/v3/events/${ev.id}/recap`, { token: owner.token });
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.json.battleRoyale).toEqual([{ matchNo: 1, team: "Alpha", placement: 1, kills: 12, corrected: false }, { matchNo: 1, team: "Beta", placement: 2, kills: 5, corrected: false }]);
    expect(r.json.matches).toHaveLength(1);
    expect(r.json.matches[0]).toMatchObject({ teamA: "Alpha", teamB: "Beta", scoreA: 2, scoreB: 1, winner: "a" });
    expect(r.json.scoring).toEqual({ title: "Season", scale: [10, 6, 5], perKill: 1, winPts: 3, drawPts: 1, lossPts: 0 });
    expect((await api(`/v3/events/${ev.id}/recap`, { token: (await user("S")).token })).status).toBe(404);
    expect((await api(`/v3/events/${ev.id}/recap`)).status).toBe(401);
  });
});

describe("results from a screenshot (flag v3.screenshots)", () => {
  const row = (team: string, placement: number, kills: number, confirmed = true) => ({ team, placement, kills, confirmed });

  it("context: confirmed team names and the saved match numbers", async () => {
    await flagsOn("v3.screenshots");
    const owner = await user("Org");
    const ev = await newEvent(owner.token, "Shot Cup");
    await addRegistration(ev.id, "Alpha Wolves");
    await addRegistration(ev.id, "Pending Team", "pending");
    await addBr(ev.id, 2, "Alpha Wolves", 1, 3);
    const r = await api(`/v3/events/${ev.id}/screenshot-results`, { token: owner.token });
    expect(r.json).toMatchObject({ teams: ["Alpha Wolves"], matchNumbers: [2], nextMatchNo: 3, canEdit: true });
  });

  it("nothing saves unless every row is confirmed; confirmed rows save; an existing match needs replace", async () => {
    await flagsOn("v3.screenshots");
    const owner = await user("Org");
    const ev = await newEvent(owner.token, "Shot Cup");
    const path = `/v3/events/${ev.id}/screenshot-results`;
    const count = async () => (await db.prepare("SELECT COUNT(*) AS n FROM br_results WHERE event_id = ?1").bind(ev.id).first<{ n: number }>())!.n;

    const partly = await api(path, { token: owner.token, body: { matchNo: 1, rows: [row("Alpha", 1, 10), row("Beta", 2, 4, false)] } });
    expect([partly.status, partly.json.code]).toEqual([400, "unconfirmed_rows"]);
    const missing = await api(path, { token: owner.token, body: { matchNo: 1, rows: [{ team: "Alpha", placement: 1, kills: 1 }] } });
    expect(missing.json.code).toBe("unconfirmed_rows");
    expect(await count()).toBe(0);
    expect((await api(path, { token: owner.token, body: { matchNo: 1, rows: [] } })).json.code).toBe("invalid_rows");
    expect((await api(path, { token: owner.token, body: { matchNo: 1, rows: [row("A", 1, 1), row("a", 2, 1)] } })).json.code).toBe("duplicate_team");
    expect((await api(path, { token: owner.token, body: { matchNo: 1, rows: [row("A", 1, 1), row("B", 1, 1)] } })).json.code).toBe("duplicate_placement");
    expect((await api(path, { token: owner.token, body: { matchNo: 1, rows: [row("A", 1, -1)] } })).json.code).toBe("invalid_kills");
    expect(await count()).toBe(0);

    const ok = await api(path, { token: owner.token, body: { matchNo: 1, rows: [row("Alpha", 1, 10), row("Beta", 2, 4)] } });
    expect([ok.status, ok.json]).toEqual([201, { matchNo: 1, saved: 2 }]);
    expect(await count()).toBe(2);
    const again = await api(path, { token: owner.token, body: { matchNo: 1, rows: [row("Gamma", 1, 1)] } });
    expect([again.status, again.json.code]).toEqual([409, "match_has_results"]);
    const rep = await api(path, { token: owner.token, body: { matchNo: 1, replace: true, rows: [row("Gamma", 1, 1)] } });
    expect(rep.status).toBe(201);
    const rows = (await db.prepare("SELECT team FROM br_results WHERE event_id = ?1 AND match_no = 1").bind(ev.id).all<{ team: string }>()).results;
    expect(rows.map((x) => x.team)).toEqual(["Gamma"]);
  });

  it("strangers 404, viewers 403", async () => {
    await flagsOn("v3.screenshots");
    const owner = await user("Org");
    const ev = await newEvent(owner.token, "Shot Cup");
    const s = await user("S");
    expect((await api(`/v3/events/${ev.id}/screenshot-results`, { token: s.token })).status).toBe(404);
    const viewer = await user("V");
    await api(`/events/${ev.id}/members`, { token: owner.token, body: { email: viewer.email, role: "viewer" } });
    expect((await api(`/v3/events/${ev.id}/screenshot-results`, { token: viewer.token, body: { matchNo: 1, rows: [row("A", 1, 1)] } })).status).toBe(403);
  });
});
