import { Hono } from "hono";
import type { AppBindings } from "../types";
import { HttpError, rateLimitSoft, rateLimitSubject, readJson } from "../http";
import { ownedEvent, requireUser } from "../auth";
import type { RouteRules } from "./types";

/**
 * Privacy-friendly page-load counters. A hit increments one number per (event, UTC day, source, view).
 * Every call counts as one page load (the client sends one hit per load), so the number is page loads, not people.
 * The visitor's address is used only for an in-memory rate limit (no database write); no visitor is ever stored in live_hits.
 * A hit costs at most one database write: the counter upsert.
 */
export const routes = new Hono<AppBindings>();

const SOURCES = ["live", "overlay", "embed"] as const;
type Source = (typeof SOURCES)[number];
const SLUG_RE = /^[a-z2-7]{12}$/;
const VIEW_RE = /^[a-z0-9_-]{0,20}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 90;
const DAY_MS = 86_400_000;

export const routeRules: RouteRules = {
  "POST /public/hit/:slug": { public: true, limit: "60/minute per address, in memory (no database write); every accepted call counts as one page load" },
  "GET /events/:id/sponsor-report": { roles: ["owner", "editor", "viewer"], limit: "120/hour/user" },
};

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

routes.post("/public/hit/:slug", async (c) => {
  rateLimitSoft(c, "hit", 60, 60);
  const b = await readJson(c, 512);
  const source = b.source;
  if (typeof source !== "string" || !(SOURCES as readonly string[]).includes(source)) throw new HttpError(400, "source must be one of live, overlay, embed");
  const view = b.view === undefined || b.view === null ? "" : b.view;
  if (typeof view !== "string" || !VIEW_RE.test(view)) throw new HttpError(400, "view must be at most 20 characters of a-z, 0-9, _ and -");
  const slug = c.req.param("slug");
  // Unknown, malformed and unpublished pages all answer exactly like a counted hit: no information, no effect.
  const done = () => c.body(null, 204);
  if (!SLUG_RE.test(slug)) return done();
  const row = await c.env.DB.prepare("SELECT event_id FROM live_pages WHERE slug = ? AND published = 1").bind(slug).first<{ event_id: string }>();
  if (!row) return done();
  await c.env.DB.prepare(
    "INSERT INTO live_hits (event_id, day, source, view, hits) VALUES (?, ?, ?, ?, 1) ON CONFLICT (event_id, day, source, view) DO UPDATE SET hits = hits + 1",
  ).bind(row.event_id, dayOf(Date.now()), source, view).run();
  return done();
});

function parseDay(v: string | undefined, name: string): number | null {
  if (v === undefined || v === "") return null;
  const ms = DAY_RE.test(v) ? Date.parse(`${v}T00:00:00Z`) : NaN;
  if (Number.isNaN(ms) || dayOf(ms) !== v) throw new HttpError(400, `${name} must be a date like 2026-12-01`);
  return ms;
}

interface HitRow { day: string; source: string; view: string; hits: number }

routes.get("/events/:id/sponsor-report", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "sponsorReport", c.get("userId"), 120, 3600);
  const today = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const to = parseDay(c.req.query("to"), "to") ?? today;
  const from = parseDay(c.req.query("from"), "from") ?? to - 29 * DAY_MS;
  if (from > to) throw new HttpError(400, "from must not be after to");
  const span = Math.round((to - from) / DAY_MS) + 1;
  if (span > MAX_DAYS) throw new HttpError(400, `The period can be at most ${MAX_DAYS} days`);
  const rs = await c.env.DB.prepare(
    "SELECT day, source, view, hits FROM live_hits WHERE event_id = ? AND day >= ? AND day <= ? ORDER BY day, source, view",
  ).bind(ev.id, dayOf(from), dayOf(to)).all<HitRow>();
  const rows = rs.results ?? [];
  const perDay = new Map<string, number>();
  const bySource: Record<Source, number> = { live: 0, overlay: 0, embed: 0 };
  const perView = new Map<string, { source: string; view: string; hits: number }>();
  let total = 0;
  for (const r of rows) {
    total += r.hits;
    perDay.set(r.day, (perDay.get(r.day) ?? 0) + r.hits);
    bySource[r.source as Source] += r.hits;
    const k = `${r.source}|${r.view}`;
    const v = perView.get(k) ?? { source: r.source, view: r.view, hits: 0 };
    v.hits += r.hits;
    perView.set(k, v);
  }
  const days: { day: string; hits: number }[] = [];
  for (let i = 0; i < span; i++) { const d = dayOf(from + i * DAY_MS); days.push({ day: d, hits: perDay.get(d) ?? 0 }); }
  let peak: { day: string; hits: number } | null = null;
  for (const d of days) if (d.hits > 0 && (!peak || d.hits > peak.hits)) peak = d;
  return c.json({
    from: dayOf(from), to: dayOf(to), total, days, bySource,
    byView: [...perView.values()].sort((a, b) => b.hits - a.hits || a.view.localeCompare(b.view)),
    peak, note: "Counts of page loads, not of people.",
  });
});
