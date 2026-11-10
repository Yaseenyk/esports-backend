import { Hono } from "hono";
import type { AppBindings } from "../types";
import { importPassKey, passCode, passSig, randomToken, sha256 } from "../crypto";
import { HttpError, MAX_PHOTO_BODY, idStr, inHours, nowIso, optBool, optHours, readBytes, readJson, str } from "../http";
import { blobBytes, checkImage, imageResponse, parsePhotoDataUrl, validateLogo, type Image } from "../images";
import { ownedEvent } from "../auth";

export const roster = new Hono<AppBindings>();

const MAX_PEOPLE = 2000;
const MAX_TEAMS = 100;
const CHUNK_BYTES = 50_000; // keep each json_each parameter well under D1's statement limits

interface Chunkable {
  json: string;
}
function chunk<T extends Chunkable>(items: T[]): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let size = 2;
  for (const it of items) {
    if (cur.length && size + it.json.length > CHUNK_BYTES) {
      out.push(`[${cur.join(",")}]`);
      cur = [];
      size = 2;
    }
    cur.push(it.json);
    size += it.json.length + 1;
  }
  if (cur.length) out.push(`[${cur.join(",")}]`);
  return out;
}

function zonesValue(v: unknown): string {
  if (v === undefined || v === null) return "[]";
  if (typeof v === "string") {
    if (v.length > 200) throw new HttpError(400, "zones is too long");
    return JSON.stringify(v);
  }
  if (Array.isArray(v) && v.length <= 20 && v.every((z) => typeof z === "string" && z.length <= 40)) return JSON.stringify(v);
  throw new HttpError(400, "zones must be a string or an array of up to 20 short strings");
}

roster.put("/events/:id/roster", async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const body = await readJson(c);
  if (!Array.isArray(body.teams) || !Array.isArray(body.people)) throw new HttpError(400, "teams and people must be arrays");
  if (body.teams.length > MAX_TEAMS) throw new HttpError(400, `At most ${MAX_TEAMS} teams per event`);
  if (body.people.length > MAX_PEOPLE) throw new HttpError(400, `At most ${MAX_PEOPLE} people per event`);

  // ---- validate everything before touching the database ----
  const teamIds = new Set<string>();
  const teams = body.teams.map((raw: unknown, i) => {
    if (typeof raw !== "object" || raw === null) throw new HttpError(400, `teams[${i}] must be an object`);
    const t = raw as Record<string, unknown>;
    const id = idStr(t.id, `teams[${i}].id`);
    if (teamIds.has(id)) throw new HttpError(400, `Duplicate team id ${id}`);
    teamIds.add(id);
    const row = { id, name: str(t.name, `teams[${i}].name`, 1, 60), logo: validateLogo(t.logo, `teams[${i}].logo`) };
    return { ...row, json: JSON.stringify(row) };
  });

  const personIds = new Set<string>();
  const photoSet: { id: string; img: Image }[] = [];
  const photoClear: string[] = [];
  const people = body.people.map((raw: unknown, i) => {
    if (typeof raw !== "object" || raw === null) throw new HttpError(400, `people[${i}] must be an object`);
    const p = raw as Record<string, unknown>; // unknown fields (e.g. a date of birth) are ignored, never stored
    const id = idStr(p.id, `people[${i}].id`);
    if (personIds.has(id)) throw new HttpError(400, `Duplicate person id ${id}`);
    personIds.add(id);
    const teamId = idStr(p.teamId, `people[${i}].teamId`);
    if (!teamIds.has(teamId)) throw new HttpError(400, `people[${i}].teamId does not match any team`);
    if (p.photo === null) photoClear.push(id);
    else if (p.photo !== undefined) photoSet.push({ id, img: parsePhotoDataUrl(p.photo, `people[${i}].photo`) });
    const row = {
      id,
      teamId,
      name: str(p.name, `people[${i}].name`, 1, 80),
      role: p.role === undefined ? "Player" : str(p.role, `people[${i}].role`, 1, 40),
      zones: zonesValue(p.zones),
      minor: optBool(p.minor, `people[${i}].minor`) ? 1 : 0,
      guardian: optBool(p.guardian, `people[${i}].guardian`) ? 1 : 0,
    };
    return { ...row, json: JSON.stringify(row) };
  });

  // ---- one atomic D1 batch (a transaction: all statements apply or none do) ----
  const db = c.env.DB;
  const stmts: D1PreparedStatement[] = [
    db.prepare("DELETE FROM people WHERE event_id = ?").bind(ev.id),
    db.prepare("DELETE FROM teams WHERE event_id = ?").bind(ev.id),
  ];
  for (const j of chunk(teams)) {
    stmts.push(
      db
        .prepare("INSERT INTO teams (event_id, id, name, logo) SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.name'), json_extract(value, '$.logo') FROM json_each(?)")
        .bind(ev.id, j),
    );
  }
  for (const j of chunk(people)) {
    stmts.push(
      db
        .prepare(
          "INSERT INTO people (event_id, id, team_id, name, role, zones, minor, guardian) SELECT ?, json_extract(value, '$.id'), json_extract(value, '$.teamId'), json_extract(value, '$.name'), json_extract(value, '$.role'), json_extract(value, '$.zones'), json_extract(value, '$.minor'), json_extract(value, '$.guardian') FROM json_each(?)",
        )
        .bind(ev.id, j),
    );
  }
  for (const j of chunk(photoClear.map((id) => ({ json: JSON.stringify(id) })))) {
    stmts.push(db.prepare("DELETE FROM photos WHERE event_id = ? AND person_id IN (SELECT value FROM json_each(?))").bind(ev.id, j));
  }
  for (const ph of photoSet) {
    stmts.push(
      db
        .prepare("INSERT OR REPLACE INTO photos (event_id, person_id, content_type, bytes) VALUES (?, ?, ?, ?)")
        .bind(ev.id, ph.id, ph.img.type, ph.img.bytes.buffer as ArrayBuffer),
    );
  }
  // Photos of people that stay in the roster are kept; everything tied to removed people goes.
  for (const t of ["photos", "checkins", "share_links"]) {
    stmts.push(db.prepare(`DELETE FROM ${t} WHERE event_id = ? AND person_id NOT IN (SELECT id FROM people WHERE event_id = ?)`).bind(ev.id, ev.id));
  }
  await db.batch(stmts);
  return c.json({ ok: true, teams: teams.length, people: people.length, photos: photoSet.length });
});

roster.get("/events/:id/roster", async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const [t, p] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT id, name, logo FROM teams WHERE event_id = ? ORDER BY rowid").bind(ev.id),
    c.env.DB.prepare(
      "SELECT p.id, p.name, p.team_id, p.role, p.zones, p.minor, p.guardian, EXISTS (SELECT 1 FROM photos h WHERE h.event_id = p.event_id AND h.person_id = p.id) AS has_photo FROM people p WHERE p.event_id = ? ORDER BY p.rowid",
    ).bind(ev.id),
  ]);
  type P = { id: string; name: string; team_id: string; role: string; zones: string; minor: number; guardian: number; has_photo: number };
  return c.json({
    teams: t!.results,
    people: (p!.results as P[]).map((r) => ({
      id: r.id,
      name: r.name,
      teamId: r.team_id,
      role: r.role,
      zones: JSON.parse(r.zones) as unknown,
      minor: !!r.minor,
      guardian: !!r.guardian,
      photoUrl: r.has_photo ? `/events/${ev.id}/photos/${encodeURIComponent(r.id)}` : null,
    })),
  });
});

// ---- photos (owner) ----
roster.get("/events/:id/photos/:personId", async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const ph = await c.env.DB.prepare("SELECT content_type, bytes FROM photos WHERE event_id = ? AND person_id = ?").bind(ev.id, c.req.param("personId")).first<{ content_type: string; bytes: ArrayBuffer }>();
  if (!ph) throw new HttpError(404, "Photo not found");
  return imageResponse(ph.content_type, blobBytes(ph.bytes));
});

roster.put("/events/:id/photos/:personId", async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const personId = c.req.param("personId");
  const person = await c.env.DB.prepare("SELECT 1 FROM people WHERE event_id = ? AND id = ?").bind(ev.id, personId).first();
  if (!person) throw new HttpError(404, "Person not found");
  const type = (c.req.header("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const bytes = await readBytes(c, MAX_PHOTO_BODY);
  const img = checkImage(type, bytes, "photo");
  await c.env.DB.prepare("INSERT OR REPLACE INTO photos (event_id, person_id, content_type, bytes) VALUES (?, ?, ?, ?)").bind(ev.id, personId, img.type, img.bytes.buffer as ArrayBuffer).run();
  return c.json({ ok: true });
});

roster.delete("/events/:id/photos/:personId", async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM photos WHERE event_id = ? AND person_id = ?").bind(ev.id, c.req.param("personId")).run();
  return c.json({ ok: true });
});

// ---- passes ----
roster.get("/events/:id/passes", async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const rows = await c.env.DB.prepare("SELECT id, role FROM people WHERE event_id = ? ORDER BY rowid").bind(ev.id).all<{ id: string; role: string }>();
  const key = await importPassKey(ev.signing_secret);
  const out = [];
  for (const r of rows.results) out.push({ personId: r.id, code: passCode(ev.slug, r.id, await passSig(key, ev.slug, r.id, r.role)) });
  return c.json(out);
});

// ---- gate keys ----
roster.post("/events/:id/gate-keys", async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const b = await readJson(c);
  const label = str(b.label, "label", 1, 60);
  const hours = optHours(b.expiresInHours, "expiresInHours");
  const raw = `gk_${randomToken()}`;
  const row = { id: crypto.randomUUID(), expiresAt: inHours(hours), createdAt: nowIso() };
  await c.env.DB.prepare("INSERT INTO gate_keys (id, event_id, label, key_hash, expires_at, revoked, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)")
    .bind(row.id, ev.id, label, await sha256(raw), row.expiresAt, row.createdAt)
    .run();
  return c.json({ id: row.id, key: raw, label, expiresAt: row.expiresAt, createdAt: row.createdAt }, 201);
});

roster.get("/events/:id/gate-keys", async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const rows = await c.env.DB.prepare("SELECT id, label, expires_at, revoked, created_at FROM gate_keys WHERE event_id = ? ORDER BY created_at DESC").bind(ev.id).all<{ id: string; label: string; expires_at: string | null; revoked: number; created_at: string }>();
  return c.json(rows.results.map((r) => ({ id: r.id, label: r.label, expiresAt: r.expires_at, revoked: !!r.revoked, createdAt: r.created_at })));
});

roster.delete("/events/:id/gate-keys/:keyId", async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const r = await c.env.DB.prepare("UPDATE gate_keys SET revoked = 1 WHERE id = ? AND event_id = ?").bind(c.req.param("keyId"), ev.id).run();
  if (!r.meta.changes) throw new HttpError(404, "Gate key not found");
  return c.json({ ok: true });
});

// ---- live check-in view ----
roster.get("/events/:id/checkins", async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const sinceRaw = c.req.query("since");
  let since = "";
  if (sinceRaw) {
    const d = new Date(sinceRaw);
    if (Number.isNaN(d.getTime())) throw new HttpError(400, "since must be an ISO date");
    since = d.toISOString();
  }
  const db = c.env.DB;
  const [list, totals] = await db.batch([
    db
      .prepare("SELECT k.person_id, p.name, t.name AS team, p.role, k.at FROM checkins k JOIN people p ON p.event_id = k.event_id AND p.id = k.person_id LEFT JOIN teams t ON t.event_id = p.event_id AND t.id = p.team_id WHERE k.event_id = ? AND k.at > ? ORDER BY k.at LIMIT 2000")
      .bind(ev.id, since),
    db.prepare("SELECT (SELECT COUNT(*) FROM people WHERE event_id = ?1) AS total, (SELECT COUNT(*) FROM checkins WHERE event_id = ?1) AS checked").bind(ev.id),
  ]);
  const tot = totals!.results[0] as { total: number; checked: number };
  return c.json({
    checkins: (list!.results as { person_id: string; name: string; team: string | null; role: string; at: string }[]).map((r) => ({ personId: r.person_id, name: r.name, team: r.team, role: r.role, at: r.at })),
    total: tot.total,
    checkedIn: tot.checked,
  });
});

roster.delete("/events/:id/checkins", async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM checkins WHERE event_id = ?").bind(ev.id).run();
  return c.json({ ok: true });
});
