/**
 * Kill-switch enforcement (blueprint 9.3). ONE helper that route files call in the later serial sweep:
 *
 *     const off = await killGate(c, "kill.public_forms");
 *     if (off) return off;
 *
 *  - Returns `null` to carry on, or a ready `503 { error, code: "temporarily_disabled", retryAfter: 300 }` Response (with a Retry-After header).
 *    It returns instead of throwing because `HttpError` has no 503 and `onError` would turn any other throw into a 500.
 *  - WRITE requests (anything but GET, HEAD, OPTIONS) read the flag straight from D1 on every call (one statement, primary-key reads of at most two rows),
 *    so a switch bites on the next request. `kill.public_writes` is the master valve: it also stops every key that guards a public write route
 *    (forms, directory, team pages, uploads).
 *  - READS are not blocked unless the caller passes `{ read: true }`; then the 10-second isolate cache is used (no extra D1 read on a hot path).
 *  - Any flag read failure answers "not killed" (the default), like the rest of src/flags.ts: a broken flags table must not take the product down.
 *  - Constant SQL only.
 */
import { FLAG_DEFAULTS, getFlag, parseFlagValue, type FlagKey } from "../flags";
import type { Ctx } from "../http";

/** The seven human kill switches (the automatic `shed.tracking` is not one of them). */
export const KILL_KEYS = [
  "kill.public_forms", "kill.directory", "kill.team_pages", "kill.uploads", "kill.mail", "kill.tracking", "kill.public_writes",
] as const;
export type KillKey = (typeof KILL_KEYS)[number];

/** Keys that guard a public write route: the master valve `kill.public_writes` stops these too. */
const PUBLIC_WRITE_KEYS: readonly KillKey[] = ["kill.public_forms", "kill.directory", "kill.team_pages", "kill.uploads"];

export const KILL_RETRY_SECONDS = 300;

export function killedResponse(): Response {
  return new Response(JSON.stringify({ error: "This feature is temporarily switched off", code: "temporarily_disabled", retryAfter: KILL_RETRY_SECONDS }), {
    status: 503,
    headers: { "content-type": "application/json", "retry-after": String(KILL_RETRY_SECONDS) },
  });
}

const isWrite = (method: string): boolean => method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

export async function killGate(c: Ctx, key: KillKey, opts: { read?: boolean } = {}): Promise<Response | null> {
  const write = isWrite(c.req.method);
  if (!write && !opts.read) return null;
  const master = PUBLIC_WRITE_KEYS.includes(key);
  try {
    if (!write) {
      // cached read path
      if (await getFlag(c.env.DB, key)) return killedResponse();
      if (master && (await getFlag(c.env.DB, "kill.public_writes"))) return killedResponse();
      return null;
    }
    const r = await c.env.DB.prepare("SELECT key, value FROM flags WHERE key IN (?1, 'kill.public_writes')").bind(key).all<{ key: string; value: string }>();
    for (const row of r.results) {
      if (row.key !== key && !master) continue;
      const k = row.key as FlagKey;
      if (!Object.prototype.hasOwnProperty.call(FLAG_DEFAULTS, k)) continue;
      if (parseFlagValue(k, row.value) === true) return killedResponse();
    }
  } catch {
    /* unreadable flags: not killed */
  }
  return null;
}
