import { beforeAll, describe, expect, it, vi } from "vitest";
import { call, uniq } from "../helpers";
import { addRegistration, api, db, nowSec, prodLikeOn, tournament, user } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
beforeAll(() => prodLikeOn("v3.directory"));

const ITEM_KEYS = ["city", "endsAt", "format", "game", "maxTeams", "pagePath", "registerUrl", "registration", "slug", "startsAt", "state", "status", "summary", "title", "venue"];
const dayIso = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const dir = (q = "") => api(`/public/tournament-directory${q}`);
const slugsOf = (r: { json: { items: { slug: string }[] } }) => r.json.items.map((x) => x.slug);

describe("public tournament directory", () => {
  it("lists only UPCOMING public tournaments, soonest first, with no private field", async () => {
    const later = await tournament({ startsAt: dayIso(20), endsAt: dayIso(21), city: "Pune" }, "registration_open");
    const sooner = await tournament({ startsAt: dayIso(3), endsAt: dayIso(3.2), city: "Mumbai", game: "valorant", format: "single_elimination" }, "published");
    const draft = await tournament({ startsAt: dayIso(4) });
    const done = await tournament({ startsAt: dayIso(5) }, "completed");
    const past = await tournament({ startsAt: dayIso(-5), endsAt: dayIso(-4) }, "registration_closed");
    const cancelled = await tournament({ startsAt: dayIso(6) }, "published");
    await api(`/v3/events/${cancelled.eventId}/tournament/status`, { token: cancelled.owner.token, body: { to: "cancelled" } });
    const r = await dir();
    expect(r.status, r.text).toBe(200);
    expect(r.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=300");
    const slugs = slugsOf(r);
    expect(slugs.indexOf(sooner.slug)).toBeGreaterThanOrEqual(0);
    expect(slugs.indexOf(sooner.slug)).toBeLessThan(slugs.indexOf(later.slug));
    for (const t of [draft, done, past, cancelled]) expect(slugs, t.slug).not.toContain(t.slug);
    const item = r.json.items.find((x: { slug: string }) => x.slug === later.slug);
    expect(Object.keys(item).sort()).toEqual(ITEM_KEYS);
    expect(item).toMatchObject({ registerUrl: null, pagePath: `/tournaments/${later.slug}/`, registration: { open: true, registered: 0, spotsLeft: 16 } });
    for (const needle of [later.eventId, later.owner.id, later.owner.email]) expect(r.text).not.toContain(needle);
    expect(Object.keys(r.json).sort()).toEqual(["cities", "games", "indexable", "items", "minForIndex", "total"]);
  });

  it("filters by game and by city (any letter case); facets list the cities and games", async () => {
    const t = await tournament({ startsAt: dayIso(7), city: "Nagpur", game: "free_fire" }, "registration_open");
    expect(slugsOf(await dir("?city=nagpur"))).toEqual([t.slug]);
    expect(slugsOf(await dir("?city=NAGPUR&game=free_fire"))).toEqual([t.slug]);
    expect(slugsOf(await dir("?city=Nagpur&game=bgmi"))).toEqual([]);
    const all = await dir();
    expect(all.json.cities).toEqual(expect.arrayContaining([{ city: "Nagpur", count: 1 }]));
    expect(all.json.games).toEqual(expect.arrayContaining([expect.objectContaining({ game: "free_fire" })]));
    expect((await dir("?game=chess")).status).toBe(400);
    expect((await dir("?city=%3Cb%3E")).status).toBe(400);
    expect((await dir("?limit=0")).status).toBe(400);
  });

  it("the Register button carries the sign-up link ONLY when the organiser opted in and registration and the form are open", async () => {
    const t = await tournament({ startsAt: dayIso(9), maxTeams: 2 }, "registration_open");
    const f = await call(`/events/${t.eventId}/registration`, { method: "PUT", token: t.owner.token, body: { open: true, acknowledge: true, teamSize: 1, subs: 0 } });
    expect(f.status, f.text).toBe(201);
    const item = async () => (await dir()).json.items.find((x: { slug: string }) => x.slug === t.slug);
    expect((await item()).registerUrl).toBeNull(); // not opted in
    const get0 = await api(`/v3/events/${t.eventId}/tournament/directory`, { token: t.owner.token });
    expect(get0.json).toMatchObject({ signupPublic: false, listed: true, registrationOpen: true, signupFormOpen: true, linkShown: false });
    const put = await api(`/v3/events/${t.eventId}/tournament/directory`, { method: "PUT", token: t.owner.token, body: { signupPublic: true } });
    expect(put.status, put.text).toBe(200);
    expect(put.json).toMatchObject({ signupPublic: true, linkShown: true });
    expect((await item()).registerUrl).toBe(`/register/?t=${encodeURIComponent(f.json.token)}`);
    // full: no link
    await addRegistration(t.eventId, "One");
    await addRegistration(t.eventId, "Two");
    expect((await item())).toMatchObject({ registerUrl: null, registration: { open: false, spotsLeft: 0 } });
    // a form that is closed: no link
    const t2 = await tournament({ startsAt: dayIso(10) }, "registration_open");
    await call(`/events/${t2.eventId}/registration`, { method: "PUT", token: t2.owner.token, body: { open: true, acknowledge: true, teamSize: 1, subs: 0 } });
    await api(`/v3/events/${t2.eventId}/tournament/directory`, { method: "PUT", token: t2.owner.token, body: { signupPublic: true } });
    const i2 = async () => (await dir()).json.items.find((x: { slug: string }) => x.slug === t2.slug);
    expect((await i2()).registerUrl).toMatch(/^\/register\/\?t=/);
    await call(`/events/${t2.eventId}/registration`, { method: "PUT", token: t2.owner.token, body: { open: false } });
    expect((await i2()).registerUrl).toBeNull();
    // registration closed on the tournament: no link
    await call(`/events/${t2.eventId}/registration`, { method: "PUT", token: t2.owner.token, body: { open: true } });
    await api(`/v3/events/${t2.eventId}/tournament/status`, { token: t2.owner.token, body: { to: "registration_closed" } });
    expect((await i2()).registerUrl).toBeNull();
  });

  it("organiser setting: owner or editor only, strangers get 404, bad bodies 400, needs the tournament page", async () => {
    const t = await tournament({ startsAt: dayIso(11) }, "published");
    expect((await api(`/v3/events/${t.eventId}/tournament/directory`)).status).toBe(401);
    expect((await api(`/v3/events/${t.eventId}/tournament/directory`, { token: (await user("Stranger")).token })).status).toBe(404);
    expect((await api(`/v3/events/${t.eventId}/tournament/directory`, { method: "PUT", token: t.owner.token, body: { signupPublic: "yes" } })).status).toBe(400);
    const ev = await call("/events", { token: t.owner.token, body: { name: `Bare ${uniq()}`, game: "BGMI", organiser: "x", date: "2026-12-30", venue: "x", emergency: "x", rules: "x", settings: {} } });
    expect((await api(`/v3/events/${ev.json.id}/tournament/directory`, { token: t.owner.token })).json.code).toBe("tournament_missing");
  });

  it("indexable only from 5 upcoming public tournaments (the AdSense thin-page rule)", async () => {
    await db.prepare("UPDATE tournaments SET status = 'cancelled'").run(); // this file's tournaments only (storage is per test file)
    const empty = await dir();
    expect(empty.json).toMatchObject({ items: [], total: 0, indexable: false, minForIndex: 5, cities: [], games: [] });
    for (let i = 0; i < 4; i++) await tournament({ startsAt: dayIso(12 + i) }, "published");
    expect((await dir()).json).toMatchObject({ total: 4, indexable: false });
    await tournament({ startsAt: dayIso(20) }, "registration_open");
    expect((await dir()).json).toMatchObject({ total: 5, indexable: true });
    // filters never change the total that decides indexing
    expect((await dir("?game=cs2")).json).toMatchObject({ items: [], total: 5, indexable: true });
    // a tournament that ended no longer counts
    await db.prepare("UPDATE tournaments SET starts_at = ?1, ends_at = ?1 WHERE status = 'registration_open'").bind(nowSec() - 3 * 86_400).run();
    expect((await dir()).json).toMatchObject({ total: 4, indexable: false });
  });

  it("kill.directory stops the public read; kill.public_writes stops the setting write", async () => {
    const t = await tournament({ startsAt: dayIso(13) }, "published");
    await prodLikeOn("v3.directory", "kill.directory");
    expect((await dir()).status).toBe(503);
    await prodLikeOn("v3.directory", "kill.public_writes");
    expect((await api(`/v3/events/${t.eventId}/tournament/directory`, { method: "PUT", token: t.owner.token, body: { signupPublic: true } })).status).toBe(503);
    await prodLikeOn("v3.directory");
  });
});
