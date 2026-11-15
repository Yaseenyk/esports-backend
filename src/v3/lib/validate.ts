/** Small request-body validators for v3 services. They throw HttpError (400) with a machine-readable `code`. */
import { HttpError } from "../../http";
import { cleanText } from "./lft-text";
import { fromIso } from "./ids";
import { isOneOf } from "./enums";

export const bad = (message: string, code: string): HttpError => new HttpError(400, message, { code });

export function reqEnum<T extends string>(v: unknown, list: readonly T[], field: string): T {
  if (!isOneOf(list, v)) throw bad(`${field} must be one of: ${list.join(", ")}`, `invalid_${field}`);
  return v;
}
export function optEnum<T extends string>(v: unknown, list: readonly T[], field: string): T | undefined {
  return v === undefined ? undefined : reqEnum(v, list, field);
}

/** Plain text field. undefined stays undefined (no change); null or "" gives null (clear) when allowed. */
export function optText(v: unknown, field: string, max: number, min = 0): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "string") throw bad(`${field} must be a string`, `invalid_${field}`);
  const t = cleanText(v);
  if (t === "") {
    if (min > 0) throw bad(`${field} must be at least ${min} characters`, `invalid_${field}`);
    return null;
  }
  if (t.length < min || Array.from(t).length > max) throw bad(`${field} must be ${min}-${max} characters`, `invalid_${field}`);
  if (/[<>]/.test(t)) throw bad(`${field} must be plain text`, `invalid_${field}`);
  return t;
}
export function reqText(v: unknown, field: string, min: number, max: number): string {
  const t = optText(v, field, max, Math.max(min, 1));
  if (typeof t !== "string") throw bad(`${field} is required`, `invalid_${field}`);
  return t;
}

export function optInt(v: unknown, field: string, min: number, max: number): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(`${field} must be a whole number from ${min} to ${max}`, `invalid_${field}`);
  return v;
}

/** An ISO date or date-time to epoch seconds. null clears. */
export function optDate(v: unknown, field: string): number | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const s = fromIso(v);
  if (s === null || s < 0 || s > 4_102_444_800) throw bad(`${field} must be an ISO 8601 date`, `invalid_${field}`);
  return s;
}

export function optBoolean(v: unknown, field: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw bad(`${field} must be true or false`, `invalid_${field}`);
  return v;
}

/** An array of enum values, no duplicates, at most `max`. */
export function enumArray<T extends string>(v: unknown, list: readonly T[], field: string, max: number): T[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > max) throw bad(`${field} must be a list of at most ${max} values`, `invalid_${field}`);
  const out: T[] = [];
  for (const x of v) {
    const e = reqEnum(x, list, field);
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

export function shortList(v: unknown, field: string, maxItems: number, maxLen: number): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > maxItems) throw bad(`${field} must be a list of at most ${maxItems} items`, `invalid_${field}`);
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") throw bad(`${field} must hold text`, `invalid_${field}`);
    const t = cleanText(x);
    if (t.length < 1 || t.length > maxLen || /[<>]/.test(t)) throw bad(`${field} items must be 1-${maxLen} characters`, `invalid_${field}`);
    if (!out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}
