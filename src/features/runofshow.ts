import { Hono } from "hono";
import type { AppBindings } from "../types";
import type { RouteRules } from "./types";
import { HttpError, nowIso, rateLimitSoft, rateLimitSubject, readJson, str, type Ctx } from "../http";
import { randomToken, sha256 } from "../crypto";
import { ownedEvent, requireUser } from "../auth";

export const routes = new Hono<AppBindings>();

export const routeRules: RouteRules = {
  "GET /events/:id/runofshow": { roles: ["owner", "editor", "viewer"] },
  "PUT /events/:id/runofshow": { roles: ["owner", "editor"], limit: "60/hour per user" },
  "POST /events/:id/runofshow/:iid/status": { roles: ["owner", "editor"], limit: "600/hour per user" },
  "POST /events/:id/runofshow/link": { roles: ["owner", "editor"], limit: "30/hour per user" },
  "DELETE /events/:id/runofshow/link": { roles: ["owner", "editor"], limit: "30/hour per user" },
  "GET /public/run/:token": { public: true, limit: "120/min per address" },
};

const MAX_ITEMS = 200;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const STATUSES = ["todo", "doing", "done"] as const;
type Status = (typeof STATUSES)[number];

interface Row { id: string; sort: number; at_time: string; day_offset: number; title: string; owner_name: string; status: Status; notes: string; updated_at: string }
const shape = (r: Row) => ({ id: r.id, atTime: r.at_time, dayOffset: r.day_offset, title: r.title, ownerName: r.owner_name, status: r.status, notes: r.notes, updatedAt: r.updated_at });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

async function listItems(c: Ctx, eventId: string): Promise<Row[]> {
  const r = await c.env.DB.prepare("SELECT id, sort, at_time, day_offset, title, owner_name, status, notes, updated_at FROM runofshow_items WHERE event_id = ? ORDER BY sort, at_time LIMIT 200").bind(eventId).all<Row>();
  return r.results ?? [];
}

async function linkInfo(c: Ctx, eventId: string) {
  const l = await c.env.DB.prepare("SELECT show_notes, created_at FROM runofshow_links WHERE event_id = ?").bind(eventId).first<{ show_notes: number; created_at: string }>();
  return l ? { active: true, showNotes: l.show_notes === 1, createdAt: l.created_at } : null;
}

routes.get("/events/:id/runofshow", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  return c.json({ items: (await listItems(c, ev.id)).map(shape), link: await linkInfo(c, ev.id) });
});

routes.put("/events/:id/runofshow", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "runofshowPut", c.get("userId"), 60, 3600);
  const b = await readJson(c, 300_000);
  if (!Array.isArray(b.items)) throw new HttpError(400, "items must be an array");
  if (b.items.length > MAX_ITEMS) throw new HttpError(400, `A run of show can have at most ${MAX_ITEMS} items`);
  const mine = new Set((await c.env.DB.prepare("SELECT id FROM runofshow_items WHERE event_id = ?").bind(ev.id).all<{ id: string }>()).results?.map((r) => r.id) ?? []);
  const used = new Set<string>();
  const now = nowIso();
  const rows: Row[] = b.items.map((raw, i) => {
    if (!isObj(raw)) throw new HttpError(400, `items[${i}] must be an object`);
    const at = typeof raw.atTime === "string" ? raw.atTime.trim() : "";
    if (!TIME_RE.test(at)) throw new HttpError(400, `items[${i}].atTime must be a time like 09:30`);
    const day = raw.dayOffset === undefined || raw.dayOffset === null ? 0 : raw.dayOffset;
    if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 30) throw new HttpError(400, `items[${i}].dayOffset must be a whole number from 0 to 30`);
    const status = raw.status === undefined || raw.status === null ? "todo" : raw.status;
    if (typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) throw new HttpError(400, `items[${i}].status must be todo, doing or done`);
    const id = typeof raw.id === "string" && mine.has(raw.id) && !used.has(raw.id) ? raw.id : crypto.randomUUID();
    used.add(id);
    return {
      id, sort: i, at_time: at, day_offset: day,
      title: oneLine(str(raw.title, `items[${i}].title`, 1, 100)),
      owner_name: oneLine(raw.ownerName === undefined || raw.ownerName === null ? "" : str(raw.ownerName, `items[${i}].ownerName`, 0, 60)),
      status: status as Status,
      notes: (raw.notes === undefined || raw.notes === null ? "" : str(raw.notes, `items[${i}].notes`, 0, 300)),
      updated_at: now,
    };
  });
  const by = c.get("userId");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM runofshow_items WHERE event_id = ?").bind(ev.id),
    ...rows.map((r) =>
      c.env.DB.prepare("INSERT INTO runofshow_items (id, event_id, sort, at_time, day_offset, title, owner_name, status, notes, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(r.id, ev.id, r.sort, r.at_time, r.day_offset, r.title, r.owner_name, r.status, r.notes, now, by)),
  ]);
  return c.json({ items: (await listItems(c, ev.id)).map(shape), link: await linkInfo(c, ev.id) });
});

routes.post("/events/:id/runofshow/:iid/status", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "runofshowStatus", c.get("userId"), 600, 3600);
  const b = await readJson(c, 2_000);
  if (typeof b.status !== "string" || !(STATUSES as readonly string[]).includes(b.status)) throw new HttpError(400, "status must be todo, doing or done");
  const r = await c.env.DB.prepare("UPDATE runofshow_items SET status = ?, updated_at = ?, updated_by = ? WHERE id = ? AND event_id = ?")
    .bind(b.status, nowIso(), c.get("userId"), c.req.param("iid"), ev.id).run();
  if ((r.meta?.changes ?? 0) === 0) throw new HttpError(404, "Item not found");
  const row = await c.env.DB.prepare("SELECT id, sort, at_time, day_offset, title, owner_name, status, notes, updated_at FROM runofshow_items WHERE id = ?").bind(c.req.param("iid")).first<Row>();
  return c.json({ item: row ? shape(row) : null });
});

routes.post("/events/:id/runofshow/link", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "runofshowLink", c.get("userId"), 30, 3600);
  const b = await readJson(c, 2_000);
  if (b.showNotes !== undefined && typeof b.showNotes !== "boolean") throw new HttpError(400, "showNotes must be true or false");
  const token = randomToken(24);
  const now = nowIso();
  // One link per event: making a new one replaces (and so revokes) the old one. The token is returned this once and only its hash is kept.
  await c.env.DB.prepare(
    "INSERT INTO runofshow_links (event_id, token_hash, show_notes, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (event_id) DO UPDATE SET token_hash = excluded.token_hash, show_notes = excluded.show_notes, created_at = excluded.created_at",
  ).bind(ev.id, await sha256(token), b.showNotes ? 1 : 0, now).run();
  return c.json({ token, showNotes: b.showNotes === true, createdAt: now }, 201);
});

routes.delete("/events/:id/runofshow/link", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "runofshowLink", c.get("userId"), 30, 3600);
  await c.env.DB.prepare("DELETE FROM runofshow_links WHERE event_id = ?").bind(ev.id).run();
  return c.json({ ok: true });
});

routes.get("/public/run/:token", async (c) => {
  rateLimitSoft(c, "runPublic", 120, 60);
  const token = c.req.param("token");
  if (!TOKEN_RE.test(token)) throw new HttpError(404, "not_found");
  const link = await c.env.DB.prepare(
    "SELECT e.id AS event_id, e.name AS name, e.date AS date, e.venue AS venue, l.show_notes AS show_notes FROM runofshow_links l JOIN events e ON e.id = l.event_id WHERE l.token_hash = ?",
  ).bind(await sha256(token)).first<{ event_id: string; name: string; date: string; venue: string; show_notes: number }>();
  if (!link) throw new HttpError(404, "not_found");
  const items = (await listItems(c, link.event_id)).map((r) => {
    const s = shape(r);
    return { id: s.id, atTime: s.atTime, dayOffset: s.dayOffset, title: s.title, ownerName: s.ownerName, status: s.status, ...(link.show_notes === 1 && s.notes ? { notes: s.notes } : {}) };
  });
  const body = JSON.stringify({ event: { name: link.name, date: link.date, venue: link.venue }, items, showNotes: link.show_notes === 1 });
  const etag = `"${(await sha256(body)).slice(0, 27)}"`;
  const inm = c.req.header("if-none-match");
  const cache = "private, max-age=5";
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers: { "cache-control": cache, etag } });
  return new Response(body, { status: 200, headers: { "cache-control": cache, etag, "content-type": "application/json; charset=UTF-8" } });
});
