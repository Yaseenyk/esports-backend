import { Hono } from "hono";
import type { AppBindings } from "../types";
import { HttpError, nowIso, rateLimitSoft, rateLimitSubject, readJson, type Ctx } from "../http";
import { sha256 } from "../crypto";
import { ownedEvent, requireUser } from "../auth";
import { listMatches, publicMatch } from "../matches";

export const live = new Hono<AppBindings>();

const KINDS = ["standings", "league", "schedule", "bracket", "countdown"] as const;
const VIEW_TYPES = ["table", "schedule", "countdown", "bracket"];
const MAX_SNAPSHOT_CHARS = 250_000;
const MAX_LOGO_CHARS = 60_000;
const LOGO_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
const SLUG_RE = /^[a-z2-7]{12}$/;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";

interface Sponsor { name: string; logo?: string }
interface LiveSnapshot {
  views: { kind: string; payload: Record<string, unknown> }[];
  announcements: { text: string; at: string }[];
  sponsors: Sponsor[];
  ticker: string[];
}

const EMPTY: LiveSnapshot = { views: [], announcements: [], sponsors: [], ticker: [] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const bad = (m: string): never => { throw new HttpError(400, m); };

function arr(v: unknown, field: string, max: number): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return bad(`${field} must be an array`);
  if (v.length > max) return bad(`${field} can have at most ${max} items`);
  return v;
}

function text(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string") return bad(`${field} must be a string`);
  const t = v.trim();
  if (t.length < min || t.length > max) return bad(`${field} must be ${min}-${max} characters`);
  return t;
}

/** Strict shape and size check. The result contains only known fields; nothing is rendered or interpreted here. */
export function validateSnapshot(raw: unknown): LiveSnapshot {
  if (!isObj(raw)) return bad("snapshot must be an object");
  const seen = new Set<string>();
  const views = arr(raw.views, "snapshot.views", 5).map((v, i) => {
    if (!isObj(v)) return bad(`snapshot.views[${i}] must be an object`);
    if (typeof v.kind !== "string" || !(KINDS as readonly string[]).includes(v.kind)) return bad(`snapshot.views[${i}].kind must be one of ${KINDS.join(", ")}`);
    if (seen.has(v.kind)) return bad(`snapshot.views can have only one view of kind ${v.kind}`);
    seen.add(v.kind);
    const p = v.payload;
    if (!isObj(p)) return bad(`snapshot.views[${i}].payload must be an object`);
    if (typeof p.v !== "string" || !VIEW_TYPES.includes(p.v)) return bad(`snapshot.views[${i}].payload.v must be one of ${VIEW_TYPES.join(", ")}`);
    if (!isObj(p.d)) return bad(`snapshot.views[${i}].payload.d must be an object`);
    if (p.x !== undefined && !isObj(p.x)) return bad(`snapshot.views[${i}].payload.x must be an object`);
    const payload: Record<string, unknown> = { v: p.v, d: p.d };
    if (p.x !== undefined) payload.x = p.x;
    return { kind: v.kind, payload };
  });
  const announcements = arr(raw.announcements, "snapshot.announcements", 10).map((a, i) => {
    if (!isObj(a)) return bad(`snapshot.announcements[${i}] must be an object`);
    const at = text(a.at, `snapshot.announcements[${i}].at`, 1, 40);
    if (!ISO_RE.test(at) || Number.isNaN(Date.parse(at))) return bad(`snapshot.announcements[${i}].at must be an ISO time`);
    return { text: text(a.text, `snapshot.announcements[${i}].text`, 1, 140), at };
  });
  const sponsors = arr(raw.sponsors, "snapshot.sponsors", 4).map((s, i) => {
    if (!isObj(s)) return bad(`snapshot.sponsors[${i}] must be an object`);
    const out: Sponsor = { name: text(s.name, `snapshot.sponsors[${i}].name`, 1, 40) };
    if (s.logo !== undefined && s.logo !== null && s.logo !== "") {
      if (typeof s.logo !== "string" || s.logo.length > MAX_LOGO_CHARS) return bad(`snapshot.sponsors[${i}].logo must be an image data URL of at most ${MAX_LOGO_CHARS} characters`);
      if (!LOGO_RE.test(s.logo)) return bad(`snapshot.sponsors[${i}].logo must be a png, jpeg or webp base64 data URL`);
      out.logo = s.logo;
    }
    return out;
  });
  const ticker = arr(raw.ticker, "snapshot.ticker", 5).map((t, i) => text(t, `snapshot.ticker[${i}]`, 1, 80));
  const snap: LiveSnapshot = { views, announcements, sponsors, ticker };
  if (JSON.stringify(snap).length > MAX_SNAPSHOT_CHARS) throw new HttpError(400, `snapshot is too large (at most ${MAX_SNAPSHOT_CHARS} characters of JSON)`);
  return snap;
}

function newSlug(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  let s = "";
  for (const x of b) s += B32[x & 31];
  return s;
}

interface LiveRow { event_id: string; slug: string; published: number; snapshot: string; updated_at: string }

function parseSnapshot(s: string): LiveSnapshot {
  try {
    return JSON.parse(s) as LiveSnapshot;
  } catch {
    return EMPTY;
  }
}

function ownerShape(r: LiveRow | null) {
  if (!r) return { slug: null, published: false, snapshot: null, updatedAt: null };
  return { slug: r.slug, published: r.published === 1, snapshot: parseSnapshot(r.snapshot), updatedAt: r.updated_at };
}

const readRow = (c: Ctx, eventId: string) =>
  c.env.DB.prepare("SELECT event_id, slug, published, snapshot, updated_at FROM live_pages WHERE event_id = ?").bind(eventId).first<LiveRow>();

live.get("/events/:id/live", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  return c.json(ownerShape(await readRow(c, ev.id)));
});

live.put("/events/:id/live", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "livePut", c.get("userId"), 60, 3600);
  const b = await readJson(c, 400_000);
  if (b.published !== undefined && typeof b.published !== "boolean") throw new HttpError(400, "published must be a boolean");
  const snap = b.snapshot === undefined ? undefined : validateSnapshot(b.snapshot);
  const cur = await readRow(c, ev.id);
  const published = b.published === undefined ? (cur?.published ?? 0) : b.published ? 1 : 0;
  const snapshot = snap ? JSON.stringify(snap) : (cur?.snapshot ?? JSON.stringify(EMPTY));
  const updated = nowIso();
  let slug = cur?.slug ?? "";
  for (let attempt = 0; ; attempt++) {
    try {
      // The slug only applies on first insert; an existing row keeps its slug (stable, unguessable, never re-rolled).
      await c.env.DB.prepare(
        "INSERT INTO live_pages (event_id, slug, published, snapshot, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (event_id) DO UPDATE SET published = excluded.published, snapshot = excluded.snapshot, updated_at = excluded.updated_at",
      ).bind(ev.id, slug || newSlug(), published, snapshot, updated).run();
      break;
    } catch (e) {
      if (cur || attempt >= 4) throw e; // only a slug collision on a brand new page is worth retrying
    }
  }
  return c.json(ownerShape(await readRow(c, ev.id)));
});

live.get("/public/live/:slug", async (c) => {
  rateLimitSoft(c, "livePublic", 240, 60);
  const slug = c.req.param("slug");
  if (!SLUG_RE.test(slug)) throw new HttpError(404, "not_found");
  const row = await c.env.DB.prepare(
    "SELECT e.id AS event_id, e.name AS name, e.date AS date, e.venue AS venue, l.snapshot AS snapshot, l.updated_at AS updated_at FROM live_pages l JOIN events e ON e.id = l.event_id WHERE l.slug = ? AND l.published = 1",
  ).bind(slug).first<{ event_id: string; name: string; date: string; venue: string; snapshot: string; updated_at: string }>();
  if (!row) throw new HttpError(404, "not_found");
  const matches = (await listMatches(c.env, row.event_id)).map(publicMatch);
  // `matches` is only present when the event has some, so pages without matches keep exactly the old body (and ETag). The ETag hashes the body, so it changes when a match does.
  const body = JSON.stringify({ event: { name: row.name, date: row.date, venue: row.venue }, snapshot: parseSnapshot(row.snapshot), updatedAt: row.updated_at, ...(matches.length ? { matches } : {}) });
  const etag = `"${(await sha256(body)).slice(0, 27)}"`;
  const headers = { "cache-control": "public, max-age=10", etag, "content-type": "application/json; charset=UTF-8" };
  const inm = c.req.header("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers: { "cache-control": headers["cache-control"], etag } });
  return new Response(body, { status: 200, headers });
});
