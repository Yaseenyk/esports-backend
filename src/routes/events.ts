import { Hono } from "hono";
import type { AppBindings, EventRow } from "../types";
import { randomToken } from "../crypto";
import { HttpError, nowIso, optStr, readJson, str, type Ctx } from "../http";
import { ownedEvent, ownerEvent, requireUser } from "../auth";
import { getFlag } from "../flags";
import { personalOrgId } from "../ownership";
import { orgRoleCan } from "../policy/roles";
import { orgMembership } from "../orgs/access";

export const events = new Hono<AppBindings>();
events.use("/events", requireUser);
events.use("/events/*", requireUser);

/** Public shape of an event. Never includes the creator id or signing_secret. */
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
    startsOn: e.starts_on ?? null,
    venue: e.venue,
    emergency: e.emergency,
    rules: e.rules,
    settings,
    createdAt: e.created_at,
    updatedAt: e.updated_at,
  };
}

/** Pure. The ISO day of a free-text event date: exactly YYYY-MM-DD and a real calendar day, otherwise null. */
export function strictIsoDate(text: string | null | undefined): string | null {
  const s = (text ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
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

/** `teamOrgId` is the chosen organisation when it is a team one: its whole key space is checked, so a later hand-over to another admin cannot collide (blueprint 5.3 item 3). */
async function uniqueSlug(c: Ctx, name: string, teamOrgId: string | null): Promise<string> {
  const base = slugify(name);
  const rows = await c.env.DB.prepare("SELECT slug FROM events WHERE (owner_id = ?1 OR org_id = ?2) AND (slug = ?3 OR slug LIKE ?4)")
    .bind(c.get("userId"), teamOrgId, base, `${base.slice(0, 20)}-%`)
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

/** The events a user created or was added to, newest first (the list behind GET /events and the data export). */
export async function myEvents(db: D1Database, uid: string, limit: number) {
  // The id set comes from two indexed branches that return bare ids, so UNION de-duplicates (a creator who is also a member appears once);
  // the role comes from the outer joins, never from a per-branch literal.
  const rows = await db.prepare("SELECT e.*, CASE WHEN e.owner_id = ?1 THEN 'owner' ELSE m.role END AS my_role FROM events e LEFT JOIN event_members m ON m.event_id = e.id AND m.user_id = ?1 WHERE e.id IN (SELECT id FROM events WHERE owner_id = ?1 UNION SELECT event_id FROM event_members WHERE user_id = ?1) ORDER BY e.created_at DESC, e.id DESC LIMIT ?2").bind(uid, limit).all<EventRow & { my_role: string }>();
  return rows.results;
}

/** The same list in the public shape, plus the caller's role and the organisation id (the export uses it; GET /events drops the id). */
export async function myEventList(db: D1Database, uid: string, limit: number) {
  const rows = await myEvents(db, uid, limit);
  return rows.map((r) => ({ ...publicEvent(r), role: r.my_role, orgId: r.org_id ?? null }));
}

events.get("/events", async (c) => {
  const list = await myEventList(c.env.DB, c.get("userId"), 200);
  return c.json(list.map(({ orgId: _o, ...rest }) => (void _o, rest)));
});

/**
 * Which organisation a new event goes into. Flag orgs.team off: always the creator's personal organisation (dual-write, blueprint 5.5), nothing else is read.
 * Flag on: the organisation named by `orgId` in the body (the caller must belong to it with org.events.create, and it must not be suspended), else the
 * organisation of the source event when copying and the caller belongs to it, else the personal one. A suspended organisation refuses new events (403 org_suspended).
 * The INSERT stores the organisation row's id, or NULL when the row does not exist yet (an account from before the backfill), never a foreign key failure.
 * `teamOrgId` is set when the target is a club, so the slug check covers the whole club.
 */
export async function chooseOrg(c: Ctx, body: Record<string, unknown>, sourceOrgId: string | null = null): Promise<{ orgId: string; teamOrgId: string | null }> {
  const uid = c.get("userId");
  const own = personalOrgId(uid);
  if (!(await getFlag(c.env.DB, "orgs.team"))) return { orgId: own, teamOrgId: null };
  const explicit = typeof body.orgId === "string";
  const wanted = explicit ? (body.orgId as string) : (sourceOrgId ?? own);
  const m = await orgMembership(c.env.DB, wanted, uid);
  if (!m && wanted === own) return { orgId: own, teamOrgId: null }; // an account from before the backfill
  const usable = !!m && m.status === "active" && orgRoleCan(m.role, "org.events.create") && (m.kind === "team" || wanted === own);
  if (usable) return { orgId: wanted, teamOrgId: m!.kind === "team" ? wanted : null };
  if (explicit) {
    if (!m || (m.kind !== "team" && wanted !== own)) throw new HttpError(404, "Not found");
    if (m.status !== "active") throw new HttpError(403, "This club is paused, so events cannot be added to it", { code: "org_suspended" });
    throw new HttpError(403, "You cannot add events to this club");
  }
  // A copy whose source club the caller cannot use falls back to their own organisation, which must itself be active.
  const mine = wanted === own ? m : await orgMembership(c.env.DB, own, uid);
  if (mine && mine.status !== "active") throw new HttpError(403, "This club is paused, so events cannot be added to it", { code: "org_suspended" });
  return { orgId: own, teamOrgId: null };
}

events.post("/events", async (c) => {
  const b = await readJson(c);
  const target = await chooseOrg(c, b);
  const row: EventRow = {
    id: crypto.randomUUID(),
    owner_id: c.get("userId"),
    slug: await uniqueSlug(c, typeof b.name === "string" ? b.name : "", target.teamOrgId),
    name: str(b.name, "name", 1, 120),
    game: optStr(b.game, "game", 80),
    organiser: optStr(b.organiser, "organiser", 120),
    date: optStr(b.date, "date", 40),
    starts_on: null,
    venue: optStr(b.venue, "venue", 200),
    emergency: optStr(b.emergency, "emergency", 500),
    rules: optStr(b.rules, "rules", 10_000),
    settings: settingsJson(b.settings),
    signing_secret: randomToken(32),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  row.starts_on = strictIsoDate(row.date);
  // Dual-write: org_id and created_by are set in the same statement as the event.
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO events (id, owner_id, slug, name, game, organiser, date, starts_on, venue, emergency, rules, settings, signing_secret, created_at, updated_at, org_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM organisations WHERE id = ?), ?)",
    ).bind(row.id, row.owner_id, row.slug, row.name, row.game, row.organiser, row.date, row.starts_on, row.venue, row.emergency, row.rules, row.settings, row.signing_secret, row.created_at, row.updated_at, target.orgId, row.owner_id),
  ]);
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
  // starts_on follows the date: recomputed only when the date text was sent; otherwise (e.g. a backfilled value) it is kept.
  const startsOn = b.date === undefined ? (cur.starts_on ?? null) : strictIsoDate(next.date);
  await c.env.DB.prepare("UPDATE events SET name = ?, game = ?, organiser = ?, date = ?, starts_on = ?, venue = ?, emergency = ?, rules = ?, settings = ?, updated_at = ? WHERE id = ? AND owner_id = ?")
    .bind(next.name, next.game, next.organiser, next.date, startsOn, next.venue, next.emergency, next.rules, next.settings, updated, cur.id, cur.owner_id)
    .run();
  return c.json(publicEvent({ ...cur, ...next, starts_on: startsOn, updated_at: updated }));
});

/** The explicit cascade of one event (the schema also declares ON DELETE CASCADE), shared by DELETE /events/:id and the chunked account delete (S1c). */
export function eventDeleteStatements(db: D1Database, id: string, ownerId: string): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM submissions WHERE event_id = ?").bind(id),
    db.prepare("DELETE FROM invites WHERE event_id = ?").bind(id),
    db.prepare("DELETE FROM share_links WHERE event_id = ?").bind(id),
    db.prepare("DELETE FROM live_pages WHERE event_id = ?").bind(id),
    db.prepare("DELETE FROM matches WHERE event_id = ?").bind(id),
    db.prepare("DELETE FROM br_results WHERE event_id = ?").bind(id),
    db.prepare("DELETE FROM checkins WHERE event_id = ?").bind(id),
    db.prepare("DELETE FROM gate_keys WHERE event_id = ?").bind(id),
    db.prepare("DELETE FROM photos WHERE event_id = ?").bind(id),
    db.prepare("DELETE FROM people WHERE event_id = ?").bind(id),
    db.prepare("DELETE FROM teams WHERE event_id = ?").bind(id),
    db.prepare("DELETE FROM events WHERE id = ? AND owner_id = ?").bind(id, ownerId),
  ];
}

events.delete("/events/:id", async (c) => {
  const e = await ownerEvent(c, c.req.param("id"));
  await c.env.DB.batch(eventDeleteStatements(c.env.DB, e.id, e.owner_id)); // atomically in one batch
  return c.json({ ok: true });
});
