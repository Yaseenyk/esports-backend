import type { MiddlewareHandler } from "hono";
import type { AppBindings, EventRow } from "./types";
import { sha256, verifyJwt } from "./crypto";
import { HttpError, rateLimit, type Ctx } from "./http";

export const requireUser: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.get("userId")) return next(); // already verified by an earlier middleware
  if (!c.env.JWT_SECRET) throw new HttpError(500, "Server misconfigured");
  const h = c.req.header("authorization") ?? "";
  const m = /^Bearer (\S+)$/.exec(h);
  const sub = m ? await verifyJwt(m[1]!, c.env.JWT_SECRET) : null;
  if (!sub) throw new HttpError(401, "Authentication required");
  c.set("userId", sub);
  await next();
};

export type EventRole = "owner" | "editor" | "viewer";

/**
 * Loads an event for the signed-in user if they own it or have been given access to it; otherwise 404 (never reveals existence).
 * A viewer may only read: any other method is refused with 403.
 */
export async function accessibleEvent(c: Ctx, id: string): Promise<EventRow & { my_role: EventRole }> {
  const uid = c.get("userId");
  const row = await c.env.DB.prepare(
    "SELECT e.*, CASE WHEN e.owner_id = ?1 THEN 'owner' ELSE m.role END AS my_role FROM events e LEFT JOIN event_members m ON m.event_id = e.id AND m.user_id = ?1 WHERE e.id = ?2 AND (e.owner_id = ?1 OR m.user_id = ?1)",
  ).bind(uid, id).first<EventRow & { my_role: EventRole }>();
  if (!row) throw new HttpError(404, "Event not found");
  if (row.my_role === "viewer" && c.req.method !== "GET") throw new HttpError(403, "You can view this event but not change it");
  return row;
}

/** Same as accessibleEvent: owner or editor can read and change, a viewer can read. Kept under the old name so every route uses it. */
export const ownedEvent = accessibleEvent;

/** Only the owner: deleting the event and managing who else has access. */
export async function ownerEvent(c: Ctx, id: string): Promise<EventRow> {
  const row = await accessibleEvent(c, id);
  if (row.my_role !== "owner") throw new HttpError(403, "Only the owner of the event can do this");
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
