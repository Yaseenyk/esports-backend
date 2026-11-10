import { Hono } from "hono";
import type { AppBindings, EventRow } from "../types";
import { importPassKey, passCode, passSig, randomToken } from "../crypto";
import { HttpError, nowIso } from "../http";
import { blobBytes, imageResponse } from "../images";
import { ownedEvent, requireUser } from "../auth";

export const share = new Hono<AppBindings>();

share.post("/events/:id/people/:personId/share", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const pid = c.req.param("personId");
  const person = await c.env.DB.prepare("SELECT 1 FROM people WHERE event_id = ? AND id = ?").bind(ev.id, pid).first();
  if (!person) throw new HttpError(404, "Person not found");
  const existing = await c.env.DB.prepare("SELECT token FROM share_links WHERE event_id = ? AND person_id = ? AND revoked = 0").bind(ev.id, pid).first<{ token: string }>();
  if (existing) return c.json({ token: existing.token });
  const token = randomToken();
  await c.env.DB.prepare("INSERT INTO share_links (id, event_id, person_id, token, created_at, revoked) VALUES (?, ?, ?, ?, ?, 0)").bind(crypto.randomUUID(), ev.id, pid, token, nowIso()).run();
  return c.json({ token }, 201);
});

share.delete("/events/:id/people/:personId/share", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await c.env.DB.prepare("UPDATE share_links SET revoked = 1 WHERE event_id = ? AND person_id = ?").bind(ev.id, c.req.param("personId")).run();
  return c.json({ ok: true });
});

interface PassRow {
  token: string;
  person_id: string;
  event_id: string;
}

async function linkFor(c: { env: AppBindings["Bindings"] }, token: string) {
  if (token.length > 64) throw new HttpError(404, "Not found");
  const row = await c.env.DB.prepare("SELECT token, person_id, event_id FROM share_links WHERE token = ? AND revoked = 0").bind(token).first<PassRow>();
  if (!row) throw new HttpError(404, "Not found");
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
    photoUrl: p.has_photo ? `/public/pass/${l.token}/photo` : null,
  });
});

share.get("/public/pass/:token/photo", async (c) => {
  const l = await linkFor(c, c.req.param("token"));
  const ph = await c.env.DB.prepare("SELECT content_type, bytes FROM photos WHERE event_id = ? AND person_id = ?").bind(l.event_id, l.person_id).first<{ content_type: string; bytes: ArrayBuffer }>();
  if (!ph) throw new HttpError(404, "Not found");
  return imageResponse(ph.content_type, blobBytes(ph.bytes), "private, max-age=300");
});
