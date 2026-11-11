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
  "admin.enabled": boolean;
  "takedown.enforce": boolean;
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
  "admin.enabled": false,
  "takedown.enforce": false,
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
