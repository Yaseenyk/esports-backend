import { Hono } from "hono";
import type { AppBindings } from "../types";
import { randomToken } from "../crypto";
import { HttpError, idStr, inHours, nowIso, optBool, optHours, optStr, rateLimit, readJson, str } from "../http";
import { blobBytes, imageResponse, parsePhotoDataUrl } from "../images";
import { ownedEvent, requireUser } from "../auth";

export const invites = new Hono<AppBindings>();

const ROLES = ["Player", "Substitute", "Coach", "Manager", "Staff"];

// ---------------- owner side ----------------
invites.post("/events/:id/invites", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const b = await readJson(c);
  const teamId = idStr(b.teamId, "teamId");
  const team = await c.env.DB.prepare("SELECT 1 FROM teams WHERE event_id = ? AND id = ?").bind(ev.id, teamId).first();
  if (!team) throw new HttpError(404, "Team not found");
  const label = optStr(b.label, "label", 60);
  let maxUses: number | null = null;
  if (b.maxUses !== undefined && b.maxUses !== null) {
    if (typeof b.maxUses !== "number" || !Number.isInteger(b.maxUses) || b.maxUses < 1 || b.maxUses > 10_000) throw new HttpError(400, "maxUses must be an integer between 1 and 10000");
    maxUses = b.maxUses;
  }
  const expiresAt = inHours(optHours(b.expiresInHours, "expiresInHours"));
  const id = crypto.randomUUID();
  const token = randomToken();
  await c.env.DB.prepare("INSERT INTO invites (id, event_id, team_id, token, label, max_uses, uses, expires_at, revoked, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?)")
    .bind(id, ev.id, teamId, token, label, maxUses, expiresAt, nowIso())
    .run();
  return c.json({ id, token, teamId, label, maxUses, expiresAt }, 201);
});

invites.get("/events/:id/invites", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const hide = ev.my_role === "viewer"; // the token is a credential that lets its holder submit people: view-only members get it blank
  const rows = await c.env.DB.prepare("SELECT id, team_id, token, label, max_uses, uses, expires_at, revoked, created_at FROM invites WHERE event_id = ? ORDER BY created_at DESC LIMIT 500")
    .bind(ev.id)
    .all<{ id: string; team_id: string; token: string; label: string; max_uses: number | null; uses: number; expires_at: string | null; revoked: number; created_at: string }>();
  return c.json(rows.results.map((r) => ({ id: r.id, teamId: r.team_id, token: hide ? "" : r.token, label: r.label, maxUses: r.max_uses, uses: r.uses, expiresAt: r.expires_at, revoked: !!r.revoked, createdAt: r.created_at })));
});

invites.delete("/events/:id/invites/:inviteId", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const r = await c.env.DB.prepare("UPDATE invites SET revoked = 1 WHERE id = ? AND event_id = ?").bind(c.req.param("inviteId"), ev.id).run();
  if (!r.meta.changes) throw new HttpError(404, "Invite not found");
  return c.json({ ok: true });
});

interface SubRow {
  id: string;
  team_id: string;
  team: string | null;
  name: string;
  role: string;
  minor: number;
  status: string;
  created_at: string;
  has_photo: number;
}

invites.get("/events/:id/submissions", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const status = c.req.query("status");
  if (status !== undefined && !["pending", "approved", "rejected"].includes(status)) throw new HttpError(400, "status must be pending, approved or rejected");
  const rows = await c.env.DB.prepare(
    "SELECT s.id, s.team_id, t.name AS team, s.name, s.role, s.minor, s.status, s.created_at, (s.photo IS NOT NULL) AS has_photo FROM submissions s LEFT JOIN teams t ON t.event_id = s.event_id AND t.id = s.team_id WHERE s.event_id = ?1 AND (?2 IS NULL OR s.status = ?2) ORDER BY s.created_at LIMIT 1000",
  )
    .bind(ev.id, status ?? null)
    .all<SubRow>();
  return c.json(
    rows.results.map((r) => ({
      id: r.id,
      teamId: r.team_id,
      team: r.team,
      name: r.name,
      role: r.role,
      minor: !!r.minor,
      status: r.status,
      createdAt: r.created_at,
      photoUrl: r.has_photo ? `/events/${ev.id}/submissions/${r.id}/photo` : null,
    })),
  );
});

invites.get("/events/:id/submissions/:sid/photo", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const r = await c.env.DB.prepare("SELECT photo, photo_type FROM submissions WHERE id = ? AND event_id = ? AND photo IS NOT NULL").bind(c.req.param("sid"), ev.id).first<{ photo: ArrayBuffer; photo_type: string }>();
  if (!r) throw new HttpError(404, "Photo not found");
  return imageResponse(r.photo_type, blobBytes(r.photo));
});

async function pendingSubmission(c: Parameters<typeof ownedEvent>[0], eventId: string, sid: string) {
  const s = await c.env.DB.prepare("SELECT id, team_id, name, role, minor, status FROM submissions WHERE id = ? AND event_id = ?")
    .bind(sid, eventId)
    .first<{ id: string; team_id: string; name: string; role: string; minor: number; status: string }>();
  if (!s) throw new HttpError(404, "Submission not found");
  if (s.status !== "pending") throw new HttpError(409, `Submission is already ${s.status}`);
  return s;
}

invites.post("/events/:id/submissions/:sid/approve", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const s = await pendingSubmission(c, ev.id, c.req.param("sid"));
  const raw = c.req.header("content-length") === "0" ? {} : await readJson(c).catch(() => ({}) as Record<string, unknown>);
  const db = c.env.DB;
  const team = await db.prepare("SELECT name FROM teams WHERE event_id = ? AND id = ?").bind(ev.id, s.team_id).first<{ name: string }>();
  if (!team) throw new HttpError(409, "The team of this submission no longer exists");
  const count = await db.prepare("SELECT COUNT(*) AS n FROM people WHERE event_id = ?").bind(ev.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 2000) throw new HttpError(409, "Event already has the maximum of 2000 people");

  let personId: string;
  if (raw.personId !== undefined && raw.personId !== null) {
    personId = idStr(raw.personId, "personId");
    const dup = await db.prepare("SELECT 1 FROM people WHERE event_id = ? AND id = ?").bind(ev.id, personId).first();
    if (dup) throw new HttpError(409, "A person with this id already exists");
  } else {
    const prefix = (team.name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 3) || "TEM").padEnd(3, "X");
    const rows = await db.prepare("SELECT id FROM people WHERE event_id = ? AND id LIKE ?").bind(ev.id, `${prefix}-%`).all<{ id: string }>();
    let max = 0;
    for (const r of rows.results) {
      const m = /^[A-Z0-9]{3}-(\d+)$/.exec(r.id);
      if (m) max = Math.max(max, Number(m[1]));
    }
    personId = `${prefix}-${String(max + 1).padStart(3, "0")}`;
  }
  const guardian = optBool(raw.guardian, "guardian") && !!s.minor ? 1 : 0;
  const res = await db.batch([
    db.prepare("UPDATE submissions SET status = 'approved' WHERE id = ? AND event_id = ? AND status = 'pending'").bind(s.id, ev.id),
    db
      .prepare("INSERT INTO people (event_id, id, team_id, name, role, zones, minor, guardian) SELECT ?, ?, ?, ?, ?, '[]', ?, ? WHERE changes() = 1")
      .bind(ev.id, personId, s.team_id, s.name, s.role, s.minor, guardian),
    db
      .prepare("INSERT OR REPLACE INTO photos (event_id, person_id, content_type, bytes) SELECT ?1, ?2, photo_type, photo FROM submissions WHERE id = ?3 AND photo IS NOT NULL AND changes() = 1")
      .bind(ev.id, personId, s.id),
  ]);
  if (res[1]!.meta.changes !== 1) throw new HttpError(409, "Submission was already handled");
  return c.json({ ok: true, personId });
});

invites.post("/events/:id/submissions/:sid/reject", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const s = await pendingSubmission(c, ev.id, c.req.param("sid"));
  await c.env.DB.prepare("UPDATE submissions SET status = 'rejected', photo = NULL, photo_type = NULL WHERE id = ? AND event_id = ?").bind(s.id, ev.id).run();
  return c.json({ ok: true });
});

// ---------------- public side ----------------
interface InviteRow {
  id: string;
  event_id: string;
  team_id: string;
  event_name: string;
  event_date: string;
  team_name: string;
}

async function usableInvite(c: { env: AppBindings["Bindings"] }, token: string): Promise<InviteRow> {
  if (token.length > 64) throw new HttpError(404, "Invite not found");
  const row = await c.env.DB.prepare(
    "SELECT i.id, i.event_id, i.team_id, e.name AS event_name, e.date AS event_date, t.name AS team_name FROM invites i JOIN events e ON e.id = i.event_id JOIN teams t ON t.event_id = i.event_id AND t.id = i.team_id WHERE i.token = ? AND i.revoked = 0 AND (i.expires_at IS NULL OR i.expires_at > ?) AND (i.max_uses IS NULL OR i.uses < i.max_uses)",
  )
    .bind(token, nowIso())
    .first<InviteRow>();
  if (!row) throw new HttpError(404, "Invite not found");
  return row;
}

invites.get("/public/invite/:token", async (c) => {
  const i = await usableInvite(c, c.req.param("token"));
  c.header("cache-control", "public, max-age=30");
  return c.json({ event: { name: i.event_name, date: i.event_date }, team: { name: i.team_name } });
});

invites.post("/public/invite/:token/submit", async (c) => {
  const token = c.req.param("token");
  await rateLimit(c, "submit", 30, 3600, token);
  const b = await readJson(c);
  const name = str(b.name, "name", 1, 80);
  let role = "Player";
  if (b.role !== undefined && b.role !== null) {
    if (typeof b.role !== "string" || !ROLES.includes(b.role)) throw new HttpError(400, `role must be one of ${ROLES.join(", ")}`);
    role = b.role;
  }
  const minor = optBool(b.minor, "minor") ? 1 : 0;
  const img = b.photo === undefined || b.photo === null ? null : parsePhotoDataUrl(b.photo, "photo");
  const inv = await usableInvite(c, token);
  const db = c.env.DB;
  const sid = crypto.randomUUID();
  // Atomic: only insert the submission if the use counter could really be incremented.
  const res = await db.batch([
    db
      .prepare("UPDATE invites SET uses = uses + 1 WHERE id = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?) AND (max_uses IS NULL OR uses < max_uses)")
      .bind(inv.id, nowIso()),
    db
      .prepare("INSERT INTO submissions (id, invite_id, event_id, team_id, name, role, minor, photo, photo_type, status, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ? WHERE changes() = 1")
      .bind(sid, inv.id, inv.event_id, inv.team_id, name, role, minor, img ? (img.bytes.buffer as ArrayBuffer) : null, img ? img.type : null, nowIso()),
  ]);
  if (res[1]!.meta.changes !== 1) throw new HttpError(404, "Invite not found");
  return c.json({ ok: true, id: sid }, 201);
});
