/** Text rules for the Looking-for-Team board: plain text, 600 characters, no links, no phone numbers. Pure. */
export const LFT_MESSAGE_MAX = 600;
export const APPLICATION_MESSAGE_MAX = 400;
export const CONTACT_MAX = 40;

export type TextCheck = { ok: true; text: string } | { ok: false; code: "empty" | "too_long" | "has_link" | "has_phone" | "has_markup" | "bad_contact" | "contact_outside" };

const CONTROL_RANGES: [number, number][] = [[0, 8], [11, 12], [14, 31], [0x7f, 0x9f], [0x200b, 0x200f], [0x2028, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]];
const CONTROL = new RegExp(`[${CONTROL_RANGES.map(([x, y]) => `${String.fromCharCode(x)}-${String.fromCharCode(y)}`).join("")}]`, "g");
const DOT = "[.\\u3002\\uff0e\\u2024]";
const TLDS = "com|net|org|io|gg|co|in|me|tv|xyz|app|dev|link|ly|to|ink|info|biz|us|uk|ru|cc|club|site|online|live|chat|gl|be|im|fm|ws|vip|shop|store|page|tk|ml|ga|cf|gq";
// Links: a scheme, www., a domain-looking token, a discord invite, "dot com" spelled out, and the common short-link hosts.
const LINK_RES: RegExp[] = [
  /\b[a-z][a-z0-9+.-]{1,15}:\/\//i,
  /\bwww\s*\./i,
  /\b(?:https?|ftp)\b\s*:/i,
  new RegExp(`(?:^|[^a-z0-9])[a-z0-9-]+\\s*${DOT}\\s*(?:${TLDS})(?![a-z0-9])`, "i"),
  /\bdiscord\s*\.?\s*(?:gg|com\s*\/\s*invite)/i,
  /\b(?:dot|d0t)\s*(?:com|net|org|gg|io|in)\b/i,
  /\bt\s*\.\s*me\s*\//i,
  /\bwa\s*\.\s*me\b/i,
  /\bbit\s*\.\s*ly\b/i,
];

// Contact outside the site. Public listings only: "contact details stay hidden until the poster accepts you".
const OUTSIDE_RE = /\b(?:dm|msg|message|contact|ping|add|reach|hit)\s+me\s+(?:up\s+)?(?:on|at|via|in)\b|\b(?:dm|msg|call|text|whatsapp)\s+me\b/i;
const HANDLE_RE = /@[\p{L}\p{N}._]{3,}/gu;
const DISCORD_TAG_RE = /[\p{L}\p{N}._]{2,}#\d{4}\b/u;
const PLATFORM_RE = /\b(?:discord|telegram|snapchat|snap|instagram|insta|whatsapp)\b(?:\s+(?:is|id|handle|username|user))?(\s*[:\-–—=]\s*|\s+)@?([\p{L}\p{N}._]{3,})/giu;
const PLAIN_AFTER_COLON = new Set(["yes", "required", "optional", "preferred", "only", "mandatory", "needed", "available", "active", "ready", "must", "okay", "not", "and", "the", "for", "but", "also", "sometimes", "often", "daily", "always", "never", "open", "voice", "chat", "server", "call", "calls", "comms"]);

/** True when the text hands out a way to reach the poster outside the site: an @handle, "DM me", "insta: name", a Discord tag. */
export function hasOutsideContact(text: string): boolean {
  if (OUTSIDE_RE.test(text) || DISCORD_TAG_RE.test(text)) return true;
  for (const m of text.matchAll(HANDLE_RE)) if (!/^@\d{1,2}(?:am|pm)$/i.test(m[0])) return true; // "@9pm" is a time, not a handle
  for (const m of text.matchAll(PLATFORM_RE)) {
    const token = (m[2] ?? "").replace(/\.+$/, "");
    if (token.length < 3) continue;
    if (/[^\s]/.test(m[1] ?? "")) { if (!PLAIN_AFTER_COLON.has(token.toLowerCase())) return true; } // "insta: rohan_igl"
    else if (/[\d_]|[^.]\.[^.]/.test(token)) return true; // "insta rohan_igl", but "insta sometimes" passes
  }
  return false;
}

/** A phone number: a run of digits with separators holding 7 or more digits, or 10 or more digits in the whole text. */
export function hasPhoneNumber(text: string): boolean {
  const runs = text.match(/[+(]?\d[\d\s().\-‐-―]{5,}\d/g) ?? [];
  for (const r of runs) if (r.replace(/\D/g, "").length >= 7) return true;
  return text.replace(/[^0-9]/g, "").length >= 10;
}

export const hasLink = (text: string): boolean => LINK_RES.some((re) => re.test(text));

/** Normalises whitespace (keeps single newlines), strips control and bidi characters. */
export function cleanText(v: string): string {
  return v.replace(CONTROL, " ").replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function validatePlain(v: unknown, max: number, minLen: number, publicText = false): TextCheck {
  if (typeof v !== "string") return { ok: false, code: "empty" };
  const t = cleanText(v);
  if (t.length < minLen) return { ok: false, code: "empty" };
  if (Array.from(t).length > max) return { ok: false, code: "too_long" };
  if (/[<>]/.test(t)) return { ok: false, code: "has_markup" };
  if (hasLink(t)) return { ok: false, code: "has_link" };
  if (hasPhoneNumber(t)) return { ok: false, code: "has_phone" };
  if (publicText && hasOutsideContact(t)) return { ok: false, code: "contact_outside" };
  return { ok: true, text: t };
}

/** A listing message: 10 to 600 characters of plain text; public, so no way to contact the poster outside the site. */
export const validateLftMessage = (v: unknown): TextCheck => validatePlain(v, LFT_MESSAGE_MAX, 10, true);
/** An application message: 0 to 400 (only the poster sees it, so handles are allowed; links and phones are not) characters (empty allowed, returned as ""). */
export function validateApplicationMessage(v: unknown): TextCheck {
  if (v === undefined || v === null || v === "") return { ok: true, text: "" };
  return validatePlain(v, APPLICATION_MESSAGE_MAX, 0);
}
/** A dispute or comment text: 1 to `max` characters; links ARE allowed in disputes (evidence links), phone numbers are not. */
export function validateFreeText(v: unknown, max: number, min = 1): TextCheck {
  if (typeof v !== "string") return { ok: false, code: "empty" };
  const t = cleanText(v);
  if (t.length < min) return { ok: false, code: "empty" };
  if (Array.from(t).length > max) return { ok: false, code: "too_long" };
  if (/[<>]/.test(t)) return { ok: false, code: "has_markup" };
  if (hasPhoneNumber(t)) return { ok: false, code: "has_phone" };
  return { ok: true, text: t };
}

/** A contact handle (for example a Discord username): 2 to 40 characters of letters, digits and . _ # @ - and spaces; no link, no phone number. */
export function validateContact(v: unknown): TextCheck {
  if (typeof v !== "string") return { ok: false, code: "bad_contact" };
  const t = cleanText(v);
  if (t.length < 2 || t.length > CONTACT_MAX || !/^[\p{L}\p{N}._#@ -]+$/u.test(t)) return { ok: false, code: "bad_contact" };
  if (hasLink(t)) return { ok: false, code: "has_link" };
  if (hasPhoneNumber(t)) return { ok: false, code: "has_phone" };
  return { ok: true, text: t };
}

/** An optional short PUBLIC note (scrim skill note, server name): 0 to `max` characters, no links, phone numbers or contact outside the site. "" when empty. */
export function validatePublicNote(v: unknown, max: number): TextCheck {
  if (v === undefined || v === null || v === "") return { ok: true, text: "" };
  return validatePlain(v, max, 0, true);
}
/** An email address anywhere in the text (a scrim contact must be a platform handle, not an email). */
export const hasEmail = (text: string): boolean => /[^\s@]+@[^\s@]+\.[^\s@]{2,}/.test(text);
