/**
 * Staff identity (blueprint 4.3). Separate from users in every way that matters:
 *
 *  - Own table (`platform_staff`), own secret (STAFF_JWT_SECRET), own audience (`aud: "staff"`). A user token (signed with JWT_SECRET, no `aud`) fails the
 *    signature here; a staff token fails the signature on every user route. Defence in depth: the audience is checked as well.
 *  - Door: `POST /admin/v1/session` takes the ordinary USER token plus a 6-digit TOTP code and returns a 30-minute staff token `{sub, aud, iat, exp, su, cs}`.
 *    `su` = time of the last verified code (step-up window 300 s), `cs` = start of the chain (renew works while now < cs + 4 h).
 *  - Everything else under /admin/v1 answers 404 `{error: "Not found"}` to anyone without a valid staff token (and 404 when flag admin.enabled is off or a
 *    secret is missing). Every 404 path does the same kinds of crypto work (a dummy verify) so timing does not say "this account is staff".
 *  - Lockout: 5 failures per 15 minutes per user id (rate_limits, keyed by a hash). Applies to staff with a wrong code AND to non-staff callers of the door;
 *    the 6th attempt answers 429 for both, so the limiter is not an oracle.
 *  - Replay: `totp_last_step`, updated with a conditional UPDATE (a step is accepted once, atomically).
 *  - Staff are never created here: scripts/create-staff.mjs prints SQL for wrangler.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { audit } from "../audit";
import { b64url, fromB64url, hashKey, pwFingerprint, sha256, timingSafeEqual, verifyJwt } from "../crypto";
import { getFlagFresh } from "../flags";
import { HttpError, rateLimitSoft, readJson, type Ctx } from "../http";
import { base32Encode, hotp, newSeed, openSeed, otpauthUrl, sealSeed, verifyTotp } from "./totp";

export interface StaffCtx { id: string; su: number; cs: number; iat: number }
export type AdminBindings = { Bindings: Env; Variables: { staff: StaffCtx } };
export type ACtx = Context<AdminBindings>;

export const STAFF_AUD = "staff";
export const STAFF_TTL_SECONDS = 30 * 60;
export const STAFF_CHAIN_SECONDS = 4 * 3600;
export const STEP_UP_SECONDS = 300;
export const LOCK_LIMIT = 5;
export const LOCK_WINDOW_SECONDS = 15 * 60;

const enc = new TextEncoder();
const HEADER = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
const nowSec = (): number => Math.floor(Date.now() / 1000);
const iso = (sec: number): string => new Date(sec * 1000).toISOString();
const notFound = (): HttpError => new HttpError(404, "Not found");

// ---------- staff JWT ----------
function hmacKey(secret: string, usages: ("sign" | "verify")[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

export interface StaffClaims { sub: string; aud: "staff"; iat: number; exp: number; su: number; cs: number }

export async function signStaffJwt(secret: string, claims: StaffClaims): Promise<string> {
  const data = `${HEADER}.${b64url(enc.encode(JSON.stringify(claims)))}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

/** Claims of a valid, unexpired staff token, else null. Does not look at the database. */
export async function verifyStaffJwt(token: string, secret: string): Promise<StaffClaims | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  try {
    if (h !== HEADER) return null;
    if (!(await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), fromB64url(s), enc.encode(`${h}.${p}`)))) return null;
    const c = JSON.parse(new TextDecoder().decode(fromB64url(p))) as Record<string, unknown>;
    const ints = [c.iat, c.exp, c.su, c.cs];
    if (typeof c.sub !== "string" || c.aud !== STAFF_AUD || !ints.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
    if ((c.exp as number) <= nowSec()) return null;
    return c as unknown as StaffClaims;
  } catch {
    return null;
  }
}

async function issue(env: Env, id: string, su: number, cs: number) {
  const iat = nowSec();
  const exp = Math.min(iat + STAFF_TTL_SECONDS, cs + STAFF_CHAIN_SECONDS);
  const token = await signStaffJwt(env.STAFF_JWT_SECRET!, { sub: id, aud: STAFF_AUD, iat, exp, su, cs });
  return { token, expiresAt: iso(exp), stepUpUntil: iso(su + STEP_UP_SECONDS), chainEndsAt: iso(cs + STAFF_CHAIN_SECONDS), staff: { id, role: "admin" as const } };
}

// ---------- the 404 door ----------
const DUMMY_SEED = new Uint8Array(20).fill(7);

/** The same kinds of operation a real door does (HMAC verify, HOTP, AES-GCM open), result thrown away. */
async function dummyWork(env: Env): Promise<void> {
  try {
    await crypto.subtle.verify("HMAC", await hmacKey(env.STAFF_JWT_SECRET || "dummy", ["verify"]), new Uint8Array(32), enc.encode("dummy"));
    await hotp(DUMMY_SEED, nowSec());
    await openSeed(env.TOTP_KEK || "dummy", "dummy", "v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  } catch {
    /* ignored on purpose */
  }
}

/** Global gate for /admin/v1: soft IP limit, flag admin.enabled (fresh read), both secrets present. Anything else is a plain 404. */
export const adminGate: MiddlewareHandler<AdminBindings> = async (c, next) => {
  rateLimitSoft(c as unknown as Ctx, "admin", 120, 60);
  const on = await getFlagFresh(c.env.DB, "admin.enabled");
  if (!on || !c.env.STAFF_JWT_SECRET || !c.env.TOTP_KEK) {
    await dummyWork(c.env);
    throw notFound();
  }
  await next();
};

/** Every staff route after the door: a valid, unexpired staff token for an active staff row, else 404. Sets `staff`. */
export const requireStaff: MiddlewareHandler<AdminBindings> = async (c, next) => {
  const m = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "");
  const claims = m ? await verifyStaffJwt(m[1]!, c.env.STAFF_JWT_SECRET!) : null;
  if (!claims) { await dummyWork(c.env); throw notFound(); }
  const row = await c.env.DB.prepare(
    "SELECT s.token_valid_after AS tva, u.status AS status FROM platform_staff s JOIN users u ON u.id = s.user_id WHERE s.user_id = ?1 AND s.removed_at IS NULL AND s.totp_enabled_at IS NOT NULL",
  ).bind(claims.sub).first<{ tva: number; status: string }>();
  if (!row || row.status !== "active" || claims.iat <= row.tva) throw notFound();
  c.set("staff", { id: claims.sub, su: claims.su, cs: claims.cs, iat: claims.iat });
  await next();
};

/** Step-up rule: the last verified code is at most 300 s old, else 403 `step_up_required` (the token itself stays valid). */
export function requireStepUp(c: ACtx): StaffCtx {
  const s = c.get("staff");
  if (nowSec() - s.su > STEP_UP_SECONDS) throw new HttpError(403, "A fresh authenticator code is needed for this action", { code: "step_up_required" });
  return s;
}

// ---------- lockout ----------
async function lockKey(env: Env, userId: string): Promise<string> {
  return sha256(`${hashKey(env)}|stafffail|${userId}`);
}
const lockWindow = (): number => Math.floor(nowSec() / LOCK_WINDOW_SECONDS) * LOCK_WINDOW_SECONDS;

async function assertNotLocked(db: D1Database, key: string): Promise<void> {
  const r = await db.prepare("SELECT count FROM rate_limits WHERE key = ?1 AND window_start = ?2").bind(key, lockWindow()).first<{ count: number }>();
  if (r && r.count >= LOCK_LIMIT) throw new HttpError(429, "Too many attempts, try again later", { code: "locked" });
}
async function recordFailure(db: D1Database, key: string): Promise<void> {
  await db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 1) ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1").bind(key, lockWindow()).run();
}

// ---------- code check (login and step-up) ----------
async function checkCode(c: ACtx, userId: string, secretEnc: string, lastStep: number, body: Record<string, unknown>, lockK: string): Promise<void> {
  const code = typeof body.code === "string" ? body.code.trim() : "";
  const seed = await openSeed(c.env.TOTP_KEK!, userId, secretEnc);
  if (!seed) throw new HttpError(500, "Server misconfigured");
  const step = await verifyTotp(seed, code, Date.now(), lastStep);
  let ok = false;
  if (step !== null) {
    const r = await c.env.DB.prepare(
      "UPDATE platform_staff SET totp_last_step = ?1, totp_enabled_at = COALESCE(totp_enabled_at, ?2) WHERE user_id = ?3 AND totp_last_step < ?1 AND removed_at IS NULL",
    ).bind(step, new Date().toISOString(), userId).run();
    ok = (r.meta.changes ?? 0) === 1;
  }
  if (!ok) {
    await recordFailure(c.env.DB, lockK);
    throw new HttpError(401, "That code is not valid", { code: "invalid_code" });
  }
}

interface DoorRow {
  pw_hash: string; pw_salt: string; status: string;
  role: string | null; secret_enc: string | null; enabled_at: string | null; last_step: number | null;
}

/** The caller's USER token and account, or null. One SELECT; the staff row (if any, and not removed) comes along in the same read. */
async function userDoor(c: ACtx): Promise<{ id: string; row: DoorRow } | null> {
  if (!c.env.JWT_SECRET) return null;
  const m = /^Bearer (\S+)$/.exec(c.req.header("authorization") ?? "");
  const claims = m ? await verifyJwt(m[1]!, c.env.JWT_SECRET) : null;
  if (!claims) return null;
  const row = await c.env.DB.prepare(
    "SELECT u.pw_hash AS pw_hash, u.pw_salt AS pw_salt, u.status AS status, s.role AS role, s.totp_secret_enc AS secret_enc, s.totp_enabled_at AS enabled_at, s.totp_last_step AS last_step FROM users u LEFT JOIN platform_staff s ON s.user_id = u.id AND s.removed_at IS NULL WHERE u.id = ?1",
  ).bind(claims.sub).first<DoorRow>();
  if (!row || row.status !== "active") return null;
  if (!timingSafeEqual(await pwFingerprint(row), claims.pv)) return null;
  return { id: claims.sub, row };
}

// ---------- routes that take the USER token (mounted before requireStaff) ----------
export const sessionDoor = new Hono<AdminBindings>();

/** POST /admin/v1/session {code}: user token + TOTP code -> staff token. The first valid code after enrolment also activates the authenticator. */
sessionDoor.post("/", async (c) => {
  const who = await userDoor(c);
  if (!who) { await dummyWork(c.env); throw notFound(); }
  const key = await lockKey(c.env, who.id);
  await assertNotLocked(c.env.DB, key);
  const r = who.row;
  if (!r.role) { await recordFailure(c.env.DB, key); await dummyWork(c.env); throw notFound(); }
  const body = await readJson(c as unknown as Ctx, 1024);
  if (!r.secret_enc) throw new HttpError(409, "Set up your authenticator first", { code: "totp_not_enrolled" });
  await checkCode(c, who.id, r.secret_enc, r.last_step ?? 0, body, key);
  await audit(c.env.DB, { action: "admin.session", actorType: "staff", actorId: who.id, targetType: "session", targetId: who.id, reasonCode: "login" });
  const t = nowSec();
  return c.json(await issue(c.env, who.id, t, t));
});

/** POST /admin/v1/session/enroll: a staff row WITHOUT an active authenticator gets a new seed (shown once). Active authenticator or not staff: 404. */
sessionDoor.post("/enroll", async (c) => {
  const who = await userDoor(c);
  if (!who || !who.row.role || who.row.enabled_at) { await dummyWork(c.env); throw notFound(); }
  const seed = newSeed();
  const sealed = await sealSeed(c.env.TOTP_KEK!, who.id, seed);
  const r = await c.env.DB.prepare("UPDATE platform_staff SET totp_secret_enc = ?1 WHERE user_id = ?2 AND totp_enabled_at IS NULL AND removed_at IS NULL").bind(sealed, who.id).run();
  if ((r.meta.changes ?? 0) !== 1) throw notFound();
  await audit(c.env.DB, { action: "admin.session", actorType: "staff", actorId: who.id, targetType: "session", targetId: who.id, reasonCode: "enroll" });
  return c.json({ secret: base32Encode(seed), otpauthUrl: otpauthUrl(who.id, seed) });
});

// ---------- routes that take the STAFF token (mounted after requireStaff) ----------
export const sessionStaff = new Hono<AdminBindings>();

/** POST /admin/v1/session/renew: no code. Works while the chain is under 4 hours. */
sessionStaff.post("/renew", async (c) => {
  const s = c.get("staff");
  if (nowSec() >= s.cs + STAFF_CHAIN_SECONDS) throw new HttpError(401, "Session chain ended, sign in again", { code: "session_expired" });
  await audit(c.env.DB, { action: "admin.session", actorType: "staff", actorId: s.id, targetType: "session", targetId: s.id, reasonCode: "renew" });
  return c.json(await issue(c.env, s.id, s.su, s.cs));
});

/** POST /admin/v1/session/step-up {code}: a fresh code, a fresh `su`. The chain start does not move. */
sessionStaff.post("/step-up", async (c) => {
  const s = c.get("staff");
  if (nowSec() >= s.cs + STAFF_CHAIN_SECONDS) throw new HttpError(401, "Session chain ended, sign in again", { code: "session_expired" });
  const key = await lockKey(c.env, s.id);
  await assertNotLocked(c.env.DB, key);
  const body = await readJson(c as unknown as Ctx, 1024);
  const row = await c.env.DB.prepare("SELECT totp_secret_enc AS secret_enc, totp_last_step AS last_step FROM platform_staff WHERE user_id = ?1 AND removed_at IS NULL").bind(s.id).first<{ secret_enc: string | null; last_step: number }>();
  if (!row || !row.secret_enc) throw notFound();
  await checkCode(c, s.id, row.secret_enc, row.last_step, body, key);
  await audit(c.env.DB, { action: "admin.session", actorType: "staff", actorId: s.id, targetType: "session", targetId: s.id, reasonCode: "step_up" });
  return c.json(await issue(c.env, s.id, nowSec(), s.cs));
});
