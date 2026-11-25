/** Squad availability planner rules (flag v3.planner). Pure: no SQL, no HttpError. The service turns a failed check into a 400. */
import { cleanText, hasLink, hasOutsideContact, hasPhoneNumber } from "./lft-text";

export const PLANNER = {
  MAX_SLOTS: 336, // 14 days of one-hour slots, or 7 days of half-hour slots
  MAX_SPAN_SEC: 15 * 86_400,
  MAX_AHEAD_SEC: 60 * 86_400,
  MAX_PAST_SEC: 86_400,
  MAX_VOTERS: 20,
  NAME_MAX: 24,
  TITLE_MAX: 60,
  TZ_MAX: 40,
  TTL_SEC: 30 * 86_400,
  SLOT_MINUTES: [30, 60] as const,
} as const;

/** A share token or a captain key minted by the server: 32 base64url characters (192 random bits). */
export const SERVER_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
/** A per-browser edit key made by the teammate's browser: 32 to 64 base64url characters. */
export const EDIT_KEY_RE = /^[A-Za-z0-9_-]{32,64}$/;

/** An IANA time zone the runtime knows ("Asia/Kolkata", "UTC"). Only letters, digits, _ + - and /, at most 40 characters. */
export function validTimeZone(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 1 || v.length > PLANNER.TZ_MAX || !/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(v)) return false;
  try {
    new Intl.DateTimeFormat("en-IN", { timeZone: v }).format(0);
    return true;
  } catch {
    return false;
  }
}

export type SlotCheck = { ok: true; slots: number[] } | { ok: false; code: "slots_missing" | "slots_too_many" | "slots_not_aligned" | "slots_order" | "slots_range" | "slots_span" };

/**
 * The plan's slots: a list of UTC epoch seconds, each a whole multiple of the slot length, strictly increasing, from one day ago to 60 days ahead,
 * spanning at most 15 days, at most 336 of them.
 */
export function checkSlots(v: unknown, slotMinutes: number, now: number): SlotCheck {
  if (!Array.isArray(v) || v.length === 0) return { ok: false, code: "slots_missing" };
  if (v.length > PLANNER.MAX_SLOTS) return { ok: false, code: "slots_too_many" };
  const step = slotMinutes * 60;
  const out: number[] = [];
  for (const x of v) {
    if (typeof x !== "number" || !Number.isInteger(x) || x % step !== 0) return { ok: false, code: "slots_not_aligned" };
    if (out.length && x <= out[out.length - 1]!) return { ok: false, code: "slots_order" };
    if (x < now - PLANNER.MAX_PAST_SEC || x > now + PLANNER.MAX_AHEAD_SEC) return { ok: false, code: "slots_range" };
    out.push(x);
  }
  if (out[out.length - 1]! - out[0]! > PLANNER.MAX_SPAN_SEC) return { ok: false, code: "slots_span" };
  return { ok: true, slots: out };
}

/** A teammate's picks: unique slot indexes inside the plan, returned sorted. null when any value is not a valid index. */
export function checkPicks(v: unknown, slotCount: number): number[] | null {
  if (!Array.isArray(v) || v.length > slotCount) return null;
  const seen = new Set<number>();
  for (const x of v) {
    if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x >= slotCount) return null;
    seen.add(x);
  }
  return [...seen].sort((a, b) => a - b);
}

export type NameCheck = { ok: true; text: string } | { ok: false; code: "empty" | "too_long" | "not_plain" };

/** A display name or a plan title: plain text, no markup, link, phone number or contact handle (both are shown to everyone holding the link). */
export function checkPlainLabel(v: unknown, max: number, required: boolean): NameCheck {
  if (v === undefined || v === null || v === "") return required ? { ok: false, code: "empty" } : { ok: true, text: "" };
  if (typeof v !== "string") return { ok: false, code: "not_plain" };
  const t = cleanText(v).replace(/\n/g, " ");
  if (!t) return required ? { ok: false, code: "empty" } : { ok: true, text: "" };
  if (Array.from(t).length > max) return { ok: false, code: "too_long" };
  if (/[<>]/.test(t) || hasLink(t) || hasPhoneNumber(t) || hasOutsideContact(t)) return { ok: false, code: "not_plain" };
  return { ok: true, text: t };
}

/** How many teammates are free in each slot. Pure; used by the adapter so the page never has to trust a count it did not see. */
export function slotCounts(slotCount: number, picks: number[][]): number[] {
  const counts = new Array<number>(slotCount).fill(0);
  for (const p of picks) for (const i of p) if (i >= 0 && i < slotCount) counts[i]! += 1;
  return counts;
}

/** Parses a stored JSON integer array; anything malformed is an empty list (a broken row never throws on read). */
export function intList(raw: string): number[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}
