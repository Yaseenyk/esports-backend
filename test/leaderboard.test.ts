import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { call, newEvent, newUser, setupEvent, uniq } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

async function world() {
  const o = await setupEvent("League Cup");
  const editor = await newUser("Ed");
  const viewer = await newUser("Vi");
  const stranger = await newUser("Str");
  expect((await call(`/events/${o.ev.id}/members`, { token: o.token, body: { email: editor.email, role: "editor" } })).status).toBe(201);
  expect((await call(`/events/${o.ev.id}/members`, { token: o.token, body: { email: viewer.email, role: "viewer" } })).status).toBe(201);
  return { o, id: o.ev.id, editor, viewer, stranger };
}
const put = (id: string, token: string, body: unknown) => call(`/events/${id}/league`, { method: "PUT", token, body });
const get = (id: string, token: string) => call(`/events/${id}/league`, { token });
const pub = (slug: string, headers?: Record<string, string>) => call(`/public/league/${slug}`, { headers });

describe("league: owner side", () => {
  it("is empty before first use and creates nothing on GET", async () => {
    const o = await setupEvent();
    const r = await get(o.ev.id, o.token);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ slug: null, published: false, title: "", scale: [], perKill: 1, winPts: 3, drawPts: 1, lossPts: 0, days: [], updatedAt: null });
    expect((await get(o.ev.id, o.token)).json.slug).toBeNull();
  });

  it("owner and editor write, viewer reads, stranger 404, anonymous 401", async () => {
    const w = await world();
    const a = await put(w.id, w.o.token, { title: "Season 1", published: true, scale: [10, 6, 4], perKill: 1.5, winPts: 3, drawPts: 1, lossPts: 0, days: [{ label: "Day 1", fromMatch: 1, toMatch: 6, date: "2026-12-01" }] });
    expect(a.status).toBe(200);
    expect(a.json).toMatchObject({ title: "Season 1", published: true, scale: [10, 6, 4], perKill: 1.5, days: [{ label: "Day 1", fromMatch: 1, toMatch: 6, date: "2026-12-01" }] });
    const b = await put(w.id, w.editor.token, { perKill: 2 });
    expect(b.status).toBe(200);
    expect(b.json).toMatchObject({ title: "Season 1", published: true, scale: [10, 6, 4], perKill: 2 }); // omitted parts are kept
    const v = await get(w.id, w.viewer.token);
    expect(v.status).toBe(200);
    expect(v.json.slug).toBe(a.json.slug);
    expect((await put(w.id, w.viewer.token, { title: "x" })).status).toBe(403);
    expect((await get(w.id, w.stranger.token)).status).toBe(404);
    expect((await put(w.id, w.stranger.token, { title: "x" })).status).toBe(404);
    expect((await call(`/events/${w.id}/league`)).status).toBe(401);
    expect((await call(`/events/${w.id}/league`, { method: "PUT", body: {} })).status).toBe(401);
  });

  it("slug is 12 lowercase base32 characters, random per event and stable across updates", async () => {
    const o = await setupEvent();
    const first = (await put(o.ev.id, o.token, { title: "A" })).json.slug as string;
    expect(first).toMatch(/^[a-z2-7]{12}$/);
    for (let i = 0; i < 3; i++) expect((await put(o.ev.id, o.token, { published: i % 2 === 0 })).json.slug).toBe(first);
    const other = await newEvent(o.token, "Second");
    const second = (await put(other.id, o.token, {})).json.slug as string;
    expect(second).toMatch(/^[a-z2-7]{12}$/);
    expect(second).not.toBe(first);
  });

  it("rejects bad input with 400 and changes nothing", async () => {
    const o = await setupEvent();
    await put(o.ev.id, o.token, { title: "Keep", scale: [5] });
    const day = (over: Record<string, unknown> = {}) => ({ label: "Day 1", fromMatch: 1, toMatch: 4, ...over });
    const bads: unknown[] = [
      { published: "yes" }, { title: 5 }, { title: "x".repeat(81) },
      { scale: "10,6" }, { scale: [1, -1] }, { scale: ["a"] }, { scale: Array(101).fill(1) }, { scale: [1.234] },
      { perKill: -1 }, { perKill: 1001 }, { perKill: "1" }, { winPts: 1e9 }, { drawPts: null }, { lossPts: Number.NaN },
      { days: "x" }, { days: [1] }, { days: Array.from({ length: 32 }, (_, i) => day({ fromMatch: i * 2 + 1, toMatch: i * 2 + 2 })) },
      { days: [day({ label: "" })] }, { days: [day({ label: "x".repeat(41) })] }, { days: [day({ fromMatch: 0 })] }, { days: [day({ toMatch: 10000 })] },
      { days: [day({ fromMatch: 5, toMatch: 4 })] }, { days: [day({ fromMatch: 1.5 })] }, { days: [day(), day({ label: "Day 2", fromMatch: 4, toMatch: 8 })] },
      { days: [day({ fromMatch: 5, toMatch: 8 }), day({ label: "Day 2", fromMatch: 1, toMatch: 3 })] }, { days: [day({ date: "1 Dec" })] }, { days: [day({ date: "2026-13-45" })] },
    ];
    for (const b of bads) expect((await put(o.ev.id, o.token, b)).status, JSON.stringify(b)).toBe(400);
    expect((await call(`/events/${o.ev.id}/league`, { method: "PUT", token: o.token, raw: "{nope" })).status).toBe(400);
    expect((await call(`/events/${o.ev.id}/league`, { method: "PUT", token: o.token, raw: "[]", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await get(o.ev.id, o.token)).json).toMatchObject({ title: "Keep", scale: [5] });
  });

  it("trims text and accepts decimals, negative loss points and a day without a date", async () => {
    const o = await setupEvent();
    const r = await put(o.ev.id, o.token, { title: "  Spaced  ", drawPts: 0.5, lossPts: -1, days: [{ label: " Finals ", fromMatch: 1, toMatch: 2 }] });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ title: "Spaced", drawPts: 0.5, lossPts: -1, days: [{ label: "Finals", fromMatch: 1, toMatch: 2 }] });
  });
});

describe("league: public page data", () => {
  async function published() {
    const w = await world();
    await env.DB.prepare("DELETE FROM matches WHERE id LIKE 'lg-%'").run();
    const p = uniq();
    const m1 = `lg-${p}-1`, m2 = `lg-${p}-2`;
    expect((await call(`/events/${w.id}/matches`, { method: "PUT", token: w.o.token, body: { matches: [
      { id: m1, a: "Alpha", b: "Beta", status: "finished", scoreA: 2, scoreB: 1, startsAt: "2026-12-01T10:00:00Z" },
      { id: m2, a: "Gamma", b: "Delta" },
    ] } })).status).toBe(200);
    expect((await call(`/events/${w.id}/br-results`, { method: "PUT", token: w.o.token, body: { results: [{ matchNo: 1, team: "Alpha", placement: 1, kills: 7 }, { matchNo: 1, team: "Beta", placement: 2, kills: 3 }] } })).status).toBe(200);
    const s = await put(w.id, w.o.token, { published: true, title: "Autumn League", scale: [10, 6], perKill: 1 });
    return { w, slug: s.json.slug as string };
  }

  it("returns settings, public matches and battle royale rows, and nothing private", async () => {
    const { w, slug } = await published();
    const r = await pub(slug);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(["br", "event", "matches", "settings", "title", "updatedAt"]);
    expect(r.json.title).toBe("Autumn League");
    expect(r.json.event).toEqual({ name: "League Cup", date: "2026-12-01", venue: "Hall 1" });
    expect(r.json.settings).toEqual({ scale: [10, 6], perKill: 1, winPts: 3, drawPts: 1, lossPts: 0, days: [] });
    expect(r.json.matches).toHaveLength(2);
    expect(Object.keys(r.json.matches[0]).sort()).toEqual(["a", "b", "id", "round", "scoreA", "scoreB", "slot", "stage", "startsAt", "status"]);
    expect(r.json.br).toEqual([{ matchNo: 1, team: "Alpha", placement: 1, kills: 7 }, { matchNo: 1, team: "Beta", placement: 2, kills: 3 }]);
    for (const secret of [w.id, w.o.email, "Asha", "Ravi", "ALP-001", w.o.id, "emergency"]) expect(r.text, secret).not.toContain(secret);
    expect(r.headers.get("cache-control")).toBe("public, max-age=10");
  });

  it("falls back to the event name when the title is empty", async () => {
    const o = await setupEvent("Named Cup");
    const slug = (await put(o.ev.id, o.token, { published: true })).json.slug as string;
    const r = await pub(slug);
    expect(r.json.title).toBe("Named Cup");
    expect(r.json.matches).toEqual([]);
    expect(r.json.br).toEqual([]);
  });

  it("answers 304 for an unchanged page and a new ETag when a result changes", async () => {
    const { w, slug } = await published();
    const a = await pub(slug);
    const etag = a.headers.get("etag")!;
    expect(etag).toMatch(/^"[A-Za-z0-9+/=_-]+"$/);
    const again = await pub(slug, { "if-none-match": etag });
    expect(again.status).toBe(304);
    expect(again.text).toBe("");
    expect((await pub(slug, { "if-none-match": `W/${etag}` })).status).toBe(304);
    const mid = a.json.matches.find((m: any) => m.status !== "finished").id as string;
    expect((await call(`/events/${w.id}/matches/${mid}/result`, { method: "POST", token: w.o.token, body: { scoreA: 1, scoreB: 1 } })).status).toBe(200);
    const b = await pub(slug, { "if-none-match": etag });
    expect(b.status).toBe(200);
    expect(b.headers.get("etag")).not.toBe(etag);
  });

  it("unpublished, unknown and malformed links are the same 404", async () => {
    const { w, slug } = await published();
    expect((await put(w.id, w.o.token, { published: false })).status).toBe(200);
    const off = await pub(slug);
    const unknown = await pub("abcdefghijkl");
    const malformed = await pub("NOT-A-SLUG");
    for (const r of [off, unknown, malformed]) expect(r.status).toBe(404);
    expect(off.text).toBe(unknown.text);
    expect(off.text).toBe(malformed.text);
    expect((await put(w.id, w.o.token, { published: true })).status).toBe(200);
    expect((await pub(slug)).status).toBe(200);
  });

  it("is rate limited at 240 a minute per address", async () => {
    const ip = "10.250.1.1";
    // The limit counts per 60 second window, so keep going until it trips (a window boundary can fall in the middle of the loop).
    let tripped = 0;
    for (let i = 0; i < 600 && !tripped; i++) {
      const s = (await call("/public/league/abcdefghijkl", { ip })).status;
      if (s === 429) tripped = i + 1;
      else expect(s).toBe(404);
    }
    expect(tripped).toBeGreaterThan(200);
    expect(tripped).toBeLessThanOrEqual(600);
  });

  it("deleting the event removes its league settings", async () => {
    const o = await setupEvent();
    const slug = (await put(o.ev.id, o.token, { published: true })).json.slug as string;
    expect((await call(`/events/${o.ev.id}`, { method: "DELETE", token: o.token })).status).toBe(200);
    expect((await pub(slug)).status).toBe(404);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM league_settings WHERE slug = ?").bind(slug).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});
