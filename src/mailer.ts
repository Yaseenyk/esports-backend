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
