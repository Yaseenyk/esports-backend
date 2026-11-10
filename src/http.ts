import type { Context } from "hono";
import type { AppBindings } from "./types";
import { sha256 } from "./crypto";

export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 500,
    message: string,
  ) {
    super(message);
  }
}

export type Ctx = Context<AppBindings>;

export const MAX_BODY = 1_000_000; // 1 MB
export const MAX_PHOTO_BODY = 400 * 1024;

/** Reads at most `limit` bytes of the request body, else 413. */
export async function readBytes(c: Ctx, limit: number): Promise<Uint8Array> {
  const declared = Number(c.req.header("content-length") ?? "0");
  if (declared > limit) throw new HttpError(413, "Request body too large");
  const body = c.req.raw.body;
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new HttpError(413, "Request body too large");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const ch of chunks) {
    out.set(ch, off);
    off += ch.byteLength;
  }
  return out;
}

export async function readJson(c: Ctx, limit = MAX_BODY): Promise<Record<string, unknown>> {
  const bytes = await readBytes(c, limit);
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "Body must be valid JSON");
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new HttpError(400, "Body must be a JSON object");
  return v as Record<string, unknown>;
}

// ---------- validation ----------
export function str(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  const t = v.trim();
  if (t.length < min || t.length > max) {
    throw new HttpError(400, min > 0 ? `${field} must be ${min}-${max} characters` : `${field} must be at most ${max} characters`);
  }
  return t;
}

export function optStr(v: unknown, field: string, max: number, dflt = ""): string {
  return v === undefined || v === null ? dflt : str(v, field, 0, max);
}

export function optBool(v: unknown, field: string): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") throw new HttpError(400, `${field} must be a boolean`);
  return v;
}

export function optHours(v: unknown, field: string): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 24 * 365) {
    throw new HttpError(400, `${field} must be a number of hours between 0 and 8760`);
  }
  return v;
}

export const ID_RE = /^[A-Za-z0-9._~-]{1,48}$/;
export function idStr(v: unknown, field: string): string {
  if (typeof v !== "string" || !ID_RE.test(v)) throw new HttpError(400, `${field} must be 1-48 characters of letters, digits, . _ ~ -`);
  return v;
}

export const nowIso = () => new Date().toISOString();
export const inHours = (h: number | null) => (h === null ? null : new Date(Date.now() + h * 3600_000).toISOString());

// ---------- rate limiting ----------
export async function rateLimit(c: Ctx, scope: string, limit: number, windowSec: number, extra = ""): Promise<void> {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const key = await sha256(`${c.env.JWT_SECRET}|${scope}|${extra}|${ip}`);
  const nowSec = Math.floor(Date.now() / 1000);
  const ws = Math.floor(nowSec / windowSec) * windowSec;
  const row = await c.env.DB.prepare(
    "INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1) ON CONFLICT (key, window_start) DO UPDATE SET count = count + 1 RETURNING count",
  )
    .bind(key, ws)
    .first<{ count: number }>();
  if (Math.random() < 0.01) {
    // opportunistic cleanup of old windows
    c.executionCtx.waitUntil(c.env.DB.prepare("DELETE FROM rate_limits WHERE window_start < ?").bind(nowSec - 86400).run());
  }
  if (row && row.count > limit) throw new HttpError(429, "Too many requests, try again later");
}
