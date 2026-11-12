import { afterEach, describe, expect, it, vi } from "vitest";
import { INVARIANTS } from "../../src/features/housekeeping";
import { basicRoster } from "../helpers";
import { call, db, newEvent, newUser, one, teamOff, teamOn } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
afterEach(teamOff);

describe("dual-write: register and event creation (flags all off)", () => {
  it("register creates the personal organisation and the admin membership together", async () => {
    const u = await newUser("Asha Verma");
    const org = await db.prepare("SELECT id, name, kind, status FROM organisations WHERE id = ?1").bind(`org-${u.id}`).first<{ id: string; name: string; kind: string; status: string }>();
    expect(org).toEqual({ id: `org-${u.id}`, name: "Asha Verma's workspace", kind: "personal", status: "active" });
    const m = await db.prepare("SELECT role, added_by FROM org_members WHERE org_id = ?1 AND user_id = ?2").bind(`org-${u.id}`, u.id).first<{ role: string; added_by: string }>();
    expect(m).toEqual({ role: "admin", added_by: u.id });
  });

  it("a duplicate email still answers 409 and leaves no organisation behind", async () => {
    const u = await newUser();
    const before = await one("SELECT COUNT(*) FROM organisations");
    const r = await call("/auth/register", { body: { email: u.email, password: "correct horse", name: "Again" } });
    expect(r.status).toBe(409);
    expect(await one("SELECT COUNT(*) FROM organisations")).toBe(before);
  });

  it("event create sets org_id to the creator's personal organisation and created_by", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    const row = await db.prepare("SELECT org_id, created_by, owner_id FROM events WHERE id = ?1").bind(ev.id).first<{ org_id: string; created_by: string; owner_id: string }>();
    expect(row).toEqual({ org_id: `org-${u.id}`, created_by: u.id, owner_id: u.id });
  });

  it("duplicate sets org_id and created_by for the person who copies", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    const r = await call(`/events/${ev.id}/duplicate`, { token: u.token, body: { name: "Copy", include: {} } });
    expect(r.status).toBe(201);
    const row = await db.prepare("SELECT org_id, created_by FROM events WHERE id = ?1").bind(r.json.id).first<{ org_id: string; created_by: string }>();
    expect(row).toEqual({ org_id: `org-${u.id}`, created_by: u.id });
  });

  it("an account from before the backfill (no organisation row) still creates events: org_id stays NULL, nothing fails", async () => {
    const u = await newUser();
    await db.batch([
      db.prepare("DELETE FROM org_members WHERE org_id = ?1").bind(`org-${u.id}`),
      db.prepare("DELETE FROM organisations WHERE id = ?1").bind(`org-${u.id}`),
    ]);
    const ev = await newEvent(u.token);
    const row = await db.prepare("SELECT org_id, created_by FROM events WHERE id = ?1").bind(ev.id).first<{ org_id: string | null; created_by: string }>();
    expect(row).toEqual({ org_id: null, created_by: u.id });
    const copy = await call(`/events/${ev.id}/duplicate`, { token: u.token, body: { name: "Copy", include: {} } });
    expect(copy.status).toBe(201);
    expect(await one("SELECT org_id FROM events WHERE id = ?1", copy.json.id)).toBeNull();
    // put the fixture back as the backfill would, so the global invariant test below sees a clean database
    await db.batch([
      db.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES (?1, 'x', 'personal', 'active', ?2)").bind(`org-${u.id}`, new Date().toISOString()),
      db.prepare("INSERT INTO org_members (org_id, user_id, role, added_at) VALUES (?1, ?2, 'admin', ?3)").bind(`org-${u.id}`, u.id, new Date().toISOString()),
      db.prepare("UPDATE events SET org_id = ?1 WHERE owner_id = ?2").bind(`org-${u.id}`, u.id),
    ]);
  });

  it("the five housekeeping invariants hold for everything the new Worker wrote", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    await call(`/events/${ev.id}/duplicate`, { token: u.token, body: { name: "Copy", include: {} } });
    await call(`/events/${ev.id}/roster`, { method: "PUT", token: u.token, body: basicRoster() });
    // global counts include rows of other tests in this file, but every one of them was written by the dual-write code
    for (const inv of INVARIANTS) {
      const r = await inv.stmt(db).first<{ n: number }>();
      expect(r!.n, inv.id).toBe(0);
    }
  });

  it("flag orgs.team on: an explicit orgId puts the event in that club, only for its members; the default stays the personal organisation", async () => {
    await teamOn();
    const a = await newUser();
    const stranger = await newUser();
    const conv = await call("/orgs/convert", { token: a.token, body: { name: "Club A" } });
    expect(conv.status).toBe(200);
    const inClub = await call("/events", { token: a.token, body: { name: "Club cup", orgId: conv.json.id } });
    expect(inClub.status).toBe(201);
    expect(await one("SELECT org_id FROM events WHERE id = ?1", inClub.json.id)).toBe(conv.json.id);
    expect((await call("/events", { token: stranger.token, body: { name: "Sneaky", orgId: conv.json.id } })).status).toBe(404);
    const plain = await call("/events", { token: stranger.token, body: { name: "Mine" } });
    expect(await one("SELECT org_id FROM events WHERE id = ?1", plain.json.id)).toBe(`org-${stranger.id}`);
  });

  it("flag orgs.team off: orgId in the body is ignored", async () => {
    const a = await newUser();
    const b = await newUser();
    const r = await call("/events", { token: a.token, body: { name: "Ignore", orgId: `org-${b.id}` } });
    expect(r.status).toBe(201);
    expect(await one("SELECT org_id FROM events WHERE id = ?1", r.json.id)).toBe(`org-${a.id}`);
  });
});
