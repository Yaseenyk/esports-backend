import { afterEach, describe, expect, it, vi } from "vitest";
import { call, club, db, joined, newEvent, newUser, one, setFlag, teamOff, teamOn, verified } from "./helpers";

vi.setConfig({ testTimeout: 180_000 });
afterEach(teamOff);

const PW = "correct horse";
const del = (token: string, body: Record<string, unknown> = {}) => call("/auth/delete-account", { token, body: { password: PW, ...body } });

describe("E1: the personal organisation goes with the account; a hand-over moves the event to the new owner's", () => {
  it("a sole account: user, personal organisation, membership and events are gone, audit row written", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    expect((await del(u.token)).status).toBe(200);
    expect(await one("SELECT COUNT(*) FROM organisations WHERE id = ?1", `org-${u.id}`)).toBe(0);
    expect(await one("SELECT COUNT(*) FROM org_members WHERE user_id = ?1", u.id)).toBe(0);
    expect(await one("SELECT COUNT(*) FROM events WHERE id = ?1", ev.id)).toBe(0);
    expect(await one("SELECT COUNT(*) FROM audit_log WHERE action = 'auth.account_deleted' AND actor_id = ?1", u.id)).toBe(1);
  });

  it("an event handed to an editor guest moves into the editor's personal organisation", async () => {
    const o = await newUser();
    const ed = await newUser("Ed");
    const ev = await newEvent(o.token);
    await call(`/events/${ev.id}/members`, { token: o.token, body: { email: ed.email, role: "editor" } });
    const r = await del(o.token);
    expect(r.status).toBe(200);
    expect(r.json.handedOver).toHaveLength(1);
    const row = await db.prepare("SELECT owner_id, org_id, created_by FROM events WHERE id = ?1").bind(ev.id).first<{ owner_id: string; org_id: string; created_by: string }>();
    expect(row).toEqual({ owner_id: ed.id, org_id: `org-${ed.id}`, created_by: o.id }); // created_by is history and never changes
    expect(await one("SELECT COUNT(*) FROM organisations WHERE id = ?1", `org-${o.id}`)).toBe(0);
    expect(await one("SELECT COUNT(*) FROM audit_log WHERE action = 'event.handed_over' AND event_id = ?1", ev.id)).toBe(1);
  });
});

describe("N-15: a stray event on the personal organisation refuses the delete cleanly", () => {
  it("409 ownership_conflict, nothing deleted, works again once the stray event is gone", async () => {
    const a = await newUser();
    const b = await newUser();
    const mine = await newEvent(a.token, "Mine");
    // a stray: an event owned by someone else that still points at a's personal organisation
    const stray = await newEvent(b.token, "Stray");
    await db.prepare("UPDATE events SET org_id = ?1 WHERE id = ?2").bind(`org-${a.id}`, stray.id).run();
    const r = await del(a.token);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("ownership_conflict");
    expect(r.json.error).toMatch(/nothing was deleted/);
    expect(await one("SELECT COUNT(*) FROM users WHERE id = ?1", a.id)).toBe(1);
    expect(await one("SELECT COUNT(*) FROM events WHERE id = ?1", mine.id)).toBe(1);
    expect(await one("SELECT COUNT(*) FROM organisations WHERE id = ?1", `org-${a.id}`)).toBe(1);
    expect(await one("SELECT COUNT(*) FROM audit_log WHERE action = 'auth.account_deleted' AND actor_id = ?1", a.id)).toBe(0); // rolled back with the rest
    expect((await call("/me", { token: a.token })).status).toBe(200);
    await db.prepare("UPDATE events SET org_id = ?1 WHERE id = ?2").bind(`org-${b.id}`, stray.id).run();
    expect((await del(a.token)).status).toBe(200);
  });
});

describe("E2: clubs", () => {
  it("the last admin of a club with other people cannot delete the account (409 sole_owner); nothing is deleted", async () => {
    await teamOn();
    const a = await club("Boss");
    const m = await joined(a, "member");
    await call("/events", { token: a.token, body: { name: "Club cup", orgId: a.orgId } });
    const r = await del(a.token);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("sole_owner");
    expect(r.json.error).toBe("You are the only admin of a club that other people use. Hand over the club first: make someone else an admin, then delete your account.");
    expect(r.json.orgs).toEqual([{ id: a.orgId, name: "Pune Esports Club" }]);
    expect(await one("SELECT COUNT(*) FROM users WHERE id = ?1", a.id)).toBe(1);
    expect(await one("SELECT COUNT(*) FROM events WHERE org_id = ?1", a.orgId)).toBe(1);
    // the preview says the same without changing anything
    const p = await call("/me/deletion-preview", { token: a.token });
    expect(p.json.clubs.blocking).toEqual([{ id: a.orgId, name: "Pune Esports Club" }]);
    void m;
  });

  it("with a second admin the club survives: its events go to the earliest other admin and keep their club; the leaver's membership goes", async () => {
    await teamOn();
    const a = await club("Boss");
    const b = await joined(a, "admin", "Successor");
    const m = await joined(a, "member", "Mem");
    const e1 = (await call("/events", { token: a.token, body: { name: "Cup one", orgId: a.orgId } })).json;
    const e2 = (await call("/events", { token: m.token, body: { name: "Member made", orgId: a.orgId } })).json;
    const pre = await call("/me/deletion-preview", { token: a.token });
    expect(pre.json.events.handedOver.map((h: { id: string }) => h.id)).toEqual([e1.id]);
    const r = await del(a.token);
    expect(r.status, r.text).toBe(200);
    expect(r.json.handedOver).toEqual([{ id: e1.id, name: "Cup one", newOwnerName: "Successor" }]);
    const row = await db.prepare("SELECT owner_id, org_id FROM events WHERE id = ?1").bind(e1.id).first<{ owner_id: string; org_id: string }>();
    expect(row).toEqual({ owner_id: b.id, org_id: a.orgId }); // stays in the club
    expect(await one("SELECT owner_id FROM events WHERE id = ?1", e2.id)).toBe(m.id);
    expect(await one("SELECT COUNT(*) FROM organisations WHERE id = ?1", a.orgId)).toBe(1);
    expect(await one("SELECT COUNT(*) FROM org_members WHERE org_id = ?1", a.orgId)).toBe(2);
    expect((await call(`/events/${e1.id}`, { token: b.token })).status).toBe(200);
    // in org mode the member still reaches the club event, and the new owner is its owner
    await setFlag("authz.mode", "org");
    expect((await call(`/events/${e1.id}`, { token: m.token })).status).toBe(200);
    expect((await call(`/events/${e1.id}`, { method: "DELETE", token: b.token })).status).toBe(200);
    await setFlag("authz.mode", undefined);
  });

  it("a removed creator's event goes to an admin when they delete their account later (they are no longer a member)", async () => {
    await teamOn();
    const a = await club("Boss");
    const m = await joined(a, "member", "Gone Soon");
    const ev = (await call("/events", { token: m.token, body: { name: "Made then removed", orgId: a.orgId } })).json;
    expect((await call(`/orgs/${a.orgId}/members/${m.id}`, { method: "DELETE", token: a.token })).status).toBe(200);
    expect((await del(m.token)).status).toBe(200);
    const row = await db.prepare("SELECT owner_id, org_id FROM events WHERE id = ?1").bind(ev.id).first<{ owner_id: string; org_id: string }>();
    expect(row).toEqual({ owner_id: a.id, org_id: a.orgId });
  });

  it("a slug collision on a club hand-over refuses with ownership_conflict (nothing deleted); the org-wide slug check prevents most of them", async () => {
    await teamOn();
    const a = await club("Boss");
    const b = await joined(a, "admin", "Second");
    const mine = (await call("/events", { token: a.token, body: { name: "Same Name", orgId: a.orgId } })).json;
    // creation checks the whole club, so a second event with that name gets a new key
    const theirs = (await call("/events", { token: b.token, body: { name: "Same Name", orgId: a.orgId } })).json;
    expect(theirs.key).not.toBe(mine.key);
    // force a collision the generator would have prevented (an old Worker, a rename in the database)
    await db.prepare("UPDATE events SET slug = ?1 WHERE id = ?2").bind(mine.key, theirs.id).run();
    const r = await del(a.token);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("ownership_conflict");
    expect(await one("SELECT COUNT(*) FROM users WHERE id = ?1", a.id)).toBe(1);
  });

  it("a club nobody else uses is deleted with its only member", async () => {
    await teamOn();
    const a = await club("Solo");
    await call("/events", { token: a.token, body: { name: "Solo cup", orgId: a.orgId } });
    expect((await del(a.token)).status).toBe(200);
    expect(await one("SELECT COUNT(*) FROM organisations WHERE id = ?1", a.orgId)).toBe(0);
    expect(await one("SELECT COUNT(*) FROM events WHERE org_id = ?1", a.orgId)).toBe(0);
  });
});

describe("S1c (N-14): unshared events are deleted one event per batch above 20", () => {
  async function manyEvents(n: number) {
    const u = await newUser();
    for (let i = 0; i < n; i++) await call("/events", { token: u.token, body: { name: `Solo ${i}` } });
    return u;
  }

  it("up to 20 solo events: the single batch as before, no typed count needed", async () => {
    const u = await manyEvents(20);
    expect((await del(u.token)).status).toBe(200);
    expect(await one("SELECT COUNT(*) FROM events WHERE created_by = ?1", u.id)).toBe(0);
  });

  it("21 to 35: asks for the typed count first, then deletes everything in per-event batches; the count must match", async () => {
    const u = await manyEvents(25);
    const first = await del(u.token);
    expect(first.status).toBe(409);
    expect(first.json.code).toBe("events_need_count_confirmation");
    expect(first.json.eventCount).toBe(25);
    expect(await one("SELECT COUNT(*) FROM events WHERE created_by = ?1", u.id)).toBe(25); // refused before anything happened
    expect((await del(u.token, { confirmEventCount: 24 })).status).toBe(409);
    expect((await del(u.token, { confirmEventCount: "25" })).status).toBe(409);
    expect(await one("SELECT COUNT(*) FROM events WHERE created_by = ?1", u.id)).toBe(25);
    const preview = await call("/me/deletion-preview", { token: u.token });
    expect(preview.json.events).toMatchObject({ deletedCount: 25, needsTypedCount: true });
    expect((await del(u.token, { confirmEventCount: 25 })).status).toBe(200);
    expect(await one("SELECT COUNT(*) FROM events WHERE created_by = ?1", u.id)).toBe(0);
    expect(await one("SELECT COUNT(*) FROM users WHERE id = ?1", u.id)).toBe(0);
  });

  it("more than 35: each request removes 35 and says to send it again; the account goes with the last request", async () => {
    const u = await manyEvents(40);
    const r1 = await del(u.token, { confirmEventCount: 40 });
    expect(r1.status).toBe(409);
    expect(r1.json).toMatchObject({ code: "deletion_continues", deleted: 35, remaining: 5 });
    expect(await one("SELECT COUNT(*) FROM events WHERE created_by = ?1", u.id)).toBe(5);
    expect(await one("SELECT COUNT(*) FROM users WHERE id = ?1", u.id)).toBe(1);
    expect((await del(u.token, { confirmEventCount: 5 })).status).toBe(200);
    expect(await one("SELECT COUNT(*) FROM users WHERE id = ?1", u.id)).toBe(0);
  });

  it("shared events are not part of the solo count and still need no typed count", async () => {
    const o = await newUser();
    const ed = await newUser();
    for (let i = 0; i < 22; i++) {
      const ev = (await call("/events", { token: o.token, body: { name: `Shared ${i}` } })).json;
      await call(`/events/${ev.id}/members`, { token: o.token, body: { email: ed.email, role: "editor" } });
    }
    const r = await del(o.token);
    expect(r.status).toBe(200);
    expect(r.json.handedOver).toHaveLength(22);
  });
});

describe("deletion preview", () => {
  it("lists what goes, what is handed over and what blocks, without changing anything", async () => {
    const o = await verified();
    const ed = await newUser("Ed");
    const shared = await newEvent(o.token, "Shared");
    await call(`/events/${shared.id}/members`, { token: o.token, body: { email: ed.email, role: "editor" } });
    const solo = await newEvent(o.token, "Solo");
    const p = await call("/me/deletion-preview", { token: o.token });
    expect(p.status).toBe(200);
    expect(p.json.events.deleted).toEqual([{ id: solo.id, name: "Solo" }]);
    expect(p.json.events.deletedCount).toBe(1);
    expect(p.json.events.needsTypedCount).toBe(false);
    expect(p.json.events.handedOver).toEqual([{ id: shared.id, name: "Shared", newOwnerName: "Ed" }]);
    expect(p.json.clubs).toEqual({ blocking: [], deletedWithAccount: 0 });
    expect(await one("SELECT COUNT(*) FROM events WHERE created_by = ?1", o.id)).toBe(2);
  });
});
