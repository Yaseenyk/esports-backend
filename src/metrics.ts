/**
 * Counts-only product metrics (blueprint 8, PM review r2: eight events, `report_filed` and `takedown` cut because the reports and takedowns tables hold them).
 *
 *  - Server events: `emitStmt(db, name, d1)` is ONE upsert into metrics_daily, added to the business batch (1 row written, no extra request).
 *    The client cannot forge these: the beacon's registry (CLIENT_METRICS) holds only `tool_complete`.
 *  - Client event `tool_complete`: Workers Analytics Engine binding `TRACK` when present, otherwise DROPPED (OD-C amended, dev B-21: free tier only,
 *    never a D1 write on an unauthenticated route). `writeClientMetric` does exactly that and never throws.
 *  - Allowed properties: the name and one enum member `d1`. Never a user, org, event, team, person, token, session, URL, user agent or finer-than-day time.
 *  - Pure module (no `cloudflare:*` imports). Constant SQL only.
 */

/** The 14 free tools (keys of the frontend TOOL_PAGES). Same list in esports-hub/src/lib/track.ts; a test there pins it to TOOL_PAGES. */
export const TOOL_IDS = [
  "poster", "plan", "id-cards", "double-elimination", "registration", "round-robin", "schedule",
  "certificates", "display-screen", "check-in", "brackets", "points-table", "groups", "print-kits",
] as const;

/** name -> allowed `d1` members. An empty list means d1 must be empty. */
export const METRICS = {
  tool_complete: TOOL_IDS,
  signup_done: [],
  club_created: [],
  event_created: ["scratch", "duplicate"],
  registration_opened: [],
  team_registered: [],
  live_published: [],
  invite_accepted: ["org", "event"],
} as const satisfies Record<string, readonly string[]>;

export type MetricName = keyof typeof METRICS;
export type ServerMetric = Exclude<MetricName, "tool_complete">;
export const METRIC_NAMES = Object.keys(METRICS) as MetricName[];
/** The only names the public beacon accepts. */
export const CLIENT_METRICS: readonly MetricName[] = ["tool_complete"];

export const METRIC_UPSERT_SQL =
  "INSERT INTO metrics_daily (day, name, d1, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT (day, name, d1) DO UPDATE SET n = n + 1";

/** True when `d1` is an allowed member for `name` (empty is allowed only when the name has no members). */
export function validMetric(name: unknown, d1: unknown): name is MetricName {
  if (typeof name !== "string" || !Object.prototype.hasOwnProperty.call(METRICS, name)) return false;
  const allowed = METRICS[name as MetricName] as readonly string[];
  const v = d1 ?? "";
  return typeof v === "string" && (allowed.length === 0 ? v === "" : allowed.includes(v));
}

export const metricDay = (nowMs: number = Date.now()): string => new Date(nowMs).toISOString().slice(0, 10);

/** The upsert for a server event, for a db.batch. An invalid `d1` is stored as '' (the count still lands, the property is not trusted). */
export function emitStmt(db: D1Database, name: ServerMetric, d1 = "", nowMs?: number): D1PreparedStatement {
  if (!Object.prototype.hasOwnProperty.call(METRICS, name) || (name as string) === "tool_complete") throw new Error("metrics: not a server metric");
  const allowed = METRICS[name] as readonly string[];
  return db.prepare("INSERT INTO metrics_daily (day, name, d1, n) VALUES (?1, ?2, ?3, 1) ON CONFLICT (day, name, d1) DO UPDATE SET n = n + 1").bind(metricDay(nowMs), name, allowed.includes(d1) ? d1 : "");
}

/** Minimal shape of the Analytics Engine binding (declared here so the module needs no extra type package). */
export interface MetricsSink {
  writeDataPoint(p: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

/** `tool_complete` to Analytics Engine, or dropped when there is no binding. Returns true when a data point was written. Never throws, never touches D1. */
export function writeClientMetric(sink: MetricsSink | undefined, name: MetricName, d1: string): boolean {
  if (!sink || !CLIENT_METRICS.includes(name) || !validMetric(name, d1)) return false;
  try {
    sink.writeDataPoint({ blobs: [name, d1], doubles: [1], indexes: [name] });
    return true;
  } catch {
    return false;
  }
}
