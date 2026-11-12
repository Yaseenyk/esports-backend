import { audit } from "../audit";
import { randomToken } from "../crypto";
import { HttpError, nowIso, rateLimit, rateLimitSubject, readJson, str, type Ctx } from "../http";
import { hashToken } from "../links";
import { DEFAULT_APP_URL } from "../mailer";
import { emitStmt } from "../metrics";
import { ownerEvent } from "../auth";
import { canGrantGuestRole, canGrantOrgRole, isOrgRole, type OrgRole } from "../policy/roles";
import { maskEmail } from "../features/reminders";
import { normEmail } from "../routes/auth";
import { requireOrg } from "./access";

/**
 * Invitations (blueprint 11.4, 15.4, PM review r2 N2). One table for organisation invitations (admin or member) and event guest invitations (editor or viewer).
 *
 *  - The token is 24 random bytes. Only SHA-256 of it (src/links.ts hashToken) is stored; the clear token is shown once to the inviter, as a copyable link.
 *    Nothing is mailed by default.
 *  - 7 days, single use, revocable. The invited address is blanked when the invitation is used, and purged 14 days after expiry (housekeeping).
 *  - Creating one never looks at whether an account exists for the address, so the response is the same either way.
 *  - Accepting needs a signed-in user whose email is VERIFIED and equal to the invited address.
 *  - The pending unique index (migration 0045) is the backstop; a new invitation for the same address replaces the open one (that is also "Change email": revoke and reissue).
 */
export const INVITE_TTL_MS = 7 * 86_400_000;
export const MAX_PENDING_INVITES = 100;
export const MAX_ORG_MEMBERS = 50;
export const MAX_ORGS_PER_USER = 10;

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

function inviteEmail(v: unknown): string {
  const e = normEmail(str(v, "email", 3, 254));
  if (!EMAIL_RE.test(e)) throw new HttpError(400, "email is not valid");
  return e;
}

export function inviteLink(env: { APP_URL?: string }, token: string): string {
  const base = (env.APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "");
  return `${base}/join/?t=${token}`;
}

interface Fresh { id: string; token: string; hash: string; now: string; expiresAt: string }
async function fresh(): Promise<Fresh> {
  const token = randomToken(24);
  const now = nowIso();
  return { id: crypto.randomUUID(), token, hash: await hashToken(token), now, expiresAt: new Date(Date.now() + INVITE_TTL_MS).toISOString() };
}

const created = (c: Ctx, f: Fresh, email: string, role: string) =>
  ({ id: f.id, email, role, createdAt: f.now, expiresAt: f.expiresAt, token: f.token, link: inviteLink(c.env, f.token) });

// ---------- organisation invitations ----------
/** POST /orgs/:id/invitations { email, role }. Capability org.people.manage. */
export async function createOrgInvitation(c: Ctx): Promise<Response> {
  const orgId = c.req.param("id")!;
  const me = await requireOrg(c, orgId, "org.people.manage", { write: true });
  await rateLimit(c, "invite", 30, 3600);
  await rateLimitSubject(c, "invite-user", c.get("userId"), 60, 3600);
  const b = await readJson(c);
  const email = inviteEmail(b.email);
  if (!isOrgRole(b.role)) throw new HttpError(400, "role must be admin or member");
  const role: OrgRole = b.role;
  if (!canGrantOrgRole(me.role, role)) throw new HttpError(403, "You cannot give someone a role higher than your own");
  const counts = await c.env.DB
    .prepare("SELECT (SELECT COUNT(*) FROM org_members WHERE org_id = ?1) AS members, (SELECT COUNT(*) FROM invitations WHERE org_id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2) AS pending")
    .bind(orgId, nowIso())
    .first<{ members: number; pending: number }>();
  if ((counts?.members ?? 0) >= MAX_ORG_MEMBERS || (counts?.pending ?? 0) >= MAX_PENDING_INVITES) throw new HttpError(409, `A club can have up to ${MAX_ORG_MEMBERS} people and ${MAX_PENDING_INVITES} open invitations.`, { code: "limit_reached" });
  const f = await fresh();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE invitations SET revoked_at = ?1 WHERE org_id = ?2 AND email = ?3 AND accepted_at IS NULL AND revoked_at IS NULL").bind(f.now, orgId, email),
      c.env.DB.prepare("INSERT INTO invitations (id, org_id, event_id, role, email, token_hash, invited_by, created_at, expires_at) VALUES (?1, ?2, NULL, ?3, ?4, ?5, ?6, ?7, ?8)").bind(f.id, orgId, role, email, f.hash, c.get("userId"), f.now, f.expiresAt),
    ]);
  } catch {
    throw new HttpError(409, "There is already an open invitation for this address. Try again in a moment.", { code: "invitation_pending" });
  }
  await audit(c.env.DB, { action: "invitation.created", actorType: "user", actorId: c.get("userId"), orgId, targetType: "invitation", targetId: f.id, meta: { role } });
  c.header("cache-control", "no-store");
  return c.json(created(c, f, email, role), 201);
}

/** GET /orgs/:id/invitations: the open ones, with the address they were sent for (People shows it, so a wrong address can be fixed). Link is never shown again. */
export async function listOrgInvitations(c: Ctx): Promise<Response> {
  const orgId = c.req.param("id")!;
  await requireOrg(c, orgId, "org.people.manage");
  const now = nowIso();
  const rows = await c.env.DB
    .prepare("SELECT i.id AS id, i.email AS email, i.role AS role, i.created_at AS created_at, i.expires_at AS expires_at, u.name AS invited_by_name FROM invitations i LEFT JOIN users u ON u.id = i.invited_by WHERE i.org_id = ?1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL ORDER BY i.created_at DESC, i.id LIMIT 100")
    .bind(orgId)
    .all<{ id: string; email: string; role: string; created_at: string; expires_at: string; invited_by_name: string | null }>();
  c.header("cache-control", "private, no-store");
  return c.json({ invitations: rows.results.map((r) => ({ id: r.id, email: r.email, role: r.role, createdAt: r.created_at, expiresAt: r.expires_at, expired: r.expires_at <= now, invitedBy: r.invited_by_name })) });
}

/** DELETE /orgs/:id/invitations/:iid: revoke an open invitation. */
export async function revokeOrgInvitation(c: Ctx): Promise<Response> {
  const orgId = c.req.param("id")!;
  await requireOrg(c, orgId, "org.people.manage", { write: true });
  const iid = c.req.param("iid")!;
  const r = await c.env.DB.prepare("UPDATE invitations SET revoked_at = ?1 WHERE id = ?2 AND org_id = ?3 AND accepted_at IS NULL AND revoked_at IS NULL").bind(nowIso(), iid, orgId).run();
  if ((r.meta.changes ?? 0) === 0) throw new HttpError(404, "Not found");
  await audit(c.env.DB, { action: "invitation.revoked", actorType: "user", actorId: c.get("userId"), orgId, targetType: "invitation", targetId: iid });
  return c.json({ ok: true });
}

// ---------- event guest invitations (POST /events/:id/members with flag orgs.team on) ----------
/**
 * The owner of an event invites a guest by email. Creates a pending invitation; the answer is the same whether or not an account exists for the address.
 * Called by routes/members.ts after it has authorised the owner and rate limited.
 */
export async function createEventInvitation(c: Ctx, eventId: string, orgId: string | null, rawEmail: unknown, rawRole: unknown): Promise<Response> {
  const email = inviteEmail(rawEmail);
  if (rawRole !== "editor" && rawRole !== "viewer") throw new HttpError(400, "role must be editor or viewer");
  const role: "editor" | "viewer" = rawRole;
  if (!canGrantGuestRole("owner", role)) throw new HttpError(403, "You cannot give that role");
  const pending = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM invitations WHERE event_id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2").bind(eventId, nowIso()).first<{ n: number }>();
  if ((pending?.n ?? 0) >= MAX_PENDING_INVITES) throw new HttpError(409, `An event can have up to ${MAX_PENDING_INVITES} open invitations.`, { code: "limit_reached" });
  const f = await fresh();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE invitations SET revoked_at = ?1 WHERE event_id = ?2 AND email = ?3 AND accepted_at IS NULL AND revoked_at IS NULL").bind(f.now, eventId, email),
      c.env.DB.prepare("INSERT INTO invitations (id, org_id, event_id, role, email, token_hash, invited_by, created_at, expires_at) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").bind(f.id, eventId, role, email, f.hash, c.get("userId"), f.now, f.expiresAt),
    ]);
  } catch {
    throw new HttpError(409, "There is already an open invitation for this address. Try again in a moment.", { code: "invitation_pending" });
  }
  await audit(c.env.DB, { action: "invitation.created", actorType: "user", actorId: c.get("userId"), orgId, eventId, targetType: "invitation", targetId: f.id, meta: { role } });
  c.header("cache-control", "no-store");
  return c.json({ ...created(c, f, email, role), pending: true }, 201);
}

// ---------- accept ----------
interface InviteRow { id: string; org_id: string | null; event_id: string | null; role: string; email: string; expires_at: string; accepted_at: string | null; revoked_at: string | null }

const GONE = "This invitation can no longer be used. Ask your admin for a new link.";

/** POST /me/invitations/accept { token }. A signed-in user with a verified email equal to the invited address. Single use. */
export async function acceptInvitation(c: Ctx): Promise<Response> {
  const uid = c.get("userId");
  const db = c.env.DB;
  await rateLimit(c, "invaccept", 20, 3600);
  await rateLimitSubject(c, "invaccept-user", uid, 20, 3600);
  const b = await readJson(c);
  const token = typeof b.token === "string" ? b.token : "";
  if (!TOKEN_RE.test(token)) throw new HttpError(404, GONE, { code: "invitation_invalid" });
  const inv = await db
    .prepare("SELECT id, org_id, event_id, role, email, expires_at, accepted_at, revoked_at FROM invitations WHERE token_hash = ?1")
    .bind(await hashToken(token))
    .first<InviteRow>();
  if (!inv || inv.revoked_at) throw new HttpError(404, GONE, { code: "invitation_invalid" });
  if (inv.accepted_at) throw new HttpError(409, "This invitation has already been used.", { code: "invitation_used" });
  const now = nowIso();
  if (inv.expires_at <= now) throw new HttpError(409, "This invitation has expired. Ask your admin for a new one.", { code: "invitation_expired" });

  const u = await db.prepare("SELECT email, email_verified_at FROM users WHERE id = ?1").bind(uid).first<{ email: string; email_verified_at: string | null }>();
  if (!u) throw new HttpError(401, "Authentication required");
  if (!u.email_verified_at) throw new HttpError(403, "Verify your email address first, then open this link again.", { code: "email_unverified" });
  if (normEmail(u.email) !== normEmail(inv.email)) {
    // N2: say whose address it was for (masked), and what to do, in words a busy organiser can act on.
    const hint = maskEmail(inv.email);
    throw new HttpError(403, `This invitation was sent for ${hint}. Sign in with that address, or ask your admin to invite the one you use.`, { code: "wrong_email", invitedHint: hint });
  }

  if (inv.org_id) {
    const orgId = inv.org_id;
    const lim = await db
      .prepare("SELECT (SELECT COUNT(*) FROM org_members WHERE org_id = ?1) AS members, (SELECT COUNT(*) FROM org_members WHERE user_id = ?2) AS mine, EXISTS (SELECT 1 FROM org_members WHERE org_id = ?1 AND user_id = ?2) AS already")
      .bind(orgId, uid)
      .first<{ members: number; mine: number; already: number }>();
    if (!lim?.already && ((lim?.members ?? 0) >= MAX_ORG_MEMBERS || (lim?.mine ?? 0) >= MAX_ORGS_PER_USER)) {
      throw new HttpError(409, (lim?.members ?? 0) >= MAX_ORG_MEMBERS ? `This club already has ${MAX_ORG_MEMBERS} people.` : `You belong to ${MAX_ORGS_PER_USER} clubs already.`, { code: "limit_reached" });
    }
    // Single use is decided by the first statement; the second runs only if it changed a row (changes() = 1). The inviter must still be an admin and the club active.
    const res = await db.batch([
      db.prepare("UPDATE invitations SET accepted_at = ?1, email = '' WHERE id = ?2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?1 AND EXISTS (SELECT 1 FROM org_members a WHERE a.org_id = invitations.org_id AND a.user_id = invitations.invited_by AND a.role = 'admin') AND EXISTS (SELECT 1 FROM organisations o WHERE o.id = invitations.org_id AND o.status = 'active')").bind(now, inv.id),
      db.prepare("INSERT OR IGNORE INTO org_members (org_id, user_id, role, added_by, added_at) SELECT org_id, ?1, role, invited_by, ?2 FROM invitations WHERE id = ?3 AND changes() = 1").bind(uid, now, inv.id),
    ]);
    if ((res[0]!.meta.changes ?? 0) !== 1) throw new HttpError(409, GONE, { code: "invitation_invalid" });
    const mine = await db.prepare("SELECT role FROM org_members WHERE org_id = ?1 AND user_id = ?2").bind(orgId, uid).first<{ role: string }>();
    await audit(db, { action: "invitation.accepted", actorType: "user", actorId: uid, orgId, targetType: "invitation", targetId: inv.id });
    if (!lim?.already) await audit(db, { action: "member.added", actorType: "user", actorId: uid, orgId, targetType: "user", targetId: uid, meta: { role: inv.role as OrgRole } });
    await countAccepted(db, "org");
    return c.json({ ok: true, kind: "org", orgId, role: mine?.role ?? inv.role });
  }

  const eventId = inv.event_id!;
  // The event's creator is already above any guest role: the invitation is consumed and nothing is added.
  let isOwner = false;
  try {
    await ownerEvent(c, eventId); // owner or club admin: already above any guest role
    isOwner = true;
  } catch {
    /* no access yet: the normal case */
  }
  const consume = db.prepare("UPDATE invitations SET accepted_at = ?1, email = '' WHERE id = ?2 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?1").bind(now, inv.id);
  const res = isOwner
    ? await db.batch([consume])
    : await db.batch([
        consume,
        db
          .prepare("INSERT INTO event_members (event_id, user_id, role, added_at) SELECT event_id, ?1, role, ?2 FROM invitations WHERE id = ?3 AND changes() = 1 ON CONFLICT (event_id, user_id) DO UPDATE SET role = CASE WHEN event_members.role = 'editor' THEN 'editor' ELSE excluded.role END")
          .bind(uid, now, inv.id),
      ]);
  if ((res[0]!.meta.changes ?? 0) !== 1) throw new HttpError(409, GONE, { code: "invitation_invalid" });
  const role = isOwner ? "owner" : ((await db.prepare("SELECT role FROM event_members WHERE event_id = ?1 AND user_id = ?2").bind(eventId, uid).first<{ role: string }>())?.role ?? inv.role);
  await audit(db, { action: "invitation.accepted", actorType: "user", actorId: uid, eventId, targetType: "invitation", targetId: inv.id });
  if (!isOwner) await audit(db, { action: "event.guest_added", actorType: "user", actorId: uid, eventId, targetType: "user", targetId: uid, meta: { role: inv.role as "editor" | "viewer" } });
  await countAccepted(db, "event");
  return c.json({ ok: true, kind: "event", eventId, role });
}

async function countAccepted(db: D1Database, kind: "org" | "event"): Promise<void> {
  try {
    await emitStmt(db, "invite_accepted", kind).run();
  } catch {
    /* counts only, never blocks the product */
  }
}
