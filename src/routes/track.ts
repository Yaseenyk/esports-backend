import { Hono } from "hono";
import type { AppBindings } from "../types";
import { rateLimitSoft } from "../http";
import { getFlag } from "../flags";
import { CLIENT_METRICS, validMetric, writeClientMetric, type MetricName } from "../metrics";

/**
 * POST /public/t: the one unauthenticated tracking beacon (blueprint 8.4, dev B-21, OD-C amended).
 *
 *  - Always answers 204 with an empty body: no oracle for what was accepted.
 *  - Writes nothing to D1, ever: no metrics_daily row, no rate_limits row (the limiter is the in-isolate rateLimitSoft). The only destination is the
 *    Analytics Engine binding `TRACK`; when it is absent the event is dropped.
 *  - Nothing is written when: DNT is 1, Sec-GPC is 1, Origin is not allowed, the body is over 200 bytes or not exactly {v:1,e,d?}, the event is not a
 *    registered client event (only `tool_complete`) or its `d` is not a tool id, or flag kill.tracking / shed.tracking is set.
 *  - Body is text/plain JSON (a CORS-safelisted type, so no preflight): {"v":1,"e":"tool_complete","d":"poster"}. Nothing else is read or kept.
 */
export const track = new Hono<AppBindings>();

export const BEACON_MAX_BYTES = 200;
const DEFAULT_ORIGINS = "https://esports.streamerosai.com,http://localhost:3000,http://localhost:4173";

/** Parses a beacon body into a registered (name, d1) or null. Pure. */
export function parseBeacon(text: string): { name: MetricName; d1: string } | null {
  if (text.length > BEACON_MAX_BYTES) return null;
  let j: unknown;
  try { j = JSON.parse(text); } catch { return null; }
  if (j === null || typeof j !== "object" || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "v" && k !== "e" && k !== "d")) return null; // an unknown property rejects the whole event
  if (o.v !== 1 || typeof o.e !== "string") return null;
  if (!(CLIENT_METRICS as readonly string[]).includes(o.e)) return null;
  const d = o.d === undefined ? "" : o.d;
  if (typeof d !== "string" || !validMetric(o.e, d)) return null;
  return { name: o.e as MetricName, d1: d };
}

/** Reads at most BEACON_MAX_BYTES bytes; null when larger. */
async function readSmall(req: Request): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > BEACON_MAX_BYTES) return null;
  const body = req.body;
  if (!body) return "";
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > BEACON_MAX_BYTES) { await reader.cancel(); return null; }
    parts.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { all.set(p, off); off += p.byteLength; }
  return new TextDecoder().decode(all);
}

track.post("/public/t", async (c) => {
  const done = () => c.body(null, 204);
  try {
    if (c.req.header("dnt") === "1" || c.req.header("sec-gpc") === "1") return done();
    const origin = c.req.header("origin");
    const allowed = (c.env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS).split(",").map((s) => s.trim()).filter(Boolean);
    if (!origin || !allowed.includes(origin)) return done();
    const sink = c.env.TRACK;
    if (!sink) return done(); // no Analytics Engine binding: tool_complete is dropped, never written to D1
    try { rateLimitSoft(c, "track", 20, 60); } catch { return done(); } // in-isolate only: accident protection, never a D1 row
    const text = await readSmall(c.req.raw);
    if (text === null) return done();
    const ev = parseBeacon(text);
    if (!ev) return done();
    if ((await getFlag(c.env.DB, "kill.tracking")) || (await getFlag(c.env.DB, "shed.tracking"))) return done();
    writeClientMetric(sink, ev.name, ev.d1);
  } catch {
    /* tracking must never fail a page */
  }
  return done();
});
