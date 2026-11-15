/**
 * Feedback bot: pure input handling (no database, no layer imports). Validation, the page-path normaliser, text and error sanitising, device and browser
 * family from a User-Agent, and the keyed hash of the visitor address.
 *
 * Privacy rules enforced here: a query string or #hash is never kept; id-like and token-like path segments become ':id'; secrets are redacted from free
 * text; the raw User-Agent and the IP are never returned for storage (only a device class, a browser family and a keyed hash).
 */
import { HttpError } from "../../http";

export const FEEDBACK_CONSENT_VERSION = "feedback-v1";
export const FEEDBACK_KINDS = ["bug", "idea", "confusing", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_STATUSES = ["new", "triaged", "fixed", "wontfix"] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

export const FEEDBACK = {
  MAX_BODY: 16_384,
  MSG_MIN: 10,
  MSG_MAX: 2000,
  PATH_MAX: 200,
  TITLE_MAX: 120,
  ERR_MAX: 5,
  ERR_LEN: 200,
  ATTACH_MAX_FILES: 2,
  ATTACH_MAX_BYTES: 409_600,
  TOKEN_TTL_SEC: 1200,
  HOUR_LIMIT: 5,
  DAY_LIMIT: 20,
  GLOBAL_DAY_CAP: 300,
  ATTACH_HOUR_LIMIT: 30,
  ATTACH_IP_DAY_LIMIT: 10,
  ATTACH_GLOBAL_DAY_CAP: 100,
  STORAGE_BUDGET_BYTES: 120 * 1024 * 1024,
  BYTES_RETENTION_SEC: 90 * 86_400,
  REPORT_RETENTION_SEC: 365 * 86_400,
} as const;

const invalid = (message: string, field: string): HttpError => new HttpError(400, message, { code: "invalid", field });

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F​-‏‪-‮⁦-⁩﻿]/g;

/** Redacts values that look like secrets. `colon` also catches "password: x" style pairs (used for client errors). */
export function redactSecrets(s: string, colon = false): string {
  let t = s
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g, "[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\b(token|t|key|secret|password|passwd|pwd|auth|authorization|code|otp|session|sid|apikey|api_key)\s*=\s*[^\s&#,;]+/gi, "$1=[redacted]");
  if (colon) t = t.replace(/\b(password|passwd|pwd|token|secret|authorization|api[_-]?key)\s*:\s*[^\s,;]+/gi, "$1: [redacted]");
  return t;
}

/** Plain text for the message: control, zero-width and bidi characters removed, line breaks kept (two in a row at most). */
export function cleanMessage(raw: string): string {
  return redactSecrets(raw.replace(/\r\n?/g, "\n").replace(/\t/g, " ").replace(CONTROL_RE, ""))
    .replace(/[ ]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function cleanOneLine(raw: string, max: number): string {
  return Array.from(raw.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim()).slice(0, max).join("");
}

/** "Repeated characters" check: fewer than 4 different characters, or one character making up 70% of the non-space text, or almost no letters/digits. */
export function looksLikeNoise(msg: string): boolean {
  const chars = Array.from(msg.replace(/\s/g, "").toLowerCase());
  if (chars.length === 0) return true;
  const counts = new Map<string, number>();
  for (const c of chars) counts.set(c, (counts.get(c) ?? 0) + 1);
  if (counts.size < 4) return true;
  if (Math.max(...counts.values()) / chars.length >= 0.7) return true;
  return (msg.match(/[\p{L}\p{N}]/gu) ?? []).length < 5;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idLike(seg: string): boolean {
  if (UUID_RE.test(seg)) return true;
  if (/^[0-9a-f]{12,}$/i.test(seg)) return true;
  if (/^\d{6,}$/.test(seg)) return true;
  if (/^eyJ/.test(seg)) return true;
  const hasDigit = /\d/.test(seg);
  const hasLetter = /[A-Za-z]/.test(seg);
  if (/^[A-Za-z0-9_]+$/.test(seg) && seg.length >= 10 && hasDigit && hasLetter) return true;
  if (/^[A-Za-z0-9_-]+$/.test(seg) && seg.length >= 20 && hasDigit && /[a-z]/.test(seg) && /[A-Z]/.test(seg)) return true;
  return false;
}

/**
 * Normalises a page path for storage. Returns null when it is not an absolute path (must start with '/'). The query and the hash are cut entirely,
 * `;params` and percent-encoded `?`/`#` tails are cut, slashes collapsed, id-like segments become ':id', length capped on a segment boundary.
 */
export function normalisePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let s = raw.replace(CONTROL_RE, "").trim();
  if (!s.startsWith("/")) return null;
  s = s.split(/[?#]/)[0]!;
  const enc = s.search(/%3f|%23/i);
  if (enc >= 0) s = s.slice(0, enc);
  const segs: string[] = [];
  for (const part of s.split("/")) {
    if (part === "") continue;
    const seg = part.split(";")[0]!;
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { segs.pop(); continue; }
    segs.push(idLike(seg) ? ":id" : seg);
  }
  let out = "/";
  for (const seg of segs) {
    if ((out + seg + "/").length > FEEDBACK.PATH_MAX) break;
    out += seg + "/";
  }
  if (out !== "/" && !s.endsWith("/")) out = out.slice(0, -1);
  return out;
}

/** One client error line: control characters, secrets, emails, long opaque runs and URL queries removed, truncated. */
export function sanitiseClientError(raw: string): string {
  let t = raw.replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  t = redactSecrets(t, true)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]")
    .replace(/(\bhttps?:\/\/[^\s?#]*)[?#]\S*/gi, "$1")
    .replace(/\?\S*/g, "")
    .replace(/\b[0-9a-f]{16,}\b/gi, "[redacted]")
    .replace(/[A-Za-z0-9+\/_-]{24,}/g, (m) => (/\d/.test(m) ? "[redacted]" : m));
  return Array.from(t).slice(0, FEEDBACK.ERR_LEN).join("");
}

export function validContact(raw: string): boolean {
  if (raw.length < 3 || raw.length > 120) return false;
  if (/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(raw)) return true;
  return /^@?[A-Za-z0-9._]{2,32}$/.test(raw) || /^[^\s#@:]{2,32}#\d{4}$/.test(raw);
}

export interface FeedbackInput {
  kind: FeedbackKind;
  message: string;
  pagePath: string;
  pageTitle: string | null;
  referrerPath: string | null;
  viewportW: number;
  viewportH: number;
  locale: string | null;
  buildId: string | null;
  clientErrors: string[];
  contact: string | null;
  includeAccount: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validates and sanitises a POST /feedback body (the honeypot is handled before this). Throws HttpError 400 `invalid` (+field) or `too_short`. */
export function parseFeedback(b: Record<string, unknown>): FeedbackInput {
  if (typeof b.kind !== "string" || !(FEEDBACK_KINDS as readonly string[]).includes(b.kind)) throw invalid("kind must be bug, idea, confusing or other", "kind");
  if (typeof b.message !== "string") throw invalid("message must be text", "message");
  const message = cleanMessage(b.message);
  if (Array.from(message).length < FEEDBACK.MSG_MIN) throw new HttpError(400, "Please write at least 10 characters", { code: "too_short", field: "message", min: FEEDBACK.MSG_MIN });
  if (Array.from(message).length > FEEDBACK.MSG_MAX) throw invalid("message is too long (2000 characters at most)", "message");
  if (looksLikeNoise(message)) throw invalid("Please describe what you saw in a few real words", "message");

  if (!isObj(b.page)) throw invalid("page is required", "page");
  const pagePath = normalisePath(b.page.path);
  if (pagePath === null) throw invalid("page.path must be a path starting with /", "page.path");
  let pageTitle: string | null = null;
  if (b.page.title !== undefined && b.page.title !== null) {
    if (typeof b.page.title !== "string") throw invalid("page.title must be text", "page.title");
    pageTitle = cleanOneLine(b.page.title, FEEDBACK.TITLE_MAX) || null;
  }
  let referrerPath: string | null = null;
  if (b.page.referrer !== undefined && b.page.referrer !== null && b.page.referrer !== "") {
    referrerPath = normalisePath(b.page.referrer);
    if (referrerPath === null) throw invalid("page.referrer must be a path starting with /", "page.referrer");
  }

  if (!isObj(b.client)) throw invalid("client is required", "client");
  const vp = b.client.viewport;
  const dim = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 20000 ? Math.round(v) : null);
  const w = isObj(vp) ? dim(vp.w) : null;
  const h = isObj(vp) ? dim(vp.h) : null;
  if (w === null || h === null) throw invalid("client.viewport.w and .h must be numbers from 1 to 20000", "client.viewport");
  const locale = typeof b.client.locale === "string" && b.client.locale.length <= 35 && /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,3}$/.test(b.client.locale) ? b.client.locale : null;
  const buildId = typeof b.client.buildId === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(b.client.buildId) ? b.client.buildId : null;
  let clientErrors: string[] = [];
  if (b.client.errors !== undefined && b.client.errors !== null) {
    if (!Array.isArray(b.client.errors)) throw invalid("client.errors must be a list", "client.errors");
    clientErrors = b.client.errors.filter((e): e is string => typeof e === "string").slice(0, FEEDBACK.ERR_MAX).map(sanitiseClientError).filter((e) => e !== "");
  }

  let contact: string | null = null;
  if (b.contact !== undefined && b.contact !== null && b.contact !== "") {
    if (typeof b.contact !== "string") throw invalid("contact must be text", "contact");
    const c = b.contact.trim();
    if (c !== "" && !validContact(c)) throw invalid("contact must be an email address or a Discord handle", "contact");
    contact = c === "" ? null : c;
  }
  if (b.includeAccount !== undefined && b.includeAccount !== null && typeof b.includeAccount !== "boolean") throw invalid("includeAccount must be true or false", "includeAccount");
  if (b.consent !== true) throw invalid("consent is required", "consent");
  if (b.consentVersion !== FEEDBACK_CONSENT_VERSION) throw invalid("consentVersion is not the current version", "consentVersion");

  return { kind: b.kind as FeedbackKind, message, pagePath, pageTitle, referrerPath, viewportW: w, viewportH: h, locale, buildId, clientErrors, contact, includeAccount: b.includeAccount === true };
}

export type DeviceClass = "mobile" | "tablet" | "desktop";
/** Device class and browser family from a User-Agent. The UA itself is never kept. */
export function deviceFromUa(ua: string | null | undefined): { deviceClass: DeviceClass | null; browserFamily: string } {
  const u = (ua ?? "").slice(0, 400);
  if (u === "") return { deviceClass: null, browserFamily: "other" };
  const deviceClass: DeviceClass = /iPad|Tablet|PlayBook|Kindle|Silk/i.test(u) || (/Android/i.test(u) && !/Mobile/i.test(u)) ? "tablet" : /Mobi|iPhone|iPod|Android/i.test(u) ? "mobile" : "desktop";
  const browserFamily = /\b(Edg|EdgA|EdgiOS|Edge)\//.test(u) ? "edge" : /\bOPR\/|Opera/.test(u) ? "opera" : /SamsungBrowser/.test(u) ? "samsung" : /Firefox\/|FxiOS\//.test(u) ? "firefox" : /Chrome\/|CriOS\/|Chromium\//.test(u) ? "chrome" : /Safari\//.test(u) ? "safari" : "other";
  return { deviceClass, browserFamily };
}

const hex = (b: ArrayBuffer): string => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Keyed hash of the visitor address (HMAC-SHA-256, first 32 hex chars). Key: the Worker secret FEEDBACK_SALT; when it is not set, a per-deploy fallback
 * derived from JWT_SECRET ("feedback-ip-v1|" + JWT_SECRET), so rotating JWT_SECRET also rotates the hashes. The raw address is never stored or logged.
 */
export async function hashIp(ip: string, env: { FEEDBACK_SALT?: string; JWT_SECRET: string }): Promise<string> {
  const keyText = env.FEEDBACK_SALT && env.FEEDBACK_SALT.length >= 8 ? env.FEEDBACK_SALT : `feedback-ip-v1|${env.JWT_SECRET}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(keyText), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(ip))).slice(0, 32);
}

export type FeedbackImage = "png" | "jpeg" | "webp";
export const IMAGE_BY_CONTENT_TYPE: Record<string, FeedbackImage> = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" };
export const CONTENT_TYPE_BY_IMAGE: Record<FeedbackImage, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" };
