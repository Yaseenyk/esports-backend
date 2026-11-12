import { Hono } from "hono";
import type { AppBindings } from "../types";
import type { RouteRules } from "./types";
import { randomToken } from "../crypto";
import { newLink } from "../links";
import { HttpError, nowIso, optStr, rateLimitSubject, readJson, str } from "../http";
import { accessibleEvent, requireUser } from "../auth";
import { chooseOrg, publicEvent, slugify, strictIsoDate } from "../routes/events";
import { listMatches, MAX_MATCHES } from "../matches";

/**
 * Event templates: "Run it again". POST /events/:id/duplicate makes a new event owned by the caller from an event they can edit.
 * No new table. Everything is copied in ONE D1 batch (a transaction): the new event exists completely or not at all.
 *
 * Privacy: people are copied as name, team, role and zones only. Never copied: photos, check-ins, guardian consent, pass codes
 * (the new event has its own signing secret and key), gate keys, invites, share links, registration submissions, captain or scorer
 * links, reminders, reports, announcements, views and the public page address (a new page starts unpublished with its own new slug).
 * The 'minor' flag is KEPT and consent is RESET: a child stays protected on every page, and the new organiser must record consent again.
 */
export const routes = new Hono<AppBindings>();

export const routeRules: RouteRules = {
  "POST /events/:id/duplicate": { roles: ["owner", "editor"], limit: "20 per hour per user; the same name twice within 10 seconds returns the first result" },
};

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const KEYS = ["teams", "people", "registrationForm", "liveExtras", "directory", "members", "matches"] as const;
const GUARD_SECONDS = 10;

function newSlug(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  let s = "";
  for (const x of b) s += B32[x & 31];
  return s;
}

function parseInclude(v: unknown): Record<(typeof KEYS)[number], boolean> {
  const out = { teams: false, people: false, registrationForm: false, liveExtras: false, directory: false, members: false, matches: false };
  if (v === undefined || v === null) return out;
  if (typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "include must be an object of true or false values");
  const o = v as Record<string, unknown>;
  for (const k of KEYS) {
    if (o[k] === undefined) continue;
    if (typeof o[k] !== "boolean") throw new HttpError(400, `include.${k} must be true or false`);
    out[k] = o[k] as boolean;
  }
  if (out.directory) throw new HttpError(400, "The public listing is never copied. Publish the new event yourself when it is ready.");
  if (out.people && !out.teams) throw new HttpError(400, "People can only be brought over together with their teams");
  return out;
}

async function uniqueSlug(db: D1Database, ownerId: string, name: string, teamOrgId: string | null): Promise<string> {
  const base = slugify(name);
  const rows = await db.prepare("SELECT slug FROM events WHERE (owner_id = ?1 OR org_id = ?2) AND (slug = ?3 OR slug LIKE ?4)").bind(ownerId, teamOrgId, base, `${base.slice(0, 20)}-%`).all<{ slug: string }>();
  const taken = new Set(rows.results.map((r) => r.slug));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 10000; n++) {
    const suffix = `-${n}`;
    const cand = base.slice(0, 24 - suffix.length).replace(/-+$/g, "") + suffix;
    if (!taken.has(cand)) return cand;
  }
  throw new HttpError(409, "Could not derive a unique event key");
}

routes.post("/events/:id/duplicate", requireUser, async (c) => {
  // Authorise before reading the body: a stranger gets the same 404 as a missing event.
  const src = await accessibleEvent(c, c.req.param("id"));
  const uid = c.get("userId");
  const b = await readJson(c);
  const name = str(b.name, "name", 1, 120);
  const date = b.date === undefined || b.date === null ? src.date : optStr(b.date, "date", 40);
  const inc = parseInclude(b.include);
  if (inc.members && src.my_role !== "owner") throw new HttpError(403, "Only the owner of the event can bring its editors and viewers over");
  // People are the event's personal data: an editor works on the event but must not be able to copy its people into an account of their own.
  if (inc.people && src.my_role !== "owner") throw new HttpError(403, "Only the owner of the event can bring its people over");
  const db = c.env.DB;

  // Simple guard: the same name by the same user within 10 seconds is the first request again (a double tap), not a new event.
  const cutoff = new Date(Date.now() - GUARD_SECONDS * 1000).toISOString();
  const recent = await db.prepare("SELECT * FROM events WHERE owner_id = ? AND name = ? AND created_at > ? ORDER BY created_at DESC LIMIT 1").bind(uid, name, cutoff).first<import("../types").EventRow>();
  if (recent) return c.json(publicEvent(recent), 200);

  await rateLimitSubject(c, "duplicate", uid, 20, 3600);

  // Read what needs reshaping in code (match ids, live extras); everything else is copied by INSERT ... SELECT inside the batch.
  const now = nowIso();
  const newId = crypto.randomUUID();
  const stmts: D1PreparedStatement[] = [];
  // Dual-write: org_id (NULL when the organisation row does not exist yet, never a foreign key failure) and created_by, in the same statement as the event.
  const target = await chooseOrg(c, b, src.org_id ?? null);
  stmts.push(
    db.prepare("INSERT INTO events (id, owner_id, slug, name, game, organiser, date, starts_on, venue, emergency, rules, settings, signing_secret, created_at, updated_at, org_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (SELECT id FROM organisations WHERE id = ?), ?)")
      .bind(newId, uid, await uniqueSlug(db, uid, name, target.teamOrgId), name, src.game, src.organiser, date, strictIsoDate(date), src.venue, src.emergency, src.rules, src.settings, randomToken(32), now, now, target.orgId, uid),
  );

  if (inc.teams) {
    stmts.push(db.prepare("INSERT INTO teams (event_id, id, name, logo) SELECT ?, id, name, logo FROM teams WHERE event_id = ?").bind(newId, src.id));
  }
  if (inc.people) {
    // Name, team, role, zones and the minor flag only. Guardian consent is reset to 0 (not recorded). No photos, no check-ins, no share links.
    stmts.push(db.prepare("INSERT INTO people (event_id, id, team_id, name, role, zones, minor, guardian) SELECT ?, id, team_id, name, role, zones, minor, 0 FROM people WHERE event_id = ?").bind(newId, src.id));
  }
  if (inc.registrationForm) {
    // Text and settings only. New token, starts closed, no deadline carried over, no submissions.
    const link = await newLink(c.env, "regform", newId);
    stmts.push(
      db.prepare("INSERT INTO registration_forms (event_id, token, token_hash, token_enc, title, intro, closes_at, max_teams, team_size, subs, open, created_at) SELECT ?, ?, ?, ?, title, intro, NULL, max_teams, team_size, subs, 0, ? FROM registration_forms WHERE event_id = ?")
        .bind(newId, link.cols.token, link.cols.token_hash, link.cols.token_enc, now, src.id),
    );
  }
  if (inc.liveExtras) {
    const row = await db.prepare("SELECT snapshot FROM live_pages WHERE event_id = ?").bind(src.id).first<{ snapshot: string }>();
    if (row) {
      let snap: { sponsors?: unknown; ticker?: unknown } = {};
      try { snap = JSON.parse(row.snapshot) as typeof snap; } catch { /* empty */ }
      const out = { views: [], announcements: [], sponsors: Array.isArray(snap.sponsors) ? snap.sponsors : [], ticker: Array.isArray(snap.ticker) ? snap.ticker : [] };
      stmts.push(db.prepare("INSERT INTO live_pages (event_id, slug, published, snapshot, updated_at) VALUES (?, ?, 0, ?, ?)").bind(newId, newSlug(), JSON.stringify(out), now));
    }
  }
  if (inc.members) {
    stmts.push(db.prepare("INSERT INTO event_members (event_id, user_id, role, added_at) SELECT ?, user_id, role, ? FROM event_members WHERE event_id = ? AND user_id != ?").bind(newId, now, src.id, uid));
  }
  if (inc.matches) {
    const ms = (await listMatches(c.env, src.id)).slice(0, MAX_MATCHES);
    const ids = new Map(ms.map((m) => [m.id, crypto.randomUUID()]));
    // A side that was filled by a winner advancing is a result, so it starts empty again.
    const fed = new Set<string>();
    for (const m of ms) if (m.nextId && m.nextSide && ids.has(m.nextId)) fed.add(`${m.nextId}|${m.nextSide}`);
    for (const m of ms) {
      const nextId = m.nextId && ids.has(m.nextId) ? ids.get(m.nextId)! : null;
      stmts.push(
        db.prepare("INSERT INTO matches (id, event_id, stage, round, slot, a, b, status, score_a, score_b, winner, starts_at, next_id, next_side, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', NULL, NULL, NULL, NULL, ?, ?, ?, ?)")
          .bind(ids.get(m.id)!, newId, m.stage, m.round, m.slot, fed.has(`${m.id}|a`) ? "" : m.a, fed.has(`${m.id}|b`) ? "" : m.b, nextId, nextId ? m.nextSide : null, now, uid),
      );
    }
  }

  await db.batch(stmts); // one transaction: all or nothing
  const created = await db.prepare("SELECT * FROM events WHERE id = ?").bind(newId).first<import("../types").EventRow>();
  return c.json(publicEvent(created!), 201);
});
