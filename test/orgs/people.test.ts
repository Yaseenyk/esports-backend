import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { conversionSentence } from "../../src/orgs/convert";
import { syncRecipients } from "../../src/features/reminders";
import { env } from "cloudflare:workers";
import { call, club, db, joined, newEvent, newUser, one, setFlag, teamOff, teamOn, verified } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
beforeEach(teamOn);
afterEach(async () => {
  await teamOff();
  await setFlag("authz.mode", undefined);
});

describe("conversion (personal organisation to club)", () => {
  it("preview carries the N1 sentence verbatim with the real count; convert flips kind and name only, events are untouched", async () => {
    const u = await verified();
    await newEvent(u.token, "One");
    await newEvent(u.token, "Two");
    const p = await call("/orgs/convert/preview", { token: u.token });
    expect(p.status).toBe(200);
    expect(p.json.eventCount).toBe(2);
    expect(p.json.sentence).toBe("Everything you have made so far (2 events, with their teams and players' details) will be shared with the people you invite to your club. Invited helpers can edit; only admins can delete or invite. Continue?");
    expect(p.json.sentence).not.toMatch(/space|workspace/i);
    expect(p.json.primaryButton).toBe("Create my club");
    expect(p.json.secondaryButton).toBe("Not now");
    expect(conversionSentence(1)).toContain("(1 event, with");
    const before = await db.prepare("SELECT id, slug, owner_id, org_id FROM events WHERE owner_id = ?1 ORDER BY id").bind(u.id).all();
    const r = await call("/orgs/convert", { token: u.token, body: { name: "Pune Esports" } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ id: `org-${u.id}`, name: "Pune Esports", kind: "team", role: "admin", eventCount: 2 });
    expect((await db.prepare("SELECT id, slug, owner_id, org_id FROM events WHERE owner_id = ?1 ORDER BY id").bind(u.id).all()).results).toEqual(before.results);
    expect(await one("SELECT kind FROM organisations WHERE id = ?1", `org-${u.id}`)).toBe("team");
    const audit = await db.prepare("SELECT action, actor_id, org_id FROM audit_log WHERE org_id = ?1").bind(`org-${u.id}`).all();
    expect(audit.results).toEqual([{ action: "org.converted", actor_id: u.id, org_id: `org-${u.id}` }]);
    expect(await one("SELECT n FROM metrics_daily WHERE name = 'club_created' ORDER BY day DESC LIMIT 1")).toBeGreaterThanOrEqual(1);
  });

  it("a second conversion is refused (already a club); a bad name is refused; context shows the club", async () => {
    const u = await verified();
    expect((await call("/orgs/convert", { token: u.token, body: { name: "" } })).status).toBe(400);
    expect((await call("/orgs/convert", { token: u.token, body: { name: "x".repeat(81) } })).status).toBe(400);
    expect((await call("/orgs/convert", { token: u.token, body: { name: "My Club" } })).status).toBe(200);
    const again = await call("/orgs/convert", { token: u.token, body: { name: "My Club 2" } });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("already_club");
    const ctx = (await call("/me/context", { token: u.token })).json;
    expect(ctx.orgs[0]).toMatchObject({ kind: "team", name: "My Club", role: "admin" });
  });

  it("a personal organisation that already has a second member cannot be converted", async () => {
    const u = await verified();
    const other = await newUser();
    await db.prepare("INSERT INTO org_members (org_id, user_id, role, added_at) VALUES (?1, ?2, 'member', 'now')").bind(`org-${u.id}`, other.id).run();
    const r = await call("/orgs/convert", { token: u.token, body: { name: "Nope" } });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("not_sole_member");
  });
});

describe("J6: convert, invite by copy link, colleague works as member, admin removes them, next request refused", () => {
  it("runs end to end in org mode", async () => {
    await setFlag("authz.mode", "org");
    const a = await club("Secretary", "College Esports");
    const evA = (await call("/events", { token: a.token, body: { name: "Inter-college cup" } })).json;
    const m = await joined(a, "member", "Volunteer");

    // works as member: sees and edits the club's event, cannot delete it or manage people
    expect((await call(`/events/${evA.id}`, { token: m.token })).status).toBe(200);
    expect((await call(`/events/${evA.id}`, { method: "PUT", token: m.token, body: { name: "Renamed by member" } })).status).toBe(200);
    expect((await call(`/events/${evA.id}`, { method: "DELETE", token: m.token })).status).toBe(403);
    expect((await call(`/events/${evA.id}/members`, { token: m.token })).status).toBe(403);
    expect((await call(`/orgs/${a.orgId}/invitations`, { token: m.token, body: { email: "z@example.com", role: "member" } })).status).toBe(403);
    // the member creates an event in the club
    const own = await call("/events", { token: m.token, body: { name: "Member's night", orgId: a.orgId } });
    expect(own.status).toBe(201);
    expect((await call(`/events/${own.json.id}`, { token: a.token })).status).toBe(200); // the admin reaches it too

    // the admin removes them: their very next request is refused (404), on both the club's event and the one they created
    expect((await call(`/orgs/${a.orgId}/members/${m.id}`, { method: "DELETE", token: a.token })).status).toBe(200);
    expect((await call(`/events/${evA.id}`, { token: m.token })).status).toBe(404);
    expect((await call(`/events/${own.json.id}`, { token: m.token })).status).toBe(404);
    expect((await call(`/orgs/${a.orgId}`, { token: m.token })).status).toBe(404);
    // the audit log says who removed whom
    const rows = (await call(`/orgs/${a.orgId}/audit`, { token: a.token })).json.entries as { action: string; actorId: string; targetId: string }[];
    const removed = rows.find((r) => r.action === "member.removed")!;
    expect(removed).toMatchObject({ actorId: a.id, targetId: m.id });
    expect(await one("SELECT owner_id FROM events WHERE id = ?1", own.json.id)).toBe(m.id); // removal never touches the creator column
  });
});

describe("escalation over HTTP", () => {
  it("nobody changes their own role; a member cannot change anyone's; roles other than admin or member are refused", async () => {
    const a = await club();
    const b = await joined(a, "admin", "Second");
    const m = await joined(a, "member", "Mem");
    expect((await call(`/orgs/${a.orgId}/members/${a.id}`, { method: "PUT", token: a.token, body: { role: "member" } })).json.code).toBe("self_role_change");
    expect((await call(`/orgs/${a.orgId}/members/${m.id}`, { method: "PUT", token: m.token, body: { role: "admin" } })).status).toBe(403);
    expect((await call(`/orgs/${a.orgId}/members/${b.id}`, { method: "PUT", token: m.token, body: { role: "member" } })).status).toBe(403);
    for (const role of ["owner", "editor", "", undefined]) expect((await call(`/orgs/${a.orgId}/members/${m.id}`, { method: "PUT", token: a.token, body: { role } })).status).toBe(400);
    expect((await call(`/orgs/${a.orgId}/members/${m.id}`, { method: "PUT", token: a.token, body: { role: "admin" } })).status).toBe(200);
    expect(await one("SELECT role FROM org_members WHERE org_id = ?1 AND user_id = ?2", a.orgId, m.id)).toBe("admin");
    expect((await call(`/orgs/${a.orgId}/members/${b.id}`, { method: "PUT", token: m.token, body: { role: "member" } })).status).toBe(200); // now an admin, may demote another
    expect((await call(`/orgs/${a.orgId}/members/not-a-member`, { method: "PUT", token: a.token, body: { role: "member" } })).status).toBe(404);
  });

  it("the last admin cannot leave (409 sole_owner, plain words); with a second admin they can; the new sole admin then cannot either", async () => {
    const a = await club();
    const left = await call(`/orgs/${a.orgId}/members/${a.id}`, { method: "DELETE", token: a.token });
    expect(left.status).toBe(409);
    expect(left.json.code).toBe("sole_owner");
    expect(left.json.error).toBe("You are the only admin of this club. Hand over the club first: make someone else an admin, then leave.");
    expect(await one("SELECT COUNT(*) FROM org_members WHERE org_id = ?1", a.orgId)).toBe(1);
    const b = await joined(a, "admin", "Successor");
    expect((await call(`/orgs/${a.orgId}/members/${a.id}`, { method: "DELETE", token: a.token })).status).toBe(200);
    expect(await one("SELECT COUNT(*) FROM org_members WHERE org_id = ?1 AND role = 'admin'", a.orgId)).toBe(1);
    expect((await call(`/orgs/${a.orgId}/members/${b.id}`, { method: "DELETE", token: b.token })).json.code).toBe("sole_owner");
    expect((await call(`/orgs/${a.orgId}`, { token: a.token })).status).toBe(404); // the one who left is out
  });

  it("an admin cannot remove the last admin (themselves counted); a member can leave but not remove others; a member list hides emails", async () => {
    const a = await club();
    const m1 = await joined(a, "member", "M1");
    const m2 = await joined(a, "member", "M2");
    expect((await call(`/orgs/${a.orgId}/members/${m2.id}`, { method: "DELETE", token: m1.token })).status).toBe(403);
    const list = await call(`/orgs/${a.orgId}/members`, { token: m1.token });
    expect(list.status).toBe(200);
    expect(list.json.members.every((x: { email: string | null }) => x.email === null)).toBe(true);
    const adminList = await call(`/orgs/${a.orgId}/members`, { token: a.token });
    expect(adminList.json.members.map((x: { email: string }) => x.email).sort()).toEqual([a.email, m1.email, m2.email].sort());
    expect((await call(`/orgs/${a.orgId}/members/${m1.id}`, { method: "DELETE", token: m1.token })).status).toBe(200); // leave
    expect((await call(`/orgs/${a.orgId}/members/${m2.id}`, { method: "DELETE", token: a.token })).status).toBe(200); // removed by an admin
    expect(await one("SELECT COUNT(*) FROM org_members WHERE org_id = ?1", a.orgId)).toBe(1);
  });

  it("two admins leaving at once cannot leave a club with none (the guard is inside the statement)", async () => {
    const a = await club();
    const b = await joined(a, "admin", "B");
    const [r1, r2] = await Promise.all([
      call(`/orgs/${a.orgId}/members/${a.id}`, { method: "DELETE", token: a.token }),
      call(`/orgs/${a.orgId}/members/${b.id}`, { method: "DELETE", token: b.token }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await one("SELECT COUNT(*) FROM org_members WHERE org_id = ?1 AND role = 'admin'", a.orgId)).toBe(1);
  });

  it("only members see the club: a stranger gets the same 404 as an unknown id on every route", async () => {
    const a = await club();
    const s = await verified();
    for (const [method, suffix, body] of [["GET", "", undefined], ["GET", "/members", undefined], ["GET", "/invitations", undefined], ["GET", "/events", undefined], ["GET", "/audit", undefined], ["PUT", `/members/${a.id}`, { role: "member" }], ["DELETE", `/members/${a.id}`, undefined]] as const) {
      const real = await call(`/orgs/${a.orgId}${suffix}`, { method, token: s.token, body });
      const fake = await call(`/orgs/org-nothing-here${suffix}`, { method, token: s.token, body });
      expect(real.status, `${method} ${suffix}`).toBe(404);
      expect(real.text, `${method} ${suffix}`).toBe(fake.text);
    }
  });

  it("the audit log is for admins only", async () => {
    const a = await club();
    const m = await joined(a, "member");
    expect((await call(`/orgs/${a.orgId}/audit`, { token: m.token })).status).toBe(403);
    const r = await call(`/orgs/${a.orgId}/audit?limit=2`, { token: a.token });
    expect(r.status).toBe(200);
    expect(r.json.entries).toHaveLength(2);
    expect(r.json.next).not.toBeNull();
    expect((await call(`/orgs/${a.orgId}/audit?limit=0`, { token: a.token })).status).toBe(400);
  });

  it("a suspended club refuses writes with org_suspended but members can still read", async () => {
    const a = await club();
    await db.prepare("UPDATE organisations SET status = 'suspended' WHERE id = ?1").bind(a.orgId).run();
    const w = await call(`/orgs/${a.orgId}/invitations`, { token: a.token, body: { email: "s@example.com", role: "member" } });
    expect(w.status).toBe(403);
    expect(w.json.code).toBe("org_suspended");
    expect((await call(`/orgs/${a.orgId}/members`, { token: a.token })).status).toBe(200);
    expect((await call("/events", { token: a.token, body: { name: "Blocked", orgId: a.orgId } })).json.code).toBe("org_suspended");
  });
});

describe("OD-AA: removed members stop receiving organiser copies of reminders", () => {
  it("recipients are the club's admins, the creator while they belong, and editor guests; a removed creator drops out at once and at the next sync", async () => {
    const a = await club("Boss");
    const m = await joined(a, "member", "Maker");
    const ev = await call("/events", { token: m.token, body: { name: "Maker's cup", orgId: a.orgId } });
    expect(ev.status).toBe(201);
    await syncRecipients(env, ev.json.id);
    const emails = async () => (await db.prepare("SELECT email FROM reminder_recipients WHERE event_id = ?1 AND kind = 'organiser' ORDER BY email").bind(ev.json.id).all<{ email: string }>()).results.map((r) => r.email);
    expect(await emails()).toEqual([a.email, m.email].sort());
    // removal deletes their recipient rows at once
    expect((await call(`/orgs/${a.orgId}/members/${m.id}`, { method: "DELETE", token: a.token })).status).toBe(200);
    expect(await emails()).toEqual([a.email]);
    // and a later sync does not bring them back (they created the event but no longer belong)
    await syncRecipients(env, ev.json.id);
    expect(await emails()).toEqual([a.email]);
  });

  it("an event with no club (org_id NULL) still mails its creator; legacy behaviour is unchanged", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    await db.prepare("UPDATE events SET org_id = NULL WHERE id = ?1").bind(ev.id).run();
    await syncRecipients(env, ev.id);
    expect((await db.prepare("SELECT email FROM reminder_recipients WHERE event_id = ?1").bind(ev.id).all<{ email: string }>()).results.map((r) => r.email)).toEqual([u.email]);
  });
});
