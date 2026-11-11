import { env } from "cloudflare:workers";
import { restoreDirectoryListing } from "../src/directory-admin";
import { describe, expect, it, vi } from "vitest";
import { call, freshIp, newUser, setupEvent } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

const day = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);
const good = (over: Record<string, unknown> = {}) => ({ listed: true, title: "Spring BGMI Cup", game: "BGMI", city: "Pune", mode: "in-person", startsOn: day(10), blurb: "Squads of four, prizes for the top three.", ...over });
const put = (id: string, token: string, body: unknown) => call(`/events/${id}/directory`, { method: "PUT", token, body });
const list = (q = "", headers: Record<string, string> = {}) => call(`/public/directory${q}`, { headers });

async function listed(over: Record<string, unknown> = {}) {
  const o = await setupEvent("Dir Cup");
  expect((await call(`/events/${o.ev.id}/registration`, { method: "PUT", token: o.token, body: { title: "Reg" } })).status).toBe(201);
  const r = await put(o.ev.id, o.token, good(over));
  expect(r.status).toBe(200);
  return o;
}

describe("directory, owner side", () => {
  it("needs a registration page before listing, and builds the link on the server", async () => {
    const o = await setupEvent("Dir Cup");
    expect((await put(o.ev.id, o.token, good())).status).toBe(409);
    const form = await call(`/events/${o.ev.id}/registration`, { method: "PUT", token: o.token, body: { title: "Reg" } });
    const r = await put(o.ev.id, o.token, good({ regLink: "https://evil.example/x" }));
    expect(r.status).toBe(200);
    const pub = await list("?game=BGMI");
    const mine = pub.json.entries.find((e: any) => e.id === o.ev.id);
    expect(mine.regLink).toBe(`https://esports.streamerosai.com/register/?t=${form.json.token}`);
  });

  it("GET gives defaults from the event; roles and strangers behave", async () => {
    const o = await setupEvent("Dir Cup");
    const viewer = await newUser("Vi");
    const stranger = await newUser("St");
    await call(`/events/${o.ev.id}/members`, { token: o.token, body: { email: viewer.email, role: "viewer" } });
    const g = await call(`/events/${o.ev.id}/directory`, { token: o.token });
    expect(g.status).toBe(200);
    expect(g.json.entry).toBeNull();
    expect(g.json.defaults.title).toBe("Dir Cup");
    expect(g.json.defaults.game).toBe("BGMI");
    expect((await call(`/events/${o.ev.id}/directory`, { token: viewer.token })).status).toBe(200);
    expect((await put(o.ev.id, viewer.token, { listed: false })).status).toBe(403);
    expect((await call(`/events/${o.ev.id}/directory`, { token: stranger.token })).status).toBe(404);
    expect((await call(`/events/${o.ev.id}/directory`)).status).toBe(401);
  });

  it("validates fields and rejects contact details with the plain message", async () => {
    const o = await listed();
    for (const blurb of ["Call 98765 43210 now", "mail me a@b.co", "see https://x.example", "join www.foo.bar", "visit foo.gg today", "+91 98765-43210"]) {
      const r = await put(o.ev.id, o.token, { blurb });
      expect(r.status, blurb).toBe(400);
      expect(r.json.error).toBe("Please do not put contact details here: players register through the link");
    }
    expect((await put(o.ev.id, o.token, { title: "x".repeat(81) })).status).toBe(400);
    expect((await put(o.ev.id, o.token, { mode: "teleport" })).status).toBe(400);
    expect((await put(o.ev.id, o.token, { startsOn: "2026-02-31" })).status).toBe(400);
    expect((await put(o.ev.id, o.token, { city: "" })).status).toBe(400); // listed in-person needs a city
    const ok = await put(o.ev.id, o.token, { blurb: "  Prize pool\u0000   on the day,\n 2026-12-01  " });
    expect(ok.json.entry.blurb).toBe("Prize pool on the day, 2026-12-01");
  });

  it("online events need no city; unlisting hides the entry", async () => {
    const o = await listed({ mode: "online", city: "" });
    expect((await list("?mode=online")).json.entries.some((e: any) => e.id === o.ev.id)).toBe(true);
    const r = await put(o.ev.id, o.token, { listed: false });
    expect(r.json.entry.listed).toBe(false);
    expect((await list("?mode=online")).json.entries.some((e: any) => e.id === o.ev.id)).toBe(false);
  });
});

describe("directory, public list", () => {
  it("lists only listed, current entries; no owner or person data; filters work", async () => {
    const a = await listed({ game: "Free Fire", city: "Goa" });
    const old = await listed({ game: "Free Fire", city: "Goa", startsOn: day(-3) });
    const gone = await listed({ game: "Free Fire", city: "Goa", startsOn: day(-9) });
    const res = await list("?game=free%20fire&city=GOA");
    expect(res.status).toBe(200);
    const ids = res.json.entries.map((e: any) => e.id);
    expect(ids).toContain(a.ev.id);
    expect(ids).toContain(old.ev.id);
    expect(ids).not.toContain(gone.ev.id);
    expect(res.json.entries.find((e: any) => e.id === old.ev.id).ended).toBe(true);
    expect(res.json.entries.find((e: any) => e.id === a.ev.id).ended).toBe(false);
    expect(ids.indexOf(a.ev.id)).toBeLessThan(ids.indexOf(old.ev.id)); // newest first
    expect(Object.keys(res.json.entries[0]).sort()).toEqual(["blurb", "city", "ended", "game", "id", "mode", "regLink", "startsOn", "title"]);
    expect(res.text).not.toMatch(/owner|email|@/i);
    expect((await list("?mode=online&game=Free%20Fire&city=Goa")).json.entries).toEqual([]);
    expect((await list("?mode=bogus")).status).toBe(400);
    expect((await list("?page=0")).status).toBe(400);
    expect((await list("?game=%3Cscript%3E")).status).toBe(400);
  });

  it("pages 20 at a time", async () => {
    const o = await listed({ game: "PageGame", city: "Pagetown" });
    const stamp = new Date().toISOString();
    const stmts = [];
    for (let i = 0; i < 24; i++) {
      stmts.push(env.DB.prepare("INSERT INTO directory_entries (event_id, listed, title, game, city, mode, starts_on, blurb, reg_link, updated_at) VALUES (?, 1, ?, 'PageGame', 'Pagetown', 'online', ?, '', 'https://esports.streamerosai.com/register/?t=x', ?)").bind(o.ev.id + "-" + i, `T${i}`, day(20), stamp));
    }
    const evs = [];
    for (let i = 0; i < 24; i++) evs.push(env.DB.prepare("INSERT INTO events (id, owner_id, slug, name, signing_secret, created_at, updated_at) VALUES (?, ?, ?, 'Bulk', 's', ?, ?)").bind(o.ev.id + "-" + i, o.id, `bulk-${o.ev.id}-${i}`, stamp, stamp));
    await env.DB.batch([...evs, ...stmts]);
    const p1 = await list("?game=PageGame");
    expect(p1.json.entries).toHaveLength(20);
    expect(p1.json.hasMore).toBe(true);
    const p2 = await list("?game=PageGame&page=2");
    expect(p2.json.entries).toHaveLength(5);
    expect(p2.json.hasMore).toBe(false);
  });

  it("sends an ETag and answers 304", async () => {
    const first = await list("?game=BGMI");
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const again = await list("?game=BGMI", { "if-none-match": etag });
    expect(again.status).toBe(304);
  });

  it("rate limits at 120 a minute", async () => {
    const ip = freshIp();
    let last = 200;
    for (let i = 0; i < 122; i++) last = (await call("/public/directory", { ip })).status;
    expect(last).toBe(429);
  });
});

describe("directory, reports", () => {
  const report = (id: string, ip = freshIp(), reason = "Looks fake") => call(`/public/directory/${id}/report`, { body: { reason }, ip });

  it("three different reporters hide an entry; an owner edit resolves the reports but the listing stays hidden until a person restores it", async () => {
    const o = await listed({ game: "RepGame" });
    const shown = async () => (await list("?game=RepGame")).json.entries.some((e: any) => e.id === o.ev.id);
    expect(await shown()).toBe(true);
    expect((await report(o.ev.id)).status).toBe(201);
    expect((await report(o.ev.id)).status).toBe(201);
    expect(await shown()).toBe(true);
    expect((await report(o.ev.id)).status).toBe(201);
    expect(await shown()).toBe(false);
    const g = await call(`/events/${o.ev.id}/directory`, { token: o.token });
    expect(g.json.reports).toBe(3);
    expect(g.json.hidden).toBe(true);
    const edit = await put(o.ev.id, o.token, { blurb: "Updated text" });
    expect(edit.json).toMatchObject({ reports: 0, hidden: true, held: true });
    expect(edit.json.heldNote).toContain("Contact us");
    expect(await shown()).toBe(false); // an edit alone no longer brings it back
    // the history is kept: three resolved reports, none open
    const rows = await env.DB.prepare("SELECT COUNT(*) AS n, SUM(resolved_at IS NOT NULL) AS done FROM directory_reports WHERE event_id = ?").bind(o.ev.id).first<{ n: number; done: number }>();
    expect(rows).toEqual({ n: 3, done: 3 });
    const g2 = await call(`/events/${o.ev.id}/directory`, { token: o.token });
    expect(g2.json).toMatchObject({ reports: 0, hidden: true, held: true });
    // relisting stays hidden too
    await put(o.ev.id, o.token, { listed: false });
    await put(o.ev.id, o.token, { listed: true });
    expect(await shown()).toBe(false);
    // a person restores it with the internal helper (no public route exists)
    expect(await restoreDirectoryListing(env.DB, o.ev.id)).toBe(true);
    expect(await shown()).toBe(true);
    expect((await call(`/events/${o.ev.id}/directory`, { token: o.token })).json).toMatchObject({ hidden: false, held: false });
    // after the restore, fresh reports count again from zero
    for (let i = 0; i < 2; i++) await report(o.ev.id);
    expect(await shown()).toBe(true);
    await report(o.ev.id);
    expect(await shown()).toBe(false);
  });

  it("an owner edit while the listing is NOT hidden resolves open reports without holding it", async () => {
    const o = await listed({ game: "RepGame3" });
    await report(o.ev.id);
    await report(o.ev.id);
    const edit = await put(o.ev.id, o.token, { blurb: "Fine" });
    expect(edit.json).toMatchObject({ hidden: false, held: false });
    expect((await list("?game=RepGame3")).json.entries).toHaveLength(1);
    await report(o.ev.id); // one open report only: two were resolved
    expect((await list("?game=RepGame3")).json.entries).toHaveLength(1);
  });

  it("one address counts once, and is limited to 5 an hour", async () => {
    const o = await listed({ game: "RepGame2" });
    const ip = freshIp();
    for (let i = 0; i < 5; i++) expect((await report(o.ev.id, ip)).status).toBe(201);
    expect((await report(o.ev.id, ip)).status).toBe(429);
    expect((await list("?game=RepGame2")).json.entries).toHaveLength(1); // still shown: one reporter
  });

  it("unknown or unlisted entries give 404", async () => {
    expect((await report("nope")).status).toBe(404);
    const o = await listed();
    await put(o.ev.id, o.token, { listed: false });
    expect((await report(o.ev.id)).status).toBe(404);
  });
});
