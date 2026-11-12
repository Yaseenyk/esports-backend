import { HttpError, ID_RE, type Ctx } from "../http";
import { sha256 } from "../crypto";
import { requireOrg } from "../orgs/access";
import { myEvents } from "../routes/events";
import { ANALYTICS_MONTHS_MAX, can, subjectOf } from "../plans";

/**
 * Counts-only analytics (Phase 4) and the numbers behind the public API (Phase 6). ONE builder, so the API can never show more than the dashboard.
 *
 * Privacy: every statement returns COUNTS and the event's own public metadata (id, key, name, game, date, start day, created day). No registration row,
 * team name, captain, player, contact, photo, check-in person or minors flag is ever selected. Tool usage is NOT included: metrics_daily is platform-wide
 * with no event or organisation on it, so there is nothing that belongs to one organisation.
 * Cost: ONE db.batch of five bounded statements, zero writes. Scope is "this organisation OR these event ids" in constant SQL (ids travel as one JSON text).
 */
export interface Scope { orgId: string; ids: string[]; fromTs: string }

export interface EventCounts {
  id: string; key: string; name: string; game: string; date: string; startsOn: string | null; createdAt: string;
  registrations: { total: number; pending: number; approved: number }; checkIns: number; liveViews: number;
}
export interface Analytics {
  events: { total: number; byMonth: { month: string; count: number }[] };
  registrations: { total: number; byStatus: Record<string, number> };
  checkIns: { total: number };
  liveViews: { total: number; bySource: Record<string, number> };
  perEvent: EventCounts[];
}

interface PerRow { id: string; slug: string; name: string; game: string; date: string; starts_on: string | null; created_at: string; reg_total: number; reg_pending: number; reg_approved: number; checkins: number; hits: number }

export async function buildAnalytics(db: D1Database, s: Scope): Promise<Analytics> {
  const ids = JSON.stringify(s.ids.slice(0, 200));
  const res = await db.batch([
    db.prepare("SELECT substr(e.created_at, 1, 7) AS month, COUNT(*) AS n FROM events e WHERE (e.org_id = ?1 OR e.id IN (SELECT value FROM json_each(?2))) AND e.created_at >= ?3 GROUP BY month ORDER BY month LIMIT 13").bind(s.orgId, ids, s.fromTs),
    db.prepare("SELECT r.status AS status, COUNT(*) AS n FROM registrations r JOIN events e ON e.id = r.event_id WHERE (e.org_id = ?1 OR e.id IN (SELECT value FROM json_each(?2))) AND e.created_at >= ?3 GROUP BY r.status LIMIT 10").bind(s.orgId, ids, s.fromTs),
    db.prepare("SELECT h.source AS source, SUM(h.hits) AS n FROM live_hits h JOIN events e ON e.id = h.event_id WHERE (e.org_id = ?1 OR e.id IN (SELECT value FROM json_each(?2))) AND e.created_at >= ?3 GROUP BY h.source LIMIT 3").bind(s.orgId, ids, s.fromTs),
    db.prepare("SELECT COUNT(*) AS n FROM checkins c JOIN events e ON e.id = c.event_id WHERE (e.org_id = ?1 OR e.id IN (SELECT value FROM json_each(?2))) AND e.created_at >= ?3").bind(s.orgId, ids, s.fromTs),
    db.prepare("SELECT e.id AS id, e.slug AS slug, e.name AS name, e.game AS game, e.date AS date, e.starts_on AS starts_on, e.created_at AS created_at, (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id) AS reg_total, (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'pending') AS reg_pending, (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'approved') AS reg_approved, (SELECT COUNT(*) FROM checkins c WHERE c.event_id = e.id) AS checkins, (SELECT COALESCE(SUM(h.hits), 0) FROM live_hits h WHERE h.event_id = e.id) AS hits FROM events e WHERE (e.org_id = ?1 OR e.id IN (SELECT value FROM json_each(?2))) AND e.created_at >= ?3 ORDER BY e.created_at DESC, e.id DESC LIMIT 50").bind(s.orgId, ids, s.fromTs),
  ]);
  const byMonth = (res[0]!.results as unknown as { month: string; n: number }[]).map((r) => ({ month: r.month, count: r.n }));
  const byStatus: Record<string, number> = {};
  for (const r of res[1]!.results as unknown as { status: string; n: number }[]) byStatus[r.status] = r.n;
  const bySource: Record<string, number> = {};
  for (const r of res[2]!.results as unknown as { source: string; n: number }[]) bySource[r.source] = r.n;
  const sum = (o: Record<string, number>) => Object.values(o).reduce((a, n) => a + n, 0);
  return {
    events: { total: byMonth.reduce((a, m) => a + m.count, 0), byMonth },
    registrations: { total: sum(byStatus), byStatus },
    checkIns: { total: (res[3]!.results as unknown as { n: number }[])[0]?.n ?? 0 },
    liveViews: { total: sum(bySource), bySource },
    perEvent: (res[4]!.results as unknown as PerRow[]).map((r) => ({
      id: r.id, key: r.slug, name: r.name, game: r.game, date: r.date, startsOn: r.starts_on, createdAt: r.created_at,
      registrations: { total: r.reg_total, pending: r.reg_pending, approved: r.reg_approved }, checkIns: r.checkins, liveViews: r.hits,
    })),
  };
}

/** `months` query parameter: a whole number from 1 to 12 (default 12). Returns the window and the first instant of its first month. */
export function parseWindow(q: Record<string, string>, nowMs = Date.now()): { months: number; fromMonth: string; fromTs: string; to: string } {
  let months = ANALYTICS_MONTHS_MAX;
  if (q.months !== undefined) {
    months = Number(q.months);
    if (!Number.isInteger(months) || months < 1 || months > ANALYTICS_MONTHS_MAX) throw new HttpError(400, `months must be a whole number from 1 to ${ANALYTICS_MONTHS_MAX}`);
  }
  const now = new Date(nowMs);
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1));
  const fromMonth = first.toISOString().slice(0, 7);
  return { months, fromMonth, fromTs: `${fromMonth}-01T00:00:00.000Z`, to: now.toISOString().slice(0, 10) };
}

/** JSON with an ETag and a short private cache; answers 304 when If-None-Match matches. No D1 write either way. */
export async function cachedJson(c: Ctx, body: unknown, maxAge = 60): Promise<Response> {
  const text = JSON.stringify(body);
  const etag = `"${(await sha256(text)).slice(0, 27)}"`;
  const headers: Record<string, string> = { etag, "cache-control": `private, max-age=${maxAge}`, vary: "Authorization" };
  const inm = c.req.header("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers });
  return new Response(text, { status: 200, headers: { ...headers, "content-type": "application/json" } });
}

/** GET /orgs/:id/analytics?months= : capability org.read (admin or member). Behind flag orgs.team like every other organisation route. */
export async function orgAnalytics(c: Ctx): Promise<Response> {
  const orgId = c.req.param("id")!;
  if (!ID_RE.test(orgId)) throw new HttpError(404, "Not found");
  const m = await requireOrg(c, orgId, "org.read");
  if (!can(subjectOf("org", orgId), "analytics")) throw new HttpError(403, "Not part of your plan");
  const w = parseWindow(c.req.query());
  const a = await buildAnalytics(c.env.DB, { orgId, ids: [], fromTs: w.fromTs });
  return cachedJson(c, { org: { id: orgId, name: m.name, kind: m.kind }, window: { months: w.months, from: w.fromMonth, to: w.to }, ...a });
}

/** GET /me/analytics?months= : always on. The events the signed-in user created or was added to (the same set as GET /events, newest 200). */
export async function meAnalytics(c: Ctx): Promise<Response> {
  const uid = c.get("userId");
  if (!can(subjectOf("user", uid), "analytics")) throw new HttpError(403, "Not part of your plan");
  const w = parseWindow(c.req.query());
  const mine = await myEvents(c.env.DB, uid, 200);
  const a = await buildAnalytics(c.env.DB, { orgId: "", ids: mine.map((e) => e.id), fromTs: w.fromTs });
  return cachedJson(c, { window: { months: w.months, from: w.fromMonth, to: w.to }, ...a });
}
