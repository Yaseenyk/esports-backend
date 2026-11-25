/**
 * Feature flags and kill switches (blueprint 9.3, 15.2). Backed by the `flags` table (fewer than 20 rows).
 *
 *  - Absent row, unreadable row, invalid value or a missing table: the DEFAULT. Defaults are the safe state (authz.mode legacy, everything else off),
 *    so with an empty table the product behaves exactly as before the flags existed.
 *  - `getFlags` caches the whole table for 10 seconds per isolate (public READS and the access layer use it).
 *  - `getFlagFresh` reads one key by primary key on every call (public WRITE routes use it, so a kill switch bites on the next request).
 *  - Constant SQL only. This module never writes: flipping is done by the runbook SQL or, from Phase 1, by the staff API.
 */

export type AuthzMode = "legacy" | "shadow" | "org";

export interface Flags {
  "authz.mode": AuthzMode;
  "orgs.team": boolean;
  "audit.off": boolean;
  "shed.tracking": boolean;
  "kill.public_forms": boolean;
  "kill.directory": boolean;
  "kill.team_pages": boolean;
  "kill.uploads": boolean;
  "kill.mail": boolean;
  "kill.tracking": boolean;
  "kill.public_writes": boolean;
  "kill.feedback": boolean; // stops POST /feedback and its attachments (503) and hides the widget (GET /feedback/status 404); withdrawing still works
  "admin.enabled": boolean;
  "takedown.enforce": boolean;
  "auth.verify_required": boolean; // new password sign-ups must confirm their email (users.verify_required is set at sign-up while this is on)
  // Esports Hub v3 (ADR-1 option A). All default OFF: the route answers 404 before touching any v3 table.
  "v3.tournaments": boolean;
  "v3.resume": boolean;
  "v3.lft": boolean;
  "v3.disputes": boolean;
  "v3.discord": boolean; // Discord automation (stage 3): install flow, /link, interactions endpoint, outbox drain
  // Phases 3-5 (24 Nov 2026, migration 0056). Separate from v3.resume / v3.tournaments on purpose: those are ON in production, these stay OFF until the owner decides.
  "v3.profiles": boolean; // public player profiles and team pages: Private / Link only / Public, certificates from verified results, report and hide
  "v3.scrims": boolean; // scrim finder: captains post open scrim slots, other captains request, contact after accept
  "v3.rooms": boolean; // organiser tools: match room ID and password for captains of confirmed teams, from a reveal time (migration 0070)
  "v3.recaps": boolean; // organiser tools: match recap facts for the template recap and picture
  "v3.screenshots": boolean; // organiser tools: save battle royale results read from a screenshot in the browser (every row confirmed)
  "v3.directory": boolean; // public tournament directory: upcoming public tournaments by game and city, optional public sign-up link
  "v3.calendar": boolean; // college esports calendar (migration 0080): /public/calendar and the verified-organisation listing routes
  "v3.trust": boolean; // organiser trust score (migration 0080): proof-based ratings, reviews, replies, reports, staff moderation
  "v3.planner": boolean; // squad availability planner (migration 0090): share-link plans, teammates vote without an account, deleted after 30 days
  "v3.alerts": boolean; // tournament alerts (migration 0090): saved rules, double opt-in email, one digest a day at most, global daily cap
  "v3.journal": boolean; // personal match journal (migration 0091): private, owner-only self-logged matches, progress charts, CSV export
  "v3.achievements": boolean; // server badges (migration 0091): earned only from recorded actions, per-badge show/hide, on player pages
  "v3.lft_match": boolean; // LFT team matching (migration 0090): language and play-hour filters, sort by match, chosen contacts, block and report on requests
  "feedback.enabled": boolean; // on-page feedback bot (migration 0054): /feedback routes and the staff list. OFF = 404 before any feedback table is read
}

export type FlagKey = keyof Flags;

export const FLAG_DEFAULTS: Readonly<Flags> = Object.freeze({
  "authz.mode": "legacy",
  "orgs.team": false,
  "audit.off": false,
  "shed.tracking": false,
  "kill.public_forms": false,
  "kill.directory": false,
  "kill.team_pages": false,
  "kill.uploads": false,
  "kill.mail": false,
  "kill.tracking": false,
  "kill.public_writes": false,
  "kill.feedback": false,
  "admin.enabled": false,
  "takedown.enforce": false,
  "auth.verify_required": false,
  "v3.tournaments": false,
  "v3.resume": false,
  "v3.lft": false,
  "v3.disputes": false,
  "v3.discord": false,
  "v3.profiles": false,
  "v3.scrims": false,
  "v3.directory": false,
  "v3.rooms": false,
  "v3.recaps": false,
  "v3.screenshots": false,
  "v3.calendar": false,
  "v3.trust": false,
  "v3.planner": false,
  "v3.alerts": false,
  "v3.lft_match": false,
  "v3.journal": false,
  "v3.achievements": false,
  "feedback.enabled": false,
});

/** One plain sentence per flag for the staff console's Switches page (GET /admin/v1/flags `description`). Every key has one (test/admin/flags.test.ts). */
export const FLAG_NOTES: Readonly<Record<FlagKey, string>> = Object.freeze({
  "authz.mode": "How event access is decided: legacy, shadow (compare and log) or org. Runbook SQL only.",
  "orgs.team": "Clubs: turn a personal space into a team organisation and invite helpers. Runbook SQL only.",
  "audit.off": "Stops writing the activity log. Emergency only. Runbook SQL only.",
  "shed.tracking": "Automatic: usage counting is shed when the database is under pressure.",
  "kill.public_forms": "Stops registration and invite forms.",
  "kill.directory": "Stops adding to and reporting on the public directory.",
  "kill.team_pages": "Stops changes to public team pages.",
  "kill.uploads": "Stops photo and file uploads.",
  "kill.mail": "Stops all email (reminders and password resets).",
  "kill.tracking": "Stops usage counting.",
  "kill.public_writes": "The big switch: stops every public form and action that saves something.",
  "kill.feedback": "Stops new feedback and its screenshots and hides the feedback button.",
  "admin.enabled": "The staff console itself. Off = every staff route answers 404. Runbook SQL only.",
  "takedown.enforce": "Hide taken-down pages and pages of suspended organisations from the public.",
  "auth.verify_required": "New password sign-ups must confirm their email first.",
  "v3.tournaments": "Public tournament pages.",
  "v3.resume": "Esports Resume (player history from verified results).",
  "v3.lft": "Looking for team / player board.",
  "v3.disputes": "Dispute portal for match results.",
  "v3.discord": "Discord automation: install, /link, interactions and the outbox.",
  "v3.profiles": "Public player profiles and team pages (Private, Link only, Public), report and hide.",
  "v3.scrims": "Scrim finder: captains post open slots, others request, contact after accept.",
  "v3.rooms": "Organiser tool: match room ID and password for confirmed captains.",
  "v3.recaps": "Organiser tool: match recap facts for the template recap and picture.",
  "v3.screenshots": "Organiser tool: save battle royale results read from a screenshot (every row confirmed).",
  "v3.directory": "Public tournament directory by game and city.",
  "v3.calendar": "College esports calendar: verified organisations list their events.",
  "v3.trust": "Organiser trust score: proof-based ratings, reviews, replies and reports.",
  "v3.planner": "Squad availability planner: share-link plans, teammates tap free hours (no account), deleted after 30 days.",
  "v3.alerts": "Tournament alerts: saved rules, double opt-in email, at most one email a day per person, capped daily.",
  "v3.journal": "Personal match journal: private self-logged matches with weekly and monthly charts and CSV export.",
  "v3.achievements": "Player badges earned only from recorded actions (results, scrims, events, card), shown on player pages.",
  "v3.lft_match": "Team finder matching: language and play-hour filters, best-match sort, chosen contacts, block and report on requests.",
  "feedback.enabled": "On-page feedback bot and the staff feedback inbox.",
});

export const FLAG_CACHE_MS = 10_000;
const AUTHZ_MODES: readonly string[] = ["legacy", "shadow", "org"];

/** Turns a stored JSON text into a value of the right type for the key, or undefined when it is not valid for that key. */
export function parseFlagValue<K extends FlagKey>(key: K, raw: string): Flags[K] | undefined {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (key === "authz.mode") return (typeof v === "string" && AUTHZ_MODES.includes(v) ? v : undefined) as Flags[K] | undefined;
  return (typeof v === "boolean" ? v : undefined) as Flags[K] | undefined;
}

const isKey = (k: string): k is FlagKey => Object.prototype.hasOwnProperty.call(FLAG_DEFAULTS, k);

function fromRows(rows: { key: string; value: string }[]): Flags {
  const out: Flags = { ...FLAG_DEFAULTS };
  const set = out as unknown as Record<string, unknown>;
  for (const r of rows) {
    if (!isKey(r.key)) continue; // unknown keys are ignored
    const v = parseFlagValue(r.key, r.value);
    if (v !== undefined) set[r.key] = v;
  }
  return out;
}

let cache = new WeakMap<object, { at: number; flags: Flags }>();

/** All flags, cached 10 s per isolate. Any failure (table missing, D1 error) answers the defaults, never throws. */
export async function getFlags(db: D1Database, nowMs: number = Date.now()): Promise<Flags> {
  const hit = cache.get(db);
  if (hit && nowMs - hit.at < FLAG_CACHE_MS && nowMs >= hit.at) return hit.flags;
  let flags: Flags;
  try {
    const r = await db.prepare("SELECT key, value FROM flags").all<{ key: string; value: string }>();
    flags = fromRows(r.results);
  } catch {
    flags = { ...FLAG_DEFAULTS };
  }
  cache.set(db, { at: nowMs, flags });
  return flags;
}

/** One flag from the 10 s cache. */
export async function getFlag<K extends FlagKey>(db: D1Database, key: K, nowMs?: number): Promise<Flags[K]> {
  return (await getFlags(db, nowMs))[key];
}

/** One flag read straight from D1 (one primary-key read), no cache. For public write routes and kill switches. Failure answers the default. */
export async function getFlagFresh<K extends FlagKey>(db: D1Database, key: K): Promise<Flags[K]> {
  try {
    const r = await db.prepare("SELECT value FROM flags WHERE key = ?").bind(key).first<{ value: string }>();
    if (r) {
      const v = parseFlagValue(key, r.value);
      if (v !== undefined) return v;
    }
  } catch {
    /* table missing or D1 error: default */
  }
  return FLAG_DEFAULTS[key];
}

/** The authorisation mode. Anything but a valid stored value is "legacy". */
export async function getAuthzMode(db: D1Database): Promise<AuthzMode> {
  return getFlag(db, "authz.mode");
}

/** Test and runbook helper: forget cached flags (the cache is per isolate and lives 10 s). */
export function resetFlagsCache(db?: D1Database): void {
  if (db) cache.delete(db);
  else cache = new WeakMap();
}
