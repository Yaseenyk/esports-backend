/**
 * Audit helper (blueprint 7, dev-review-r2 N-4 and N-10). Governance actions only, one row per successful state CHANGE (never per press: a route that is
 * called repeatedly, such as PUT /events/:id/live, audits only the transition).
 *
 *  - Pure module: imports nothing from `cloudflare:*`, so the sanitiser and registry run in plain node tests.
 *  - ONE statement style: the single constant INSERT below, used by `auditStmt` (added to the same db.batch as the mutation) and by `audit` (stand-alone run).
 *  - Closed registry: `AUDIT_ACTIONS` lists every action and the meta keys it may carry. An action not in it does not compile; test/audit.test.ts scans
 *    every `audit(` / `auditStmt(` call in src/ and checks the action literals against this registry.
 *  - Meta: keys not on the action's allow-list are dropped, and so is any value of the wrong type or shape. Hostile or non-object meta gives {}.
 *    Dropped keys bump a counter (`auditDropped()`) and nothing else: the dropped content is never logged.
 *  - Flag `audit.off` (src/flags.ts): `auditStmts` returns [] and `audit` does nothing.
 *  - Constant SQL only.
 */
import { getFlag } from "./flags";

export type ActorType = "user" | "staff" | "capability" | "system";
const ACTOR_TYPES: readonly string[] = ["user", "staff", "capability", "system"];

/** A meta value kind: an id (typed id shape), a count (integer 0 to 1e9), a bool, or one member of a fixed list. */
type MetaSpec = "id" | "count" | "bool" | readonly string[];

const LINK_KINDS = ["gate", "scorer", "captain", "run", "share", "invite", "registration"] as const;
const ROLES = ["admin", "member", "editor", "viewer"] as const;

const NONE = {} as const;
const COUNT = { count: "count" } as const;
const KIND = { kind: LINK_KINDS } as const;
const ROLE_CHANGE = { role: ROLES, prev: ROLES } as const;

/** Every audited action (blueprint 7.2) and the only meta keys it may carry. Closed: add an action here before using it. */
export const AUDIT_ACTIONS = {
  // identity
  "auth.password_changed": NONE,
  "auth.password_reset": NONE,
  "auth.account_deleted": NONE,
  "account.suspended": NONE,
  "account.restored": NONE,
  // organisation
  "org.converted": NONE,
  "org.suspended": NONE,
  "org.restored": NONE,
  "member.added": { role: ROLES },
  "member.role_changed": ROLE_CHANGE,
  "member.removed": NONE,
  "member.left": NONE,
  "invitation.created": { role: ROLES },
  "invitation.accepted": NONE,
  "invitation.revoked": NONE,
  // event governance
  "event.deleted": NONE,
  "event.handed_over": NONE,
  "event.guest_added": { role: ROLES },
  "event.guest_removed": NONE,
  "link.created": KIND,
  "link.revoked": KIND,
  "live.published": NONE,
  "live.unpublished": NONE,
  "directory.listed": NONE,
  "directory.unlisted": NONE,
  "checkins.reset": COUNT,
  "roster.replaced": COUNT,
  "matches.deleted": COUNT,
  // moderation and platform
  "report.decided": { decision: ["upheld", "dismissed"] },
  "takedown.hidden": NONE,
  "takedown.restored": NONE,
  "admin.flag_set": { flag: "id", value: "bool" },
  "admin.lookup": NONE,
  "admin.suspend": NONE,
  "admin.session": NONE,
} as const satisfies Record<string, Record<string, MetaSpec>>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;
export const AUDIT_ACTION_NAMES = Object.keys(AUDIT_ACTIONS) as AuditAction[];

export interface AuditEntry {
  action: AuditAction;
  actorType: ActorType;
  /** An id, never an email, name or token. Anything that is not id-shaped is stored as ''. */
  actorId?: string;
  orgId?: string | null;
  eventId?: string | null;
  targetType?: string;
  /** An id, never a name. */
  targetId?: string;
  /** Enum-like short code (lower case letters and underscores, at most 24). */
  reasonCode?: string;
  /** Untrusted by design: sanitised against the action's allow-list. */
  meta?: unknown;
  /** Test hook. */
  at?: string;
}

/** The single INSERT. Everything is bound; the text never changes. */
export const AUDIT_INSERT_SQL =
  "INSERT INTO audit_log (at, actor_type, actor_id, org_id, event_id, action, target_type, target_id, reason_code, meta) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)";

/** The purge (D1 has no DELETE ... LIMIT). Runs only after the oldest-row guard says something is due. */
export const AUDIT_OLDEST_SQL = "SELECT at FROM audit_log ORDER BY id LIMIT 1";
export const AUDIT_PURGE_SQL = "DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE at < ?1 ORDER BY id LIMIT 500)";
/** One retention class (blueprint 7.3; OD-Q lets the owner pick 90 or 400). */
export const AUDIT_RETENTION_DAYS = 400;

const ID_SHAPE = /^[A-Za-z0-9._~-]{1,48}$/;
const CODE_SHAPE = /^[a-z_]{1,24}$/;
const MAX_META = 300;

let dropped = 0;
/** How many meta keys or values were refused since this isolate started (a counter, never the content). */
export const auditDropped = (): number => dropped;

const isId = (v: unknown): v is string => typeof v === "string" && ID_SHAPE.test(v);

/**
 * Keeps only the allow-listed keys of `meta` whose value has the right shape. Anything else (not an object, an array, a throwing getter, a too-long
 * result) gives "{}". Never throws.
 */
export function sanitizeMeta(action: AuditAction, meta: unknown): string {
  try {
    if (meta === null || typeof meta !== "object" || Array.isArray(meta)) return "{}";
    const spec: Record<string, MetaSpec> = AUDIT_ACTIONS[action] ?? NONE;
    const src = meta as Record<string, unknown>;
    const out: Record<string, string | number | boolean> = {};
    for (const key of Object.keys(src)) {
      const rule = Object.prototype.hasOwnProperty.call(spec, key) ? spec[key] : undefined;
      if (rule === undefined) { dropped++; continue; }
      const v = src[key];
      if (rule === "id") { if (isId(v)) out[key] = v; else dropped++; }
      else if (rule === "count") { if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 1_000_000_000) out[key] = v; else dropped++; }
      else if (rule === "bool") { if (typeof v === "boolean") out[key] = v; else dropped++; }
      else if (typeof v === "string" && (rule as readonly string[]).includes(v)) out[key] = v;
      else dropped++;
    }
    const text = JSON.stringify(out);
    return text.length <= MAX_META ? text : "{}";
  } catch {
    return "{}";
  }
}

const idOrEmpty = (v: unknown): string => (isId(v) ? v : "");
const idOrNull = (v: unknown): string | null => (isId(v) ? v : null);
const codeOrEmpty = (v: unknown): string => (typeof v === "string" && CODE_SHAPE.test(v) ? v : "");

/** The ten bound values of AUDIT_INSERT_SQL, every one validated. Throws only for an action outside the registry (a programming error). */
export function auditBinds(e: AuditEntry): (string | null)[] {
  if (!Object.prototype.hasOwnProperty.call(AUDIT_ACTIONS, e.action)) throw new Error("audit: unregistered action");
  return [
    typeof e.at === "string" && e.at.length <= 40 ? e.at : new Date().toISOString(),
    ACTOR_TYPES.includes(e.actorType) ? e.actorType : "system",
    idOrEmpty(e.actorId),
    idOrNull(e.orgId),
    idOrNull(e.eventId),
    e.action,
    codeOrEmpty(e.targetType),
    idOrEmpty(e.targetId),
    codeOrEmpty(e.reasonCode),
    sanitizeMeta(e.action, e.meta),
  ];
}

/** The audit statement for a db.batch: the row commits or rolls back with the mutation. Does not look at flag audit.off (see auditStmts). */
export function auditStmt(db: D1Database, entry: AuditEntry): D1PreparedStatement {
  const b = auditBinds(entry);
  return db.prepare("INSERT INTO audit_log (at, actor_type, actor_id, org_id, event_id, action, target_type, target_id, reason_code, meta) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)").bind(b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9]);
}

/** `[...auditStmts(db, entry, off)]` for a batch: empty when flag audit.off is set. Read the flag once per request with `auditOff`. */
export function auditStmts(db: D1Database, entry: AuditEntry, off = false): D1PreparedStatement[] {
  return off ? [] : [auditStmt(db, entry)];
}

/** Flag audit.off (10 s isolate cache, defaults to false on any failure). */
export const auditOff = (db: D1Database): Promise<boolean> => getFlag(db, "audit.off");

/** Stand-alone audit write for a change that has no batch (for example a staff lookup). Best effort: never throws, so an audit failure cannot undo an action. */
export async function audit(db: D1Database, entry: AuditEntry): Promise<void> {
  try {
    if (await auditOff(db)) return;
    await auditStmt(db, entry).run();
  } catch {
    console.error("audit write failed"); // no details: they could hold personal data
  }
}

/**
 * Retention purge for the daily housekeeping slot (03:00 UTC tick). Guard first: read the oldest row (1 row read); run the delete only when it is older than
 * the cutoff (dev N-4: there is no index on `at`, and for the first 400 days nothing qualifies). At most `maxChunks` x 500 rows per call. Returns rows deleted.
 */
export async function purgeAudit(db: D1Database, nowMs: number = Date.now(), days: number = AUDIT_RETENTION_DAYS, maxChunks = 4): Promise<number> {
  const cutoff = new Date(nowMs - days * 86_400_000).toISOString();
  let total = 0;
  for (let i = 0; i < maxChunks; i++) {
    const oldest = await db.prepare("SELECT at FROM audit_log ORDER BY id LIMIT 1").first<{ at: string }>();
    if (!oldest || oldest.at >= cutoff) break;
    const r = await db.prepare("DELETE FROM audit_log WHERE id IN (SELECT id FROM audit_log WHERE at < ?1 ORDER BY id LIMIT 500)").bind(cutoff).run();
    const n = r.meta.changes ?? 0;
    total += n;
    if (n < 500) break;
  }
  return total;
}
