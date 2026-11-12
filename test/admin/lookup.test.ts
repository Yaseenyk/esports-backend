import { describe, expect, it, vi } from "vitest";
import { basicRoster, newEvent, newUser, call, pngDataUrl } from "../helpers";
import { api, auditRows, db, makeStaff } from "./helpers";

vi.setConfig({ testTimeout: 180_000 });

async function staffToken() {
  const s = await makeStaff();
  return { s, token: (await s.login()).token };
}

describe("lookup: metadata only, response key snapshot", () => {
  it("user by email and by id: ids, dates, status and counts, never name, email, or any content", async () => {
    const { s, token } = await staffToken();
    const owner = await newUser("Visible Name");
    const ev = await newEvent(owner.token, "Secret Cup Name");
    // a roster with a minor and a photo: counts may show, content must not
    const put = await call(`/events/${ev.id}/roster`, { method: "PUT", token: owner.token, body: { ...basicRoster(), people: basicRoster().people.map((p) => ({ ...p, photo: p.photo ?? pngDataUrl() })) } });
    expect(put.status).toBe(200);
    await db.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES (?1, 'Org Name Private', 'team', 'active', ?2)").bind(`org-${owner.id}`, new Date().toISOString()).run();
    await db.prepare("INSERT INTO org_members (org_id, user_id, role, added_at) VALUES (?1, ?2, 'admin', ?3)").bind(`org-${owner.id}`, owner.id, new Date().toISOString()).run();

    const byEmail = await api(`/admin/v1/lookup?email=${encodeURIComponent(owner.email.toUpperCase())}`, { token });
    expect(byEmail.status).toBe(200);
    expect(Object.keys(byEmail.json).sort()).toEqual(["counts", "createdAt", "emailVerified", "id", "kind", "orgs", "status"]);
    expect(Object.keys(byEmail.json.counts).sort()).toEqual(["eventsOwned", "eventsShared"]);
    expect(Object.keys(byEmail.json.orgs[0]).sort()).toEqual(["id", "kind", "role", "status"]);
    expect(byEmail.json).toMatchObject({ kind: "user", id: owner.id, status: "active", emailVerified: false, counts: { eventsOwned: 1, eventsShared: 0 } });
    const byId = await api(`/admin/v1/lookup?id=${owner.id}`, { token });
    expect(byId.json).toEqual(byEmail.json);
    for (const text of [byEmail.text, byId.text]) {
      for (const secret of [owner.email, "Visible Name", "Secret Cup Name", "Org Name Private", "Ravi", "Asha", "photo", "pw_hash"]) expect(text).not.toContain(secret);
    }
    expect((await auditRows("admin.lookup", owner.id)).length).toBe(2);
    expect((await auditRows("admin.lookup", owner.id))[0]).toMatchObject({ actor_type: "staff", actor_id: s.id, target_type: "user" });
  });

  it("organisation and event: counts only, and no person, team name, photo or registration content", async () => {
    const { token } = await staffToken();
    const owner = await newUser("Owner Two");
    const ev = await newEvent(owner.token, "Event Name Private");
    await call(`/events/${ev.id}/roster`, { method: "PUT", token: owner.token, body: basicRoster() });
    await db.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES ('org-lk1', 'Club Private', 'team', 'active', ?1)").bind(new Date().toISOString()).run();
    await db.prepare("UPDATE events SET org_id = 'org-lk1' WHERE id = ?1").bind(ev.id).run();

    const org = await api("/admin/v1/lookup?id=org-lk1", { token });
    expect(Object.keys(org.json).sort()).toEqual(["counts", "createdAt", "id", "kind", "orgKind", "status"]);
    expect(org.json).toMatchObject({ kind: "org", id: "org-lk1", orgKind: "team", status: "active", counts: { members: 0, events: 1 } });

    const e = await api(`/admin/v1/lookup?id=${ev.id}`, { token });
    expect(Object.keys(e.json).sort()).toEqual(["counts", "createdAt", "date", "id", "kind", "orgId", "ownerId", "startsOn"]);
    expect(Object.keys(e.json.counts).sort()).toEqual(["checkins", "people", "registrations", "teams"]);
    expect(e.json.counts).toEqual({ teams: 2, people: 3, registrations: 0, checkins: 0 });
    for (const secret of ["Event Name Private", "Club Private", "Alpha Wolves", "Ravi", "Asha", "Mira", "guardian", "minor", ev.key ?? "@@"]) expect(org.text + e.text).not.toContain(secret);
  });

  it("unknown email or id is 404 (and still audited), both or neither parameter is 400, odd input is a clean 400", async () => {
    const { token } = await staffToken();
    expect((await api("/admin/v1/lookup?email=nobody@example.com", { token })).status).toBe(404);
    expect((await api("/admin/v1/lookup?id=nope", { token })).status).toBe(404);
    expect((await api("/admin/v1/lookup", { token })).status).toBe(400);
    expect((await api("/admin/v1/lookup?id=a&email=b@example.com", { token })).status).toBe(400);
    expect((await api("/admin/v1/lookup?id=" + encodeURIComponent("x' OR '1'='1"), { token })).status).toBe(400);
    expect((await api("/admin/v1/lookup?email=" + "a".repeat(300), { token })).status).toBe(400);
    const miss = await auditRows("admin.lookup", "");
    expect(miss.length).toBeGreaterThanOrEqual(2);
  });

  it("exact match only: a prefix or a partial email finds nothing; there is no list route", async () => {
    const { token } = await staffToken();
    const u = await newUser("Exact");
    expect((await api(`/admin/v1/lookup?email=${encodeURIComponent(u.email.slice(0, -4))}`, { token })).status).toBe(404);
    expect((await api(`/admin/v1/lookup?id=${u.id.slice(0, 10)}`, { token })).status).toBe(404);
    expect((await api("/admin/v1/users", { token })).status).toBe(404);
    expect((await api("/admin/v1/lookup/export", { token })).status).toBe(404);
  });
});

describe("audit viewer", () => {
  it("newest first, 50 per page with a cursor, filter by org", async () => {
    const { token } = await staffToken();
    for (let i = 0; i < 3; i++) await api("/admin/v1/lookup?id=nope", { token });
    const first = await api("/admin/v1/audit", { token });
    expect(first.status).toBe(200);
    expect(Object.keys(first.json).sort()).toEqual(["entries", "next"]);
    expect(Object.keys(first.json.entries[0]).sort()).toEqual(["action", "actorId", "actorType", "at", "eventId", "id", "meta", "orgId", "reasonCode", "targetId", "targetType"]);
    const ids = first.json.entries.map((x: { id: number }) => x.id);
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
    expect(first.json.entries.length).toBeLessThanOrEqual(50);
    const older = await api(`/admin/v1/audit?after=${ids[1]}`, { token });
    expect(older.json.entries.every((x: { id: number }) => x.id < ids[1])).toBe(true);
    expect((await api("/admin/v1/audit?after=abc", { token })).status).toBe(400);
    expect((await api("/admin/v1/audit?org=bad%20id", { token })).status).toBe(400);
    const orgOnly = await api("/admin/v1/audit?org=org-lk1", { token });
    expect(orgOnly.json.entries.every((x: { orgId: string }) => x.orgId === "org-lk1")).toBe(true);
  });
});
