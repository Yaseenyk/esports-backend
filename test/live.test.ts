import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { sha256 } from "../src/crypto";
import { call, freshIp, newEvent, newUser, pngDataUrl, setupEvent } from "./helpers";
import { callDirect } from "./golden/direct";

vi.setConfig({ testTimeout: 120_000 });

const table = { v: "table", d: { title: "Standings", rows: [["Alpha", 10]] } };
const snap = (over: Record<string, unknown> = {}) => ({
  views: [{ kind: "standings", payload: table }],
  announcements: [{ text: "Finals at 6 pm", at: "2026-12-01T12:00:00.000Z" }],
  sponsors: [{ name: "Acme", logo: pngDataUrl() }],
  ticker: ["Welcome", "Good luck"],
  ...over,
});
const put = (id: string, token: string, body: unknown) => call(`/events/${id}/live`, { method: "PUT", token, body });
const get = (id: string, token: string) => call(`/events/${id}/live`, { token });

async function members() {
  const o = await setupEvent("Live Cup");
  const editor = await newUser("Ed");
  const viewer = await newUser("Vi");
  const stranger = await newUser("Str");
  expect((await call(`/events/${o.ev.id}/members`, { token: o.token, body: { email: editor.email, role: "editor" } })).status).toBe(201);
  expect((await call(`/events/${o.ev.id}/members`, { token: o.token, body: { email: viewer.email, role: "viewer" } })).status).toBe(201);
  return { o, id: o.ev.id, editor, viewer, stranger };
}

describe("live page, owner side", () => {
  it("is empty before first use", async () => {
    const o = await setupEvent();
    const r = await get(o.ev.id, o.token);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ slug: null, published: false, snapshot: null, updatedAt: null });
  });

  it("owner and editor can PUT and GET; viewer can GET but not PUT; stranger 404; anonymous 401", async () => {
    const w = await members();
    const a = await put(w.id, w.o.token, { published: true, snapshot: snap() });
    expect(a.status).toBe(200);
    expect(a.json.published).toBe(true);
    expect(a.json.snapshot.ticker).toEqual(["Welcome", "Good luck"]);
    expect(a.json.updatedAt).toMatch(/^\d{4}-/);
    const b = await put(w.id, w.editor.token, { snapshot: snap({ ticker: ["From editor"] }) });
    expect(b.status).toBe(200);
    expect(b.json.published).toBe(true); // omitted part is kept
    expect((await get(w.id, w.editor.token)).json.snapshot.ticker).toEqual(["From editor"]);
    const v = await get(w.id, w.viewer.token);
    expect(v.status).toBe(200);
    expect(v.json.slug).toBe(a.json.slug);
    expect((await put(w.id, w.viewer.token, { published: false })).status).toBe(403);
    expect((await get(w.id, w.o.token)).json.published).toBe(true);
    expect((await get(w.id, w.stranger.token)).status).toBe(404);
    expect((await put(w.id, w.stranger.token, { published: true })).status).toBe(404);
    expect((await call(`/events/${w.id}/live`)).status).toBe(401);
    expect((await call(`/events/${w.id}/live`, { method: "PUT", body: {} })).status).toBe(401);
  });

  it("slug is 12 lowercase base32 characters, random per event and stable across updates", async () => {
    const o = await setupEvent();
    const first = (await put(o.ev.id, o.token, { snapshot: snap() })).json.slug as string;
    expect(first).toMatch(/^[a-z2-7]{12}$/);
    for (let i = 0; i < 3; i++) expect((await put(o.ev.id, o.token, { published: i % 2 === 0, snapshot: snap({ ticker: [`t${i}`] }) })).json.slug).toBe(first);
    const other = await newEvent(o.token, "Second");
    const second = (await put(other.id, o.token, {})).json.slug as string;
    expect(second).toMatch(/^[a-z2-7]{12}$/);
    expect(second).not.toBe(first);
    expect((await get(o.ev.id, o.token)).json.slug).toBe(first);
  });

  it("a snapshot replaces the previous one whole", async () => {
    const o = await setupEvent();
    await put(o.ev.id, o.token, { snapshot: snap() });
    const r = await put(o.ev.id, o.token, { snapshot: { views: [], announcements: [], sponsors: [], ticker: [] } });
    expect(r.json.snapshot).toEqual({ views: [], announcements: [], sponsors: [], ticker: [] });
  });
});

describe("live page, validation", () => {
  const cases: [string, unknown][] = [
    ["snapshot not an object", "x"],
    ["snapshot array", []],
    ["views not an array", snap({ views: "x" })],
    ["six views", snap({ views: ["standings", "league", "schedule", "bracket", "countdown", "standings"].map((kind) => ({ kind, payload: table })) })],
    ["unknown kind", snap({ views: [{ kind: "evil", payload: table }] })],
    ["duplicate kind", snap({ views: [{ kind: "standings", payload: table }, { kind: "standings", payload: table }] })],
    ["payload not an object", snap({ views: [{ kind: "standings", payload: "x" }] })],
    ["payload v not allowed", snap({ views: [{ kind: "standings", payload: { v: "script", d: {} } }] })],
    ["payload v missing", snap({ views: [{ kind: "standings", payload: { d: {} } }] })],
    ["payload d not an object", snap({ views: [{ kind: "standings", payload: { v: "table", d: [] } }] })],
    ["payload x not an object", snap({ views: [{ kind: "standings", payload: { v: "table", d: {}, x: 5 } }] })],
    ["eleven announcements", snap({ announcements: Array.from({ length: 11 }, () => ({ text: "a", at: "2026-12-01T12:00:00Z" })) })],
    ["announcement too long", snap({ announcements: [{ text: "a".repeat(141), at: "2026-12-01T12:00:00Z" }] })],
    ["announcement bad time", snap({ announcements: [{ text: "a", at: "yesterday" }] })],
    ["announcement impossible time", snap({ announcements: [{ text: "a", at: "2026-13-45T99:00:00Z" }] })],
    ["five sponsors", snap({ sponsors: Array.from({ length: 5 }, () => ({ name: "s" })) })],
    ["sponsor name too long", snap({ sponsors: [{ name: "n".repeat(41) }] })],
    ["sponsor logo not a data url", snap({ sponsors: [{ name: "s", logo: "https://evil.example/x.png" }] })],
    ["sponsor logo svg", snap({ sponsors: [{ name: "s", logo: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }] })],
    ["sponsor logo not base64", snap({ sponsors: [{ name: "s", logo: "data:image/png;base64,<script>" }] })],
    ["sponsor logo too long", snap({ sponsors: [{ name: "s", logo: `data:image/png;base64,${"A".repeat(60_000)}` }] })],
    ["six ticker lines", snap({ ticker: ["a", "b", "c", "d", "e", "f"] })],
    ["ticker line too long", snap({ ticker: ["x".repeat(81)] })],
    ["ticker line not a string", snap({ ticker: [5] })],
    ["over 250000 characters", snap({ views: [{ kind: "standings", payload: { v: "table", d: { blob: "z".repeat(251_000) } } }] })],
  ];
  it.each(cases)("rejects %s with 400 and a message", async (_n, snapshot) => {
    const o = await setupEvent();
    const r = await put(o.ev.id, o.token, { snapshot });
    expect(r.status).toBe(400);
    expect(typeof r.json.error).toBe("string");
    expect(r.json.error.length).toBeGreaterThan(5);
    expect((await get(o.ev.id, o.token)).json.snapshot).toBeNull(); // nothing was stored
  });

  it("rejects malformed bodies and a non-boolean published", async () => {
    const o = await setupEvent();
    expect((await call(`/events/${o.ev.id}/live`, { method: "PUT", token: o.token, raw: "{nope", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await put(o.ev.id, o.token, { published: "yes" })).status).toBe(400);
    expect((await call(`/events/${o.ev.id}/live`, { method: "PUT", token: o.token, raw: JSON.stringify([]), headers: { "content-type": "application/json" } })).status).toBe(400);
  });

  it("accepts values at the limits", async () => {
    const o = await setupEvent();
    const logo = `data:image/webp;base64,${"A".repeat(60_000 - "data:image/webp;base64,".length)}`;
    const r = await put(o.ev.id, o.token, {
      snapshot: {
        views: ["standings", "league", "schedule", "bracket", "countdown"].map((kind) => ({ kind, payload: { v: "table", d: {}, x: { ticker: ["a"] } } })),
        announcements: Array.from({ length: 10 }, () => ({ text: "a".repeat(140), at: "2026-12-01T12:00:00+05:30" })),
        sponsors: Array.from({ length: 4 }, () => ({ name: "n".repeat(40), logo })),
        ticker: Array.from({ length: 5 }, () => "t".repeat(80)),
      },
    });
    expect(r.status).toBe(200);
  });

  it("stores hostile strings as inert data, never interpreted", async () => {
    const o = await setupEvent();
    const evil = `<b>x</b>'); DROP TABLE live_pages;--`;
    const r = await put(o.ev.id, o.token, { published: true, snapshot: snap({ ticker: [evil], announcements: [{ text: evil, at: "2026-12-01T12:00:00Z" }], sponsors: [{ name: evil }] }) });
    expect(r.status).toBe(200);
    const pub = await call(`/public/live/${r.json.slug}`);
    expect(pub.json.snapshot.ticker).toEqual([evil]);
    expect(pub.json.snapshot.sponsors[0].name).toBe(evil);
    expect(pub.headers.get("content-type")).toContain("application/json");
    expect(pub.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await get(o.ev.id, o.token)).status).toBe(200); // table still there
  });
});

describe("live page, public side", () => {
  it("unpublished, unknown and malformed slugs all give the same 404", async () => {
    const o = await setupEvent();
    const made = (await put(o.ev.id, o.token, { snapshot: snap() })).json.slug as string;
    const responses = [
      await call(`/public/live/${made}`), // exists but unpublished
      await call("/public/live/aaaaaaaaaaaa"),
      await call("/public/live/short"),
      await call("/public/live/UPPERCASE123"),
      await call(`/public/live/${made}${made}`),
      await call("/public/live/a%20b"),
      await call("/public/live/..%2F..%2Fevents"),
    ];
    for (const r of responses) {
      expect(r.status).toBe(404);
      expect(r.json).toEqual({ error: "not_found" });
    }
    // un-publishing hides it again
    await put(o.ev.id, o.token, { published: true });
    expect((await call(`/public/live/${made}`)).status).toBe(200);
    await put(o.ev.id, o.token, { published: false });
    expect((await call(`/public/live/${made}`)).status).toBe(404);
  });

  it("published page returns 200 with cache headers and ETag; If-None-Match gives 304; a change gives a new ETag", async () => {
    const o = await setupEvent("Public Cup");
    const slug = (await put(o.ev.id, o.token, { published: true, snapshot: snap() })).json.slug as string;
    const a = await call(`/public/live/${slug}`);
    expect(a.status).toBe(200);
    expect(a.json.event).toEqual({ name: "Public Cup", date: "2026-12-01", venue: "Hall 1" });
    expect(a.json.snapshot.views[0].kind).toBe("standings");
    expect(a.json.updatedAt).toMatch(/^\d{4}-/);
    expect(a.headers.get("cache-control")).toBe("public, max-age=10");
    const etag = a.headers.get("etag")!;
    expect(etag).toMatch(/^"[^"]+"$/);
    const hit = await call(`/public/live/${slug}`, { headers: { "if-none-match": etag } });
    expect(hit.status).toBe(304);
    expect(hit.text).toBe("");
    expect(hit.headers.get("etag")).toBe(etag);
    expect((await call(`/public/live/${slug}`, { headers: { "if-none-match": '"other"' } })).status).toBe(200);
    expect((await call(`/public/live/${slug}`, { headers: { "if-none-match": `W/${etag}` } })).status).toBe(304);
    await put(o.ev.id, o.token, { snapshot: snap({ ticker: ["changed"] }) });
    const b = await call(`/public/live/${slug}`, { headers: { "if-none-match": etag } });
    expect(b.status).toBe(200);
    expect(b.headers.get("etag")).not.toBe(etag);
  });

  it("leaks nothing about people, passes, keys, registrations or the owner", async () => {
    const o = await setupEvent("Leak Cup");
    const key = (await call(`/events/${o.ev.id}/gate-keys`, { token: o.token, body: { label: "Door" } })).json;
    const form = (await call(`/events/${o.ev.id}/registration`, { method: "PUT", token: o.token, body: { acknowledge: true, title: "Reg", teamSize: 1, subs: 0 } })).json;
    const secret = (await env.DB.prepare("SELECT signing_secret FROM events WHERE id = ?").bind(o.ev.id).first<{ signing_secret: string }>())!.signing_secret;
    const slug = (await put(o.ev.id, o.token, { published: true, snapshot: snap() })).json.slug as string;
    const r = await call(`/public/live/${slug}`);
    expect(Object.keys(r.json).sort()).toEqual(["event", "pollMs", "snapshot", "updatedAt"]);
    expect(Object.keys(r.json.event).sort()).toEqual(["date", "name", "venue"]);
    for (const secretText of ["Asha", "Ravi", "Mira", "Alpha Wolves", "ALP-001", "EH1.", key.key, form.token, secret, o.id, o.email, "owner", "Be nice", o.ev.id, o.ev.key]) {
      expect(r.text, secretText).not.toContain(secretText);
    }
  });

  it("deleting the event removes the page", async () => {
    const o = await setupEvent();
    const slug = (await put(o.ev.id, o.token, { published: true, snapshot: snap() })).json.slug as string;
    expect((await call(`/public/live/${slug}`)).status).toBe(200);
    expect((await call(`/events/${o.ev.id}`, { method: "DELETE", token: o.token })).status).toBe(200);
    expect((await call(`/public/live/${slug}`)).status).toBe(404);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM live_pages WHERE event_id = ?").bind(o.ev.id).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});

describe("live page, rate limits", () => {
  it("PUT is limited to 60 per hour per user", async () => {
    const o = await setupEvent();
    let last = 0;
    for (let i = 0; i < 60; i++) last = (await put(o.ev.id, o.token, { published: false })).status;
    expect(last).toBe(200);
    expect((await put(o.ev.id, o.token, { published: false })).status).toBe(429);
    // another user is unaffected
    const other = await setupEvent();
    expect((await put(other.ev.id, other.token, { published: false })).status).toBe(200);
  });

  it("public GET is limited to 240 per minute per address", async () => {
    const ip = freshIp();
    // The limiter is in memory now (no D1 row to pre-seed), so make the 240 real requests; direct calls are fast enough to stay inside one minute.
    for (let i = 0; i < 239; i++) expect((await callDirect("/public/live/aaaaaaaaaaaa", { ip })).status).toBe(404);
    expect((await callDirect("/public/live/aaaaaaaaaaaa", { ip })).status).toBe(404); // 240th
    expect((await callDirect("/public/live/aaaaaaaaaaaa", { ip })).status).toBe(429); // 241st
    expect((await callDirect("/public/live/aaaaaaaaaaaa", { ip: freshIp() })).status).toBe(404);
  });
});

describe("public live pollMs hint (S2b, OD-D)", () => {
  it("is 120000 with no live match and 20000 while a match is live, in the body", async () => {
    const o = await setupEvent("Poll Cup");
    const p = await put(o.ev.id, o.token, { published: true, snapshot: snap() });
    const slug = p.json.slug as string;
    const a = await call(`/public/live/${slug}`);
    expect(a.json.pollMs).toBe(120_000);
    expect(a.headers.get("x-poll-ms")).toBeNull();
    await call(`/events/${o.ev.id}/matches`, { method: "PUT", token: o.token, body: { matches: [{ stage: "main", round: 1, slot: 1, a: "Alpha Wolves", b: "Beta Hawks", status: "live" }] } });
    expect((await call(`/public/live/${slug}`)).json.pollMs).toBe(20_000);
  });
});
