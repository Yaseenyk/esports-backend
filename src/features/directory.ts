import { Hono } from "hono";
import type { AppBindings } from "../types";
import type { RouteRules } from "./types";
import { HttpError, nowIso, rateLimit, rateLimitSoft, rateLimitSubject, readJson, type Ctx } from "../http";
import { ownedEvent, requireUser } from "../auth";
import { randomToken, sha256 } from "../crypto";
import { DEFAULT_APP_URL } from "../mailer";

/** Public events listing. Owner side: GET/PUT /events/:id/directory. Public side: list and report. Nothing about the owner is ever returned publicly. */
export const routes = new Hono<AppBindings>();

export const routeRules: RouteRules = {
  "GET /events/:id/directory": { roles: ["owner", "editor", "viewer"] },
  "PUT /events/:id/directory": { roles: ["owner", "editor"], limit: "60 per hour per user" },
  "GET /public/directory": { public: true, limit: "120 per minute per address" },
  "POST /public/directory/:eventId/report": { public: true, limit: "5 per hour per address" },
};

const MODES = ["in-person", "online", "hybrid"] as const;
const PAGE = 20;
export const HIDE_AT = 3; // distinct reporters (open reports only) that hide an entry
// Once a listing has been hidden by reports, an owner edit resolves the reports but does NOT bring it back: it is held (directory_entries.held_at)
// until a person restores it (src/directory-admin.ts, for the Phase 1 admin). Only unresolved reports count towards HIDE_AT.
export const HELD_NOTE = "This listing was hidden after reports from other people. Saving changes does not bring it back. Contact us and we will look at it.";
const CONTACT_MSG = "Please do not put contact details here: players register through the link";

/** Strips control characters and collapses whitespace. */
export function clean(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, " ").replace(/\s+/g, " ").trim();
}
const URL_RE = /(https?:|ftp:|www\.)|\b[a-z0-9-]+\.(com|in|net|org|io|gg|tv|co|me|app|link|ly|to|xyz|info|live|club)\b/i;
const MAIL_RE = /\S@\S|\(at\)/i;
const PHONE_RE = /(?:\+?\d[\s().-]{0,2}){10,}/;
export function hasContact(s: string): boolean {
  if (URL_RE.test(s) || MAIL_RE.test(s)) return true;
  return PHONE_RE.test(s.replace(/\d{4}-\d{2}-\d{2}/g, ""));
}
function field(v: unknown, name: string, min: number, max: number): string {
  if (typeof v !== "string") throw new HttpError(400, `${name} must be text`);
  const t = clean(v);
  if (t.length < min || t.length > max) throw new HttpError(400, min > 0 ? `${name} must be ${min}-${max} characters` : `${name} must be at most ${max} characters`);
  if (hasContact(t)) throw new HttpError(400, CONTACT_MSG);
  return t;
}
export function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const dayShift = (days: number) => new Date(Date.now() + days * 86400_000).toISOString().slice(0, 10);

interface Row { event_id: string; listed: number; title: string; game: string; city: string; mode: string; starts_on: string; blurb: string; reg_link: string; updated_at: string; held_at: string | null }
const readEntry = (c: Ctx, eventId: string) =>
  c.env.DB.prepare("SELECT event_id, listed, title, game, city, mode, starts_on, blurb, reg_link, updated_at, held_at FROM directory_entries WHERE event_id = ?").bind(eventId).first<Row>();
const shape = (r: Row) => ({ listed: r.listed === 1, title: r.title, game: r.game, city: r.city, mode: r.mode, startsOn: r.starts_on, blurb: r.blurb, updatedAt: r.updated_at });

const reportCount = async (c: Ctx, eventId: string) =>
  (await c.env.DB.prepare("SELECT COUNT(DISTINCT reporter) AS n FROM directory_reports WHERE event_id = ? AND resolved_at IS NULL").bind(eventId).first<{ n: number }>())?.n ?? 0;

async function registrationLink(c: Ctx, eventId: string): Promise<string | null> {
  const f = await c.env.DB.prepare("SELECT token FROM registration_forms WHERE event_id = ?").bind(eventId).first<{ token: string }>();
  if (!f) return null;
  const base = (c.env.APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "");
  return `${base}/register/?t=${encodeURIComponent(f.token)}`;
}

routes.get("/events/:id/directory", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const row = await readEntry(c, ev.id);
  const reports = await reportCount(c, ev.id);
  return c.json({
    entry: row ? shape(row) : null,
    hasRegistration: (await registrationLink(c, ev.id)) !== null,
    reports,
    hidden: !!row && row.listed === 1 && (reports >= HIDE_AT || row.held_at !== null),
    held: !!row && row.held_at !== null,
    ...(row && row.held_at !== null ? { heldNote: HELD_NOTE } : {}),
    defaults: { title: ev.name, game: ev.game, city: "", mode: "in-person", startsOn: validDate(ev.date) ? ev.date : "" },
  });
});

routes.put("/events/:id/directory", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "directoryPut", c.get("userId"), 60, 3600);
  const b = await readJson(c, 20_000);
  const cur = await readEntry(c, ev.id);
  if (b.listed !== undefined && typeof b.listed !== "boolean") throw new HttpError(400, "listed must be true or false");
  const listed = b.listed === undefined ? cur?.listed === 1 : b.listed;
  const title = b.title === undefined ? (cur?.title ?? "") : field(b.title, "title", 0, 80);
  const game = b.game === undefined ? (cur?.game ?? "") : field(b.game, "game", 0, 40);
  const city = b.city === undefined ? (cur?.city ?? "") : field(b.city, "city", 0, 40);
  const blurb = b.blurb === undefined ? (cur?.blurb ?? "") : field(b.blurb, "blurb", 0, 300);
  let mode = cur?.mode ?? "in-person";
  if (b.mode !== undefined) {
    if (typeof b.mode !== "string" || !(MODES as readonly string[]).includes(b.mode)) throw new HttpError(400, "mode must be in-person, online or hybrid");
    mode = b.mode;
  }
  let startsOn = cur?.starts_on ?? "";
  if (b.startsOn !== undefined) {
    if (typeof b.startsOn !== "string" || !validDate(b.startsOn)) throw new HttpError(400, "startsOn must be a date like 2026-12-01");
    startsOn = b.startsOn;
  }
  let regLink = cur?.reg_link ?? "";
  if (listed) {
    if (title.length < 3) throw new HttpError(400, "title must be 3-80 characters");
    if (!game) throw new HttpError(400, "Say which game it is");
    if (!startsOn) throw new HttpError(400, "Choose the start date");
    if (mode !== "online" && !city) throw new HttpError(400, "Add the city, or choose online");
    const link = await registrationLink(c, ev.id);
    if (!link) throw new HttpError(409, "Set up team registration first: the listing sends players to your registration page");
    regLink = link; // always built here from the event's own registration token; a client-sent link is ignored
  }
  const at = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO directory_entries (event_id, listed, title, game, city, mode, starts_on, blurb, reg_link, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (event_id) DO UPDATE SET listed = excluded.listed, title = excluded.title, game = excluded.game, city = excluded.city, mode = excluded.mode, starts_on = excluded.starts_on, blurb = excluded.blurb, reg_link = excluded.reg_link, updated_at = excluded.updated_at",
    ).bind(ev.id, listed ? 1 : 0, title, game, city, mode, startsOn, blurb, regLink, at),
    // A listing that is hidden right now (enough open reports) is held until a person restores it; an owner edit alone does not bring it back.
    c.env.DB.prepare("UPDATE directory_entries SET held_at = ?2 WHERE event_id = ?1 AND held_at IS NULL AND (SELECT COUNT(DISTINCT reporter) FROM directory_reports WHERE event_id = ?1 AND resolved_at IS NULL) >= ?3").bind(ev.id, at, HIDE_AT),
    // The edit resolves the open reports; they stay as history instead of being deleted.
    c.env.DB.prepare("UPDATE directory_reports SET resolved_at = ?2 WHERE event_id = ?1 AND resolved_at IS NULL").bind(ev.id, at),
  ]);
  const row = (await readEntry(c, ev.id))!;
  const held = row.held_at !== null;
  return c.json({ entry: shape(row), reports: 0, hidden: held && row.listed === 1, held, ...(held ? { heldNote: HELD_NOTE } : {}) });
});

// ---------- public ----------
const QUERY_RE = /^[\p{L}\p{N} .'&+-]{1,40}$/u;
function filter(v: string | undefined, name: string): string | null {
  if (v === undefined || v === "") return null;
  const t = clean(v);
  if (!QUERY_RE.test(t)) throw new HttpError(400, `${name} is not a valid filter`);
  return t;
}

routes.get("/public/directory", async (c) => {
  rateLimitSoft(c, "directoryList", 120, 60);
  const game = filter(c.req.query("game"), "game");
  const city = filter(c.req.query("city"), "city");
  const mode = c.req.query("mode") ?? null;
  if (mode !== null && mode !== "" && !(MODES as readonly string[]).includes(mode)) throw new HttpError(400, "mode must be in-person, online or hybrid");
  const pageRaw = c.req.query("page");
  const page = pageRaw === undefined ? 1 : Number(pageRaw);
  if (!Number.isInteger(page) || page < 1 || page > 500) throw new HttpError(400, "page must be a whole number from 1");
  const today = dayShift(0);
  const from = dayShift(-7); // an event stays visible, marked as ended, for a week
  const rows = await c.env.DB.prepare(
    "SELECT d.event_id, d.title, d.game, d.city, d.mode, d.starts_on, d.blurb, d.reg_link FROM directory_entries d WHERE d.listed = 1 AND d.held_at IS NULL AND d.starts_on >= ?1 AND (?2 IS NULL OR d.game = ?2 COLLATE NOCASE) AND (?3 IS NULL OR d.city = ?3 COLLATE NOCASE) AND (?4 IS NULL OR d.mode = ?4) AND (SELECT COUNT(DISTINCT r.reporter) FROM directory_reports r WHERE r.event_id = d.event_id AND r.resolved_at IS NULL) < ?5 ORDER BY d.starts_on DESC, d.event_id LIMIT ?6 OFFSET ?7",
  ).bind(from, game, city, mode || null, HIDE_AT, PAGE + 1, (page - 1) * PAGE).all<Row>();
  const all = await c.env.DB.prepare(
    "SELECT d.game AS game, d.city AS city FROM directory_entries d WHERE d.listed = 1 AND d.held_at IS NULL AND d.starts_on >= ?1 AND (SELECT COUNT(DISTINCT r.reporter) FROM directory_reports r WHERE r.event_id = d.event_id AND r.resolved_at IS NULL) < ?2 LIMIT 500",
  ).bind(from, HIDE_AT).all<{ game: string; city: string }>();
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))].sort((a, b) => a.localeCompare(b)).slice(0, 60);
  const body = JSON.stringify({
    entries: rows.results.slice(0, PAGE).map((r) => ({ id: r.event_id, title: r.title, game: r.game, city: r.city, mode: r.mode, startsOn: r.starts_on, blurb: r.blurb, regLink: r.reg_link, ended: r.starts_on < today })),
    page,
    hasMore: rows.results.length > PAGE,
    games: uniq(all.results.map((r) => r.game)),
    cities: uniq(all.results.map((r) => r.city)),
  });
  const etag = `"${(await sha256(body)).slice(0, 27)}"`;
  const headers = { "cache-control": "public, max-age=30", etag, "content-type": "application/json; charset=UTF-8" };
  const inm = c.req.header("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers: { "cache-control": headers["cache-control"], etag } });
  return new Response(body, { status: 200, headers });
});

routes.post("/public/directory/:eventId/report", async (c) => {
  await rateLimit(c, "directoryReport", 5, 3600);
  const eventId = c.req.param("eventId").slice(0, 64);
  const b = await readJson(c, 4_000);
  const reason = typeof b.reason === "string" ? clean(b.reason).slice(0, 200) : "";
  const row = await c.env.DB.prepare("SELECT 1 AS x FROM directory_entries WHERE event_id = ? AND listed = 1").bind(eventId).first();
  if (!row) throw new HttpError(404, "not_found");
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const reporter = await sha256(`${c.env.JWT_SECRET}|directoryReporter|${ip}`);
  await c.env.DB.prepare("INSERT INTO directory_reports (id, event_id, reason, reporter, created_at) VALUES (?, ?, ?, ?, ?)").bind(randomToken(), eventId, reason, reporter, nowIso()).run();
  return c.json({ ok: true }, 201);
});
