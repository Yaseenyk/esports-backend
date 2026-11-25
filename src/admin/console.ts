/**
 * Staff console: overview, organisation approvals and the user list (mounted after requireStaff in src/admin/routes.ts).
 *
 *  GET  /admin/v1/overview                        counts that link to each queue, plus the 10 newest audit entries. Counts only (not audited: no person).
 *  GET  /admin/v1/orgs?status=pending|verified|all&q=&after=   team organisations; owner email MASKED. Audited `admin.lookup` (target `orgs`).
 *  POST /admin/v1/orgs/:id/verify    { reasonCode, slug? }    sets verified_at (and the slug when it has none). Audited `org.verified`.
 *  POST /admin/v1/orgs/:id/unverify  { reasonCode }           clears verified_at (the slug stays, so a URL never changes hands). Audited `org.unverified`.
 *  GET  /admin/v1/users?q=&after=                 newest accounts or an email search; emails MASKED. Audited `admin.lookup` (target `users` / `user_search`).
 *  POST /admin/v1/users/:id/reveal   { reasonCode }           the full email of ONE account. Audited `admin.email_revealed` with the reason.
 *
 * Owner decision (25 Nov 2026): a new organisation works at once, unverified; staff approve it later. Verification only unlocks the features that
 * already require verified_at (college calendar listing, public college pages, the "verified" mark next to trust scores).
 * Personal organisations (every account has one) are never in the queue: verification means nothing for them (those features need kind = 'team').
 * Never in a response: names of people, phone numbers, id numbers, tokens. Constant SQL only.
 */
import { Hono } from "hono";
import { audit, auditOff, auditStmts } from "../audit";
import { HttpError, ID_RE, readJson } from "../http";
import { normEmail } from "../routes/auth";
import { checkSlug, slugify } from "../v3/lib/slug";
import { feedbackSummary } from "../v3/services/feedback-admin-service";
import { reasonCodeOf } from "./flags";
import { cursor } from "./moderation";
import type { ACtx, AdminBindings } from "./session";

export const consoleRoutes = new Hono<AdminBindings>();

const NO_STORE = { "cache-control": "no-store" };
const PAGE = 25;
const isoSec = (s: number | null | undefined): string | null => (typeof s === "number" ? new Date(s * 1000).toISOString() : null);

/** "yaseen@gmail.com" -> "y***@g***.com". The first letter of each part and the last domain label; nothing else. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return "";
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${local[0]}***@${host[0] ?? ""}***${tld}`;
}

/** Tables the overview may count. Missing ones (not migrated on a database) count as null, never an error. */
const OPTIONAL_TABLES = ["tournaments", "scrim_slots", "lft_listings", "directory_entries", "calendar_entries", "organiser_ratings", "organiser_rating_reports"] as const;

export async function existing(db: D1Database, names: readonly string[]): Promise<Set<string>> {
  const r = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(names)).all<{ name: string }>();
  return new Set(r.results.map((x) => x.name));
}

type Row = Record<string, number | null>;
const one = async (p: D1PreparedStatement): Promise<Row> => (await p.first<Row>()) ?? {};

interface AuditRow { id: number; at: string; actor_type: string; org_id: string | null; event_id: string | null; action: string; target_type: string; target_id: string; reason_code: string }

consoleRoutes.get("/overview", async (c) => {
  const db = c.env.DB;
  const has = await existing(db, OPTIONAL_TABLES);
  const maybe = (t: (typeof OPTIONAL_TABLES)[number], p: () => D1PreparedStatement): Promise<Row | null> => (has.has(t) ? one(p()) : Promise.resolve(null));
  const [users, orgs, events, reports, dirReports, tournaments, feedback, scrims, lft, directory, calendar, ratings, ratingReports, recent] = await Promise.all([
    one(db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN email_verified_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS verified, COALESCE(SUM(CASE WHEN status = 'suspended' THEN 1 ELSE 0 END), 0) AS suspended FROM users")),
    one(db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN verified_at IS NULL THEN 1 ELSE 0 END), 0) AS pending, COALESCE(SUM(CASE WHEN verified_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS verified FROM organisations WHERE kind = 'team'")),
    one(db.prepare("SELECT COUNT(*) AS n FROM events")),
    one(db.prepare("SELECT COUNT(*) AS n FROM reports WHERE status IN ('open','needs_other_staff')")),
    one(db.prepare("SELECT COUNT(*) AS n FROM directory_reports WHERE resolved_at IS NULL")),
    maybe("tournaments", () => db.prepare("SELECT COUNT(*) AS n FROM tournaments")),
    // feedback goes through its own service (the feedback tables are named only by the feedback repository); missing tables: not available
    feedbackSummary(db).then((f) => ({ n: f.total, fresh: f.byStatus.new ?? 0 }) as Row, () => null),
    maybe("scrim_slots", () => db.prepare("SELECT COALESCE(SUM(CASE WHEN status IN ('open','full') THEN 1 ELSE 0 END), 0) AS n, COALESCE(SUM(CASE WHEN hidden_at IS NOT NULL AND status IN ('open','full') THEN 1 ELSE 0 END), 0) AS hidden FROM scrim_slots")),
    maybe("lft_listings", () => db.prepare("SELECT COALESCE(SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END), 0) AS n, COALESCE(SUM(CASE WHEN hidden_at IS NOT NULL AND status = 'open' THEN 1 ELSE 0 END), 0) AS hidden FROM lft_listings")),
    maybe("directory_entries", () => db.prepare("SELECT COALESCE(SUM(CASE WHEN listed = 1 THEN 1 ELSE 0 END), 0) AS n, COALESCE(SUM(CASE WHEN held_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS hidden FROM directory_entries")),
    maybe("calendar_entries", () => db.prepare("SELECT COALESCE(SUM(CASE WHEN hidden_at IS NULL AND status = 'listed' THEN 1 ELSE 0 END), 0) AS n, COALESCE(SUM(CASE WHEN hidden_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS hidden FROM calendar_entries")),
    maybe("organiser_ratings", () => db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN hidden_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS hidden FROM organiser_ratings")),
    maybe("organiser_rating_reports", () => db.prepare("SELECT COUNT(*) AS n FROM organiser_rating_reports WHERE status = 'open'")),
    db.prepare("SELECT id, at, actor_type, org_id, event_id, action, target_type, target_id, reason_code FROM audit_log ORDER BY id DESC LIMIT 10").all<AuditRow>(),
  ]);
  const n = (r: Row | null, k = "n"): number | null => (r === null ? null : Number(r[k] ?? 0));
  return c.json({
    counts: {
      users: n(users), usersVerified: n(users, "verified"), usersSuspended: n(users, "suspended"),
      orgs: n(orgs), orgsPending: n(orgs, "pending"), orgsVerified: n(orgs, "verified"),
      events: n(events), tournaments: n(tournaments),
      openReports: (n(reports) ?? 0) + (n(dirReports) ?? 0), openRatingReports: n(ratingReports),
      feedbackNew: n(feedback, "fresh"), feedbackTotal: n(feedback),
      scrims: n(scrims), scrimsHidden: n(scrims, "hidden"),
      lft: n(lft), lftHidden: n(lft, "hidden"),
      directory: n(directory), directoryHidden: n(directory, "hidden"),
      calendar: n(calendar), calendarHidden: n(calendar, "hidden"),
      ratings: n(ratings), ratingsHidden: n(ratings, "hidden"),
    },
    recent: recent.results.map((x) => ({ id: x.id, at: x.at, actorType: x.actor_type, orgId: x.org_id, eventId: x.event_id, action: x.action, targetType: x.target_type, targetId: x.target_id, reasonCode: x.reason_code })),
  }, 200, NO_STORE);
});

// ---------------- organisations ----------------

interface OrgRow { id: string; name: string; kind: string; slug: string | null; status: string; created_at: string; verified_at: number | null; members: number; events: number; admin_user: string | null }

consoleRoutes.get("/orgs", async (c) => {
  const db = c.env.DB;
  const status = c.req.query("status") ?? "pending";
  if (status !== "pending" && status !== "verified" && status !== "all") throw new HttpError(400, "status must be pending, verified or all");
  const qRaw = c.req.query("q");
  const q = qRaw === undefined || qRaw.trim() === "" ? null : qRaw.trim().slice(0, 80);
  const after = cursor(c.req.query("after"));
  const r = await db
    .prepare(
      "SELECT o.id AS id, o.name AS name, o.kind AS kind, o.slug AS slug, o.status AS status, o.created_at AS created_at, o.verified_at AS verified_at, (SELECT COUNT(*) FROM org_members x WHERE x.org_id = o.id) AS members, (SELECT COUNT(*) FROM events e WHERE e.org_id = o.id) AS events, (SELECT m.user_id FROM org_members m WHERE m.org_id = o.id AND m.role = 'admin' ORDER BY m.added_at, m.user_id LIMIT 1) AS admin_user FROM organisations o WHERE o.kind = 'team' AND ((?1 = 'pending' AND o.verified_at IS NULL) OR (?1 = 'verified' AND o.verified_at IS NOT NULL) OR ?1 = 'all') AND (?2 IS NULL OR instr(lower(o.name), lower(?2)) > 0) ORDER BY o.created_at DESC, o.id DESC LIMIT ?3 OFFSET ?4",
    )
    .bind(status, q, PAGE + 1, after)
    .all<OrgRow>();
  const page = r.results.slice(0, PAGE);
  const ownerIds = [...new Set(page.map((o) => o.admin_user).filter((x): x is string => !!x))];
  const emails = ownerIds.length
    ? new Map((await db.prepare("SELECT id, email FROM users WHERE id IN (SELECT value FROM json_each(?1))").bind(JSON.stringify(ownerIds)).all<{ id: string; email: string }>()).results.map((u) => [u.id, u.email]))
    : new Map<string, string>();
  await audit(db, { action: "admin.lookup", actorType: "staff", actorId: c.get("staff").id, targetType: "orgs" });
  return c.json({
    items: page.map((o) => ({
      id: o.id, name: o.name, kind: o.kind, slug: o.slug, status: o.status, createdAt: o.created_at, verifiedAt: isoSec(o.verified_at),
      members: o.members, events: o.events, owner: o.admin_user ? { id: o.admin_user, email: maskEmail(emails.get(o.admin_user)) } : null,
    })),
    next: r.results.length > PAGE ? after + PAGE : null,
  }, 200, NO_STORE);
});

async function orgFor(c: ACtx): Promise<{ id: string; name: string; kind: string; status: string; slug: string | null; verified_at: number | null }> {
  const id = c.req.param("id") ?? "";
  if (!ID_RE.test(id)) throw new HttpError(404, "Not found");
  const o = await c.env.DB.prepare("SELECT id, name, kind, status, slug, verified_at FROM organisations WHERE id = ?1").bind(id).first<{ id: string; name: string; kind: string; status: string; slug: string | null; verified_at: number | null }>();
  if (!o) throw new HttpError(404, "Not found");
  return o;
}

const slugTaken = async (db: D1Database, slug: string, orgId: string): Promise<boolean> =>
  (await db.prepare("SELECT 1 AS x FROM organisations WHERE slug = ?1 AND id <> ?2").bind(slug, orgId).first()) !== null;

/** The slug the organisation will have: its own, the one staff typed (validated, unique), or one made from its name (with -2 ... -9 when taken). */
async function slugFor(db: D1Database, o: { id: string; name: string; slug: string | null }, given: unknown): Promise<string> {
  if (o.slug) return o.slug;
  if (given !== undefined && given !== null && given !== "") {
    const s = checkSlug(given);
    if (!s.ok) throw new HttpError(400, "The address must be 3 to 60 letters, numbers and single hyphens, and not a reserved word", { code: "invalid_slug" });
    if (await slugTaken(db, s.slug, o.id)) throw new HttpError(409, "Another organisation already uses this address. Choose another.", { code: "slug_taken" });
    return s.slug;
  }
  const base = slugify(o.name, 52);
  const first = checkSlug(base);
  if (!first.ok) throw new HttpError(400, "This name does not make a usable address. Type one.", { code: "slug_required" });
  for (const cand of [base, ...[2, 3, 4, 5, 6, 7, 8, 9].map((i) => `${base}-${i}`)]) if (!(await slugTaken(db, cand, o.id))) return cand;
  throw new HttpError(409, "Every address made from this name is taken. Type one.", { code: "slug_taken" });
}

consoleRoutes.post("/orgs/:id/verify", async (c) => {
  const staff = c.get("staff");
  const o = await orgFor(c);
  const b = await readJson(c as never, 2048);
  const reasonCode = reasonCodeOf(b);
  if (o.kind !== "team") throw new HttpError(409, "Only clubs and colleges (team organisations) can be verified", { code: "not_a_club" });
  if (o.status !== "active") throw new HttpError(409, "Restore this organisation before verifying it", { code: "org_not_active" });
  if (o.verified_at !== null) return c.json({ ok: true, id: o.id, verifiedAt: isoSec(o.verified_at), slug: o.slug, changed: false });
  const slug = await slugFor(c.env.DB, o, b.slug);
  const at = Math.floor(Date.now() / 1000);
  try {
    const res = await c.env.DB.batch([
      c.env.DB.prepare("UPDATE organisations SET verified_at = ?1, slug = COALESCE(slug, ?2) WHERE id = ?3 AND verified_at IS NULL AND kind = 'team' AND status = 'active'").bind(at, slug, o.id),
      ...auditStmts(c.env.DB, { action: "org.verified", actorType: "staff", actorId: staff.id, orgId: o.id, targetType: "org", targetId: o.id, reasonCode }, await auditOff(c.env.DB)),
    ]);
    if ((res[0]?.meta.changes ?? 0) !== 1) throw new HttpError(409, "This organisation changed meanwhile. Reload and try again.", { code: "changed" });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (String((e as Error)?.message ?? e).includes("UNIQUE")) throw new HttpError(409, "Another organisation already uses this address. Choose another.", { code: "slug_taken" });
    throw e;
  }
  return c.json({ ok: true, id: o.id, verifiedAt: isoSec(at), slug, changed: true });
});

consoleRoutes.post("/orgs/:id/unverify", async (c) => {
  const staff = c.get("staff");
  const o = await orgFor(c);
  const reasonCode = reasonCodeOf(await readJson(c as never, 2048));
  if (o.verified_at === null) return c.json({ ok: true, id: o.id, verifiedAt: null, slug: o.slug, changed: false });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE organisations SET verified_at = NULL WHERE id = ?1 AND verified_at IS NOT NULL").bind(o.id),
    ...auditStmts(c.env.DB, { action: "org.unverified", actorType: "staff", actorId: staff.id, orgId: o.id, targetType: "org", targetId: o.id, reasonCode }, await auditOff(c.env.DB)),
  ]);
  return c.json({ ok: true, id: o.id, verifiedAt: null, slug: o.slug, changed: true });
});

// ---------------- users ----------------

interface UserRow { id: string; email: string; status: string; created_at: string; email_verified_at: string | null; staff: number | null }

consoleRoutes.get("/users", async (c) => {
  const db = c.env.DB;
  const qRaw = c.req.query("q");
  const q = qRaw === undefined || qRaw.trim() === "" ? null : normEmail(qRaw);
  if (q !== null && (q.length < 2 || q.length > 254)) throw new HttpError(400, "Type at least 2 characters of the email");
  const after = cursor(c.req.query("after"));
  const r = q === null
    ? await db.prepare("SELECT u.id AS id, u.email AS email, u.status AS status, u.created_at AS created_at, u.email_verified_at AS email_verified_at, (SELECT 1 FROM platform_staff s WHERE s.user_id = u.id AND s.removed_at IS NULL) AS staff FROM users u ORDER BY u.created_at DESC, u.id DESC LIMIT ?1 OFFSET ?2").bind(PAGE + 1, after).all<UserRow>()
    : await db.prepare("SELECT u.id AS id, u.email AS email, u.status AS status, u.created_at AS created_at, u.email_verified_at AS email_verified_at, (SELECT 1 FROM platform_staff s WHERE s.user_id = u.id AND s.removed_at IS NULL) AS staff FROM users u WHERE instr(u.email, ?3) > 0 ORDER BY u.created_at DESC, u.id DESC LIMIT ?1 OFFSET ?2").bind(PAGE + 1, after, q).all<UserRow>();
  const page = r.results.slice(0, PAGE);
  type M = { user_id: string; id: string; name: string; kind: string; role: string; verified_at: number | null };
  const members = page.length
    ? (await db.prepare("SELECT m.user_id AS user_id, o.id AS id, o.name AS name, o.kind AS kind, m.role AS role, o.verified_at AS verified_at FROM org_members m JOIN organisations o ON o.id = m.org_id WHERE m.user_id IN (SELECT value FROM json_each(?1)) ORDER BY o.kind DESC, o.name LIMIT 500").bind(JSON.stringify(page.map((u) => u.id))).all<M>()).results
    : [];
  await audit(db, { action: "admin.lookup", actorType: "staff", actorId: c.get("staff").id, targetType: q === null ? "users" : "user_search" });
  return c.json({
    items: page.map((u) => ({
      id: u.id, email: maskEmail(u.email), status: u.status, createdAt: u.created_at, emailVerifiedAt: u.email_verified_at, staff: u.staff === 1,
      orgs: members.filter((m) => m.user_id === u.id).slice(0, 10).map((m) => ({ id: m.id, name: m.name, kind: m.kind, role: m.role, verified: m.verified_at !== null })),
    })),
    next: r.results.length > PAGE ? after + PAGE : null,
  }, 200, NO_STORE);
});

consoleRoutes.post("/users/:id/reveal", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) throw new HttpError(404, "Not found");
  const u = await c.env.DB.prepare("SELECT id, email FROM users WHERE id = ?1").bind(id).first<{ id: string; email: string }>();
  if (!u) throw new HttpError(404, "Not found");
  const reasonCode = reasonCodeOf(await readJson(c as never, 2048));
  await audit(c.env.DB, { action: "admin.email_revealed", actorType: "staff", actorId: c.get("staff").id, targetType: "user", targetId: u.id, reasonCode });
  return c.json({ id: u.id, email: u.email }, 200, NO_STORE);
});

export const CONSOLE_ROUTES: readonly { method: string; path: string }[] = [
  { method: "GET", path: "/admin/v1/overview" },
  { method: "GET", path: "/admin/v1/orgs" },
  { method: "POST", path: "/admin/v1/orgs/:id/verify" },
  { method: "POST", path: "/admin/v1/orgs/:id/unverify" },
  { method: "GET", path: "/admin/v1/users" },
  { method: "POST", path: "/admin/v1/users/:id/reveal" },
];
