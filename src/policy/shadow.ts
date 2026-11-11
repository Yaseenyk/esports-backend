import type { Ctx } from "../http";
import { decide, type AccessFacts } from "./decide";

/**
 * Shadow mode (blueprint 5.2; dev-review-r2 N-6). With flag authz.mode = 'shadow' the legacy decision is enforced, the org decision is computed from the
 * SAME row (no extra query), and a difference is recorded:
 *   1. one JSON console.warn line, and
 *   2. one upsert into metrics_daily (name 'authz_mismatch', d1 = route class) through waitUntil, so the 48-hour gate reads a counter, not a log search.
 * At most MAX_WRITES_PER_HOUR counter writes per isolate per hour: a systematic bug cannot become a write flood (the log line is not capped).
 * Normal operation (no mismatch) writes nothing. This module never changes a result and never throws.
 */
export const MAX_WRITES_PER_HOUR = 20;
export const COUNTER_NAME = "authz_mismatch";
export const COUNTER_SQL = "INSERT INTO metrics_daily (day, name, d1, n) VALUES (?1, 'authz_mismatch', ?2, 1) ON CONFLICT (day, name, d1) DO UPDATE SET n = n + 1";

let windowHour = -1;
let written = 0;

/** Test helper: forget the in-memory hourly cap. */
export function resetShadowCap(): void {
  windowHour = -1;
  written = 0;
}

/** Whether another counter write is allowed in this isolate-hour (and reserves it). */
export function takeWriteSlot(nowMs: number): boolean {
  const h = Math.floor(nowMs / 3_600_000);
  if (h !== windowHour) {
    windowHour = h;
    written = 0;
  }
  if (written >= MAX_WRITES_PER_HOUR) return false;
  written++;
  return true;
}

/** A short route class for the counter's d1 column (at most 20 characters): method plus the route pattern without the /events/:id prefix. */
export function routeClass(method: string, routePath: string): string {
  const p = routePath.replace(/^\/events\/:[A-Za-z]+/, "").replace(/^\//, "") || "event";
  return `${method} ${p}`.slice(0, 20);
}

export interface ShadowInput {
  facts: AccessFacts;
  userId: string;
  eventId: string;
}

/** Compares the two decisions. Returns true when they differ. Never throws. */
export function shadowCompare(c: Ctx, i: ShadowInput, nowMs: number = Date.now()): boolean {
  try {
    const legacy = decide("legacy", i.facts);
    const org = decide("org", i.facts);
    if (legacy === org) return false;
    let rc = c.req.method;
    try {
      rc = routeClass(c.req.method, c.req.routePath);
    } catch {
      /* no route path: the method alone */
    }
    // ids only, never names or emails
    console.warn(JSON.stringify({ authz_mismatch: true, legacy, org, route: rc, user: i.userId, event: i.eventId, org_id: i.facts.org_id }));
    if (takeWriteSlot(nowMs)) {
      const day = new Date(nowMs).toISOString().slice(0, 10);
      const p = c.env.DB.prepare("INSERT INTO metrics_daily (day, name, d1, n) VALUES (?1, 'authz_mismatch', ?2, 1) ON CONFLICT (day, name, d1) DO UPDATE SET n = n + 1").bind(day, rc).run().catch(() => undefined); // metrics_daily missing or D1 error: the log line still exists
      try {
        c.executionCtx.waitUntil(p);
      } catch {
        /* no execution context (tests, direct calls): the promise still runs */
      }
    }
    return true;
  } catch {
    return false;
  }
}
