import { env } from "cloudflare:workers";
import app from "../../src/index";
import type { Opts } from "../helpers";
import { freshIp } from "../helpers";

/**
 * Same contract as `call` in test/helpers.ts, but invokes the Hono app directly instead of going through `exports.default.fetch`.
 * Measured: the exports path costs more with every request made in one test file (150 calls 1.8 s, 600 calls 63 s, roughly cubic),
 * while a direct call stays at 0.15 ms. Tests that make hundreds of requests use this one; the response is identical because it is the same app.
 */
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

export async function callDirect(path: string, o: Opts = {}) {
  const headers: Record<string, string> = { "cf-connecting-ip": o.ip ?? freshIp(), ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.gate) headers["x-gate-key"] = o.gate;
  let body: BodyInit | undefined = o.raw;
  if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers["content-type"] = "application/json";
  }
  const res = await app.fetch(new Request(`https://api.test${path}`, { method: o.method ?? (body !== undefined ? "POST" : "GET"), headers, body }), env, ctx);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, headers: res.headers };
}
