/** Tournament alerts (flag v3.alerts): rule checks and the email text. Pure: no SQL, no HttpError, no network. */
import { GAMES } from "./enums";
import { cleanText } from "./lft-text";

export const ALERTS = {
  MAX_RULES: 5,
  /** The alerts' own daily email cap. The free Resend plan allows 100 a day and 3,000 a month; the shared mail_budget pool (90 a day) also applies. */
  DAY_CAP: 25,
  CONFIRM_TTL_SEC: 48 * 3600,
  /** Only items published (or opened for registration) within this window, and never before the person confirmed, are sent. */
  LOOKBACK_SEC: 7 * 86_400,
  MAX_ITEMS_PER_EMAIL: 10,
  /** Sent-item memory: an item is never sent twice while this lasts (tournaments are over long before). */
  SENT_RETENTION_SEC: 120 * 86_400,
  /** The digest runs on the 15-minute cron between these UTC hours (08:30 to 14:30 IST), skipping the 03:00 housekeeping tick. */
  WINDOW_START_HOUR_UTC: 3,
  WINDOW_END_HOUR_UTC: 9,
  /** D1 statements one cron tick may spend on the digest (the free plan allows 50 per invocation, shared with the other cron jobs). */
  TICK_QUERY_BUDGET: 20,
} as const;

export const ALERT_GAMES = ["any", ...GAMES] as const;
export const ALERT_KINDS = ["any", "tournament", "college"] as const;
export type AlertGame = (typeof ALERT_GAMES)[number];
export type AlertKind = (typeof ALERT_KINDS)[number];
export interface AlertRule { game: AlertGame; place: string; kind: AlertKind }

export type RuleCheck = { ok: true; rules: AlertRule[] } | { ok: false; code: "invalid_rules" | "too_many_rules" | "invalid_game" | "invalid_place" | "invalid_kind" };

/** place: "any", "online" or a city (2 to 60 letters, spaces, dots and hyphens), stored lower-case so matching is case-insensitive. */
export function normalisePlace(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = cleanText(v).replace(/\n/g, " ").toLowerCase();
  if (t === "any" || t === "online") return t;
  if (t.length < 2 || t.length > 60 || !/^[\p{L}][\p{L} .'-]*$/u.test(t)) return null;
  return t;
}

/** A list of up to 5 rules. Duplicates are dropped. */
export function checkRules(v: unknown): RuleCheck {
  if (!Array.isArray(v)) return { ok: false, code: "invalid_rules" };
  if (v.length > ALERTS.MAX_RULES) return { ok: false, code: "too_many_rules" };
  const out: AlertRule[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "invalid_rules" };
    const r = raw as Record<string, unknown>;
    const game = r.game ?? "any", kind = r.kind ?? "any";
    if (typeof game !== "string" || !(ALERT_GAMES as readonly string[]).includes(game)) return { ok: false, code: "invalid_game" };
    if (typeof kind !== "string" || !(ALERT_KINDS as readonly string[]).includes(kind)) return { ok: false, code: "invalid_kind" };
    const place = normalisePlace(r.place ?? "any");
    if (place === null) return { ok: false, code: "invalid_place" };
    const rule: AlertRule = { game: game as AlertGame, place, kind: kind as AlertKind };
    if (!out.some((o) => o.game === rule.game && o.place === rule.place && o.kind === rule.kind)) out.push(rule);
  }
  return { ok: true, rules: out };
}

/** a***@gmail.com: first character, three stars, the domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 1 ? "***" : `${email[0]}***${email.slice(at)}`;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
const GAME_NAMES: Record<string, string> = { bgmi: "BGMI", free_fire: "Free Fire", valorant: "Valorant", cod_mobile: "COD Mobile", cs2: "CS2", other: "Other game" };
export const gameName = (g: string): string => GAME_NAMES[g] ?? "Other game";

export interface AlertItem { key: string; kind: "tournament" | "college"; title: string; game: string; where: string; when: string; link: string; status: string }

/** The footer every alert email carries, in the same words and layout as the reminder emails, plus the one-click unsubscribe and the settings link. */
function footer(unsubLink: string, settingsLink: string): { text: string; html: string } {
  const text = `You get this email because you turned on tournament alerts on Esports Hub and confirmed this address.\nUnsubscribe in one click: ${unsubLink}\nChange your alerts: ${settingsLink}\nEsports Hub never charges entry fees and never asks for payment by email.`;
  const html = `<hr style="border:0;border-top:1px solid #ddd;margin:20px 0"><p style="font-size:13px;color:#555;margin:0">You get this email because you turned on tournament alerts on Esports Hub and confirmed this address. <a href="${esc(unsubLink)}">Unsubscribe in one click</a> or <a href="${esc(settingsLink)}">change your alerts</a>. Esports Hub never charges entry fees and never asks for payment by email.</p>`;
  return { text, html };
}

/** The daily digest: one email listing every new matching item (at most 10). Plain text and simple HTML, no images, no tracking. */
export function buildDigestMail(items: AlertItem[], unsubLink: string, settingsLink: string): { subject: string; text: string; html: string } {
  const one = items.length === 1 ? items[0]! : null;
  const subject = one ? `${one.status === "registration_open" ? "Registration open" : "New"}: ${one.title.replace(/[\r\n]+/g, " ").slice(0, 80)}` : `${items.length} new tournaments match your alerts`;
  const lines = items.map((i) => `- ${i.title} (${gameName(i.game)}, ${i.where}, ${i.when})${i.status === "registration_open" ? " - registration open" : ""}\n  ${i.link}`);
  const f = footer(unsubLink, settingsLink);
  const text = `New on Esports Hub for your alerts:\n\n${lines.join("\n\n")}\n\nCheck the organiser's rules on each page before you register. Entry is free on Esports Hub.\n\n--\n${f.text}\n`;
  const rows = items.map((i) => `<li style="margin:0 0 12px"><a href="${esc(i.link)}">${esc(i.title)}</a><br><span style="color:#333">${esc(gameName(i.game))} · ${esc(i.where)} · ${esc(i.when)}${i.status === "registration_open" ? " · registration open" : ""}</span></li>`).join("");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#111"><p style="margin:0 0 14px">New on Esports Hub for your alerts:</p><ul style="padding-left:18px;margin:0 0 14px">${rows}</ul><p style="margin:0 0 14px">Check the organiser's rules on each page before you register. Entry is free on Esports Hub.</p>${f.html}</div>`;
  return { subject, text, html };
}

/** The double opt-in email: one link, valid 48 hours. Nothing is sent to the address until it is clicked. */
export function buildConfirmMail(link: string): { subject: string; text: string; html: string } {
  const text = `Someone (we hope you) asked for tournament alerts from Esports Hub at this address.\n\nConfirm within 48 hours to start getting at most one email a day when a matching tournament is published or opens registration:\n${link}\n\nIf you did not ask for this, ignore this email: nothing will be sent.\n`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#111"><p style="margin:0 0 14px">Someone (we hope you) asked for tournament alerts from Esports Hub at this address.</p><p style="margin:0 0 14px"><a href="${esc(link)}">Confirm tournament alerts</a></p><p style="margin:0 0 14px">The link is valid for 48 hours. After that you get at most one email a day, only when a matching tournament is published or opens registration.</p><p style="font-size:13px;color:#555;margin:0">If you did not ask for this, ignore this email: nothing will be sent.</p></div>`;
  return { subject: "Confirm your Esports Hub tournament alerts", text, html };
}

/** "Sat 20 Dec" in India time for a tournament start (epoch seconds), or the calendar date as written. */
export function istDay(sec: number): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(new Date(sec * 1000));
}

/** True when the cron tick at `ms` falls in the digest window (and is not the 03:00 UTC housekeeping tick). */
export function inDigestWindow(ms: number): boolean {
  const d = new Date(ms);
  const h = d.getUTCHours();
  if (h === 3 && d.getUTCMinutes() < 15) return false;
  return h >= ALERTS.WINDOW_START_HOUR_UTC && h < ALERTS.WINDOW_END_HOUR_UTC;
}
