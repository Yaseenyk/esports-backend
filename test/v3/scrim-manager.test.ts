import { beforeAll, describe, expect, it, vi } from "vitest";
import { addDays, istDay, istToEpoch } from "../../src/v3/lib/ist";
import { runManagerTick } from "../../src/v3/services/scrim-manager-service";
import { api, db, flagsOn, nowSec, ownTeamPage, prodLikeOn, user } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
beforeAll(() => prodLikeOn("v3.scrims"));

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();
async function captain(name: string) {
  const u = await user(name);
  return { ...u, team: await ownTeamPage(u.id, `${name} Squad`) };
}
type Cap = Awaited<ReturnType<typeof captain>>;
async function scrim(slots = 2, poster?: Cap) {
  const p = poster ?? (await captain("Poster"));
  const r = await api("/v3/scrims", { token: p.token, body: { teamProfileId: p.team.id, game: "bgmi", startsAt: inHours(6), region: "india", slots, contact: "poster#1" } });
  expect(r.status, r.text).toBe(201);
  return { p, id: r.json.id as string };
}
const ask = (c: Cap, id: string) => api(`/v3/scrims/${id}/requests`, { token: c.token, body: { teamProfileId: c.team.id, contact: `${c.team.name.split(" ")[0]}#2` } });
const accept = (p: Cap, q: string) => api(`/v3/scrim-requests/${q}/respond`, { token: p.token, body: { decision: "accept" } });
const join = (c: Cap, id: string) => api(`/v3/scrims/${id}/waitlist`, { token: c.token, body: { teamProfileId: c.team.id, contact: `${c.team.name.split(" ")[0]}#3` } });
const rosterOf = (u: Cap, id: string) => api(`/v3/scrims/${id}/roster`, { token: u.token });
/** A full 1-seat scrim with one confirmed team. */
async function full() {
  const s = await scrim(1);
  const a = await captain("Alpha");
  const qa = (await ask(a, s.id)).json.id;
  expect((await accept(s.p, qa)).status).toBe(200);
  return { ...s, a, qa };
}

describe("roster: who is in which slot", () => {
  it("numbers seats from 1; the poster sees contacts, a confirmed team only names, a stranger nothing; a freed number is reused", async () => {
    const s = await scrim(3);
    const [a, b, c] = [await captain("Ann"), await captain("Ben"), await captain("Cat")];
    const qa = (await ask(a, s.id)).json.id, qb = (await ask(b, s.id)).json.id, qc = (await ask(c, s.id)).json.id;
    await accept(s.p, qa); await accept(s.p, qb);
    const r = await rosterOf(s.p, s.id);
    expect(r.status, r.text).toBe(200);
    expect(r.json.role).toBe("poster");
    expect(r.json.seats).toEqual([expect.objectContaining({ slotNo: 1, teamName: "Ann Squad", contact: "Ann#2" }), expect.objectContaining({ slotNo: 2, teamName: "Ben Squad", contact: "Ben#2" })]);
    expect(r.json.openSeats).toEqual([3]);
    const asTeam = await rosterOf(b, s.id);
    expect(asTeam.json.role).toBe("team");
    expect(asTeam.text).not.toContain("Ann#2");
    expect(asTeam.json.seats.find((x: { you: boolean }) => x.you).slotNo).toBe(2);
    expect((await rosterOf(c, s.id)).status).toBe(404); // asked, not confirmed
    expect((await api(`/v3/scrims/${s.id}/roster`)).status).toBe(401);
    expect((await api(`/v3/scrim-requests/${qa}/withdraw`, { token: a.token, body: {} })).status).toBe(200);
    await accept(s.p, qc);
    expect((await rosterOf(s.p, s.id)).json.seats.map((x: { slotNo: number; teamName: string }) => `${x.slotNo}:${x.teamName}`)).toEqual(["1:Cat Squad", "2:Ben Squad"]);
  });
});

describe("waitlist and automatic backfill", () => {
  it("only a full scrim has a waitlist; when a confirmed team drops the next team gets an offer it must accept", async () => {
    const roomy = await scrim(2);
    const w1 = await captain("Wait1");
    expect((await join(w1, roomy.id)).json.code).toBe("slot_not_full");
    const s = await full();
    const w2 = await captain("Wait2");
    const j1 = await join(w1, s.id);
    expect(j1.status, j1.text).toBe(201);
    expect(j1.json.status).toBe("waiting");
    expect((await join(w1, s.id)).json.code).toBe("already_requested");
    await join(w2, s.id);
    expect((await join(s.p, s.id)).json.code).toBe("own_slot");
    const before = await api("/v3/me/scrim-waitlist", { token: w2.token });
    expect(before.json.items[0]).toMatchObject({ status: "waiting", position: 2 });
    // the confirmed team drops: the first in line gets an offer and a notice
    expect((await api(`/v3/scrim-requests/${s.qa}/withdraw`, { token: s.a.token, body: {} })).status).toBe(200);
    const mine = (await api("/v3/me/scrim-waitlist", { token: w1.token })).json.items[0];
    expect(mine).toMatchObject({ status: "offered", position: 1 });
    expect(Date.parse(mine.offerExpiresAt) - Date.now()).toBeGreaterThan(25 * 60_000);
    const notes = await api("/v3/me/scrim-notifications", { token: w1.token });
    expect(notes.json).toMatchObject({ unread: 1, items: [expect.objectContaining({ kind: "waitlist_offer", slotId: s.id })] });
    expect((await api("/v3/me/scrim-notifications/read", { token: w1.token, body: {} })).json).toEqual({ ok: true });
    expect((await api("/v3/me/scrim-notifications", { token: w1.token })).json.unread).toBe(0);
    expect((await api(`/v3/scrim-waitlist/${mine.id}/accept`, { token: w2.token, body: {} })).status).toBe(404);
    const acc = await api(`/v3/scrim-waitlist/${mine.id}/accept`, { token: w1.token, body: {} });
    expect(acc.json).toEqual({ id: mine.id, status: "accepted" });
    const r = await rosterOf(s.p, s.id);
    expect(r.json.seats).toEqual([expect.objectContaining({ slotNo: 1, teamName: "Wait1 Squad" })]);
    expect(r.json.slot.status).toBe("full");
    expect(r.json.waitlist).toEqual([expect.objectContaining({ position: 1, teamName: "Wait2 Squad", status: "waiting" })]);
    expect((await api("/v3/me/scrim-requests", { token: w1.token })).json.items[0]).toMatchObject({ status: "accepted", contact: "poster#1" });
  });

  it("an unanswered offer expires, the team is told, and the place passes to the next team; a late accept is refused", async () => {
    const s = await full();
    const [w1, w2] = [await captain("Slow"), await captain("Next")];
    await join(w1, s.id); await join(w2, s.id);
    await api(`/v3/scrim-requests/${s.qa}/withdraw`, { token: s.a.token, body: {} });
    const offer = (await api("/v3/me/scrim-waitlist", { token: w1.token })).json.items[0];
    await db.prepare("UPDATE scrim_waitlist SET offer_expires_at = ?2 WHERE id = ?1").bind(offer.id, nowSec() - 5).run();
    const r = await rosterOf(s.p, s.id); // any read of the scrim processes it
    expect(r.json.waitlist).toEqual([expect.objectContaining({ teamName: "Next Squad", status: "offered" })]);
    const late = await api(`/v3/scrim-waitlist/${offer.id}/accept`, { token: w1.token, body: {} });
    expect([late.status, late.json.code]).toEqual([409, "offer_expired"]);
    expect((await api("/v3/me/scrim-notifications", { token: w1.token })).json.items.map((n: { kind: string }) => n.kind).sort()).toEqual(["offer_expired", "waitlist_offer"]);
    expect((await api("/v3/me/scrim-requests", { token: w1.token })).json.items[0].status).toBe("declined");
  });

  it("declining or leaving passes the place on; a seat taken meanwhile sends the offer back to the queue", async () => {
    const s = await full();
    const [w1, w2, w3] = [await captain("No"), await captain("Leaver"), await captain("Third")];
    await join(w1, s.id); await join(w2, s.id); await join(w3, s.id);
    await api(`/v3/scrim-requests/${s.qa}/withdraw`, { token: s.a.token, body: {} });
    const o1 = (await api("/v3/me/scrim-waitlist", { token: w1.token })).json.items[0];
    const dec = await api(`/v3/scrim-waitlist/${o1.id}/decline`, { token: w1.token, body: {} });
    expect(dec.json.status, dec.text).toBe("declined");
    const o2 = (await api("/v3/me/scrim-waitlist", { token: w2.token })).json.items[0];
    expect(o2.status).toBe("offered");
    expect((await api(`/v3/scrim-waitlist/${o2.id}/leave`, { token: w2.token, body: {} })).json.status).toBe("left");
    const o3 = (await api("/v3/me/scrim-waitlist", { token: w3.token })).json.items[0];
    expect(o3.status).toBe("offered");
    // the poster fills the seat directly before Third answers
    const d = await captain("Direct");
    await db.prepare("UPDATE scrim_slots SET status = 'open' WHERE id = ?1").bind(s.id).run();
    const qd = (await ask(d, s.id)).json.id;
    expect((await accept(s.p, qd)).status).toBe(200);
    const miss = await api(`/v3/scrim-waitlist/${o3.id}/accept`, { token: w3.token, body: {} });
    expect([miss.status, miss.json.code]).toEqual([409, "slot_full"]);
    expect((await api("/v3/me/scrim-waitlist", { token: w3.token })).json.items[0]).toMatchObject({ status: "waiting", position: 1 });
  });

  it("the poster removes a confirmed team: the team is told and the waitlist is offered the seat; only confirmed teams can be removed", async () => {
    const s = await full();
    const w = await captain("Backup");
    await join(w, s.id);
    expect((await api(`/v3/scrim-requests/${s.qa}/remove`, { token: s.a.token, body: {} })).status).toBe(404);
    expect((await api(`/v3/scrim-requests/${s.qa}/remove`, { token: s.p.token, body: {} })).json.status).toBe("removed");
    expect((await api(`/v3/scrim-requests/${s.qa}/remove`, { token: s.p.token, body: {} })).json.code).toBe("not_confirmed");
    expect((await api("/v3/me/scrim-notifications", { token: s.a.token })).json.items[0].kind).toBe("removed_from_scrim");
    expect((await api("/v3/me/scrim-waitlist", { token: w.token })).json.items[0].status).toBe("offered");
  });

  it("editing a scrim: more seats offer the waitlist; fewer seats than confirmed teams are refused; only the poster", async () => {
    const s = await full();
    const w = await captain("More");
    await join(w, s.id);
    expect((await api(`/v3/scrims/${s.id}`, { method: "PUT", token: w.token, body: { slots: 3 } })).status).toBe(404);
    const e = await api(`/v3/scrims/${s.id}`, { method: "PUT", token: s.p.token, body: { slots: 2, skillNote: "Tier 1 only" } });
    expect(e.status, e.text).toBe(200);
    expect(e.json.slot).toMatchObject({ slotsTotal: 2, skillNote: "Tier 1 only", status: "open" });
    expect(e.json.waitlist[0].status).toBe("offered");
    const qx = (await ask(await captain("X"), s.id)).json.id;
    void qx;
    expect((await api(`/v3/scrims/${s.id}`, { method: "PUT", token: s.p.token, body: { slots: 0 } })).status).toBe(400);
    await db.prepare("UPDATE scrim_slots SET slots_filled = 2 WHERE id = ?1").bind(s.id).run();
    expect((await api(`/v3/scrims/${s.id}`, { method: "PUT", token: s.p.token, body: { slots: 1 } })).json.code).toBe("below_confirmed");
    expect((await api(`/v3/scrims/${s.id}`, { method: "PUT", token: s.p.token, body: { startsAt: inHours(0.1) } })).json.code).toBe("starts_too_soon");
    expect((await api(`/v3/scrims/${s.id}`, { method: "PUT", token: s.p.token, body: { skillNote: "dm me on insta" } })).json.code).toBe("skillNote_contact_outside");
  });
});

describe("recurring daily scrims", () => {
  const sched = (c: Cap, over: Record<string, unknown> = {}) => api("/v3/scrim-schedules", { token: c.token, body: { teamProfileId: c.team.id, game: "bgmi", timeOfDay: "21:00", daysAhead: 3, region: "india", slots: 4, contact: "daily#1", ...over } });

  it("creates one slot per India day at the IST time, days ahead; never twice; a skipped day is cancelled and never re-made", async () => {
    const c = await captain("Daily");
    const r = await sched(c);
    expect(r.status, r.text).toBe(201);
    const now = nowSec();
    const today = istDay(now);
    const expected = [0, 1, 2].map((i) => addDays(today, i)).filter((d) => istToEpoch(d, "21:00") >= now + 15 * 60);
    const made = r.json.days.filter((d: { slotId: string | null }) => d.slotId);
    expect(made.map((d: { day: string }) => d.day)).toEqual(expected);
    for (const d of made) expect(Date.parse(d.startsAt) / 1000).toBe(istToEpoch(d.day, "21:00"));
    expect(r.json).toMatchObject({ timeOfDay: "21:00", timeZone: "Asia/Kolkata", daysAhead: 3, active: true, slots: 4 });
    const board = (await api("/public/scrims")).json.items.filter((x: { teamName: string }) => x.teamName === "Daily Squad");
    expect(board).toHaveLength(expected.length);
    // listing again makes nothing new
    const again = await api("/v3/me/scrim-schedules", { token: c.token });
    expect(again.json.items[0].days.filter((d: { slotId: string | null }) => d.slotId)).toHaveLength(expected.length);
    // skip the last day
    const last = expected[expected.length - 1]!;
    const skip = await api(`/v3/scrim-schedules/${r.json.id}/days/${last}/skip`, { token: c.token, body: {} });
    expect(skip.json.days.find((d: { day: string }) => d.day === last)).toMatchObject({ skipped: true, status: "cancelled" });
    await flagsOn("v3.tournaments", "v3.resume", "v3.lft", "v3.disputes", "v3.scrims");
    await runManagerTick(db, { daily: false });
    expect((await api("/v3/me/scrim-schedules", { token: c.token })).json.items[0].days.find((d: { day: string }) => d.day === last)).toMatchObject({ skipped: true, status: "cancelled" });
    // one day can be edited like any scrim
    const first = made[0];
    expect((await api(`/v3/scrims/${first.slotId}`, { method: "PUT", token: c.token, body: { skillNote: "Finals practice" } })).json.slot.skillNote).toBe("Finals practice");
    expect((await api(`/v3/scrim-schedules/${r.json.id}/days/2020-01-01/skip`, { token: c.token, body: {} })).json.code).toBe("invalid_day");
  });

  it("the template changes days made from then on; pause stops making days; delete cancels future empty slots; caps and checks", async () => {
    const c = await captain("Template");
    const r = await sched(c, { daysAhead: 1, timeOfDay: "23:59" });
    const id = r.json.id;
    const u = await api(`/v3/scrim-schedules/${id}`, { method: "PUT", token: c.token, body: { daysAhead: 4, slots: 6, active: false } });
    expect(u.json).toMatchObject({ daysAhead: 4, slots: 6, active: false });
    const before = u.json.days.length;
    await runManagerTick(db, { daily: false });
    expect((await api("/v3/me/scrim-schedules", { token: c.token })).json.items[0].days).toHaveLength(before); // paused
    const on = await api(`/v3/scrim-schedules/${id}`, { method: "PUT", token: c.token, body: { active: true } });
    const newDays = on.json.days.filter((d: { slotId: string | null; slots: number }) => d.slotId && d.slots === 6);
    expect(newDays.length).toBeGreaterThanOrEqual(3);
    expect((await api(`/v3/scrim-schedules/${id}`, { method: "PUT", token: (await captain("Other")).token, body: { slots: 2 } })).status).toBe(404);
    expect((await api(`/v3/scrim-schedules/${id}`, { method: "DELETE", token: c.token })).json).toEqual({ ok: true });
    for (const d of on.json.days.filter((x: { slotId: string | null }) => x.slotId)) {
      expect(await db.prepare("SELECT status FROM scrim_slots WHERE id = ?1").bind(d.slotId).first()).toEqual({ status: "cancelled" });
    }
    const v = await captain("Checks");
    expect((await sched(v, { timeOfDay: "9pm" })).json.code).toBe("invalid_timeOfDay");
    expect((await sched(v, { daysAhead: 8 })).json.code).toBe("invalid_daysAhead");
    expect((await sched(v, { contact: "a@b.com" })).json.code).toBe("contact_has_email");
    expect((await sched(v, { teamProfileId: c.team.id })).json.code).toBe("not_team_owner");
    for (let i = 0; i < 3; i++) expect((await sched(v, { timeOfDay: `2${i}:30` })).status).toBe(201);
    expect((await sched(v, { timeOfDay: "23:30" })).json.code).toBe("schedule_cap");
    const kid = await user("KidCap", false);
    const kt = await ownTeamPage(kid.id);
    expect((await api("/v3/scrim-schedules", { token: kid.token, body: { teamProfileId: kt.id, game: "bgmi", timeOfDay: "21:00", slots: 2, contact: "k#1" } })).json.code).toBe("adult_required");
  });

  it("the cron does nothing while v3.scrims is off", async () => {
    const c = await captain("Cron");
    const r = await sched(c, { daysAhead: 7, timeOfDay: "22:00" });
    await db.prepare("DELETE FROM scrim_schedule_days WHERE schedule_id = ?1").bind(r.json.id).run();
    await prodLikeOn(); // scrims off
    expect((await runManagerTick(db, { daily: false })).generated).toBe(0);
    await prodLikeOn("v3.scrims");
    expect((await runManagerTick(db, { daily: false })).generated).toBeGreaterThan(0);
  });
});
