import type { MiddlewareHandler } from "hono";
import type { AppBindings, EventRow } from "./types";
import { enforceMethod, requireCap, resolveEvent, type EventAccess } from "./policy/access";
import { pwFingerprint, sha256, timingSafeEqual, verifyJwt } from "./crypto";
import { HttpError, rateLimit, type Ctx } from "./http";

export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.get("userId")) return next(); // already verified by an earlier middleware
  if (!c.env.JWT_SECRET) throw new HttpError(500, "Server misconfigured");
  const h = c.req.header("authorization") ?? "";
  const m = /^Bearer (\S+)$/.exec(h);
  const claims = m ? await verifyJwt(m[1]!, c.env.JWT_SECRET) : null;
  if (!claims) throw new HttpError(401, "Authentication required");
  // A token outlives its account (7 days), so confirm the user still exists: a deleted account must not keep working or create orphan rows.
  // The same row carries the password fingerprint: a token issued before a password change no longer matches.
  const u = await c.env.DB.prepare("SELECT pw_hash, pw_salt, status FROM users WHERE id = ?").bind(claims.sub).first<{ pw_hash: string; pw_salt: string; status: string }>();
  if (!u || !timingSafeEqual(await pwFingerprint(u), claims.pv)) throw new HttpError(401, "Authentication required");
  // Suspended or pending-deletion accounts get 401 everywhere; only GET /me answers 403 with a code so the app can explain.
  if (u.status !== "active") {
    if (c.req.method === "GET" && c.req.path === "/me") throw new HttpError(403, "This account is not active", { code: u.status === "suspended" ? "account_suspended" : "deletion_pending" });
    throw new HttpError(401, "Authentication required");
  }
  c.set("userId", claims.sub);
  await next();
};

export type { EventRole } from "./policy/roles";

/**
 * Loads an event for the signed-in user if they own it or have been given access to it; otherwise 404 (never reveals existence).
 * A viewer may only read: any other method is refused with 403.
 * The decision lives in src/policy (flag authz.mode: legacy by default, shadow, org); this is a compatibility wrapper.
 */
export async function accessibleEvent(c: Ctx, id: string): Promise<EventAccess> {
  const row = await resolveEvent(c, id);
  enforceMethod(row,c.req.method);
  return row;
}

/** Same as accessibleEvent: owner or editor can read and change, a viewer can read. Kept under the old name so every route uses it. */
export const ownedEvent = accessibleEvent;

/** Only the owner: deleting the event (capability event.delete). */
export async function ownerEvent(c: Ctx, id: string): Promise<EventRow> {
  const row = await accessibleEvent(c, id);
  requireCap(row, "event.delete", "Only the owner of the event can do this");
  return row;
}

/** Only the owner: managing who else has access (capability event.members.manage). A second shim so the two can diverge later; today identical. */
export async function ownerEventMembers(c: Ctx, id: string): Promise<EventRow> {
  const row = await accessibleEvent(c, id);
  requireCap(row, "event.members.manage", "Only the owner of the event can do this");
  return row;
}
/** X-Gate-Key auth: sets the event id the key is scoped to. Revoked/expired/unknown => 401. */
export const requireGate: MiddlewareHandler<AppBindings> = async (c, next) => {
  const key = c.req.header("x-gate-key");
  if (!key || key.length > 128) { await rateLimit(c, "gatefail", 20, 600); throw new HttpError(401, "Valid gate key required"); }
  const row = await c.env.DB.prepare("SELECT id, event_id, label FROM gate_keys WHERE key_hash = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?)")
    .bind(await sha256(key), new Date().toISOString())
    .first<{ id: string; event_id: string; label: string }>();
  // Guessing keys is throttled: after 20 wrong tries from one address in 10 minutes, that address is refused for the rest of the window.
  if (!row) { await rateLimit(c, "gatefail", 20, 600); throw new HttpError(401, "Valid gate key required"); }
  c.set("gateEventId", row.event_id);
  c.set("gateKeyId", row.id);
  c.set("gateLabel", row.label);
  await next();
};
