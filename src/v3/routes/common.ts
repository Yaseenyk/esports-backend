/** Route plumbing shared by the v3 routers: flag gate, kill-switch middleware, cacheable JSON. No business rules here. */
import type { Context, MiddlewareHandler } from "hono";
import { killedResponse, killGate, type KillKey } from "../../admin/kill";
import { getFlag, getFlags, type FlagKey } from "../../flags";
import { sha256 } from "../../crypto";
import type { AppBindings } from "../../types";

export type V3Flag = Extract<FlagKey, `v3.${string}`>;

/**
 * Flag gate. With every listed flag OFF the answer is the router's own notFound, byte for byte the answer of an unknown route, and NO v3 table has been
 * touched (only the legacy `flags` table is read; a missing flags table means defaults = OFF). Mount it BEFORE sign-in.
 */
export const flagGate = (...keys: (V3Flag | "feedback.enabled")[]): MiddlewareHandler<AppBindings> => async (c, next) => {
  const flags = await getFlags(c.env.DB);
  if (!keys.some((k) => flags[k])) return c.notFound();
  await next();
};

/** Kill switch as middleware (503 temporarily_disabled). `read: true` applies it to GET as well. */
export const killMw = (key: KillKey, opts: { read?: boolean } = {}): MiddlewareHandler<AppBindings> => async (c, next) => {
  const off = await killGate(c, key, opts);
  if (off) return off;
  await next();
};

/**
 * Public READ kill switch: only `kill.directory` stops a public v3 read (503). The master valve `kill.public_writes` is for writes and must not stop reads,
 * so this does not use killGate (whose read path also honours the master valve).
 */
export const killReadMw: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (await getFlag(c.env.DB, "kill.directory")) return killedResponse();
  await next();
};

/**
 * Public, cacheable JSON with a weak ETag (sha-256 of the body). A matching If-None-Match answers 304 with no body.
 * Cache-Control is public so a CDN may keep it for `maxAge` seconds; `swr` lets it serve stale while it refreshes.
 */
export async function cachedJson(c: Context<AppBindings>, payload: unknown, maxAge: number, swr = 0): Promise<Response> {
  const body = JSON.stringify(payload);
  const etag = `W/"${(await sha256(body)).slice(0, 27)}"`;
  const headers: Record<string, string> = {
    etag,
    "cache-control": `public, max-age=${maxAge}${swr ? `, stale-while-revalidate=${swr}` : ""}`,
    "content-type": "application/json",
  };
  const inm = c.req.header("if-none-match");
  if (inm && inm.split(",").map((s) => s.trim()).includes(etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { status: 200, headers });
}

/** Responses with private data: never cached by a shared cache. */
export const noStore = (c: Context<AppBindings>): void => {
  c.header("cache-control", "no-store");
};
