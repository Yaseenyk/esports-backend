import { Hono } from "hono";
import type { AppBindings, EventRow } from "../types";
import { importPassKey, passCode, passSig } from "../crypto";
import { hashToken, newLink, revealToken, verifyPresented } from "../links";
import { HttpError, nowIso } from "../http";
import { blobBytes, imageResponse } from "../images";
import { ownedEvent, requireUser } from "../auth";
import { takenDown } from "../moderation/takedown";

export const share = new Hono<AppBindings>();

share.post("/events/:id/people/:personId/share", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const pid = c.req.param("personId");
  const person = await c.env.DB.prepare("SELECT 1 FROM people WHERE event_id = ? AND id = ?").bind(ev.id, pid).first();
  if (!person) throw new HttpError(404, "Person not found");
  const existing = await c.env.DB.prepare("SELECT id, token, token_enc FROM share_links WHERE event_id = ? AND person_id = ? AND revoked = 0").bind(ev.id, pid).first<{ id: string; token: string; token_enc: string | null }>();
  if (existing) return c.json({ token: await revealToken(c.env, "share", existing.id, existing) });
  const id = crypto.randomUUID();
  const { token, cols } = await newLink(c.env, "share", id);
  await c.env.DB.prepare("INSERT INTO share_links (id, event_id, person_id, token, token_hash, token_enc, created_at, revoked) VALUES (?, ?, ?, ?, ?, ?, ?, 0)").bind(id, ev.id, pid, cols.token, cols.token_hash, cols.token_enc, nowIso()).run();
  return c.json({ token }, 201);
});

share.delete("/events/:id/people/:personId/share", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await c.env.DB.prepare("UPDATE share_links SET revoked = 1 WHERE event_id = ? AND person_id = ?").bind(ev.id, c.req.param("personId")).run();
  return c.json({ ok: true });
});

interface PassRow {
  id: string;
  token: string;
  token_hash: string | null;
  person_id: string;
  event_id: string;
}

// Phase A: the hashed column first (unique index), then a legacy row that has not been backfilled yet. A row with a hash never matches on its `token` column, which only holds a placeholder.
async function linkFor(c: { env: AppBindings["Bindings"] }, token: string) {
  if (token.length > 64) throw new HttpError(404, "Not found");
  const db = c.env.DB;
  const row =
    (await db.prepare("SELECT id, token, token_hash, person_id, event_id FROM share_links WHERE token_hash = ? AND revoked = 0").bind(await hashToken(token)).first<PassRow>()) ??
    (await db.prepare("SELECT id, token, token_hash, person_id, event_id FROM share_links WHERE token = ? AND token_hash IS NULL AND revoked = 0").bind(token).first<PassRow>());
  if (!row || !(await verifyPresented(token, row))) throw new HttpError(404, "Not found");
  if (await takenDown(db, { type: "pass", id: row.id, eventId: row.event_id })) throw new HttpError(404, "Not found");
  return row;
}

share.get("/public/pass/:token", async (c) => {
  const l = await linkFor(c, c.req.param("token"));
  const db = c.env.DB;
  const ev = await db.prepare("SELECT * FROM events WHERE id = ?").bind(l.event_id).first<EventRow>();
  const p = await db
    .prepare("SELECT p.id, p.name, t.name AS team, p.role, p.zones, EXISTS (SELECT 1 FROM photos h WHERE h.event_id = p.event_id AND h.person_id = p.id) AS has_photo FROM people p LEFT JOIN teams t ON t.event_id = p.event_id AND t.id = p.team_id WHERE p.event_id = ? AND p.id = ?")
    .bind(l.event_id, l.person_id)
    .first<{ id: string; name: string; team: string | null; role: string; zones: string; has_photo: number }>();
  if (!ev || !p) throw new HttpError(404, "Not found");
  const sig = await passSig(await importPassKey(ev.signing_secret), ev.slug, p.id, p.role);
  // Cached by the browser and Cloudflare for a minute: a thousand people opening links cost a handful of reads. A switched-off link stops working within that minute.
  c.header("cache-control", "public, max-age=60, s-maxage=60");
  return c.json({
    event: { name: ev.name, date: ev.date, venue: ev.venue },
    person: { name: p.name, team: p.team, role: p.role, zones: JSON.parse(p.zones) as unknown },
    code: passCode(ev.slug, p.id, sig),
    photoUrl: p.has_photo ? `/public/pass/${c.req.param("token")}/photo` : null,
  });
});

share.get("/public/pass/:token/photo", async (c) => {
  const l = await linkFor(c, c.req.param("token"));
  const ph = await c.env.DB.prepare("SELECT content_type, bytes FROM photos WHERE event_id = ? AND person_id = ?").bind(l.event_id, l.person_id).first<{ content_type: string; bytes: ArrayBuffer }>();
  if (!ph) throw new HttpError(404, "Not found");
  return imageResponse(ph.content_type, blobBytes(ph.bytes), "private, max-age=300");
});
