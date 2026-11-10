import { Hono } from "hono";
import type { AppBindings, EventRow } from "../types";
import { importPassKey, passSig, timingSafeEqual } from "../crypto";
import { HttpError, nowIso, readJson } from "../http";
import { imageResponse } from "../images";
import { requireGate } from "../auth";

export const gate = new Hono<AppBindings>();
gate.use("/gate/*", requireGate);

gate.get("/gate/roster", async (c) => {
  const eid = c.get("gateEventId");
  const db = c.env.DB;
  const [ev, rows] = await db.batch([
    db.prepare("SELECT name, date, venue FROM events WHERE id = ?").bind(eid),
    db
      .prepare(
        "SELECT p.id, p.name, t.name AS team, p.role, p.zones, p.minor, p.guardian, EXISTS (SELECT 1 FROM photos h WHERE h.event_id = p.event_id AND h.person_id = p.id) AS has_photo, k.at AS checked_at FROM people p LEFT JOIN teams t ON t.event_id = p.event_id AND t.id = p.team_id LEFT JOIN checkins k ON k.event_id = p.event_id AND k.person_id = p.id WHERE p.event_id = ? ORDER BY p.rowid",
      )
      .bind(eid),
  ]);
  const e = ev!.results[0] as { name: string; date: string; venue: string } | undefined;
  if (!e) throw new HttpError(401, "Valid gate key required");
  type R = { id: string; name: string; team: string | null; role: string; zones: string; minor: number; guardian: number; has_photo: number; checked_at: string | null };
  return c.json({
    event: { name: e.name, date: e.date, venue: e.venue },
    people: (rows!.results as R[]).map((r) => ({
      id: r.id,
      name: r.name,
      team: r.team,
      role: r.role,
      zones: JSON.parse(r.zones) as unknown,
      minor: !!r.minor,
      guardian: !!r.guardian,
      photoUrl: r.has_photo ? `/gate/photos/${encodeURIComponent(r.id)}` : null,
      checkedInAt: r.checked_at,
    })),
  });
});

gate.get("/gate/photos/:personId", async (c) => {
  const ph = await c.env.DB.prepare("SELECT content_type, bytes FROM photos WHERE event_id = ? AND person_id = ?")
    .bind(c.get("gateEventId"), c.req.param("personId"))
    .first<{ content_type: string; bytes: ArrayBuffer }>();
  if (!ph) throw new HttpError(404, "Photo not found");
  return imageResponse(ph.content_type, ph.bytes);
});

const bad = (reason: string) => ({ status: "bad" as const, reason });

gate.post("/gate/checkin", async (c) => {
  const body = await readJson(c);
  const code = typeof body.code === "string" ? body.code : "";
  const eid = c.get("gateEventId");
  if (code.length > 200) return c.json(bad("Malformed pass"));
  // EH1.<eventKey>.<personId>.<sig>; the id may itself contain dots, so take first two and last parts.
  const parts = code.split(".");
  if (parts.length < 4 || parts[0] !== "EH1") return c.json(bad("Malformed pass"));
  const eventKey = parts[1]!;
  const sig = parts[parts.length - 1]!;
  const personId = parts.slice(2, -1).join(".");

  const db = c.env.DB;
  const ev = await db.prepare("SELECT * FROM events WHERE id = ?").bind(eid).first<EventRow>();
  if (!ev) throw new HttpError(401, "Valid gate key required");
  if (!timingSafeEqual(eventKey, ev.slug)) return c.json(bad("Pass is for a different event"));
  const person = await db
    .prepare("SELECT p.id, p.name, t.name AS team, p.role, p.zones, p.minor, p.guardian FROM people p LEFT JOIN teams t ON t.event_id = p.event_id AND t.id = p.team_id WHERE p.event_id = ? AND p.id = ?")
    .bind(eid, personId)
    .first<{ id: string; name: string; team: string | null; role: string; zones: string; minor: number; guardian: number }>();
  if (!person) return c.json(bad("Unknown person"));
  const expected = await passSig(await importPassKey(ev.signing_secret), ev.slug, person.id, person.role);
  if (!timingSafeEqual(expected, sig)) return c.json(bad("Signature does not match (pass edited or role changed)"));

  const info = { id: person.id, name: person.name, team: person.team, role: person.role, zones: JSON.parse(person.zones) as unknown, minor: !!person.minor, guardian: !!person.guardian };
  const at = nowIso();
  const ins = await db.prepare("INSERT INTO checkins (event_id, person_id, at) VALUES (?, ?, ?) ON CONFLICT (event_id, person_id) DO NOTHING").bind(eid, person.id, at).run();
  if (ins.meta.changes === 1) return c.json({ status: "ok", person: info, at });
  const first = await db.prepare("SELECT at FROM checkins WHERE event_id = ? AND person_id = ?").bind(eid, person.id).first<{ at: string }>();
  return c.json({ status: "again", person: info, at: first?.at ?? at });
});
