import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { call, newUser, setupEvent } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

async function published(publish = true) {
  const o = await setupEvent("Report Cup");
  const r = await call(`/events/${o.ev.id}/live`, { method: "PUT", token: o.token, body: { published: publish, snapshot: { views: [], announcements: [], sponsors: [{ name: "Acme" }], ticker: [] } } });
  return { o, id: o.ev.id as string, slug: r.json.slug as string };
}
const hit = (slug: string, body: unknown, ip?: string) => call(`/public/hit/${slug}`, { body, ip });
const report = (id: string, token: string, q = "") => call(`/events/${id}/sponsor-report${q}`, { token });
const iso = (offset = 0) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

describe("hit counter", () => {
  it("counts page loads by source and view, and answers 204", async () => {
    const p = await published();
    for (const b of [{ source: "live" }, { source: "overlay", view: "table" }, { source: "embed", view: "bracket" }, { source: "live", view: "" }]) {
      const r = await hit(p.slug, b);
      expect(r.status).toBe(204);
      expect(r.text).toBe("");
    }
    const r = await report(p.id, p.o.token);
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(4);
    expect(r.json.bySource).toEqual({ live: 2, overlay: 1, embed: 1 });
    expect(r.json.days.at(-1)).toEqual({ day: iso(), hits: 4 });
    expect(r.json.peak).toEqual({ day: iso(), hits: 4 });
    expect(r.json.byView).toContainEqual({ source: "overlay", view: "table", hits: 1 });
  });

  it("unknown, malformed and unpublished slugs change nothing and look identical to a counted hit", async () => {
    const p = await published(false);
    const counted = await published();
    const a = await hit(p.slug, { source: "live" });
    const b = await hit("aaaaaaaaaaaa", { source: "live" });
    const c = await hit("not-a-slug", { source: "live" });
    const d = await hit(counted.slug, { source: "live" });
    for (const r of [a, b, c, d]) { expect(r.status).toBe(204); expect(r.text).toBe(""); }
    expect([...a.headers.keys()].sort()).toEqual([...d.headers.keys()].sort());
    expect((await report(p.id, p.o.token)).json.total).toBe(0);
    expect((await report(counted.id, counted.o.token)).json.total).toBe(1);
  });

  it("every accepted call is one page load: there is no per-visitor de-duplication any more (nothing about the visitor is stored)", async () => {
    const p = await published();
    const ip = "198.51.100.7";
    for (const b of [{ source: "overlay", view: "table" }, { source: "overlay", view: "table" }, { source: "overlay", view: "schedule" }, { source: "embed", view: "table" }]) {
      expect((await hit(p.slug, b, ip)).status).toBe(204);
    }
    const r = await report(p.id, p.o.token);
    expect(r.json.total).toBe(4);
    expect(r.json.byView).toContainEqual({ source: "overlay", view: "table", hits: 2 });
  });

  it("is rate limited per address, in memory (60 a minute, so a flood cannot inflate the numbers much)", async () => {
    const p = await published();
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 20}`;
    let limited = 0;
    for (let i = 0; i < 125; i++) if ((await hit(p.slug, { source: "live", view: `v${i}` }, ip)).status === 429) limited++;
    expect(limited).toBeGreaterThanOrEqual(5); // 125 requests span at most two one-minute windows: at most 120 count
    expect((await report(p.id, p.o.token)).json.total).toBe(125 - limited);
    expect(125 - limited).toBeLessThanOrEqual(120);
  });

  it("validates the source and the view", async () => {
    const p = await published();
    for (const b of [{}, { source: "tv" }, { source: 1 }, { source: "live", view: "x".repeat(21) }, { source: "live", view: "Bad View!" }, { source: "live", view: 5 }]) {
      expect((await hit(p.slug, b)).status).toBe(400);
    }
    expect((await call(`/public/hit/${p.slug}`, { method: "POST", raw: "nope", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await report(p.id, p.o.token)).json.total).toBe(0);
  });

  it("stores nothing about visitors: the table has only counters", async () => {
    const cols = await env.DB.prepare("SELECT name FROM pragma_table_info('live_hits') ORDER BY cid").all<{ name: string }>();
    expect(cols.results.map((r) => r.name)).toEqual(["event_id", "day", "source", "view", "hits"]);
    const p = await published();
    await hit(p.slug, { source: "live" }, "203.0.113.50");
    const rows = await env.DB.prepare("SELECT * FROM live_hits WHERE event_id = ?").bind(p.id).all();
    expect(JSON.stringify(rows.results)).not.toContain("203.0.113.50");
  });
});

describe("sponsor report, organiser side", () => {
  it("owner, editor and viewer can read; stranger 404; anonymous 401", async () => {
    const p = await published();
    const editor = await newUser("Ed"), viewer = await newUser("Vi"), stranger = await newUser("Str");
    await call(`/events/${p.id}/members`, { token: p.o.token, body: { email: editor.email, role: "editor" } });
    await call(`/events/${p.id}/members`, { token: p.o.token, body: { email: viewer.email, role: "viewer" } });
    for (const t of [p.o.token, editor.token, viewer.token]) expect((await report(p.id, t)).status).toBe(200);
    expect((await report(p.id, stranger.token)).status).toBe(404);
    expect((await call(`/events/${p.id}/sponsor-report`)).status).toBe(401);
  });

  it("defaults to 30 days, honours from and to, and caps at 90 days", async () => {
    const p = await published();
    const d = await report(p.id, p.o.token);
    expect(d.json.days.length).toBe(30);
    expect(d.json.to).toBe(iso());
    expect(d.json.total).toBe(0);
    expect(d.json.peak).toBeNull();
    const r = await report(p.id, p.o.token, `?from=${iso(-6)}&to=${iso()}`);
    expect(r.json.days.length).toBe(7);
    expect((await report(p.id, p.o.token, `?from=${iso(-89)}&to=${iso()}`)).status).toBe(200);
    expect((await report(p.id, p.o.token, `?from=${iso(-90)}&to=${iso()}`)).status).toBe(400);
    expect((await report(p.id, p.o.token, `?from=${iso()}&to=${iso(-1)}`)).status).toBe(400);
    expect((await report(p.id, p.o.token, "?from=yesterday")).status).toBe(400);
    expect((await report(p.id, p.o.token, "?from=2026-02-31")).status).toBe(400);
  });

  it("only counts inside the period, and only for its own event", async () => {
    const p = await published(), other = await published();
    await hit(p.slug, { source: "live" });
    await env.DB.prepare("INSERT INTO live_hits (event_id, day, source, view, hits) VALUES (?, ?, 'live', '', 5)").bind(p.id, iso(-10)).run();
    expect((await report(p.id, p.o.token, `?from=${iso(-6)}&to=${iso()}`)).json.total).toBe(1);
    const all = await report(p.id, p.o.token);
    expect(all.json.total).toBe(6);
    expect(all.json.peak).toEqual({ day: iso(-10), hits: 5 });
    expect((await report(other.id, other.o.token)).json.total).toBe(0);
  });
});
