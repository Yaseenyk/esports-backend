import { Hono } from "hono";
import type { AppBindings } from "../types";
import { HttpError, ID_RE, rateLimitSoft, type Ctx } from "../http";
import { hashToken } from "../links";
import { resolveEvent } from "../policy/access";
import { myEvents } from "../routes/events";
import { can, subjectOf } from "../plans";
import { buildAnalytics, cachedJson } from "./analytics";
import { isKeyShape } from "./keys";

/**
 * Read-only public API v1 (Phase 6). `Authorization: Bearer ehk_...` only; a user token does not work here and an API key works nowhere else.
 * Returns event metadata and COUNTS (the same builder as the dashboard): never rosters, people, photos, registrations or contact details.
 * Limited to the key owner's own events through the same access rules as the app. CORS is closed (see src/index.ts). There is no read kill key in
 * src/admin/kill.ts (kill.public_writes does not apply to GET), so the emergency stop is revoking keys; no webhooks (docs/ecosystem/phase6-notes.md).
 * Zero D1 writes except last_used_at, at most once an hour per key.
 */
export const v1 = new Hono<AppBindings>();
const HOUR_MS = 3_600_000;
const SOFT_LIMIT = 60; // requests per minute, per key per address (in-memory, per isolate)

v1.use("/api/v1/*", async (c, next) => {
  if (c.req.method !== "GET") throw new HttpError(404, "Not found");
  rateLimitSoft(c, "api.v1.auth", 120, 60);
  const m = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "");
  if (!m || !isKeyShape(m[1]!)) throw new HttpError(401, "A valid API key is required");
  const row = await c.env.DB.prepare("SELECT k.id AS id, k.user_id AS user_id, k.last_used_at AS last_used_at FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?1 AND k.revoked_at IS NULL AND u.status = 'active'").bind(await hashToken(m[1]!)).first<{ id: string; user_id: string; last_used_at: string | null }>();
  if (!row) throw new HttpError(401, "A valid API key is required");
  rateLimitSoft(c, "api.v1", SOFT_LIMIT, 60, row.id);
  if (!can(subjectOf("user", row.user_id), "api_read")) throw new HttpError(403, "Not part of your plan");
  const now = Date.now();
  if (!row.last_used_at || now - Date.parse(row.last_used_at) >= HOUR_MS) {
    try {
      await c.env.DB.prepare("UPDATE api_keys SET last_used_at = ?1 WHERE id = ?2").bind(new Date(now).toISOString(), row.id).run();
    } catch {
      /* best effort: a failed touch never blocks a read */
    }
  }
  c.set("userId", row.user_id);
  await next();
});

v1.get("/api/v1/events", async (c: Ctx) => {
  const mine = await myEvents(c.env.DB, c.get("userId"), 50);
  const a = await buildAnalytics(c.env.DB, { orgId: "", ids: mine.map((e) => e.id), fromTs: "" });
  return cachedJson(c, { events: a.perEvent });
});

v1.get("/api/v1/events/:id/summary", async (c: Ctx) => {
  const id = c.req.param("id")!;
  if (!ID_RE.test(id)) throw new HttpError(404, "Event not found");
  await resolveEvent(c, id); // the app's own access rules; 404 for an event the key owner cannot see
  const a = await buildAnalytics(c.env.DB, { orgId: "", ids: [id], fromTs: "" });
  const e = a.perEvent[0];
  if (!e) throw new HttpError(404, "Event not found");
  const { registrations, checkIns, liveViews, ...meta } = e;
  return cachedJson(c, { event: meta, counts: { registrations: { ...registrations, byStatus: a.registrations.byStatus }, checkIns, liveViews: { total: liveViews, bySource: a.liveViews.bySource } } });
});
