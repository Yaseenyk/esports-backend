/**
 * Staff lookup and audit viewer (blueprint 9.1, OD-R). METADATA ONLY: ids, dates, status, role and counts.
 * Never a name, email, roster, photo, registration, proof, contact detail, token or slug; no list, no export, no search by prefix.
 *
 *  GET /admin/v1/lookup?email=<exact>   or   ?id=<exact id>  (tried as user, organisation, then event)   -> audited `admin.lookup`
 *  GET /admin/v1/audit?after=<id>&org=<org id>                newest first, 50 per page                    -> audited `admin.lookup`
 *
 * The response key sets are pinned by test/admin/lookup.test.ts (a snapshot): adding a key is a deliberate, reviewed change.
 */
import { Hono } from "hono";
import { audit } from "../audit";
import { HttpError, ID_RE } from "../http";
import { normEmail } from "../routes/auth";
import type { AdminBindings } from "./session";

export const lookupRoutes = new Hono<AdminBindings>();

const count = (r: { results: { n: number }[] }): number => r.results[0]?.n ?? 0;

lookupRoutes.get("/lookup", async (c) => {
  const db = c.env.DB;
  const staff = c.get("staff");
  const email = c.req.query("email");
  const id = c.req.query("id");
  if ((email === undefined) === (id === undefined)) throw new HttpError(400, "Give exactly one of email or id");
  if (id !== undefined && !ID_RE.test(id)) throw new HttpError(400, "id is not valid");
  if (email !== undefined && (email.length < 3 || email.length > 254)) throw new HttpError(400, "email is not valid");

  // 1. user (by exact normalised email, or by id)
  const u = email !== undefined
    ? await db.prepare("SELECT id, status, created_at, email_verified_at FROM users WHERE email = ?1").bind(normEmail(email)).first<{ id: string; status: string; created_at: string; email_verified_at: string | null }>()
    : await db.prepare("SELECT id, status, created_at, email_verified_at FROM users WHERE id = ?1").bind(id!).first<{ id: string; status: string; created_at: string; email_verified_at: string | null }>();
  if (u) {
    const [orgs, owned, shared] = await db.batch<Record<string, unknown>>([
      db.prepare("SELECT o.id AS id, o.kind AS kind, o.status AS status, m.role AS role FROM org_members m JOIN organisations o ON o.id = m.org_id WHERE m.user_id = ?1 ORDER BY o.id LIMIT 50").bind(u.id),
      db.prepare("SELECT COUNT(*) AS n FROM events WHERE owner_id = ?1").bind(u.id),
      db.prepare("SELECT COUNT(*) AS n FROM event_members WHERE user_id = ?1").bind(u.id),
    ]);
    await audit(db, { action: "admin.lookup", actorType: "staff", actorId: staff.id, targetType: "user", targetId: u.id });
    return c.json({
      kind: "user",
      id: u.id,
      status: u.status,
      createdAt: u.created_at,
      emailVerified: u.email_verified_at !== null,
      orgs: (orgs!.results as { id: string; kind: string; status: string; role: string }[]).map((o) => ({ id: o.id, kind: o.kind, status: o.status, role: o.role })),
      counts: { eventsOwned: count(owned as never), eventsShared: count(shared as never) },
    });
  }
  if (id === undefined) {
    await audit(db, { action: "admin.lookup", actorType: "staff", actorId: staff.id, targetType: "user" });
    throw new HttpError(404, "Not found");
  }

  // 2. organisation
  const o = await db.prepare("SELECT id, kind, status, created_at FROM organisations WHERE id = ?1").bind(id).first<{ id: string; kind: string; status: string; created_at: string }>();
  if (o) {
    const [members, events] = await db.batch<Record<string, unknown>>([
      db.prepare("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?1").bind(o.id),
      db.prepare("SELECT COUNT(*) AS n FROM events WHERE org_id = ?1").bind(o.id),
    ]);
    await audit(db, { action: "admin.lookup", actorType: "staff", actorId: staff.id, orgId: o.id, targetType: "org", targetId: o.id });
    return c.json({ kind: "org", id: o.id, orgKind: o.kind, status: o.status, createdAt: o.created_at, counts: { members: count(members as never), events: count(events as never) } });
  }

  // 3. event (counts only: how many teams, people, registrations and check-ins; never who)
  const e = await db.prepare("SELECT id, owner_id, org_id, date, starts_on, created_at FROM events WHERE id = ?1").bind(id).first<{ id: string; owner_id: string; org_id: string | null; date: string; starts_on: string | null; created_at: string }>();
  if (e) {
    const [teams, people, regs, checkins] = await db.batch<Record<string, unknown>>([
      db.prepare("SELECT COUNT(*) AS n FROM teams WHERE event_id = ?1").bind(e.id),
      db.prepare("SELECT COUNT(*) AS n FROM people WHERE event_id = ?1").bind(e.id),
      db.prepare("SELECT COUNT(*) AS n FROM registrations WHERE event_id = ?1").bind(e.id),
      db.prepare("SELECT COUNT(*) AS n FROM checkins WHERE event_id = ?1").bind(e.id),
    ]);
    await audit(db, { action: "admin.lookup", actorType: "staff", actorId: staff.id, orgId: e.org_id, eventId: e.id, targetType: "event", targetId: e.id });
    return c.json({
      kind: "event",
      id: e.id,
      ownerId: e.owner_id,
      orgId: e.org_id,
      date: e.date,
      startsOn: e.starts_on,
      createdAt: e.created_at,
      counts: { teams: count(teams as never), people: count(people as never), registrations: count(regs as never), checkins: count(checkins as never) },
    });
  }
  await audit(db, { action: "admin.lookup", actorType: "staff", actorId: staff.id, targetType: "id" });
  throw new HttpError(404, "Not found");
});

interface AuditRow { id: number; at: string; actor_type: string; actor_id: string; org_id: string | null; event_id: string | null; action: string; target_type: string; target_id: string; reason_code: string; meta: string }

lookupRoutes.get("/audit", async (c) => {
  const db = c.env.DB;
  const staff = c.get("staff");
  const afterQ = c.req.query("after");
  const org = c.req.query("org");
  let after = Number.MAX_SAFE_INTEGER;
  if (afterQ !== undefined) {
    if (!/^\d{1,15}$/.test(afterQ)) throw new HttpError(400, "after must be an entry id");
    after = Number(afterQ);
  }
  if (org !== undefined && !ID_RE.test(org)) throw new HttpError(400, "org is not valid");
  const r = org === undefined
    ? await db.prepare("SELECT id, at, actor_type, actor_id, org_id, event_id, action, target_type, target_id, reason_code, meta FROM audit_log WHERE id < ?1 ORDER BY id DESC LIMIT 51").bind(after).all<AuditRow>()
    : await db.prepare("SELECT id, at, actor_type, actor_id, org_id, event_id, action, target_type, target_id, reason_code, meta FROM audit_log WHERE org_id = ?2 AND id < ?1 ORDER BY id DESC LIMIT 51").bind(after, org).all<AuditRow>();
  const page = r.results.slice(0, 50);
  await audit(db, { action: "admin.lookup", actorType: "staff", actorId: staff.id, orgId: org ?? null, targetType: "audit" });
  return c.json({
    entries: page.map((x) => ({
      id: x.id, at: x.at, actorType: x.actor_type, actorId: x.actor_id, orgId: x.org_id, eventId: x.event_id,
      action: x.action, targetType: x.target_type, targetId: x.target_id, reasonCode: x.reason_code,
      meta: (() => { try { return JSON.parse(x.meta) as unknown; } catch { return {}; } })(),
    })),
    next: r.results.length > 50 ? page[page.length - 1]!.id : null,
  });
});
