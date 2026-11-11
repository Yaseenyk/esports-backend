import { Hono } from "hono";
import type { AppBindings } from "../types";
import type { RouteRules } from "./types";
import { HttpError, nowIso, rateLimit, rateLimitSubject, readJson, type Ctx } from "../http";
import { sha256 } from "../crypto";
import { ownedEvent, requireUser } from "../auth";
import { listBr, listMatches, publicMatch } from "../matches";

/**
 * Season leaderboard: the organiser's scoring settings (placement scale, points per kill, win/draw/loss points, day boundaries) and a public page.
 * Standings are never stored. The public route returns the settings plus the public subset of matches and the battle royale rows, and the page works the table out.
 */
export const routes = new Hono<AppBindings>();

export const routeRules: RouteRules = {
  "GET /events/:id/league": { roles: ["owner", "editor", "viewer"] },
  "PUT /events/:id/league": { roles: ["owner", "editor"], limit: "120 per hour per user" },
  "GET /public/league/:slug": { public: true, limit: "240 per minute per address" },
};

const SLUG_RE = /^[a-z2-7]{12}$/;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const MAX_DAYS = 31;
const MAX_SCALE = 100;

export interface LeagueDay { label: string; fromMatch: number; toMatch: number; date?: string }
export interface LeagueSettings { title: string; scale: number[]; perKill: number; winPts: number; drawPts: number; lossPts: number; days: LeagueDay[] }

interface LeagueRow { event_id: string; slug: string; published: number; title: string; scale: string; per_kill: number; win_pts: number; draw_pts: number; loss_pts: number; days: string; updated_at: string }

const DEFAULTS: LeagueSettings = { title: "", scale: [], perKill: 1, winPts: 3, drawPts: 1, lossPts: 0, days: [] };

const bad = (m: string): never => { throw new HttpError(400, m); };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function points(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || Math.round(v * 100) / 100 !== v) return bad(`${field} must be a number between ${min} and ${max} with at most 2 decimals`);
  return v;
}
function whole(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return bad(`${field} must be a whole number between ${min} and ${max}`);
  return v;
}
function title(v: unknown): string {
  if (typeof v !== "string") return bad("title must be a string");
  const t = v.trim();
  if (t.length > 80) return bad("title must be at most 80 characters");
  return t;
}

function parseScale(v: unknown): number[] {
  if (!Array.isArray(v)) return bad("scale must be an array of numbers");
  if (v.length > MAX_SCALE) return bad(`scale can have at most ${MAX_SCALE} items`);
  return v.map((x, i) => points(x, `scale[${i}]`, 0, 10000));
}

function parseDays(v: unknown): LeagueDay[] {
  if (!Array.isArray(v)) return bad("days must be an array");
  if (v.length > MAX_DAYS) return bad(`days can have at most ${MAX_DAYS} items`);
  let prevTo = 0;
  return v.map((raw: unknown, i) => {
    const f = `days[${i}]`;
    if (!isObj(raw)) return bad(`${f} must be an object`);
    if (typeof raw.label !== "string") return bad(`${f}.label must be a string`);
    const label = raw.label.trim();
    if (label.length < 1 || label.length > 40) return bad(`${f}.label must be 1-40 characters`);
    const fromMatch = whole(raw.fromMatch, `${f}.fromMatch`, 1, 9999);
    const toMatch = whole(raw.toMatch, `${f}.toMatch`, 1, 9999);
    if (toMatch < fromMatch) return bad(`${f}: toMatch must not be before fromMatch`);
    if (fromMatch <= prevTo) return bad(`${f}: days must be in order and must not share matches`);
    prevTo = toMatch;
    const day: LeagueDay = { label, fromMatch, toMatch };
    if (raw.date !== undefined && raw.date !== null && raw.date !== "") {
      if (typeof raw.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw.date) || Number.isNaN(Date.parse(raw.date))) return bad(`${f}.date must look like 2026-12-01`);
      day.date = raw.date;
    }
    return day;
  });
}

function safeJson<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

const settingsOf = (r: Pick<LeagueRow, "title" | "scale" | "per_kill" | "win_pts" | "draw_pts" | "loss_pts" | "days">): LeagueSettings => ({
  title: r.title, scale: safeJson<number[]>(r.scale, []), perKill: r.per_kill, winPts: r.win_pts, drawPts: r.draw_pts, lossPts: r.loss_pts, days: safeJson<LeagueDay[]>(r.days, []),
});

function ownerShape(r: LeagueRow | null) {
  if (!r) return { slug: null, published: false, ...DEFAULTS, updatedAt: null };
  return { slug: r.slug, published: r.published === 1, ...settingsOf(r), updatedAt: r.updated_at };
}

const readRow = (c: Ctx, eventId: string) =>
  c.env.DB.prepare("SELECT event_id, slug, published, title, scale, per_kill, win_pts, draw_pts, loss_pts, days, updated_at FROM league_settings WHERE event_id = ?").bind(eventId).first<LeagueRow>();

function newSlug(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  let s = "";
  for (const x of b) s += B32[x & 31];
  return s;
}

routes.get("/events/:id/league", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  return c.json(ownerShape(await readRow(c, ev.id)));
});

routes.put("/events/:id/league", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "leaguePut", c.get("userId"), 120, 3600);
  const b = await readJson(c, 50_000);
  if (b.published !== undefined && typeof b.published !== "boolean") return bad("published must be a boolean");
  const cur = await readRow(c, ev.id);
  const base = cur ? settingsOf(cur) : DEFAULTS;
  const next: LeagueSettings = {
    title: b.title === undefined ? base.title : title(b.title),
    scale: b.scale === undefined ? base.scale : parseScale(b.scale),
    perKill: b.perKill === undefined ? base.perKill : points(b.perKill, "perKill", 0, 1000),
    winPts: b.winPts === undefined ? base.winPts : points(b.winPts, "winPts", -1000, 1000),
    drawPts: b.drawPts === undefined ? base.drawPts : points(b.drawPts, "drawPts", -1000, 1000),
    lossPts: b.lossPts === undefined ? base.lossPts : points(b.lossPts, "lossPts", -1000, 1000),
    days: b.days === undefined ? base.days : parseDays(b.days),
  };
  const published = b.published === undefined ? (cur?.published ?? 0) : b.published ? 1 : 0;
  const updated = nowIso();
  const slug = cur?.slug ?? "";
  for (let attempt = 0; ; attempt++) {
    try {
      // The slug only applies on first insert; an existing row keeps its slug (stable, unguessable, never re-rolled).
      await c.env.DB.prepare(
        "INSERT INTO league_settings (event_id, slug, published, title, scale, per_kill, win_pts, draw_pts, loss_pts, days, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (event_id) DO UPDATE SET published = excluded.published, title = excluded.title, scale = excluded.scale, per_kill = excluded.per_kill, win_pts = excluded.win_pts, draw_pts = excluded.draw_pts, loss_pts = excluded.loss_pts, days = excluded.days, updated_at = excluded.updated_at",
      ).bind(ev.id, slug || newSlug(), published, next.title, JSON.stringify(next.scale), next.perKill, next.winPts, next.drawPts, next.lossPts, JSON.stringify(next.days), updated).run();
      break;
    } catch (e) {
      if (cur || attempt >= 4) throw e; // only a slug collision on a brand new row is worth retrying
    }
  }
  return c.json(ownerShape(await readRow(c, ev.id)));
});

routes.get("/public/league/:slug", async (c) => {
  await rateLimit(c, "leaguePublic", 240, 60);
  const slug = c.req.param("slug");
  if (!SLUG_RE.test(slug)) throw new HttpError(404, "not_found");
  const row = await c.env.DB.prepare(
    "SELECT e.id AS event_id, e.name AS name, e.date AS date, e.venue AS venue, l.title AS title, l.scale AS scale, l.per_kill AS per_kill, l.win_pts AS win_pts, l.draw_pts AS draw_pts, l.loss_pts AS loss_pts, l.days AS days, l.updated_at AS updated_at FROM league_settings l JOIN events e ON e.id = l.event_id WHERE l.slug = ? AND l.published = 1",
  ).bind(slug).first<{ event_id: string; name: string; date: string; venue: string; title: string; scale: string; per_kill: number; win_pts: number; draw_pts: number; loss_pts: number; days: string; updated_at: string }>();
  if (!row) throw new HttpError(404, "not_found");
  const [matches, br] = await Promise.all([listMatches(c.env, row.event_id), listBr(c.env, row.event_id)]);
  const s = settingsOf(row);
  const body = JSON.stringify({
    title: s.title || row.name,
    event: { name: row.name, date: row.date, venue: row.venue },
    settings: { scale: s.scale, perKill: s.perKill, winPts: s.winPts, drawPts: s.drawPts, lossPts: s.lossPts, days: s.days },
    matches: matches.map(publicMatch),
    br,
    updatedAt: row.updated_at,
  });
  // The ETag hashes the body, so it changes when a match, a result or a setting does.
  const etag = `"${(await sha256(body)).slice(0, 27)}"`;
  const headers = { "cache-control": "public, max-age=10", etag, "content-type": "application/json; charset=UTF-8" };
  const inm = c.req.header("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers: { "cache-control": headers["cache-control"], etag } });
  return new Response(body, { status: 200, headers });
});
