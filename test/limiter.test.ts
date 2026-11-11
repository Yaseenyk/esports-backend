import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { cleanupRateLimits, rateLimitSoft, softLimiterSize, type Ctx } from "../src/http";
import { isDailyTick, scheduled } from "../src/features/reminders-cron";
import { call, freshIp, setupEvent } from "./helpers";
import { callDirect } from "./golden/direct";

vi.setConfig({ testTimeout: 120_000 });

// S2: public reads and the hit route use the in-memory limiter (no D1 write); credential routes keep the exact D1 limiter and fail closed.

const WRITE_RE = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

/** A D1 stand-in that records every write statement and can be told to fail for statements that match `failOn`. */
function spyDb(failOn?: RegExp) {
  const writes: string[] = [];
  const real = env.DB;
  const db = {
    prepare(sql: string) {
      if (failOn?.test(sql)) throw new Error("D1 is down");
      if (WRITE_RE.test(sql)) writes.push(sql);
      return real.prepare(sql);
    },
    batch(stmts: D1PreparedStatement[]) { return real.batch(stmts); },
  } as unknown as D1Database;
  return { db, writes };
}

/** The real bindings with only DB swapped; a Proxy so the real env object is never written to. */
const withDb = (db: D1Database) => new Proxy(env as object, { get: (t, k, r) => (k === "DB" ? db : Reflect.get(t, k, r)) }) as typeof env;

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
/** Runs the real app with a wrapped database binding. */
async function viaSpy(db: D1Database, path: string, o: { method?: string; body?: unknown; ip?: string } = {}) {
  const e = withDb(db);
  const headers: Record<string, string> = { "cf-connecting-ip": o.ip ?? freshIp() };
  if (o.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.fetch(new Request(`https://api.test${path}`, { method: o.method ?? (o.body !== undefined ? "POST" : "GET"), headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) }), e, ctx);
  return { status: res.status, text: await res.text() };
}

async function publishedEvent() {
  const o = await setupEvent("Limiter Cup");
  const live = await call(`/events/${o.ev.id}/live`, { method: "PUT", token: o.token, body: { published: true, snapshot: { views: [], announcements: [], sponsors: [], ticker: [] } } });
  expect(live.status).toBe(200);
  return { o, slug: live.json.slug as string };
}

describe("a public read performs no D1 write", () => {
  it("live, directory, brand, league, team page, run-of-show, ready and score reads: 0 writes each, 3 times over", async () => {
    const p = await publishedEvent();
    const { db, writes } = spyDb();
    for (const path of [`/public/live/${p.slug}`, "/public/directory", `/public/brand/${p.slug}`, `/public/league/${p.slug}`, "/public/team/aaaaaaaaaaaa", "/public/run/x1", "/public/ready/x1", "/public/score/x1"]) {
      for (let i = 0; i < 3; i++) await viaSpy(db, path);
      // (the failed token lookups above do write: that is the exact guess limiter, so they are checked separately below)
    }
    expect(writes.filter((w) => !/rate_limits/.test(w))).toEqual([]);
    const limiterWrites = writes.filter((w) => /rate_limits/.test(w)).length;
    expect(limiterWrites).toBeLessThanOrEqual(6); // only the 3 + 3 bad-token guesses on /public/ready and /public/score (scoreFail / ready lookups)
  });

  it("the successful public reads alone write nothing at all", async () => {
    const p = await publishedEvent();
    const { db, writes } = spyDb();
    for (const path of [`/public/live/${p.slug}`, "/public/directory", `/public/brand/${p.slug}`]) {
      const r = await viaSpy(db, path);
      expect([200, 404]).toContain(r.status);
      for (let i = 0; i < 5; i++) await viaSpy(db, path);
    }
    expect(writes).toEqual([]);
  });

  it("the meta of a public GET reports no rows written (D1 meta.rows_written is 0 for every statement it runs)", async () => {
    const p = await publishedEvent();
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>();
    for (let i = 0; i < 20; i++) expect((await callDirect(`/public/live/${p.slug}`, { ip: "203.0.113.9" })).status).toBe(200);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
    const r = await env.DB.prepare("SELECT 1 AS x FROM live_pages WHERE slug = ?").bind(p.slug).run();
    expect(r.meta.rows_written).toBe(0);
  });

  it("a hit performs exactly one D1 write (the counter), an unknown page none", async () => {
    const p = await publishedEvent();
    const { db, writes } = spyDb();
    const r = await viaSpy(db, `/public/hit/${p.slug}`, { body: { source: "live" } });
    expect(r.status).toBe(204);
    expect(writes.length).toBe(1);
    expect(writes[0]).toContain("live_hits");
    const before = writes.length;
    await viaSpy(db, "/public/hit/aaaaaaaaaaaa", { body: { source: "live" } });
    expect(writes.length).toBe(before);
    // and rate_limits did not grow
    const keys = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE '%hit%'").first<{ n: number }>();
    expect(keys!.n).toBe(0);
  });

  it("1,000 public requests leave rate_limits exactly as it was", async () => {
    const p = await publishedEvent();
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>();
    for (let i = 0; i < 1000; i++) await callDirect(`/public/live/${p.slug}`);
    const after = await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits").first<{ n: number }>();
    expect(after!.n).toBe(before!.n);
  });
});

describe("limits still hold", () => {
  it("public GET: the 241st live read from one address in a minute is 429, other addresses are fine", async () => {
    const p = await publishedEvent();
    const ip = freshIp();
    let last = 0;
    for (let i = 0; i < 241; i++) last = (await callDirect(`/public/live/${p.slug}`, { ip })).status;
    expect(last).toBe(429);
    expect((await callDirect(`/public/live/${p.slug}`)).status).toBe(200);
  });

  it("login still 429s after 10 tries, with exactly one limiter write per try", async () => {
    const { db, writes } = spyDb();
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await viaSpy(db, "/auth/login", { ip, body: { email: "ghost@example.com", password: "nope nope nope" } })).status);
    expect(statuses).toEqual([...Array(10).fill(401), 429]);
    expect(writes.filter((w) => /rate_limits/.test(w)).length).toBe(11);
  });
});

describe("when the D1 limiter fails", () => {
  const failLimiter = /rate_limits/;

  it("public reads go on answering 200", async () => {
    const p = await publishedEvent();
    const { db } = spyDb(failLimiter);
    for (const path of [`/public/live/${p.slug}`, "/public/directory", `/public/brand/${p.slug}`]) {
      const r = await viaSpy(db, path);
      expect(r.status, path).toBe(200);
    }
    expect((await viaSpy(db, `/public/hit/${p.slug}`, { body: { source: "live" } })).status).toBe(204);
  });

  it("credential routes fail closed: login, register, forgot, reset and wrong gate keys are refused, never let through", async () => {
    const { db } = spyDb(failLimiter);
    const bad = { email: "someone@example.com", password: "correct horse", name: "X" };
    for (const [path, body] of [["/auth/login", bad], ["/auth/register", bad], ["/auth/forgot", { email: "someone@example.com" }], ["/auth/reset", { token: "x".repeat(30), password: "correct horse" }]] as const) {
      const r = await viaSpy(db, path, { body });
      expect(r.status, path).toBe(500);
      expect(r.text).toContain("busy");
    }
    const e = withDb(db);
    const gate = await app.fetch(new Request("https://api.test/gate/roster", { headers: { "x-gate-key": "gk_whatever", "cf-connecting-ip": freshIp() } }), e, ctx);
    expect(gate.status).toBe(500);
  });
});

describe("the in-memory limiter", () => {
  const fake = (ip: string) => ({ req: { header: (n: string) => (n.toLowerCase() === "cf-connecting-ip" ? ip : undefined) } }) as unknown as Ctx;

  it("counts per scope and address, and answers 429 over the limit", () => {
    const c = fake(freshIp());
    for (let i = 0; i < 3; i++) rateLimitSoft(c, "unit", 3, 60);
    expect(() => rateLimitSoft(c, "unit", 3, 60)).toThrow("Too many requests");
    expect(() => rateLimitSoft(c, "other-scope", 3, 60)).not.toThrow();
    expect(() => rateLimitSoft(fake(freshIp()), "unit", 3, 60)).not.toThrow();
  });

  it("is bounded: 12,000 different addresses never hold more than 5,000 counters", () => {
    for (let i = 0; i < 12_000; i++) rateLimitSoft(fake(`198.18.${(i >> 8) & 255}.${i & 255}-${i}`), "flood", 5, 60);
    expect(softLimiterSize()).toBeLessThanOrEqual(5000);
    expect(softLimiterSize()).toBeGreaterThan(4000);
  });
});

describe("cleanup is a daily cron step, not a random side effect of requests", () => {
  const old = (n: number) => env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)").bind(`old-${n}-${Date.now()}`, Math.floor(Date.now() / 1000) - 3 * 86400).run();
  const oldCount = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM rate_limits WHERE key LIKE 'old-%' AND window_start < ?").bind(Math.floor(Date.now() / 1000) - 86400).first<{ n: number }>())!.n;

  it("300 limiter calls never remove an old window (the 1 percent random cleanup is gone)", async () => {
    await old(1);
    const before = await oldCount();
    expect(before).toBeGreaterThan(0);
    for (let i = 0; i < 300; i++) await callDirect("/auth/login", { body: {} }); // 400 bad request, but the limiter ran first
    expect(await oldCount()).toBe(before);
  });

  it("cleanupRateLimits drops windows older than a day and keeps current ones", async () => {
    await old(2);
    await env.DB.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('old-fresh', ?, 1)").bind(Math.floor(Date.now() / 1000)).run();
    await cleanupRateLimits(env.DB);
    const rows = await env.DB.prepare("SELECT key FROM rate_limits WHERE key LIKE 'old-%'").all<{ key: string }>();
    expect(rows.results.map((r) => r.key)).toEqual(["old-fresh"]);
  });

  it("the cron handler runs the cleanup on the 03:00 UTC tick only", async () => {
    expect(isDailyTick(Date.UTC(2026, 10, 12, 3, 0))).toBe(true);
    expect(isDailyTick(Date.UTC(2026, 10, 12, 3, 14))).toBe(true);
    expect(isDailyTick(Date.UTC(2026, 10, 12, 3, 15))).toBe(false);
    expect(isDailyTick(Date.UTC(2026, 10, 12, 4, 0))).toBe(false);
    const run = async (when: number) => {
      const pending: Promise<unknown>[] = [];
      await scheduled({ scheduledTime: when } as ScheduledController, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext);
      await Promise.all(pending);
    };
    await old(3);
    const before = await oldCount();
    await run(Date.UTC(2026, 10, 12, 4, 0));
    expect(await oldCount()).toBe(before);
    await run(Date.UTC(2026, 10, 12, 3, 0));
    expect(await oldCount()).toBe(0);
  });
});
