import { Hono } from "hono";
import type { AppBindings } from "../types";
import { randomToken } from "../crypto";
import { HttpError, nowIso, optBool, optStr, rateLimit, readJson, str } from "../http";
import { ownedEvent, requireUser } from "../auth";

export const registration = new Hono<AppBindings>();

interface FormRow { event_id: string; token: string; title: string; intro: string; closes_at: string | null; max_teams: number | null; team_size: number; subs: number; open: number; created_at: string }
interface RegRow { id: string; event_id: string; team_name: string; captain_name: string; captain_contact: string; players: string; notes: string; status: string; created_at: string }
interface Player { name: string; ign: string; minor: boolean }

const publicForm = (f: FormRow) => ({ token: f.token, title: f.title, intro: f.intro, closesAt: f.closes_at, maxTeams: f.max_teams, teamSize: f.team_size, subs: f.subs, open: !!f.open, createdAt: f.created_at });
const regOut = (r: RegRow) => ({ id: r.id, teamName: r.team_name, captainName: r.captain_name, captainContact: r.captain_contact, players: JSON.parse(r.players) as Player[], notes: r.notes, status: r.status, createdAt: r.created_at });

function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new HttpError(400, `${field} must be a whole number from ${min} to ${max}`);
  return v;
}

// ---------- organiser ----------
registration.put("/events/:id/registration", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const b = await readJson(c);
  const db = c.env.DB;
  const cur = await db.prepare("SELECT * FROM registration_forms WHERE event_id = ?").bind(ev.id).first<FormRow>();
  const title = b.title === undefined ? (cur?.title ?? "") : optStr(b.title, "title", 120);
  const intro = b.intro === undefined ? (cur?.intro ?? "") : optStr(b.intro, "intro", 1000);
  let closes = cur?.closes_at ?? null;
  if (b.closesAt !== undefined) {
    if (b.closesAt === null) closes = null;
    else if (typeof b.closesAt === "string" && !Number.isNaN(Date.parse(b.closesAt))) closes = new Date(b.closesAt).toISOString();
    else throw new HttpError(400, "closesAt must be a date or null");
  }
  const maxTeams = b.maxTeams === undefined ? (cur?.max_teams ?? null) : b.maxTeams === null ? null : int(b.maxTeams, "maxTeams", 1, 500);
  const teamSize = b.teamSize === undefined ? (cur?.team_size ?? 4) : int(b.teamSize, "teamSize", 1, 20);
  const subs = b.subs === undefined ? (cur?.subs ?? 1) : int(b.subs, "subs", 0, 10);
  const open = b.open === undefined ? (cur ? !!cur.open : true) : optBool(b.open, "open");
  if (cur) {
    await db.prepare("UPDATE registration_forms SET title = ?, intro = ?, closes_at = ?, max_teams = ?, team_size = ?, subs = ?, open = ? WHERE event_id = ?")
      .bind(title, intro, closes, maxTeams, teamSize, subs, open ? 1 : 0, ev.id).run();
  } else {
    await db.prepare("INSERT INTO registration_forms (event_id, token, title, intro, closes_at, max_teams, team_size, subs, open, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(ev.id, randomToken(), title, intro, closes, maxTeams, teamSize, subs, open ? 1 : 0, nowIso()).run();
  }
  const f = await db.prepare("SELECT * FROM registration_forms WHERE event_id = ?").bind(ev.id).first<FormRow>();
  return c.json(publicForm(f!), cur ? 200 : 201);
});

registration.get("/events/:id/registration", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const db = c.env.DB;
  const f = await db.prepare("SELECT * FROM registration_forms WHERE event_id = ?").bind(ev.id).first<FormRow>();
  const counts = await db.prepare("SELECT status, COUNT(*) AS n FROM registrations WHERE event_id = ? GROUP BY status").bind(ev.id).all<{ status: string; n: number }>();
  const by = Object.fromEntries(counts.results.map((r) => [r.status, r.n]));
  return c.json({ form: f ? publicForm(f) : null, counts: { pending: by.pending ?? 0, approved: by.approved ?? 0, rejected: by.rejected ?? 0 } });
});

registration.get("/events/:id/registrations", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const status = c.req.query("status");
  if (status !== undefined && !["pending", "approved", "rejected"].includes(status)) throw new HttpError(400, "status must be pending, approved or rejected");
  const rows = await c.env.DB.prepare("SELECT * FROM registrations WHERE event_id = ?1 AND (?2 IS NULL OR status = ?2) ORDER BY created_at LIMIT 500").bind(ev.id, status ?? null).all<RegRow>();
  return c.json(rows.results.map(regOut));
});

async function pending(c: Parameters<typeof ownedEvent>[0], eventId: string, rid: string) {
  const r = await c.env.DB.prepare("SELECT * FROM registrations WHERE id = ? AND event_id = ?").bind(rid, eventId).first<RegRow>();
  if (!r) throw new HttpError(404, "Registration not found");
  if (r.status !== "pending") throw new HttpError(409, `Registration is already ${r.status}`);
  return r;
}

registration.post("/events/:id/registrations/:rid/approve", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const r = await pending(c, ev.id, c.req.param("rid"));
  const db = c.env.DB;
  const form = await db.prepare("SELECT team_size FROM registration_forms WHERE event_id = ?").bind(ev.id).first<{ team_size: number }>();
  const players = JSON.parse(r.players) as Player[];
  const dupTeam = await db.prepare("SELECT 1 FROM teams WHERE event_id = ? AND lower(name) = lower(?)").bind(ev.id, r.team_name).first();
  if (dupTeam) throw new HttpError(409, "A team with this name is already on the roster");
  const people = await db.prepare("SELECT COUNT(*) AS n FROM people WHERE event_id = ?").bind(ev.id).first<{ n: number }>();
  if ((people?.n ?? 0) + players.length > 2000) throw new HttpError(409, "Approving this team would pass the 2000 people limit");

  const teamRows = await db.prepare("SELECT id FROM teams WHERE event_id = ?").bind(ev.id).all<{ id: string }>();
  let maxT = 0;
  for (const t of teamRows.results) { const m = /^R(\d+)$/.exec(t.id); if (m) maxT = Math.max(maxT, Number(m[1])); }
  const teamId = `R${maxT + 1}`;
  const prefix = (r.team_name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "TEM").padEnd(3, "X");
  const existing = await db.prepare("SELECT id FROM people WHERE event_id = ? AND id LIKE ?").bind(ev.id, `${prefix}-%`).all<{ id: string }>();
  let maxP = 0;
  for (const p of existing.results) { const m = /^[A-Z0-9]{3}-(\d+)$/.exec(p.id); if (m) maxP = Math.max(maxP, Number(m[1])); }
  const size = form?.team_size ?? 4;

  const statements = [
    db.prepare("UPDATE registrations SET status = 'approved' WHERE id = ? AND event_id = ? AND status = 'pending'").bind(r.id, ev.id),
    db.prepare("INSERT INTO teams (event_id, id, name, logo) SELECT ?, ?, ?, NULL WHERE changes() = 1").bind(ev.id, teamId, r.team_name),
    ...players.map((p, i) => db.prepare("INSERT INTO people (event_id, id, team_id, name, role, zones, minor, guardian) SELECT ?, ?, ?, ?, ?, '[]', ?, 0 WHERE EXISTS (SELECT 1 FROM teams WHERE event_id = ? AND id = ?)")
      .bind(ev.id, `${prefix}-${String(maxP + 1 + i).padStart(3, "0")}`, teamId, p.name, i < size ? "Player" : "Substitute", p.minor ? 1 : 0, ev.id, teamId)),
  ];
  const res = await db.batch(statements);
  if (res[1]!.meta.changes !== 1) throw new HttpError(409, "Registration was already handled");
  return c.json({ ok: true, teamId, people: players.length });
});

registration.post("/events/:id/registrations/:rid/reject", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const r = await pending(c, ev.id, c.req.param("rid"));
  await c.env.DB.prepare("UPDATE registrations SET status = 'rejected' WHERE id = ? AND event_id = ?").bind(r.id, ev.id).run();
  return c.json({ ok: true });
});

// ---------- public ----------
async function openForm(c: Parameters<typeof ownedEvent>[0], token: string) {
  if (token.length > 64) throw new HttpError(404, "Not found");
  const row = await c.env.DB.prepare("SELECT f.*, e.name AS event_name, e.date AS event_date, e.venue AS event_venue FROM registration_forms f JOIN events e ON e.id = f.event_id WHERE f.token = ?")
    .bind(token).first<FormRow & { event_name: string; event_date: string; event_venue: string }>();
  if (!row) throw new HttpError(404, "Not found");
  const taken = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ? AND status != 'rejected'").bind(row.event_id).first<{ n: number }>();
  const closed = !row.open || (row.closes_at !== null && Date.parse(row.closes_at) < Date.now());
  const full = row.max_teams !== null && (taken?.n ?? 0) >= row.max_teams;
  return { row, taken: taken?.n ?? 0, status: closed ? ("closed" as const) : full ? ("full" as const) : ("open" as const) };
}

registration.get("/public/registration/:token", async (c) => {
  const { row, taken, status } = await openForm(c, c.req.param("token"));
  c.header("cache-control", "public, max-age=30");
  return c.json({
    event: { name: row.event_name, date: row.event_date, venue: row.event_venue },
    form: { title: row.title, intro: row.intro, teamSize: row.team_size, subs: row.subs, closesAt: row.closes_at, spotsLeft: row.max_teams === null ? null : Math.max(0, row.max_teams - taken), status },
  });
});

registration.post("/public/registration/:token/submit", async (c) => {
  const token = c.req.param("token");
  await rateLimit(c, "register", 10, 3600, token);
  const b = await readJson(c);
  const { row, status } = await openForm(c, token);
  if (status === "closed") throw new HttpError(409, "Registration is closed");
  if (status === "full") throw new HttpError(409, "All places are taken");
  const teamName = str(b.teamName, "teamName", 2, 60);
  const captainName = str(b.captainName, "captainName", 2, 80);
  const contact = str(b.captainContact, "captainContact", 5, 120);
  const notes = optStr(b.notes, "notes", 500);
  if (!Array.isArray(b.players)) throw new HttpError(400, "players must be a list");
  if (b.players.length < row.team_size || b.players.length > row.team_size + row.subs) throw new HttpError(400, `Give ${row.team_size} players${row.subs ? ` and up to ${row.subs} substitute${row.subs === 1 ? "" : "s"}` : ""}`);
  const players: Player[] = b.players.map((p: Record<string, unknown>, i: number) => {
    if (!p || typeof p !== "object") throw new HttpError(400, `players[${i}] is not valid`);
    return { name: str(p.name, `players[${i}].name`, 1, 80), ign: optStr(p.ign, `players[${i}].ign`, 40), minor: optBool(p.minor, `players[${i}].minor`) };
  });
  const db = c.env.DB;
  const dup = await db.prepare("SELECT 1 FROM registrations WHERE event_id = ? AND lower(team_name) = lower(?) AND status != 'rejected'").bind(row.event_id, teamName).first();
  if (dup) throw new HttpError(409, "A team with this name has already registered");
  const id = crypto.randomUUID();
  await db.prepare("INSERT INTO registrations (id, event_id, team_name, captain_name, captain_contact, players, notes, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)")
    .bind(id, row.event_id, teamName, captainName, contact, JSON.stringify(players), notes, nowIso()).run();
  return c.json({ ok: true, id }, 201);
});
