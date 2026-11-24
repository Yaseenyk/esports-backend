/** India time helpers (IST = UTC+05:30, no daylight saving). Pure: days are "YYYY-MM-DD", times "HH:MM", instants epoch seconds. */
export const IST_OFFSET_SEC = 19_800;
const pad = (n: number) => String(n).padStart(2, "0");

export function istDay(nowSec: number): string {
  const d = new Date((nowSec + IST_OFFSET_SEC) * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}
export const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(v);
export const isTimeOfDay = (v: unknown): v is string => typeof v === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
/** An India date and time to UTC epoch seconds. */
export function istToEpoch(day: string, time: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const [h, mi] = time.split(":").map(Number) as [number, number];
  return Date.UTC(y, m - 1, d, h, mi) / 1000 - IST_OFFSET_SEC;
}
