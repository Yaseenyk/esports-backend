/** LFT team matching (flag v3.lft_match): languages, play-hour blocks, chosen contacts and the match score. Pure. */
import { validateContact } from "./lft-text";

export const LANGUAGES = ["en", "hi", "bn", "ta", "te", "mr", "kn", "ml", "gu", "pa", "ur", "or", "pt", "id", "other"] as const;
export type Language = (typeof LANGUAGES)[number];
/** Play-hour blocks in India time: morning 06-12, afternoon 12-17, evening 17-21, night 21-01, late night 01-06. */
export const PLAY_HOURS = ["morning", "afternoon", "evening", "night", "late_night"] as const;
export type PlayHour = (typeof PLAY_HOURS)[number];
export const CONTACT_KINDS = ["discord", "instagram", "telegram", "ign", "other"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];
export const MAX_CONTACTS = 3;
export const MATCH_POOL = 100;

export type Contacts = Partial<Record<ContactKind, string>>;
export type ContactsCheck = { ok: true; contacts: Contacts; first: string } | { ok: false; code: "invalid_contacts" | "no_contacts" | "too_many_contacts" | "bad_contact" | "has_link" | "has_phone" };

/**
 * The contacts a person chooses to share after an accept: an object of up to 3 entries, kind -> handle (2 to 40 characters, no link, no phone number).
 * `first` is the first handle, kept in the legacy single `contact` column so older screens still work.
 */
export function checkContacts(v: unknown): ContactsCheck {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, code: "invalid_contacts" };
  const entries = Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined && x !== null && x !== "");
  if (entries.length === 0) return { ok: false, code: "no_contacts" };
  if (entries.length > MAX_CONTACTS) return { ok: false, code: "too_many_contacts" };
  const out: Contacts = {};
  let first = "";
  for (const [k, x] of entries) {
    if (!(CONTACT_KINDS as readonly string[]).includes(k)) return { ok: false, code: "invalid_contacts" };
    const c = validateContact(x);
    if (!c.ok) return { ok: false, code: c.code === "has_link" || c.code === "has_phone" ? c.code : "bad_contact" };
    out[k as ContactKind] = c.text;
    first ||= c.text;
  }
  return { ok: true, contacts: out, first };
}

/** A stored contacts JSON, re-validated on read so a broken row never leaks anything unexpected. */
export function parseContacts(raw: string | null | undefined): Contacts | null {
  if (!raw) return null;
  try {
    const c = checkContacts(JSON.parse(raw));
    return c.ok ? c.contacts : null;
  } catch {
    return null;
  }
}

/** A stored JSON array of codes from `list` (unknown codes dropped). */
export function codeList<T extends string>(raw: string | null | undefined, list: readonly T[]): T[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is T => typeof x === "string" && (list as readonly string[]).includes(x)) : [];
  } catch {
    return [];
  }
}

export interface MatchWants { roles: string[]; languages: string[]; hours: string[] }
export interface MatchFacts { roles: string[]; languages: string[]; hours: string[] }

/**
 * How well a listing fits what the viewer looks for, 0 to 100. Roles weigh 3 (a listing open to any role counts as a role match), languages 2,
 * play hours 1 per shared block. Only the parts the viewer filled in count. With nothing filled in the score is null (no ranking claimed).
 */
export function matchScore(want: MatchWants, l: MatchFacts): { score: number; reasons: ("role" | "language" | "hours")[] } | null {
  let max = 0, got = 0;
  const reasons: ("role" | "language" | "hours")[] = [];
  if (want.roles.length) {
    max += 3;
    if (l.roles.length === 0 || l.roles.some((r) => want.roles.includes(r))) { got += 3; reasons.push("role"); }
  }
  if (want.languages.length) {
    max += 2;
    if (l.languages.some((x) => want.languages.includes(x))) { got += 2; reasons.push("language"); }
  }
  if (want.hours.length) {
    max += want.hours.length;
    const shared = l.hours.filter((h) => want.hours.includes(h)).length;
    if (shared) { got += shared; reasons.push("hours"); }
  }
  return max === 0 ? null : { score: Math.round((got / max) * 100), reasons };
}

/** "a,b,c" -> the members of `list`, deduplicated, at most `max`. null when any member is unknown. */
export function csvCodes<T extends string>(v: string | undefined, list: readonly T[], max: number): T[] | null {
  if (v === undefined || v === "") return [];
  const parts = v.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length > max) return null;
  const out: T[] = [];
  for (const p of parts) {
    if (!(list as readonly string[]).includes(p)) return null;
    if (!out.includes(p as T)) out.push(p as T);
  }
  return out;
}
