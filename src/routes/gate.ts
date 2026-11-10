import { Hono, type Context } from "hono";
import type { AppBindings, EventRow } from "../types";
import { importPassKey, passSig, timingSafeEqual } from "../crypto";
import { HttpError, nowIso, readJson } from "../http";
import { blobBytes, imageResponse } from "../images";
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
  return imageResponse(ph.content_type, blobBytes(ph.bytes));
});

const bad = (reason: string) => ({ status: "bad" as const, reason });

type Ctx = Context<AppBindings>;

async function checkCode(c: Ctx, code: string) {
  const eid = c.get("gateEventId");
  if (code.length > 200) return bad("Malformed pass");
  // EH1.<eventKey>.<personId>.<sig>; the id may itself contain dots, so take first two and last parts.
  const parts = code.split(".");
  if (parts.length < 4 || parts[0] !== "EH1") return bad("Malformed pass");
  const eventKey = parts[1]!;
  const sig = parts[parts.length - 1]!;
  const personId = parts.slice(2, -1).join(".");

  const db = c.env.DB;
  const ev = await db.prepare("SELECT * FROM events WHERE id = ?").bind(eid).first<EventRow>();
  if (!ev) throw new HttpError(401, "Valid gate key required");
  if (!timingSafeEqual(eventKey, ev.slug)) return bad("Pass is for a different event");
  const person = await db
    .prepare("SELECT p.id, p.name, t.name AS team, p.role, p.zones, p.minor, p.guardian FROM people p LEFT JOIN teams t ON t.event_id = p.event_id AND t.id = p.team_id WHERE p.event_id = ? AND p.id = ?")
    .bind(eid, personId)
    .first<{ id: string; name: string; team: string | null; role: string; zones: string; minor: number; guardian: number }>();
  if (!person) return bad("Unknown person");
  const expected = await passSig(await importPassKey(ev.signing_secret), ev.slug, person.id, person.role);
  if (!timingSafeEqual(expected, sig)) return bad("Signature does not match (pass edited or role changed)");

  const info = { id: person.id, name: person.name, team: person.team, role: person.role, zones: JSON.parse(person.zones) as unknown, minor: !!person.minor, guardian: !!person.guardian };
  const at = nowIso();
  const ins = await db.prepare("INSERT INTO checkins (event_id, person_id, at, door) VALUES (?, ?, ?, ?) ON CONFLICT (event_id, person_id) DO NOTHING").bind(eid, person.id, at, c.get("gateLabel")).run();
  if (ins.meta.changes === 1) return { status: "ok" as const, person: info, at };
  const first = await db.prepare("SELECT at FROM checkins WHERE event_id = ? AND person_id = ?").bind(eid, person.id).first<{ at: string }>();
  return { status: "again" as const, person: info, at: first?.at ?? at };
}

gate.post("/gate/checkin", async (c) => {
  const body = await readJson(c);
  return c.json(await checkCode(c, typeof body.code === "string" ? body.code : ""));
});

/** Replays scans that were queued while the gate was offline. Up to 100 codes cost a handful of queries, not several per scan. */
gate.post("/gate/checkin/batch", async (c) => {
  const body = await readJson(c);
  const codes = Array.isArray(body.codes) ? body.codes.filter((x): x is string => typeof x === "string") : [];
  if (codes.length === 0 || codes.length > 100) throw new HttpError(400, "Send between 1 and 100 codes");
  const eid = c.get("gateEventId");
  const db = c.env.DB;
  const ev = await db.prepare("SELECT * FROM events WHERE id = ?").bind(eid).first<EventRow>();
  if (!ev) throw new HttpError(401, "Valid gate key required");

  type P = { code: string; id?: string; sig?: string; early?: ReturnType<typeof bad> };
  const parsed: P[] = codes.map((code) => {
    if (code.length > 200) return { code, early: bad("Malformed pass") };
    const parts = code.split(".");
    if (parts.length < 4 || parts[0] !== "EH1") return { code, early: bad("Malformed pass") };
    if (!timingSafeEqual(parts[1]!, ev.slug)) return { code, early: bad("Pass is for a different event") };
    return { code, id: parts.slice(2, -1).join("."), sig: parts[parts.length - 1]! };
  });
  const ids = [...new Set(parsed.filter((x) => x.id).map((x) => x.id!))];
  type Row = { id: string; name: string; team: string | null; role: string; zones: string; minor: number; guardian: number };
  const people = new Map<string, Row>();
  if (ids.length) {
    const rows = await db
      .prepare("SELECT p.id, p.name, t.name AS team, p.role, p.zones, p.minor, p.guardian FROM people p LEFT JOIN teams t ON t.event_id = p.event_id AND t.id = p.team_id WHERE p.event_id = ? AND p.id IN (SELECT value FROM json_each(?))")
      .bind(eid, JSON.stringify(ids))
      .all<Row>();
    for (const r of rows.results) people.set(r.id, r);
  }
  const key = await importPassKey(ev.signing_secret);
  const valid: { p: P; person: Row }[] = [];
  const out = new Map<string, ReturnType<typeof bad> | { status: "ok" | "again"; person: unknown; at: string }>();
  for (const x of parsed) {
    if (x.early) { out.set(x.code, x.early); continue; }
    const person = people.get(x.id!);
    if (!person) { out.set(x.code, bad("Unknown person")); continue; }
    if (!timingSafeEqual(await passSig(key, ev.slug, person.id, person.role), x.sig!)) { out.set(x.code, bad("Signature does not match (pass edited or role changed)")); continue; }
    valid.push({ p: x, person });
  }
  const at = nowIso();
  const unique = [...new Map(valid.map((v) => [v.person.id, v.person])).values()];
  const fresh = new Set<string>();
  if (unique.length) {
    const res = await db.batch(unique.map((u) => db.prepare("INSERT INTO checkins (event_id, person_id, at, door) VALUES (?, ?, ?, ?) ON CONFLICT (event_id, person_id) DO NOTHING").bind(eid, u.id, at, c.get("gateLabel"))));
    res.forEach((r, i) => { if (r.meta.changes === 1) fresh.add(unique[i]!.id); });
  }
  const earlier = new Map<string, string>();
  const old = unique.filter((u) => !fresh.has(u.id)).map((u) => u.id);
  if (old.length) {
    const rows = await db.prepare("SELECT person_id, at FROM checkins WHERE event_id = ? AND person_id IN (SELECT value FROM json_each(?))").bind(eid, JSON.stringify(old)).all<{ person_id: string; at: string }>();
    for (const r of rows.results) earlier.set(r.person_id, r.at);
  }
  const info = (r: Row) => ({ id: r.id, name: r.name, team: r.team, role: r.role, zones: JSON.parse(r.zones) as unknown, minor: !!r.minor, guardian: !!r.guardian });
  const seen = new Set<string>();
  const results = parsed.map((x) => {
    const early = out.get(x.code);
    if (early) return { code: x.code, ...early };
    const person = people.get(x.id!)!;
    const first = fresh.has(person.id) && !seen.has(person.id);
    seen.add(person.id);
    return { code: x.code, status: first ? ("ok" as const) : ("again" as const), person: info(person), at: first ? at : (earlier.get(person.id) ?? at) };
  });
  return c.json({ results });
});
