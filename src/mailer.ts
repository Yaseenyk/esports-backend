import type { Env } from "./types";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
}

const DEFAULT_FROM = "Esports Hub <noreply@mail.streamerosai.com>";
export const DEFAULT_APP_URL = "https://esports.streamerosai.com";

/** Sends through Resend. Never logs the key, the recipient or the body. */
export function resendMailer(env: Pick<Env, "RESEND_API_KEY" | "MAIL_FROM">): Mailer {
  return {
    async send(mail) {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: env.MAIL_FROM || DEFAULT_FROM, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text }),
      });
      if (!res.ok) throw new Error(`mail provider status ${res.status}`);
    },
  };
}

let override: Mailer | null = null;
/** Tests inject a fake here; pass null to restore the real mailer. */
export function setMailerForTests(m: Mailer | null): void {
  override = m;
}

/** Returns null when no mailer is configured (no RESEND_API_KEY and no test double). */
export function getMailer(env: Env): Mailer | null {
  if (override) return override;
  return env.RESEND_API_KEY ? resendMailer(env) : null;
}

export function resetLink(env: Pick<Env, "APP_URL">, token: string): string {
  const base = (env.APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "");
  return `${base}/reset-password/?t=${token}`;
}

export function resetMail(to: string, link: string): Mail {
  const text = `Someone asked to reset the password for your Esports Hub account.\n\nUse this link within 30 minutes:\n${link}\n\nIf you did not ask for this, ignore this email, your password is unchanged.\n`;
  const html = `<p>Someone asked to reset the password for your Esports Hub account.</p><p><a href="${link}">Reset your password</a></p><p>The link is valid for 30 minutes.</p><p>If you did not ask for this, ignore this email, your password is unchanged.</p>`;
  return { to, subject: "Reset your Esports Hub password", text, html };
}

/** A mail that may carry extra headers (for example List-Unsubscribe). Added for reminders; the original Mail type is unchanged. */
export interface MailWithHeaders extends Mail {
  headers?: Record<string, string>;
}

/** Sends one mail with optional headers. Returns false when no mailer is configured. Throws when the provider refuses. Never logs the recipient or body. */
export async function sendMailWithHeaders(env: Env, mail: MailWithHeaders): Promise<boolean> {
  if (override) { await override.send(mail); return true; }
  if (!env.RESEND_API_KEY) return false;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: env.MAIL_FROM || DEFAULT_FROM, to: [mail.to], subject: mail.subject, html: mail.html, text: mail.text, ...(mail.headers ? { headers: mail.headers } : {}) }),
  });
  if (!res.ok) throw new Error(`mail provider status ${res.status}`);
  return true;
}

/** True when sending is possible (a key or a test double). */
export const mailerConfigured = (env: Env): boolean => getMailer(env) !== null;

export function unsubscribeLink(env: Pick<Env, "APP_URL">, token: string): string {
  const base = (env.APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "");
  return `${base}/unsubscribe/?t=${token}`;
}

// ---------- daily mail pool (S6) ----------
/** One pool of mail a day (free Resend plan). Reminders may use all but AUTH_RESERVE; auth mail (verify) may use the whole pool. */
export const MAIL_DAY_LIMIT = 90;
export const AUTH_RESERVE = 10;

/** Atomically takes one email from today's pool. `kind` decides the ceiling: reminders stop 10 short so sign-in mail always gets through. */
export async function reserveMail(env: Pick<Env, "DB">, day: string, kind: "auth" | "reminder"): Promise<boolean> {
  const limit = kind === "auth" ? MAIL_DAY_LIMIT : MAIL_DAY_LIMIT - AUTH_RESERVE;
  const r = await env.DB.prepare("INSERT INTO mail_budget (day, sent) VALUES (?1, 1) ON CONFLICT (day) DO UPDATE SET sent = sent + 1 WHERE sent < ?2 RETURNING sent").bind(day, limit).first<{ sent: number }>();
  return !!r;
}

export async function refundMail(env: Pick<Env, "DB">, day: string): Promise<void> {
  await env.DB.prepare("UPDATE mail_budget SET sent = sent - 1 WHERE day = ? AND sent > 0").bind(day).run();
}

// ---------- email verification mail (S6) ----------
export function verifyLink(env: Pick<Env, "APP_URL">, token: string): string {
  const base = (env.APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "");
  return `${base}/verify-email/?t=${token}`;
}

export function verifyMail(to: string, link: string): Mail {
  const text = `Confirm that this is your email address for Esports Hub.\n\nUse this link within 30 minutes:\n${link}\n\nIf you did not create an account, ignore this email. Cannot find it later? Check your spam folder.\n`;
  const html = `<p>Confirm that this is your email address for Esports Hub.</p><p><a href="${link}">Confirm my email</a></p><p>The link is valid for 30 minutes.</p><p>If you did not create an account, ignore this email. Cannot find it later? Check your spam folder.</p>`;
  return { to, subject: "Confirm your Esports Hub email", text, html };
}
