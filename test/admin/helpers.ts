import { env } from "cloudflare:workers";
import { callDirect } from "../golden/direct";
import { newUser } from "../helpers";
import { signStaffJwt, type StaffClaims } from "../../src/admin/session";
import { base32Decode, hotp, stepOf } from "../../src/admin/totp";

export const db = env.DB;
export const nowSec = () => Math.floor(Date.now() / 1000);

/** Sets or clears flag admin.enabled (and any other flag) the way the runbook does: SQL. */
export async function setFlagSql(key: string, value: boolean | string): Promise<void> {
  await db.prepare("INSERT INTO flags (key, value, updated_by, updated_at, note) VALUES (?1, ?2, 'test', ?3, '') ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, JSON.stringify(value), new Date().toISOString()).run();
}
export const enableConsole = (on = true) => setFlagSql("admin.enabled", on);

export const api = (path: string, o: { method?: string; token?: string; body?: unknown } = {}) => callDirect(path, o);

export interface Staff {
  id: string;
  userToken: string;
  seed: Uint8Array;
  /** The next valid, never-used code (steps always increase, so replay protection never trips in a test). */
  code(): Promise<string>;
  /** Signs in with the next code: returns the staff token response. */
  login(): Promise<{ token: string; expiresAt: string; stepUpUntil: string; chainEndsAt: string; staff: { id: string; role: string } }>;
}

/** A user made staff by SQL (like scripts/create-staff.mjs prints) and enrolled through the API. */
export async function makeStaff(): Promise<Staff> {
  await enableConsole();
  const u = await newUser("Staffer");
  await db.prepare("INSERT INTO platform_staff (user_id, role, added_by, added_at) VALUES (?1, 'admin', 'test', ?2)").bind(u.id, new Date().toISOString()).run();
  const e = await api("/admin/v1/session/enroll", { token: u.token, body: {} });
  if (e.status !== 200) throw new Error(`enroll failed ${e.status} ${e.text}`);
  const seed = base32Decode(e.json.secret as string);
  let last = 0;
  const staff: Staff = {
    id: u.id,
    userToken: u.token,
    seed,
    async code() {
      last = Math.max(last + 1, stepOf(Date.now()) - 1);
      return hotp(seed, last);
    },
    async login() {
      const r = await api("/admin/v1/session", { token: u.token, body: { code: await staff.code() } });
      if (r.status !== 200) throw new Error(`login failed ${r.status} ${r.text}`);
      return r.json;
    },
  };
  return staff;
}

/** A staff token forged with the real staff secret (tests know it). Defaults: valid for 10 minutes, stepped-up now. */
export function forge(sub: string, over: Partial<StaffClaims> = {}, secret = env.STAFF_JWT_SECRET!): Promise<string> {
  const t = nowSec();
  return signStaffJwt(secret, { sub, aud: "staff", iat: t, exp: t + 600, su: t, cs: t, ...over });
}

export async function auditRows(action: string, targetId?: string) {
  const r = targetId === undefined
    ? await db.prepare("SELECT * FROM audit_log WHERE action = ?1 ORDER BY id").bind(action).all<Record<string, unknown>>()
    : await db.prepare("SELECT * FROM audit_log WHERE action = ?1 AND target_id = ?2 ORDER BY id").bind(action, targetId).all<Record<string, unknown>>();
  return r.results;
}
