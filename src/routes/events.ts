import { Hono } from "hono";
import type { AppBindings, EventRow } from "../types";
import { randomToken } from "../crypto";
import { HttpError, nowIso, optStr, readJson, str, type Ctx } from "../http";
import { ownedEvent, ownerEvent, requireUser } from "../auth";

export const events = new Hono<AppBindings>();
events.use("/events", requireUser);
events.use("/events/*", requireUser);

/** Public shape of an event. Never includes owner_id or signing_secret. */
export function publicEvent(e: EventRow) {
  let settings: unknown = {};
  try {
    settings = JSON.parse(e.settings);
  } catch {
    /* keep {} */
  }
  return {
    id: e.id,
    key: e.slug,
    name: e.name,
    game: e.game,
    organiser: e.organiser,
    date: e.date,
    venue: e.venue,
    emergency: e.emergency,
    rules: e.rules,
    settings,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  };
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
  return s || "event";
}

async function uniqueSlug(c: Ctx, name: string): Promise<string> {
  const base = slugify(name);
  const rows = await c.env.DB.prepare("SELECT slug FROM events WHERE owner_id = ? AND (slug = ? OR slug LIKE ?)")
    .bind(c.get("userId"), base, `${base.slice(0, 20)}-%`)
    .all<{ slug: string }>();
  const taken = new Set(rows.results.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10000; n++) {
    const suffix = `-${n}`;
    const cand = base.slice(0, 24 - suffix.length).replace(/-+$/g, "") + suffix;
    if (!taken.has(cand)) return cand;
  }
  throw new HttpError(409, "Could not derive a unique event key");
}

function settingsJson(v: unknown): string {
  if (v === undefined || v === null) return "{}";
  if (typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "settings must be an object");
  const s = JSON.stringify(v);
  if (s.length > 20_000) throw new HttpError(413, "settings is too large");
  return s;
}

events.get("/events", async (c) => {
  const uid = c.get("userId");
  const rows = await c.env.DB.prepare("SELECT e.*, CASE WHEN e.owner_id = ?1 THEN 'owner' ELSE m.role END AS my_role FROM events e LEFT JOIN event_members m ON m.event_id = e.id AND m.user_id = ?1 WHERE e.owner_id = ?1 OR m.user_id = ?1 ORDER BY e.created_at DESC LIMIT 200").bind(uid).all<EventRow & { my_role: string }>();
  return c.json(rows.results.map((r) => ({ ...publicEvent(r), role: r.my_role })));
});

events.post("/events", async (c) => {
  const b = await readJson(c);
  const row: EventRow = {
    id: crypto.randomUUID(),
    owner_id: c.get("userId"),
    slug: await uniqueSlug(c, typeof b.name === "string" ? b.name : ""),
    name: str(b.name, "name", 1, 120),
    game: optStr(b.game, "game", 80),
    organiser: optStr(b.organiser, "organiser", 120),
    date: optStr(b.date, "date", 40),
    venue: optStr(b.venue, "venue", 200),
    emergency: optStr(b.emergency, "emergency", 500),
    rules: optStr(b.rules, "rules", 10_000),
    settings: settingsJson(b.settings),
    signing_secret: randomToken(32),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  await c.env.DB.prepare(
    "INSERT INTO events (id, owner_id, slug, name, game, organiser, date, venue, emergency, rules, settings, signing_secret, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(row.id, row.owner_id, row.slug, row.name, row.game, row.organiser, row.date, row.venue, row.emergency, row.rules, row.settings, row.signing_secret, row.created_at, row.updated_at)
    .run();
  return c.json(publicEvent(row), 201);
});

events.get("/events/:id", async (c) => c.json(publicEvent(await ownedEvent(c, c.req.param("id")))));

events.put("/events/:id", async (c) => {
  const cur = await ownedEvent(c, c.req.param("id"));
  const b = await readJson(c);
  // Partial update: omitted fields keep their value. The key (slug) never changes, so issued passes stay valid.
  const next = {
    name: b.name === undefined ? cur.name : str(b.name, "name", 1, 120),
    game: b.game === undefined ? cur.game : optStr(b.game, "game", 80),
    organiser: b.organiser === undefined ? cur.organiser : optStr(b.organiser, "organiser", 120),
    date: b.date === undefined ? cur.date : optStr(b.date, "date", 40),
    venue: b.venue === undefined ? cur.venue : optStr(b.venue, "venue", 200),
    emergency: b.emergency === undefined ? cur.emergency : optStr(b.emergency, "emergency", 500),
    rules: b.rules === undefined ? cur.rules : optStr(b.rules, "rules", 10_000),
    settings: b.settings === undefined ? cur.settings : settingsJson(b.settings),
  };
  const updated = nowIso();
  await c.env.DB.prepare("UPDATE events SET name = ?, game = ?, organiser = ?, date = ?, venue = ?, emergency = ?, rules = ?, settings = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
    .bind(next.name, next.game, next.organiser, next.date, next.venue, next.emergency, next.rules, next.settings, updated, cur.id, cur.owner_id)
    .run();
  return c.json(publicEvent({ ...cur, ...next, updated_at: updated }));
});

events.delete("/events/:id", async (c) => {
  const e = await ownerEvent(c, c.req.param("id"));
  const db = c.env.DB;
  // Explicit cascade (the schema also declares ON DELETE CASCADE), atomically in one batch.
  await db.batch([
    db.prepare("DELETE FROM submissions WHERE event_id = ?").bind(e.id),
    db.prepare("DELETE FROM invites WHERE event_id = ?").bind(e.id),
    db.prepare("DELETE FROM share_links WHERE event_id = ?").bind(e.id),
    db.prepare("DELETE FROM live_pages WHERE event_id = ?").bind(e.id),
    db.prepare("DELETE FROM matches WHERE event_id = ?").bind(e.id),
    db.prepare("DELETE FROM br_results WHERE event_id = ?").bind(e.id),
    db.prepare("DELETE FROM checkins WHERE event_id = ?").bind(e.id),
    db.prepare("DELETE FROM gate_keys WHERE event_id = ?").bind(e.id),
    db.prepare("DELETE FROM photos WHERE event_id = ?").bind(e.id),
    db.prepare("DELETE FROM people WHERE event_id = ?").bind(e.id),
    db.prepare("DELETE FROM teams WHERE event_id = ?").bind(e.id),
    db.prepare("DELETE FROM events WHERE id = ? AND owner_id = ?").bind(e.id, e.owner_id),
  ]);
  return c.json({ ok: true });
});
