/** Random text id (128 bits, hex). Ids are never derived from content and never leave the API as anything but opaque strings. */
export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}
export const ID32_RE = /^[0-9a-f]{32}$/;
export const nowSec = (): number => Math.floor(Date.now() / 1000);
export const toIso = (sec: number | null | undefined): string | null => (sec === null || sec === undefined ? null : new Date(sec * 1000).toISOString());
/** ISO 8601 / date string to epoch seconds, or null when it does not parse. */
export function fromIso(v: unknown): number | null {
  if (typeof v !== "string" || v.length < 10 || v.length > 40) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
