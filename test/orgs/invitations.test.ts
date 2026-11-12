import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../../src/links";
import { call, club, db, invite, joined, newEvent, newUser, now, one, teamOff, teamOn, verified } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
beforeEach(teamOn);
afterEach(teamOff);

describe("invitation matrix: organisation invitations", () => {
  it("creates a copyable link, 7 days, token hashed and never stored in clear", async () => {
    const a = await club();
    const r = await call(`/orgs/${a.orgId}/invitations`, { token: a.token, body: { email: "Helper@Example.com ", role: "member" } });
    expect(r.status).toBe(201);
    expect(Object.keys(r.json).sort()).toEqual(["createdAt", "email", "expiresAt", "id", "link", "role", "token"]);
    expect(r.json.email).toBe("helper@example.com");
    expect(r.json.link).toContain(`/join/?t=${r.json.token}`);
    const days = (Date.parse(r.json.expiresAt) - Date.parse(r.json.createdAt)) / 86_400_000;
    expect(days).toBeCloseTo(7, 3);
    const row = await db.prepare("SELECT token_hash, org_id, event_id, role, invited_by FROM invitations WHERE id = ?1").bind(r.json.id).first<{ token_hash: string; org_id: string; event_id: string | null; role: string; invited_by: string }>();
    expect(row).toEqual({ token_hash: await hashToken(r.json.token), org_id: a.orgId, event_id: null, role: "member", invited_by: a.id });
    // the clear token is nowhere in the database
    const dump = JSON.stringify((await db.prepare("SELECT * FROM invitations").all()).results);
    expect(dump).not.toContain(r.json.token);
    // the list never shows the link again
    const list = await call(`/orgs/${a.orgId}/invitations`, { token: a.token });
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json)).not.toContain(r.json.token);
    expect(list.json.invitations[0]).toMatchObject({ id: r.json.id, email: "helper@example.com", role: "member", expired: false });
  });

  it("is single use: a second accept is refused and the member is added once", async () => {
    const a = await club();
    const u = await verified("Helper");
    const inv = await invite(a.orgId, a.token, u.email);
    const first = await call("/me/invitations/accept", { token: u.token, body: { token: inv.token } });
    expect(first.status).toBe(200);
    expect(first.json).toEqual({ ok: true, kind: "org", orgId: a.orgId, role: "member" });
    const again = await call("/me/invitations/accept", { token: u.token, body: { token: inv.token } });
    expect(again.status).toBe(409);
    expect(again.json.code).toBe("invitation_used");
    expect(await one("SELECT COUNT(*) FROM org_members WHERE org_id = ?1 AND user_id = ?2", a.orgId, u.id)).toBe(1);
    // the invited address is blanked once used (personal data)
    expect(await one("SELECT email FROM invitations WHERE id = ?1", inv.id)).toBe("");
  });

  it("another verified account cannot reuse a used link", async () => {
    const a = await club();
    const u = await verified();
    const other = await verified();
    const inv = await invite(a.orgId, a.token, u.email);
    expect((await call("/me/invitations/accept", { token: u.token, body: { token: inv.token } })).status).toBe(200);
    const r = await call("/me/invitations/accept", { token: other.token, body: { token: inv.token } });
    expect(r.status).toBe(409);
    expect(await one("SELECT COUNT(*) FROM org_members WHERE org_id = ?1 AND user_id = ?2", a.orgId, other.id)).toBe(0);
  });

  it("expired after 7 days, revoked, unknown and malformed tokens are refused", async () => {
    const a = await club();
    const u = await verified();
    const old = await invite(a.orgId, a.token, u.email);
    await db.prepare("UPDATE invitations SET expires_at = ?1 WHERE id = ?2").bind(new Date(Date.now() - 1000).toISOString(), old.id).run();
    const expired = await call("/me/invitations/accept", { token: u.token, body: { token: old.token } });
    expect(expired.status).toBe(409);
    expect(expired.json.code).toBe("invitation_expired");

    const fresh = await invite(a.orgId, a.token, u.email);
    expect((await call(`/orgs/${a.orgId}/invitations/${fresh.id}`, { method: "DELETE", token: a.token })).status).toBe(200);
    const revoked = await call("/me/invitations/accept", { token: u.token, body: { token: fresh.token } });
    expect(revoked.status).toBe(404);
    expect(revoked.json.code).toBe("invitation_invalid");
    expect((await call(`/orgs/${a.orgId}/invitations/${fresh.id}`, { method: "DELETE", token: a.token })).status).toBe(404); // already revoked

    for (const t of ["x".repeat(30), "short", 42, null, undefined]) {
      const r = await call("/me/invitations/accept", { token: u.token, body: { token: t } });
      expect(r.status, JSON.stringify(t)).toBe(404);
      expect(r.json.code).toBe("invitation_invalid");
    }
  });

  it("wrong email: the plain N2 message with a masked hint; nothing is joined and the invitation stays open", async () => {
    const a = await club();
    const invited = "jaya.sharma@example.com";
    const inv = await invite(a.orgId, a.token, invited);
    const other = await verified("Other Gmail");
    const r = await call("/me/invitations/accept", { token: other.token, body: { token: inv.token } });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("wrong_email");
    expect(r.json.error).toBe("This invitation was sent for j***@example.com. Sign in with that address, or ask your admin to invite the one you use.");
    expect(r.json.invitedHint).toBe("j***@example.com");
    expect(r.text).not.toContain(invited);
    expect(await one("SELECT COUNT(*) FROM org_members WHERE org_id = ?1 AND user_id = ?2", a.orgId, other.id)).toBe(0);
    expect(await one("SELECT accepted_at IS NULL FROM invitations WHERE id = ?1", inv.id)).toBe(1);
  });

  it("unverified email: refused with email_unverified, even for the right address; after verifying it works", async () => {
    const a = await club();
    const u = await newUser("Not Yet");
    const inv = await invite(a.orgId, a.token, u.email);
    const r = await call("/me/invitations/accept", { token: u.token, body: { token: inv.token } });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("email_unverified");
    expect(r.json.error).toBe("Verify your email address first, then open this link again.");
    await db.prepare("UPDATE users SET email_verified_at = ?1 WHERE id = ?2").bind(now(), u.id).run();
    expect((await call("/me/invitations/accept", { token: u.token, body: { token: inv.token } })).status).toBe(200);
  });

  it("the address match ignores case and look-alike forms", async () => {
    const a = await club();
    const u = await verified();
    const inv = await invite(a.orgId, a.token, u.email.toUpperCase());
    expect((await call("/me/invitations/accept", { token: u.token, body: { token: inv.token } })).status).toBe(200);
  });

  it("a second invitation for the same address replaces the open one; the database also refuses two open rows", async () => {
    const a = await club();
    const first = await invite(a.orgId, a.token, "dup@example.com");
    const second = await invite(a.orgId, a.token, "dup@example.com");
    expect(await one("SELECT COUNT(*) FROM invitations WHERE org_id = ?1 AND email = 'dup@example.com' AND revoked_at IS NULL AND accepted_at IS NULL", a.orgId)).toBe(1);
    const u = await verified();
    await db.prepare("UPDATE users SET email = 'dup@example.com' WHERE id = ?1").bind(u.id).run();
    expect((await call("/me/invitations/accept", { token: u.token, body: { token: first.token } })).status).toBe(404); // replaced = revoked
    expect((await call("/me/invitations/accept", { token: u.token, body: { token: second.token } })).status).toBe(200);
    // backstop: the unique pending index
    const t = new Date().toISOString();
    await db.prepare("INSERT INTO invitations (id, org_id, role, email, token_hash, invited_by, created_at, expires_at) VALUES ('i1', ?1, 'member', 'idx@example.com', 'h1', 'x', ?2, ?2)").bind(a.orgId, t).run();
    await expect(db.prepare("INSERT INTO invitations (id, org_id, role, email, token_hash, invited_by, created_at, expires_at) VALUES ('i2', ?1, 'member', 'idx@example.com', 'h2', 'x', ?2, ?2)").bind(a.orgId, t).run()).rejects.toThrow();
  });

  it("roles: only admin or member can be invited into a club; the check constraint refuses anything else", async () => {
    const a = await club();
    for (const role of ["owner", "editor", "viewer", "root", "", undefined]) {
      expect((await call(`/orgs/${a.orgId}/invitations`, { token: a.token, body: { email: "r@example.com", role } })).status, String(role)).toBe(400);
    }
    expect((await call(`/orgs/${a.orgId}/invitations`, { token: a.token, body: { email: "not an email", role: "member" } })).status).toBe(400);
    await expect(db.prepare("INSERT INTO invitations (id, org_id, role, email, token_hash, invited_by, created_at, expires_at) VALUES ('bad', ?1, 'editor', 'z@example.com', 'hz', 'x', 't', 't')").bind(a.orgId).run()).rejects.toThrow();
  });
});

describe("escalation: who may invite", () => {
  it("a member cannot invite, list or revoke; a stranger gets the same 404 as a missing club; an admin can", async () => {
    const a = await club();
    const m = await joined(a, "member");
    const stranger = await verified();
    const body = { email: "x@example.com", role: "member" };
    expect((await call(`/orgs/${a.orgId}/invitations`, { token: m.token, body })).status).toBe(403);
    expect((await call(`/orgs/${a.orgId}/invitations`, { token: m.token })).status).toBe(403);
    const inv = await invite(a.orgId, a.token, "later@example.com");
    expect((await call(`/orgs/${a.orgId}/invitations/${inv.id}`, { method: "DELETE", token: m.token })).status).toBe(403);
    const missing = await call(`/orgs/org-does-not-exist/invitations`, { token: stranger.token, body });
    const foreign = await call(`/orgs/${a.orgId}/invitations`, { token: stranger.token, body });
    expect(foreign.status).toBe(404);
    expect(foreign.json).toEqual(missing.json);
    expect((await call(`/orgs/${a.orgId}/invitations`, { token: a.token, body })).status).toBe(201);
  });

  it("an invitation whose inviter is no longer an admin cannot be used", async () => {
    const a = await club();
    const second = await joined(a, "admin", "Second Admin");
    const u = await verified();
    const inv = await invite(a.orgId, second.token, u.email);
    expect((await call(`/orgs/${a.orgId}/members/${second.id}`, { method: "DELETE", token: a.token })).status).toBe(200);
    const r = await call("/me/invitations/accept", { token: u.token, body: { token: inv.token } });
    expect(r.status).toBe(409);
    expect(await one("SELECT COUNT(*) FROM org_members WHERE org_id = ?1 AND user_id = ?2", a.orgId, u.id)).toBe(0);
  });
});

describe("event guest invitations (POST /events/:id/members with the flag on)", () => {
  it("answers the same whether or not an account exists, and adds nobody until accepted", async () => {
    const o = await verified();
    const ev = await newEvent(o.token);
    const existing = await newUser("Has Account");
    const withAccount = await call(`/events/${ev.id}/members`, { token: o.token, body: { email: existing.email, role: "viewer" } });
    const noAccount = await call(`/events/${ev.id}/members`, { token: o.token, body: { email: `ghost-${Date.now()}@example.com`, role: "viewer" } });
    expect(withAccount.status).toBe(201);
    expect(noAccount.status).toBe(201);
    expect(Object.keys(withAccount.json).sort()).toEqual(Object.keys(noAccount.json).sort());
    expect(withAccount.json.pending).toBe(true);
    expect(noAccount.json.pending).toBe(true);
    expect(withAccount.json.role).toBe(noAccount.json.role);
    expect(await one("SELECT COUNT(*) FROM event_members WHERE event_id = ?1", ev.id)).toBe(0);
    expect(withAccount.text).not.toContain(existing.id);
  });

  it("accept needs a verified, matching email; then the guest sees the event with the invited role; a second use is refused", async () => {
    const o = await verified();
    const ev = await newEvent(o.token);
    const g = await newUser("Guest");
    const r = await call(`/events/${ev.id}/members`, { token: o.token, body: { email: g.email, role: "editor" } });
    expect((await call("/me/invitations/accept", { token: g.token, body: { token: r.json.token } })).json.code).toBe("email_unverified");
    await db.prepare("UPDATE users SET email_verified_at = ?1 WHERE id = ?2").bind(now(), g.id).run();
    const wrong = await verified();
    expect((await call("/me/invitations/accept", { token: wrong.token, body: { token: r.json.token } })).json.code).toBe("wrong_email");
    const ok = await call("/me/invitations/accept", { token: g.token, body: { token: r.json.token } });
    expect(ok.status).toBe(200);
    expect(ok.json).toEqual({ ok: true, kind: "event", eventId: ev.id, role: "editor" });
    expect((await call(`/events/${ev.id}`, { token: g.token })).status).toBe(200);
    expect((await call("/me/invitations/accept", { token: g.token, body: { token: r.json.token } })).json.code).toBe("invitation_used");
    expect(await one("SELECT COUNT(*) FROM event_members WHERE event_id = ?1 AND user_id = ?2 AND role = 'editor'", ev.id, g.id)).toBe(1);
  });

  it("only the event owner invites guests; an editor cannot, a stranger gets 404; roles other than editor or viewer are refused", async () => {
    const o = await verified();
    const ev = await newEvent(o.token);
    const editor = await verified();
    const inv = await call(`/events/${ev.id}/members`, { token: o.token, body: { email: editor.email, role: "editor" } });
    expect((await call("/me/invitations/accept", { token: editor.token, body: { token: inv.json.token } })).status).toBe(200);
    expect((await call(`/events/${ev.id}/members`, { token: editor.token, body: { email: "a@example.com", role: "viewer" } })).status).toBe(403);
    const stranger = await verified();
    expect((await call(`/events/${ev.id}/members`, { token: stranger.token, body: { email: "a@example.com", role: "viewer" } })).status).toBe(404);
    for (const role of ["owner", "admin", "member"]) expect((await call(`/events/${ev.id}/members`, { token: o.token, body: { email: "a@example.com", role } })).status, role).toBe(400);
  });

  it("an owner who accepts their own guest invitation consumes it and gains nothing", async () => {
    const o = await verified();
    const ev = await newEvent(o.token);
    const inv = await call(`/events/${ev.id}/members`, { token: o.token, body: { email: o.email, role: "viewer" } });
    const r = await call("/me/invitations/accept", { token: o.token, body: { token: inv.json.token } });
    expect(r.status).toBe(200);
    expect(r.json.role).toBe("owner");
    expect(await one("SELECT COUNT(*) FROM event_members WHERE event_id = ?1", ev.id)).toBe(0);
  });
});

describe("rate limits and audit", () => {
  it("accept is rate limited per address", async () => {
    const u = await verified();
    const ip = "203.0.113.77";
    let last = 0;
    for (let i = 0; i < 22; i++) last = (await call("/me/invitations/accept", { token: u.token, body: { token: "z".repeat(30) }, ip })).status;
    expect(last).toBe(429);
  });

  it("creating, accepting and revoking leave audit rows with ids only (no email, no token)", async () => {
    const a = await club();
    const u = await verified();
    const inv = await invite(a.orgId, a.token, u.email, "member");
    await call("/me/invitations/accept", { token: u.token, body: { token: inv.token } });
    const second = await invite(a.orgId, a.token, "gone@example.com");
    await call(`/orgs/${a.orgId}/invitations/${second.id}`, { method: "DELETE", token: a.token });
    const rows = (await db.prepare("SELECT action, actor_id, target_id, meta FROM audit_log WHERE org_id = ?1 ORDER BY id").bind(a.orgId).all<{ action: string; actor_id: string; target_id: string; meta: string }>()).results;
    expect(rows.map((r) => r.action)).toEqual(["org.converted", "invitation.created", "invitation.accepted", "member.added", "invitation.created", "invitation.revoked"]);
    const text = JSON.stringify(rows);
    expect(text).not.toContain("@");
    expect(text).not.toContain(inv.token);
    expect(JSON.parse(rows[1]!.meta)).toEqual({ role: "member" });
    void env;
  });
});
