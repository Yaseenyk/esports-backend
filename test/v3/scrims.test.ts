import { beforeAll, describe, expect, it, vi } from "vitest";
import { makeStaff } from "../admin/helpers";
import { runRetention } from "../../src/v3/services/retention-service";
import { api, db, nowSec, ownTeamPage, prodLikeOn, user, type U } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
beforeAll(() => prodLikeOn("v3.scrims"));

const PUBLIC_KEYS = ["createdAt", "game", "id", "region", "server", "skillNote", "slotsLeft", "slotsTotal", "startsAt", "teamName"];
const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

async function captain(name = "Captain") {
  const u = await user(name);
  const team = await ownTeamPage(u.id, `${name} Squad`);
  return { ...u, team };
}
type Cap = Awaited<ReturnType<typeof captain>>;
const body = (c: Cap, over: Record<string, unknown> = {}) => ({ teamProfileId: c.team.id, game: "bgmi", startsAt: inHours(5), region: "india", server: "Asia", skillNote: "Tier 2 squads, T3 welcome", slots: 2, contact: "alpha_capt#7", ...over });
const post = (c: Cap | U & { team?: { id: string } }, b: Record<string, unknown>) => api("/v3/scrims", { token: c.token, body: b });
async function slot(over: Record<string, unknown> = {}) {
  const p = await captain("Poster");
  const r = await post(p, body(p, over));
  expect(r.status, r.text).toBe(201);
  return { p, id: r.json.id as string, json: r.json };
}
const ask = (c: Cap, id: string, over: Record<string, unknown> = {}) => api(`/v3/scrims/${id}/requests`, { token: c.token, body: { teamProfileId: c.team.id, message: "We can play at 9", contact: "beta_igl", ...over } });

describe("posting a scrim slot", () => {
  it("needs sign-in, 18+ and a team page the caller owns", async () => {
    expect((await api("/v3/scrims", { body: {} })).status).toBe(401);
    const kid = await user("Kid", false);
    const kt = await ownTeamPage(kid.id);
    expect((await post(kid, { ...body({ ...kid, team: kt } as Cap) })).json.code).toBe("adult_required");
    const u = await user("NoTeam");
    const other = await captain("Other");
    expect((await post(u, body(other))).json.code).toBe("not_team_owner");
    expect((await post(u, { ...body(other), teamProfileId: undefined })).json.code).toBe("team_required");
  });

  it("validates time (UTC, 15 minutes to 30 days ahead), region, slots, and keeps contact details out of public text", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ startsAt: "tomorrow" }, "invalid_startsAt"],
      [{ startsAt: inHours(0.1) }, "starts_too_soon"],
      [{ startsAt: inHours(24 * 31) }, "starts_too_late"],
      [{ region: "mars" }, "invalid_region"],
      [{ game: "chess" }, "invalid_game"],
      [{ slots: 0 }, "invalid_slots"],
      [{ slots: 25 }, "invalid_slots"],
      [{ contact: "capt@example.com" }, "contact_has_email"],
      [{ contact: "98765 43210" }, "contact_has_phone"],
      [{ skillNote: "join discord.gg/abc" }, "skillNote_has_link"],
      [{ skillNote: "call 98765 43210" }, "skillNote_has_phone"],
      [{ skillNote: "DM me on insta" }, "skillNote_contact_outside"],
      [{ server: "<b>x</b>" }, "server_has_markup"],
    ];
    for (const [over, code] of cases) {
      const c = await captain("Val"); // creating is rate limited to 10 an hour, so a fresh captain per case
      const r = await post(c, body(c, over));
      expect([r.status, r.json.code], JSON.stringify(over)).toEqual([400, code]);
    }
    // an IST time with an offset is stored as UTC
    const c = await captain("Ist");
    const local = new Date(Date.now() + 6 * 3600_000);
    const ist = new Date(local.getTime() + 5.5 * 3600_000).toISOString().replace("Z", "+05:30");
    const r = await post(c, body(c, { startsAt: ist }));
    expect(r.status, r.text).toBe(201);
    expect(Math.abs(Date.parse(r.json.startsAt) - local.getTime())).toBeLessThan(1500);
  });

  it("shows on the public board without the poster's contact or id; the poster sees their own slot with contact", async () => {
    const s = await slot();
    expect(s.json).toMatchObject({ status: "open", contact: "alpha_capt#7", slotsLeft: 2, teamName: "Poster Squad", requests: { pending: 0, accepted: 0 } });
    const board = await api("/public/scrims?game=bgmi");
    expect(board.status).toBe(200);
    expect(board.headers.get("cache-control")).toBe("public, max-age=30, stale-while-revalidate=60");
    const item = board.json.items.find((x: { id: string }) => x.id === s.id);
    expect(Object.keys(item).sort()).toEqual(PUBLIC_KEYS);
    expect(board.text).not.toContain("alpha_capt#7");
    expect(board.text).not.toContain(s.p.id);
    const one = await api(`/public/scrims/${s.id}`);
    expect(Object.keys(one.json).sort()).toEqual(PUBLIC_KEYS);
    expect((await api("/v3/me/scrims", { token: s.p.token })).json.items[0]).toMatchObject({ id: s.id, contact: "alpha_capt#7" });
  });

  it("filters by game, region and a UTC date range; bad filters are a 400", async () => {
    const a = await slot({ game: "valorant", region: "europe", startsAt: inHours(30) });
    const has = async (q: string) => (await api(`/public/scrims?${q}`)).json.items.some((x: { id: string }) => x.id === a.id);
    expect(await has("game=valorant&region=europe")).toBe(true);
    expect(await has("game=bgmi")).toBe(false);
    expect(await has("region=india")).toBe(false);
    expect(await has(`from=${encodeURIComponent(inHours(29))}&to=${encodeURIComponent(inHours(31))}`)).toBe(true);
    expect(await has(`from=${encodeURIComponent(inHours(31))}`)).toBe(false);
    for (const q of ["game=chess", "region=moon", "from=yesterday", `from=${encodeURIComponent(inHours(5))}&to=${encodeURIComponent(inHours(4))}`, "cursor=zzz", "limit=0"]) expect((await api(`/public/scrims?${q}`)).status, q).toBe(400);
  });

  it("caps open slots at 5 per captain and creation at 10 an hour", async () => {
    const c = await captain("Busy");
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await post(c, body(c, { startsAt: inHours(3 + i) }))).status);
    expect(codes).toEqual([201, 201, 201, 201, 201, 409]);
    const d = await captain("Flood");
    const all: number[] = [];
    for (let i = 0; i < 11; i++) all.push((await post(d, body(d, { slots: 99 }))).status);
    expect(all.slice(0, 10).every((x) => x === 400)).toBe(true);
    expect(all[10]).toBe(429);
  });
});

describe("requests, accept and contact after acceptance", () => {
  it("a captain asks to join; contact stays hidden until the poster accepts, then both sides see the other's", async () => {
    const s = await slot();
    const b = await captain("Beta");
    expect((await api(`/v3/scrims/${s.id}/requests`, { body: {} })).status).toBe(401);
    expect((await ask({ ...s.p, team: s.p.team } as Cap, s.id)).json.code).toBe("own_slot");
    const q = await ask(b, s.id);
    expect(q.status, q.text).toBe(201);
    expect((await ask(b, s.id)).json.code).toBe("already_requested");
    const asPoster = await api(`/v3/scrims/${s.id}/requests`, { token: s.p.token });
    expect(asPoster.json.items).toEqual([expect.objectContaining({ id: q.json.id, teamName: "Beta Squad", status: "sent", contact: null, message: "We can play at 9" })]);
    expect((await api(`/v3/scrims/${s.id}/requests`, { token: b.token })).status).toBe(404); // only the poster
    const mine = await api("/v3/me/scrim-requests", { token: b.token });
    expect(mine.json.items[0]).toMatchObject({ id: q.json.id, status: "sent", contact: null, teamName: "Poster Squad", myTeamName: "Beta Squad" });
    expect((await api(`/v3/scrim-requests/${q.json.id}/respond`, { token: b.token, body: { decision: "accept" } })).status).toBe(404);
    const acc = await api(`/v3/scrim-requests/${q.json.id}/respond`, { token: s.p.token, body: { decision: "accept" } });
    expect(acc.status, acc.text).toBe(200);
    expect(acc.json).toMatchObject({ status: "accepted", contact: "beta_igl" });
    expect((await api("/v3/me/scrim-requests", { token: b.token })).json.items[0]).toMatchObject({ status: "accepted", contact: "alpha_capt#7" });
    expect((await api(`/v3/scrim-requests/${q.json.id}/respond`, { token: s.p.token, body: { decision: "decline" } })).json.code).toBe("already_answered");
    expect((await api(`/public/scrims/${s.id}`)).json.slotsLeft).toBe(1);
  });

  it("a full slot shows 0 left and refuses more requests; a withdrawn accepted request gives the seat back", async () => {
    const s = await slot({ slots: 1 });
    const b = await captain("B1");
    const c = await captain("C1");
    const qb = (await ask(b, s.id)).json.id;
    const qc = (await ask(c, s.id)).json.id;
    expect((await api(`/v3/scrim-requests/${qb}/respond`, { token: s.p.token, body: { decision: "accept" } })).status).toBe(200);
    expect((await api(`/v3/scrim-requests/${qc}/respond`, { token: s.p.token, body: { decision: "accept" } })).json.code).toBe("slot_full");
    expect((await api(`/public/scrims/${s.id}`)).json.slotsLeft).toBe(0); // a full scrim stays on the board (its waitlist is open)
    expect((await ask(await captain("D1"), s.id)).json.code).toBe("slot_full");
    expect((await api(`/v3/scrim-requests/${qb}/withdraw`, { token: b.token, body: {} })).json).toEqual({ id: qb, status: "withdrawn" });
    expect((await api(`/public/scrims/${s.id}`)).json.slotsLeft).toBe(1);
    expect((await api(`/v3/scrim-requests/${qc}/respond`, { token: s.p.token, body: { decision: "decline" } })).json.status).toBe("declined");
    expect((await api(`/v3/scrim-requests/${qb}/withdraw`, { token: b.token, body: {} })).json.code).toBe("already_answered");
  });

  it("past slots expire: off the board, no requests, no accepts; deleted 7 days after they start", async () => {
    const s = await slot();
    const b = await captain("Late");
    const q = (await ask(b, s.id)).json.id;
    await db.prepare("UPDATE scrim_slots SET starts_at = ?2 WHERE id = ?1").bind(s.id, nowSec() - 60).run();
    expect((await api(`/public/scrims/${s.id}`)).status).toBe(404);
    expect((await api("/public/scrims")).json.items.some((x: { id: string }) => x.id === s.id)).toBe(false);
    expect((await ask(await captain("Later"), s.id)).json.code).toBe("slot_expired");
    expect((await api(`/v3/scrim-requests/${q}/respond`, { token: s.p.token, body: { decision: "accept" } })).json.code).toBe("slot_expired");
    expect((await api(`/v3/scrims/${s.id}/cancel`, { token: s.p.token, body: {} })).json.code).toBe("not_open");
    expect((await api("/v3/me/scrims", { token: s.p.token })).json.items[0]).toMatchObject({ id: s.id, expired: true });
    await db.prepare("UPDATE scrim_slots SET starts_at = ?2 WHERE id = ?1").bind(s.id, nowSec() - 8 * 86_400).run();
    const r = await runRetention(db, { daily: true });
    expect(r.scrimsDeleted).toBeGreaterThanOrEqual(1);
    expect(await db.prepare("SELECT id FROM scrim_slots WHERE id = ?1").bind(s.id).first()).toBeNull();
    expect(await db.prepare("SELECT id FROM scrim_requests WHERE id = ?1").bind(q).first()).toBeNull();
  });

  it("the poster can cancel before it starts; request rate limit is 30 a day", async () => {
    const s = await slot();
    expect((await api(`/v3/scrims/${s.id}/cancel`, { token: (await user("X")).token, body: {} })).status).toBe(404);
    expect((await api(`/v3/scrims/${s.id}/cancel`, { token: s.p.token, body: {} })).json).toEqual({ id: s.id, status: "cancelled" });
    expect((await api(`/public/scrims/${s.id}`)).status).toBe(404);
    const r = await captain("Asker");
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await ask(r, "00000000000000000000000000000000")).status);
    expect(codes.slice(0, 30).every((x) => x === 404)).toBe(true);
    expect(codes[30]).toBe(429);
  });
});

describe("blocks, reports and moderation", () => {
  it("a poster blocks a requester: the request is declined, the captain cannot ask again, neither sees the other's slots", async () => {
    const s = await slot();
    const b = await captain("Pest");
    const q = (await ask(b, s.id)).json.id;
    expect((await api(`/v3/scrim-requests/${q}/block`, { token: b.token, body: {} })).status).toBe(404);
    expect((await api(`/v3/scrim-requests/${q}/block`, { token: s.p.token, body: {} })).json).toEqual({ ok: true });
    expect((await api("/v3/me/scrim-requests", { token: b.token })).json.items[0].status).toBe("declined");
    const s2 = (await post(s.p, body({ ...s.p, team: s.p.team } as Cap, { startsAt: inHours(8) }))).json.id;
    expect((await ask(b, s2)).status).toBe(404);
    const seen = async (u: U, id: string) => (await api("/v3/scrims", { token: u.token })).json.items.some((x: { id: string }) => x.id === id);
    expect(await seen(b, s2)).toBe(false);
    const bs = (await post(b, body(b, { startsAt: inHours(9) }))).json.id;
    expect(await seen(s.p, bs)).toBe(false);
    const blocks = await api("/v3/me/scrim-blocks", { token: s.p.token });
    expect(blocks.json.items).toEqual([expect.objectContaining({ label: "Pest Squad" })]);
    expect(blocks.text).not.toContain(b.id);
    expect((await api(`/v3/me/scrim-blocks/${blocks.json.items[0].id}`, { method: "DELETE", token: b.token })).status).toBe(404);
    expect((await api(`/v3/me/scrim-blocks/${blocks.json.items[0].id}`, { method: "DELETE", token: s.p.token })).json).toEqual({ ok: true });
    expect(await seen(b, s2)).toBe(true);
  });

  it("a captain blocks a poster from the board; the signed-in board marks own slots and requests", async () => {
    const s = await slot();
    const v = await captain("Viewer");
    const before = (await api("/v3/scrims", { token: v.token })).json.items.find((x: { id: string }) => x.id === s.id);
    expect(before).toMatchObject({ mine: false, myRequest: null });
    await ask(v, s.id);
    expect((await api("/v3/scrims", { token: v.token })).json.items.find((x: { id: string }) => x.id === s.id).myRequest).toBe("sent");
    expect((await api("/v3/scrims", { token: s.p.token })).json.items.find((x: { id: string }) => x.id === s.id).mine).toBe(true);
    expect((await api(`/v3/scrims/${s.id}/block`, { token: s.p.token, body: {} })).json.code).toBe("own_slot");
    expect((await api(`/v3/scrims/${s.id}/block`, { token: v.token, body: {} })).json).toEqual({ ok: true });
    expect((await api("/v3/scrims", { token: v.token })).json.items.some((x: { id: string }) => x.id === s.id)).toBe(false);
    expect((await api("/v3/scrims")).status).toBe(401);
  });

  it("reports: signed in, not your own, listed reasons; 3 reporters (or one minor report) hide it with takedown.enforce on; staff restore or remove", async () => {
    await prodLikeOn("v3.scrims", "takedown.enforce");
    const staff = await makeStaff();
    const token = (await staff.login()).token;
    const s1 = await slot();
    const s2 = await slot();
    const rep = (u: U, id: string, reason = "spam") => api(`/v3/scrims/${id}/report`, { token: u.token, body: { reason } });
    expect((await api(`/v3/scrims/${s1.id}/report`, { body: { reason: "spam" } })).status).toBe(401);
    expect((await rep(s1.p, s1.id)).json.code).toBe("own_slot");
    expect((await rep(await user("Odd"), s1.id, "boring")).json.code).toBe("invalid_reason");
    for (let i = 0; i < 3; i++) expect((await rep(await user(`Rep${i}`), s1.id)).status).toBe(202);
    expect((await api(`/public/scrims/${s1.id}`)).status).toBe(404);
    await rep(await user("Minor"), s2.id, "minor_exposed");
    expect((await api(`/public/scrims/${s2.id}`)).status).toBe(404);
    expect((await api("/admin/v1/v3/scrims/hidden")).status).toBe(404);
    const list = await api("/admin/v1/v3/scrims/hidden", { token });
    expect(list.status, list.text).toBe(200);
    expect(list.json.items.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([s1.id, s2.id]));
    expect(list.text).not.toContain("alpha_capt#7");
    expect((await api(`/admin/v1/v3/scrims/${s1.id}/decide`, { token, body: { decision: "restore" } })).json).toEqual({ ok: true, decision: "restore" });
    expect((await api(`/public/scrims/${s1.id}`)).status).toBe(200);
    expect((await api(`/admin/v1/v3/scrims/${s2.id}/decide`, { token, body: { decision: "remove" } })).status).toBe(200);
    expect(await db.prepare("SELECT status FROM scrim_slots WHERE id = ?1").bind(s2.id).first()).toEqual({ status: "removed" });
    expect((await api(`/admin/v1/v3/scrims/${s2.id}/decide`, { token, body: { decision: "maybe" } })).status).toBe(400);
    await prodLikeOn("v3.scrims");
  });

  it("without takedown.enforce reports are recorded but nothing is hidden; kill switches answer 503", async () => {
    const s = await slot();
    for (let i = 0; i < 3; i++) await api(`/v3/scrims/${s.id}/report`, { token: (await user(`N${i}`)).token, body: { reason: "spam" } });
    expect((await api(`/public/scrims/${s.id}`)).status).toBe(200);
    expect((await db.prepare("SELECT report_count FROM scrim_slots WHERE id = ?1").bind(s.id).first<{ report_count: number }>())!.report_count).toBe(3);
    await prodLikeOn("v3.scrims", "kill.public_writes");
    const c = await captain("Killed");
    expect((await post(c, body(c))).status).toBe(503);
    await prodLikeOn("v3.scrims", "kill.directory");
    expect((await api("/public/scrims")).status).toBe(503);
    await prodLikeOn("v3.scrims");
  });
});
