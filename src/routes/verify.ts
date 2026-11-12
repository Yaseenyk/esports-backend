import { Hono } from "hono";
import type { AppBindings } from "../types";
import { randomToken, sha256 } from "../crypto";
import { HttpError, nowIso, rateLimit, rateLimitSubject, readJson, type Ctx } from "../http";
import { requireUser } from "../auth";
import { getMailer, refundMail, reserveMail, verifyLink, verifyMail } from "../mailer";
import { normEmail } from "./auth";

/**
 * Lazy email verification (S6). A new account works at once; verification is only asked for before accepting an invitation (Phase 2a).
 * Existing accounts keep email_verified_at NULL and are never locked out. The token is emailed, only its SHA-256 is stored, 30 minute expiry, single use.
 */
export const verify = new Hono<AppBindings>();

const VERIFY_TTL_MS = 30 * 60_000;
let signupMail = true;
/** Tests that count mail switch the sign-up confirmation email off (test/helpers.ts does by default); test/verify-signup.test.ts turns it on. */
export function setSignupMailForTests(on: boolean): void { signupMail = on; }
/** Sign-up calls this right after the account exists. A mail problem never stops the sign-up. */
export async function sendSignupVerification(c: Ctx, uid: string, to: string): Promise<void> {
  if (!signupMail) return;
  try { await sendVerification(c, uid, to); } catch { /* the sign-up still succeeds; they can ask for another link */ }
}
const day = () => new Date().toISOString().slice(0, 10);

/** Always the same 200 for a signed-in user, whether the address is already verified or no mail server is set up. Only an exhausted pool says so (429), because nothing was sent. */
verify.post("/me/email/verify/start", requireUser, async (c) => {
  const uid = c.get("userId");
  await rateLimit(c, "verify-ip", 20, 3600);
  await rateLimitSubject(c, "verify-user", uid, 5, 3600);
  const u = await c.env.DB.prepare("SELECT email, email_verified_at FROM users WHERE id = ?").bind(uid).first<{ email: string; email_verified_at: string | null }>();
  if (!u) throw new HttpError(401, "Authentication required");
  c.header("cache-control", "no-store");
  if (u.email_verified_at) return c.json({ ok: true });
  await sendVerification(c, uid, u.email);
  return c.json({ ok: true });
});

/**
 * Emails a fresh verification link (older unused links stop working). Used by the "send again" route, by sign-up (right after the account is made)
 * and by "change my email". Quietly does nothing when no mail server is set up; throws 429 when today's mail budget is used up.
 */
export async function sendVerification(c: Ctx, uid: string, to: string): Promise<"sent" | "nomailer"> {
  const mailer = getMailer(c.env);
  if (!mailer) {
    console.warn("email verification requested but RESEND_API_KEY is not set; no email sent");
    return "nomailer";
  }
  const today = day();
  if (!(await reserveMail(c.env, today, "auth"))) throw new HttpError(429, "Email sending is paused for today. Try again after midnight UTC", { code: "mail_budget_exhausted" });
  const token = randomToken(32);
  const now = nowIso();
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = 'verify' AND used_at IS NULL").bind(now, uid),
      c.env.DB.prepare("INSERT INTO email_tokens (id, user_id, token_hash, purpose, expires_at, used_at) VALUES (?, ?, ?, 'verify', ?, NULL)")
        .bind(crypto.randomUUID(), uid, await sha256(token), new Date(Date.now() + VERIFY_TTL_MS).toISOString()),
    ]);
  } catch {
    await refundMail(c.env, today);
    throw new HttpError(500, "Could not start verification. Please try again");
  }
  const send = (async () => {
    try {
      await mailer.send(verifyMail(to, verifyLink(c.env, token)));
    } catch {
      await refundMail(c.env, today).catch(() => {});
      console.warn("verification email failed to send"); // no details: they could contain the address
    }
  })();
  try { c.executionCtx.waitUntil(send); } catch { await send; }
  return "sent";
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;

/**
 * Fix a mistyped address before it was ever confirmed: the account's email is replaced and a fresh link goes to the new one.
 * Only while the email is unconfirmed (a confirmed address is changed through support, never by a stolen token).
 */
verify.post("/me/email/change", requireUser, async (c) => {
  const uid = c.get("userId");
  await rateLimit(c, "verify-ip", 20, 3600);
  await rateLimitSubject(c, "email-change", uid, 5, 3600);
  const body = await readJson(c);
  const next = typeof body.email === "string" ? normEmail(body.email) : "";
  if (next.length < 3 || next.length > 254 || !EMAIL_RE.test(next)) throw new HttpError(400, "email is not valid");
  const u = await c.env.DB.prepare("SELECT email, email_verified_at FROM users WHERE id = ?").bind(uid).first<{ email: string; email_verified_at: string | null }>();
  if (!u) throw new HttpError(401, "Authentication required");
  c.header("cache-control", "no-store");
  if (u.email_verified_at) throw new HttpError(409, "Your email address is already confirmed", { code: "already_verified" });
  if (next !== u.email) {
    if (await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(next).first()) throw new HttpError(409, "An account with this email already exists", { code: "email_taken" });
    try {
      await c.env.DB.prepare("UPDATE users SET email = ?1 WHERE id = ?2").bind(next, uid).run();
    } catch {
      throw new HttpError(409, "An account with this email already exists", { code: "email_taken" });
    }
  }
  await sendVerification(c, uid, next);
  return c.json({ ok: true, email: next });
});

/** Expired, used, unknown and another user's token all give the same 400 invalid_or_expired; a wrong-user attempt does not use the token up. */
verify.post("/me/email/verify", requireUser, async (c) => {
  await rateLimit(c, "verify-confirm", 20, 15 * 60);
  const body = await readJson(c);
  const token = typeof body.token === "string" ? body.token : "";
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new HttpError(400, "invalid_or_expired");
  const now = nowIso();
  // Atomic single use, scoped to the signed-in user: only one request can flip used_at from NULL.
  const row = await c.env.DB.prepare("UPDATE email_tokens SET used_at = ?1 WHERE token_hash = ?2 AND user_id = ?3 AND purpose = 'verify' AND used_at IS NULL AND expires_at > ?1 RETURNING user_id")
    .bind(now, await sha256(token), c.get("userId")).first<{ user_id: string }>();
  if (!row) throw new HttpError(400, "invalid_or_expired");
  await c.env.DB.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?").bind(now, row.user_id).run();
  c.header("cache-control", "no-store");
  return c.json({ ok: true });
});
