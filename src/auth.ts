import type { MiddlewareHandler } from "hono";
import type { AppBindings, EventRow } from "./types";
import { sha256, verifyJwt } from "./crypto";
import { HttpError, type Ctx } from "./http";

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

/** Loads an event only if the signed-in user owns it; otherwise 404 (never reveals existence). */
export async function ownedEvent(c: Ctx, id: string): Promise<EventRow> {
  const row = await c.env.DB.prepare("SELECT * FROM events WHERE id = ? AND owner_id = ?").bind(id, c.get("userId")).first<EventRow>();
  if (!row) throw new HttpError(404, "Event not found");
  return row;
}

/** X-Gate-Key auth: sets the event id the key is scoped to. Revoked/expired/unknown => 401. */
export const requireGate: MiddlewareHandler<AppBindings> = async (c, next) => {
  const key = c.req.header("x-gate-key");
  if (!key || key.length > 128) throw new HttpError(401, "Valid gate key required");
  const row = await c.env.DB.prepare("SELECT id, event_id FROM gate_keys WHERE key_hash = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?)")
    .bind(await sha256(key), new Date().toISOString())
    .first<{ id: string; event_id: string }>();
  if (!row) throw new HttpError(401, "Valid gate key required");
  c.set("gateEventId", row.event_id);
  c.set("gateKeyId", row.id);
  await next();
};
