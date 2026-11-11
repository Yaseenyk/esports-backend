import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { METRICS, METRIC_NAMES, TOOL_IDS, emitStmt, writeClientMetric } from "../src/metrics";
import { parseBeacon } from "../src/routes/track";
import { resetFlagsCache } from "../src/flags";
import { freshIp } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

const ORIGIN = "http://localhost:3000";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const GOOD = JSON.stringify({ v: 1, e: "tool_complete", d: "poster" });

/** The real bindings with a spy for TRACK (or none) and a DB that records every statement prepared. */
function setup(withSink = true) {
  const points: { blobs?: string[]; doubles?: number[]; indexes?: string[] }[] = [];
  const sql: string[] = [];
  const real = env.DB;
  const db = { prepare(s: string) { sql.push(s); return real.prepare(s); }, batch: (x: D1PreparedStatement[]) => real.batch(x) } as unknown as D1Database;
  const e = new Proxy(env as object, {
    get: (t, k, r) => (k === "DB" ? db : k === "TRACK" ? (withSink ? { writeDataPoint: (p: (typeof points)[number]) => { points.push(p); } } : undefined) : Reflect.get(t, k, r)),
  }) as typeof env;
  const post = async (body: BodyInit | null, h: Record<string, string> = {}, ip = freshIp()) => {
    const res = await app.fetch(new Request("https://api.test/public/t", { method: "POST", headers: { origin: ORIGIN, "content-type": "text/plain;charset=UTF-8", "cf-connecting-ip": ip, ...h }, body }), e, ctx);
    return { status: res.status, text: await res.text() };
  };
  const writes = () => sql.filter((s) => /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(s));
  return { points, sql, post, writes };
}

const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n;

describe("the ten-to-eight registry", () => {
  it("holds the PM's final list: eight events (report_filed and takedown cut), only tool_complete from the client", () => {
    expect([...METRIC_NAMES].sort()).toEqual(["club_created", "event_created", "invite_accepted", "live_published", "registration_opened", "signup_done", "team_registered", "tool_complete"]);
    expect(TOOL_IDS).toHaveLength(14);
    expect(METRICS.event_created).toEqual(["scratch", "duplicate"]);
    for (const n of METRIC_NAMES) expect(n.length).toBeLessThanOrEqual(24); // metrics_daily CHECK
  });
});

describe("emitStmt (server events: one upsert, 1 row written)", () => {
  it("counts per day/name/d1 with an UPSERT and nothing else", async () => {
    const day = Date.parse("2031-01-02T10:00:00Z");
    const b = await env.DB.batch([emitStmt(env.DB, "event_created", "duplicate", day), emitStmt(env.DB, "event_created", "duplicate", day), emitStmt(env.DB, "event_created", "bogus", day), emitStmt(env.DB, "signup_done", "", day)]);
    const r = await env.DB.prepare("SELECT name, d1, n FROM metrics_daily WHERE day = '2031-01-02' ORDER BY name, d1").all<{ name: string; d1: string; n: number }>();
    expect(r.results).toEqual([{ name: "event_created", d1: "", n: 1 }, { name: "event_created", d1: "duplicate", n: 2 }, { name: "signup_done", d1: "", n: 1 }]);
    const w = b[0]!.meta.rows_written;
    expect(w).toBe(1);
  });

  it("tool_complete is not a server event (the client path is Analytics Engine or dropped)", () => {
    expect(() => emitStmt(env.DB, "tool_complete" as never, "poster")).toThrow();
  });
});

describe("beacon parser", () => {
  it("accepts exactly {v:1,e:tool_complete,d:<tool id>}", () => {
    expect(parseBeacon(GOOD)).toEqual({ name: "tool_complete", d1: "poster" });
    for (const t of TOOL_IDS) expect(parseBeacon(JSON.stringify({ v: 1, e: "tool_complete", d: t }))).not.toBeNull();
  });
});

describe("POST /public/t", () => {
  it("a registered event reaches Analytics Engine, answers an empty 204, and writes no D1 row at all", async () => {
    const s = setup();
    const before = [await count("rate_limits"), await count("metrics_daily")];
    const r = await s.post(GOOD);
    expect(r).toEqual({ status: 204, text: "" });
    expect(s.points).toEqual([{ blobs: ["tool_complete", "poster"], doubles: [1], indexes: ["tool_complete"] }]);
    expect(s.writes()).toEqual([]);
    expect([await count("rate_limits"), await count("metrics_daily")]).toEqual(before);
  });

  it("no Analytics Engine binding: dropped, still 204, no D1 write", async () => {
    const s = setup(false);
    const before = [await count("rate_limits"), await count("metrics_daily")];
    expect((await s.post(GOOD)).status).toBe(204);
    expect(s.writes()).toEqual([]);
    expect([await count("rate_limits"), await count("metrics_daily")]).toEqual(before);
  });

  it("50 hostile payloads: always 204, nothing recorded, no D1 write, no rate_limits row", async () => {
    const s = setup();
    const big = "x".repeat(5000);
    const payloads: string[] = [
      "", " ", "null", "true", "0", "[]", "{}", "[[]]", '"tool_complete"', "not json", "{", "}{",
      JSON.stringify({ v: 1, e: "report_filed" }), JSON.stringify({ v: 1, e: "takedown", d: "x" }), JSON.stringify({ v: 1, e: "signup_done" }),
      JSON.stringify({ v: 1, e: "event_created", d: "scratch" }), JSON.stringify({ v: 1, e: "tool_complete" }), JSON.stringify({ v: 1, e: "tool_complete", d: "" }),
      JSON.stringify({ v: 1, e: "tool_complete", d: "nope" }), JSON.stringify({ v: 1, e: "tool_complete", d: "POSTER" }), JSON.stringify({ v: 1, e: "tool_complete", d: "poster " }),
      JSON.stringify({ v: 1, e: "tool_complete", d: ["poster"] }), JSON.stringify({ v: 1, e: "tool_complete", d: { a: 1 } }), JSON.stringify({ v: 1, e: "tool_complete", d: 5 }),
      JSON.stringify({ v: 2, e: "tool_complete", d: "poster" }), JSON.stringify({ v: "1", e: "tool_complete", d: "poster" }), JSON.stringify({ e: "tool_complete", d: "poster" }),
      JSON.stringify({ v: 1, e: "Tool_Complete", d: "poster" }), JSON.stringify({ v: 1, e: ["tool_complete"], d: "poster" }), JSON.stringify({ v: 1, e: "__proto__", d: "poster" }),
      JSON.stringify({ v: 1, e: "constructor", d: "poster" }), JSON.stringify({ v: 1, e: "toString" }),
      JSON.stringify({ v: 1, e: "tool_complete", d: "poster", user: "u-1" }), JSON.stringify({ v: 1, e: "tool_complete", d: "poster", email: "a@b.com" }),
      JSON.stringify({ v: 1, e: "tool_complete", d: "poster", ua: "Mozilla" }), JSON.stringify({ v: 1, e: "tool_complete", d: "poster", url: "https://x.test/?t=secret" }),
      JSON.stringify({ v: 1, e: "tool_complete", d: "poster", ts: Date.now() }), JSON.stringify({ v: 1, e: "tool_complete", d: "poster", __proto__: { x: 1 }, id: "1" }),
      JSON.stringify([{ v: 1, e: "tool_complete", d: "poster" }]), JSON.stringify([GOOD, GOOD]),
      JSON.stringify({ v: 1, e: "tool_complete", d: "poster" }) + JSON.stringify({ v: 1, e: "tool_complete", d: "poster" }),
      `${GOOD}\n${GOOD}`, `{"v":1,"e":"tool_complete","d":"poster","d":"x" , "pad":"${big}"}`, big, JSON.stringify({ v: 1, e: "tool_complete", d: big }),
      JSON.stringify({ v: 1, e: "tool_complete", d: "poster\u0000" }), JSON.stringify({ v: 1, e: "tool_complete", d: "poster​" }),
      "<script>alert(1)</script>", "' OR 1=1 --", "v=1&e=tool_complete&d=poster", JSON.stringify({ v: 1, e: "tool_complete", d: "poster'); DROP TABLE metrics_daily;--" }),
      JSON.stringify({ v: 1, e: "tool_complete", d: "../../etc/passwd" }),
    ];
    expect(payloads.length).toBeGreaterThanOrEqual(50);
    const before = [await count("rate_limits"), await count("metrics_daily")];
    for (const p of payloads) {
      const r = await s.post(p);
      expect(r, p.slice(0, 60)).toEqual({ status: 204, text: "" });
    }
    expect(s.points).toEqual([]);
    expect(s.writes()).toEqual([]);
    expect([await count("rate_limits"), await count("metrics_daily")]).toEqual(before);
  });

  it("Do Not Track and Global Privacy Control write nothing", async () => {
    const s = setup();
    expect((await s.post(GOOD, { dnt: "1" })).status).toBe(204);
    expect((await s.post(GOOD, { "sec-gpc": "1" })).status).toBe(204);
    expect(s.points).toEqual([]);
    expect((await s.post(GOOD, { dnt: "0" })).status).toBe(204); // DNT 0 is not an opt-out
    expect(s.points).toHaveLength(1);
  });

  it("Origin: missing or foreign writes nothing, still 204", async () => {
    const s = setup();
    for (const h of [{ origin: "https://evil.example" }, { origin: "null" }, { origin: "" }, { origin: "http://localhost:3000.evil.example" }]) expect((await s.post(GOOD, h)).status).toBe(204);
    const res = await app.fetch(new Request("https://api.test/public/t", { method: "POST", headers: { "cf-connecting-ip": freshIp() }, body: GOOD }), env, ctx);
    expect(res.status).toBe(204);
    expect(s.points).toEqual([]);
    expect((await s.post(GOOD, { origin: "https://esports.streamerosai.com" })).status).toBe(204);
    expect(s.points).toHaveLength(1);
  });

  it("flags kill.tracking and shed.tracking stop the writes", async () => {
    for (const key of ["kill.tracking", "shed.tracking"]) {
      await env.DB.prepare("INSERT OR REPLACE INTO flags (key, value, updated_by, updated_at) VALUES (?, 'true', 't', 't')").bind(key).run();
      resetFlagsCache(env.DB);
      try {
        const s = setup();
        expect((await s.post(GOOD)).status).toBe(204);
        expect(s.points).toEqual([]);
      } finally {
        await env.DB.prepare("DELETE FROM flags WHERE key = ?").bind(key).run();
        resetFlagsCache(env.DB);
      }
    }
    const s = setup();
    await s.post(GOOD);
    expect(s.points).toHaveLength(1);
  });

  it("over 200 bytes is dropped by declared length and by streamed length", async () => {
    const s = setup();
    const long = JSON.stringify({ v: 1, e: "tool_complete", d: "poster", pad: "y".repeat(300) });
    expect((await s.post(long)).status).toBe(204);
    expect((await s.post(new Blob([long]).stream() as unknown as BodyInit)).status).toBe(204);
    expect(s.points).toEqual([]);
  });

  it("uses only the in-isolate soft limiter: the 21st beacon in a minute from one address is dropped, with no rate_limits row", async () => {
    const s = setup();
    const ip = freshIp();
    const before = await count("rate_limits");
    for (let i = 0; i < 25; i++) expect((await s.post(GOOD, {}, ip)).status).toBe(204);
    expect(s.points).toHaveLength(20);
    expect(await count("rate_limits")).toBe(before);
    expect(s.writes()).toEqual([]);
  });

  it("writeClientMetric never throws and refuses non-client names", () => {
    expect(writeClientMetric({ writeDataPoint() { throw new Error("x"); } }, "tool_complete", "poster")).toBe(false);
    expect(writeClientMetric({ writeDataPoint() {} }, "signup_done", "")).toBe(false);
    expect(writeClientMetric(undefined, "tool_complete", "poster")).toBe(false);
  });
});
