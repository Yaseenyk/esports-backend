import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { applyAll, applyUpTo, foreignKeyViolations, ids, one, seedLegacyWorld, seedTeamOrg } from "./world";

// Phase 2a-i schema: 0045 invitations (+ the two pending-unique indexes), 0046 and 0047 registration_forms.ack_version / ack_at.
// Applied on top of a database that already holds a legacy world, a team organisation and a registration form.
const T = "2026-11-20T00:00:00.000Z";

describe("0045 to 0047 on a populated database", () => {
  it("expand only (existing rows keep working, the new columns are NULL, the foreign-key check stays clean) and the invitation rules hold", async () => {
    await applyUpTo(45);
    await seedLegacyWorld();
    await seedTeamOrg();
    await env.DB.prepare("INSERT INTO registration_forms (event_id, token, title, intro, team_size, subs, open, created_at) VALUES ('e1', 'x-e1', 'Reg', '', 4, 1, 1, ?1)").bind(T).run();
    await applyAll();
    expect(await one("SELECT COUNT(*) FROM registration_forms WHERE ack_version IS NULL AND ack_at IS NULL AND open = 1")).toBe(1);
    expect(await one("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('invitations','idx_invitations_org','idx_invitations_event','idx_invitations_pending_org','idx_invitations_pending_event')")).toBe(5);
    expect(await foreignKeyViolations()).toEqual([]);

    // invitations: one open row per address and scope, scope and role checks, cascade with the club and the event
    const ins = (id: string, org: string | null, ev: string | null, role: string, email: string, hash: string) =>
      env.DB.prepare("INSERT INTO invitations (id, org_id, event_id, role, email, token_hash, invited_by, created_at, expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'u', ?7, ?7)").bind(id, org, ev, role, email, hash, T).run();
    await ins("i1", ids.teamOrg, null, "member", "a@example.com", "h1");
    await expect(ins("i2", ids.teamOrg, null, "admin", "a@example.com", "h2")).rejects.toThrow(); // second open invitation, same address
    await env.DB.prepare("UPDATE invitations SET revoked_at = ?1 WHERE id = 'i1'").bind(T).run();
    await ins("i3", ids.teamOrg, null, "admin", "a@example.com", "h3"); // fine once the first is revoked
    await expect(ins("i4", ids.teamOrg, null, "member", "b@example.com", "h1")).rejects.toThrow(); // token_hash is unique
    await expect(ins("i5", null, null, "member", "c@example.com", "h5")).rejects.toThrow(); // neither scope
    await expect(ins("i6", ids.teamOrg, "e1", "member", "c@example.com", "h6")).rejects.toThrow(); // both scopes
    await expect(ins("i7", ids.teamOrg, null, "viewer", "c@example.com", "h7")).rejects.toThrow(); // event role on an organisation
    await expect(ins("i8", null, "e1", "admin", "c@example.com", "h8")).rejects.toThrow(); // organisation role on an event
    await ins("i9", null, "e1", "editor", "c@example.com", "h9");
    await expect(ins("i10", null, "e1", "viewer", "c@example.com", "h10")).rejects.toThrow(); // second open event invitation
    expect(await one("SELECT COUNT(*) FROM invitations")).toBe(3);
    await env.DB.batch([env.DB.prepare("DELETE FROM events WHERE id = 'e1'")]);
    expect(await one("SELECT COUNT(*) FROM invitations WHERE event_id = 'e1'")).toBe(0);
    expect(await foreignKeyViolations()).toEqual([]);
  });
});
