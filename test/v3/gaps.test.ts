import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SEO_WEEKLY_CAP, capAllowsRelease } from "../../src/v3/lib/seo-guard";
import { buildResumeStats, emptyStats } from "../../src/v3/adapters/stats-adapter";
import { runDiscordDrain } from "../../src/v3/services/discord-drain-service";
import { removeRoleKey, type DiscordConfig } from "../../src/v3/services/discord-service";
import { uniq } from "../helpers";
import { APP_ID, CATEGORY, FakeDiscord, GUILD, TOKEN } from "./fake-discord";
import { addBr, addMatch, addRegistration, allV3On, api, db, flagsOn, nowSec, tournament, user } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

async function claim(eventId: string, team: string, userId: string) {
  await db.prepare("INSERT INTO v3_team_captains (event_id, team_key, team_name, user_id) VALUES (?1, ?2, ?3, ?4)").bind(eventId, team.toLowerCase(), team, userId).run();
}
const hide = (eventId: string) =>
  db.prepare("INSERT INTO takedowns (target_type, target_id, state, reason_code, by_staff, at) VALUES ('event', ?1, 'hidden', 'spam', 'test-staff', ?2)").bind(eventId, new Date().toISOString()).run();
async function publicPlayer(slug: string) {
  const u = await user("Pub");
  await api("/v3/me/adult-confirmation", { token: u.token, body: { adult: true } });
  await api("/v3/me/resume-consent", { token: u.token, body: { consent: true } });
  const r = await api("/v3/me/profile", { method: "PUT", token: u.token, body: { slug, handle: "RaviIGL", visibility: "public" } });
  expect(r.status, r.text).toBe(200);
  return u;
}

describe("1. resume stats come from verified results only", () => {
  beforeEach(allV3On);

  it("pure: wins, losses, draws, battle royale numbers and byGame, with a dispute correction applied", () => {
    const m = (id: string, side: "a" | "b", winner: string | null) => ({ event_id: "e1", id, game: "bgmi", side, stage: "main", score_a: 1, score_b: 0, winner });
    const s = buildResumeStats(
      [m("m1", "a", "a"), m("m2", "a", "b"), m("m3", "b", "draw"), m("m4", "a", null)],
      [{ event_id: "e1", game: "bgmi", match_no: 1, team: "Alpha", placement: 1, kills: 8 }, { event_id: "e1", game: "bgmi", match_no: 2, team: "Alpha", placement: 4, kills: 5 }],
      [{ match_ref: "match:m2", old_value: "{}", new_value: JSON.stringify({ scoreA: 2, scoreB: 1, winner: "a" }), created_at: 1 }],
    );
    expect(s.matches).toEqual({ played: 3, wins: 2, losses: 0, draws: 1 }); // m4 has no winner: not counted; m2 corrected to a win
    expect(s.battleRoyale).toEqual({ matches: 2, wins: 1, kills: 13, bestPlacement: 1, averagePlacement: 2.5 });
    expect(s.tournaments).toBe(1);
    expect(s.byGame).toEqual([{ game: "bgmi", tournaments: 1, matchesPlayed: 3, matchWins: 2, brMatches: 2, brWins: 1, kills: 13 }]);
    expect(emptyStats()).toMatchObject({ source: "verified_results", tournaments: 0, byGame: [] });
  });

  it("a captain's public resume shows numbers from the results rows; typed numbers are ignored; private fields stay hidden", async () => {
    const t = await tournament({}, "live");
    await addRegistration(t.eventId, "Alpha Wolves");
    await addRegistration(t.eventId, "Beta Hawks");
    await addMatch(t.eventId, "Alpha Wolves", "Beta Hawks", { winner: "a" });
    await addMatch(t.eventId, "Beta Hawks", "Alpha Wolves", { winner: "a" }); // Alpha is side b: a loss
    await addMatch(t.eventId, "Alpha Wolves", "Beta Hawks", { status: "live", winner: "a" }); // not finished: not verified
    await addBr(t.eventId, 1, "Alpha Wolves", 1, 9);
    await addBr(t.eventId, 2, "alpha wolves", 3, 4); // case-insensitive team match
    await addBr(t.eventId, 1, "Beta Hawks", 2, 7); // someone else's row
    const slug = `p-${uniq()}`.toLowerCase();
    const u = await publicPlayer(slug);
    // nothing captained yet: zeros
    expect((await api(`/public/players/${slug}`)).json.stats).toMatchObject({ source: "verified_results", tournaments: 0, matches: { played: 0 } });
    await claim(t.eventId, "Alpha Wolves", u.id);

    // the player tries to type numbers: unknown fields are ignored, nothing is stored
    const put = await api("/v3/me/profile", { method: "PUT", token: u.token, body: { stats: { tournaments: 999 }, wins: 999, bio: "hi" } });
    expect(put.status).toBe(200);

    const r = await api(`/public/players/${slug}`);
    expect(r.status).toBe(200);
    expect(r.json.stats).toEqual({
      source: "verified_results", basis: "team_captain", tournaments: 1,
      matches: { played: 2, wins: 1, losses: 1, draws: 0 },
      battleRoyale: { matches: 2, wins: 1, kills: 13, bestPlacement: 1, averagePlacement: 2 },
      byGame: [{ game: "bgmi", tournaments: 1, matchesPlayed: 2, matchWins: 1, brMatches: 2, brWins: 1, kills: 13 }],
    });
    // public payload: explicit keys, no ids, emails, consent timestamps, team or event names
    expect(Object.keys(r.json).sort()).toEqual(["bio", "city", "games", "handle", "languages", "slug", "state", "stats", "updatedAt"]);
    expect(r.text).not.toMatch(new RegExp(`${u.id}|${t.eventId}|Alpha Wolves|Beta Hawks|${u.email}|adultConfirmedAt|resumeConsentAt`));
    // the owner sees the same numbers
    expect((await api("/v3/me/profile", { token: u.token })).json.profile.stats).toEqual(r.json.stats);
  });

  it("an unapproved team, a draft tournament and a hidden event add nothing", async () => {
    const slug = `p-${uniq()}`.toLowerCase();
    const u = await publicPlayer(slug);
    const pending = await tournament({}, "live");
    await addRegistration(pending.eventId, "Pending Team", "pending");
    await addMatch(pending.eventId, "Pending Team", "Other", { winner: "a" });
    await claim(pending.eventId, "Pending Team", u.id);
    const draft = await tournament({});
    await addRegistration(draft.eventId, "Draft Team");
    await addBr(draft.eventId, 1, "Draft Team", 1, 5);
    await claim(draft.eventId, "Draft Team", u.id);
    const hidden = await tournament({}, "live");
    await addRegistration(hidden.eventId, "Hidden Team");
    await addBr(hidden.eventId, 1, "Hidden Team", 1, 5);
    await claim(hidden.eventId, "Hidden Team", u.id);
    await hide(hidden.eventId);
    const stats = (await api(`/public/players/${slug}`)).json.stats;
    expect(stats.matches.played).toBe(0);
    expect(stats.battleRoyale.matches).toBe(0);
  });

  it("a private profile is still a 404", async () => {
    const u = await user("Priv");
    await api("/v3/me/profile", { method: "PUT", token: u.token, body: { slug: `pv-${uniq()}`.toLowerCase(), handle: "Hidden" } });
    const slug = (await api("/v3/me/profile", { token: u.token })).json.profile.slug;
    expect((await api(`/public/players/${slug}`)).status).toBe(404);
  });
});

describe("2. seoReadyAt and the weekly cap", () => {
  beforeEach(async () => {
    await allV3On();
    await db.prepare("UPDATE tournaments SET seo_ready_at = NULL, seo_ready = 0").run();
  });

  it("pure: the cap only gates a first release", () => {
    expect(SEO_WEEKLY_CAP).toBe(10);
    expect(capAllowsRelease({ alreadyReleased: false, releasedInWindow: 9 })).toBe(true);
    expect(capAllowsRelease({ alreadyReleased: false, releasedInWindow: 10 })).toBe(false);
    expect(capAllowsRelease({ alreadyReleased: true, releasedInWindow: 99 })).toBe(true);
  });

  it("the first release stamps seo_ready_at; page number 11 within a week is held with weekly_cap; it releases when the window moves; released pages are never capped again", async () => {
    const first = await tournament({}, "registration_open");
    const g = await api(`/v3/events/${first.eventId}/tournament`, { token: first.owner.token });
    expect([g.json.seoReady, g.json.seoFailures]).toEqual([true, []]);
    expect(g.json.seoReadyAt).toMatch(/^20/);
    const stamp = (await db.prepare("SELECT seo_ready_at FROM tournaments WHERE id = ?1").bind(first.id).first<{ seo_ready_at: number }>())!.seo_ready_at;
    // editing a released page keeps its first release date
    await api(`/v3/events/${first.eventId}/tournament`, { method: "PUT", token: first.owner.token, body: { rules: "Updated rules." } });
    expect((await db.prepare("SELECT seo_ready_at FROM tournaments WHERE id = ?1").bind(first.id).first<{ seo_ready_at: number }>())!.seo_ready_at).toBe(stamp);

    for (let i = 1; i < SEO_WEEKLY_CAP; i++) {
      const t = await tournament({}, "registration_open");
      expect((await api(`/v3/events/${t.eventId}/tournament`, { token: t.owner.token })).json.seoReady, `page ${i + 1}`).toBe(true);
    }
    const held = await tournament({}, "registration_open");
    const h = await api(`/v3/events/${held.eventId}/tournament`, { token: held.owner.token });
    expect([h.json.seoReady, h.json.seoFailures, h.json.seoReadyAt]).toEqual([false, ["weekly_cap"], null]);
    const hp = await api(`/public/tournaments/${held.slug}`);
    expect(hp.json.tournament.seoReady).toBe(false); // the public page agrees
    expect((await api("/public/tournaments?limit=50")).json.items.find((x: { slug: string }) => x.slug === held.slug).seoReady).toBe(false);

    // an already released page stays ready on edit even while the cap is full
    const edit = await api(`/v3/events/${first.eventId}/tournament`, { method: "PUT", token: first.owner.token, body: { rules: "More rules." } });
    expect(edit.json.seoReady).toBe(true);

    // the oldest release leaves the 7-day window: the held page can go out on its next edit
    await db.prepare("UPDATE tournaments SET seo_ready_at = ?2 WHERE id = ?1").bind(first.id, nowSec() - 8 * 86_400).run();
    const again = await api(`/v3/events/${held.eventId}/tournament`, { method: "PUT", token: held.owner.token, body: { rules: "Now allowed." } });
    expect([again.json.seoReady, again.json.seoFailures]).toEqual([true, []]);
    expect(again.json.seoReadyAt).toMatch(/^20/);
  });

  it("backward compatible: a row that was seo_ready before the column existed (no date) stays ready and is not capped", async () => {
    const t = await tournament({}, "registration_open");
    await db.prepare("UPDATE tournaments SET seo_ready = 1, seo_ready_at = NULL WHERE id = ?1").bind(t.id).run();
    const filler = nowSec();
    for (let i = 0; i < SEO_WEEKLY_CAP; i++) {
      const o = await tournament({});
      await db.prepare("UPDATE tournaments SET seo_ready_at = ?2 WHERE id = ?1").bind(o.id, filler).run();
    }
    const e = await api(`/v3/events/${t.eventId}/tournament`, { method: "PUT", token: t.owner.token, body: { rules: "Same page, edited." } });
    expect(e.json.seoReady).toBe(true);
    expect((await api(`/public/tournaments/${t.slug}`)).json.tournament.seoReady).toBe(true);
  });
});

describe("3. unlinking Discord takes the team role back", () => {
  let fake: FakeDiscord;
  const cfg = (): DiscordConfig => ({ token: TOKEN, appId: APP_ID, publicKey: "ab".repeat(32), appUrl: "https://esports.test", fetch: fake.fetch as typeof fetch });
  const jobs = async () => (await db.prepare("SELECT kind, status, payload, idempotency_key, guild_id FROM discord_outbox ORDER BY created_at, id").all<{ kind: string; status: string; payload: string; idempotency_key: string; guild_id: string }>()).results;
  const removals = async () => (await jobs()).filter((j) => j.idempotency_key.startsWith("remove_team_role:"));
  const DISCORD = "500000000000000001";

  async function world() {
    fake = new FakeDiscord();
    await flagsOn("v3.tournaments", "v3.discord");
    await db.prepare("DELETE FROM discord_outbox").run();
    await db.prepare("DELETE FROM discord_guilds").run();
    await db.prepare("UPDATE users SET discord_user_id = NULL WHERE discord_user_id = ?1").bind(DISCORD).run();
    const t = await tournament({}, "live");
    await db.prepare("INSERT INTO discord_guilds (guild_id, installed_by_user_id, permissions_ok) VALUES (?1, ?2, 1)").bind(GUILD, t.owner.id).run();
    await db.prepare("UPDATE tournaments SET discord_guild_id = ?2, discord_category_id = ?3 WHERE id = ?1").bind(t.id, GUILD, CATEGORY).run();
    const reg = await addRegistration(t.eventId, "Alpha Wolves");
    const cap = await user("Cap");
    await claim(t.eventId, "Alpha Wolves", cap.id);
    await db.prepare("UPDATE users SET discord_user_id = ?2 WHERE id = ?1").bind(cap.id, DISCORD).run();
    await api(`/v3/events/${t.eventId}/discord/sync`, { method: "POST", token: t.owner.token, body: {}, env: { ...env, DISCORD_BOT_TOKEN: TOKEN, DISCORD_APP_ID: APP_ID } as typeof env });
    for (let i = 0; i < 3; i++) await runDiscordDrain(db, cfg()); // channel + role created, role given to the linked captain
    return { t, reg, cap };
  }

  it("queues one removal job per role with a deterministic key, the drain calls DELETE once, the Discord id is scrubbed afterwards", async () => {
    const { reg, cap } = await world();
    expect(fake.of("PUT", /\/members\/500000000000000001\/roles\//)).toHaveLength(1);
    const un = await api("/v3/discord/link", { method: "DELETE", token: cap.token });
    expect(un.json).toEqual({ linked: false });
    expect((await db.prepare("SELECT discord_user_id FROM users WHERE id = ?1").bind(cap.id).first<{ discord_user_id: string | null }>())!.discord_user_id).toBeNull();

    const q = await removals();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ kind: "assign_team_role", status: "pending", guild_id: GUILD });
    expect(JSON.parse(q[0]!.payload)).toEqual({ registrationId: reg, userId: cap.id, discordUserId: DISCORD, remove: true });
    expect(q[0]!.idempotency_key).toBe(removeRoleKey(reg, cap.id, DISCORD, Number(q[0]!.idempotency_key.split(":").pop())));

    // a second unlink has nothing to remove and queues nothing new
    await api("/v3/discord/link", { method: "DELETE", token: cap.token });
    expect(await removals()).toHaveLength(1);

    fake.calls.length = 0;
    const r = await runDiscordDrain(db, cfg());
    expect(r.done).toBe(1);
    const del = fake.of("DELETE", /\/guilds\/\d+\/members\/500000000000000001\/roles\/\d+$/);
    expect(del).toHaveLength(1);
    expect(del[0]!.auth).toBe(`Bot ${TOKEN}`);
    const done = (await removals())[0]!;
    expect(done.status).toBe("done");
    expect(done.payload).not.toContain(DISCORD);
    // draining again calls nothing
    fake.calls.length = 0;
    await runDiscordDrain(db, cfg());
    expect(fake.of("DELETE", /roles/)).toHaveLength(0);
  });

  it("the same removal queued twice is one job (idempotent key)", async () => {
    const { reg, cap } = await world();
    const { enqueue } = await import("../../src/v3/repositories/discord-repo");
    const at = nowSec();
    const j = () => ({ id: `j${uniq()}`, kind: "assign_team_role" as const, guildId: GUILD, payload: { registrationId: reg, userId: cap.id, discordUserId: DISCORD, remove: true }, key: removeRoleKey(reg, cap.id, DISCORD, at), runAfter: at });
    expect(await enqueue(db, [j()], at)).toBe(1);
    expect(await enqueue(db, [j()], at)).toBe(0);
  });

  it("a member who already left the server (404) is still a success, and a user with no linked Discord queues nothing", async () => {
    const { cap } = await world();
    fake.notInGuild.add(DISCORD);
    await api("/v3/discord/link", { method: "DELETE", token: cap.token });
    const r = await runDiscordDrain(db, cfg());
    expect([r.done, r.dead]).toEqual([1, 0]);
    const nobody = await user("Nobody");
    await db.prepare("DELETE FROM discord_outbox").run();
    expect((await api("/v3/discord/link", { method: "DELETE", token: nobody.token })).json).toEqual({ linked: false });
    expect(await jobs()).toHaveLength(0);
  });

  it("linking again later gives the role back (the assign key is no longer used up)", async () => {
    const { cap, reg } = await world();
    await api("/v3/discord/link", { method: "DELETE", token: cap.token });
    await runDiscordDrain(db, cfg());
    const { completeLink, createLinkCode } = await import("../../src/v3/services/discord-service");
    const code = (await createLinkCode(db, cap.id)).code;
    expect(await completeLink(db, DISCORD, code)).toBe("linked");
    fake.calls.length = 0;
    await runDiscordDrain(db, cfg());
    expect(fake.of("PUT", /\/members\/500000000000000001\/roles\//)).toHaveLength(1);
    expect(reg).toBeTruthy();
  });
});

describe("4. public colleges", () => {
  beforeEach(async () => {
    await flagsOn("v3.tournaments");
    await db.prepare("UPDATE tournaments SET seo_ready_at = NULL").run(); // the cap tests above filled the weekly window
  });

  async function org(over: { slug?: string | null; verified?: boolean; status?: string; kind?: string; name?: string } = {}) {
    const id = `org${uniq()}`;
    const slug = over.slug === undefined ? `college-${uniq()}`.toLowerCase() : over.slug;
    await db.prepare("INSERT INTO organisations (id, name, kind, status, created_at, slug, verified_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
      .bind(id, over.name ?? "Gokte College of Engineering", over.kind ?? "team", over.status ?? "active", new Date().toISOString(), slug, over.verified === false ? null : nowSec()).run();
    return { id, slug: slug as string };
  }
  async function eventOf(orgId: string, status?: string) {
    const t = await tournament({}, status);
    await db.prepare("UPDATE events SET org_id = ?2 WHERE id = ?1").bind(t.eventId, orgId).run();
    return t;
  }

  it("a verified organisation with a real tournament: exact public shape, no private field", async () => {
    const o = await org();
    const t = await eventOf(o.id, "registration_open");
    await eventOf(o.id); // a draft is not a real tournament and is not listed
    const r = await api(`/public/colleges/${o.slug}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(["indexable", "name", "slug", "tournaments"]);
    expect(r.json).toMatchObject({ slug: o.slug, name: "Gokte College of Engineering", indexable: true });
    expect(r.json.tournaments).toHaveLength(1);
    expect(r.json.tournaments[0].slug).toBe(t.slug);
    expect(Object.keys(r.json.tournaments[0]).sort()).toEqual(["city", "endsAt", "format", "game", "maxTeams", "publishedAt", "seoReady", "slug", "startsAt", "state", "status", "summary", "title", "venue"]);
    expect(r.text).not.toMatch(new RegExp(`${o.id}|${t.eventId}|${t.owner.id}|${t.owner.email}|verified`));
    expect(r.headers.get("etag")).toBeTruthy();
  });

  it("404 (same answer) for: unknown, unverified, no slug match, no real tournament, suspended, personal kind, hidden event, bad slug", async () => {
    const unknown = await api("/public/colleges/no-such-college");
    expect(unknown.status).toBe(404);
    const unverified = await org({ verified: false });
    await eventOf(unverified.id, "registration_open");
    const empty = await org();
    const draftOnly = await org();
    await eventOf(draftOnly.id);
    const suspended = await org({ status: "suspended" });
    await eventOf(suspended.id, "registration_open");
    const personal = await org({ kind: "personal" });
    await eventOf(personal.id, "registration_open");
    const hiddenOrg = await org();
    const ht = await eventOf(hiddenOrg.id, "registration_open");
    await hide(ht.eventId);
    for (const slug of [unverified.slug, empty.slug, draftOnly.slug, suspended.slug, personal.slug, hiddenOrg.slug, "A", "bad_slug!", "x".repeat(70)]) {
      const r = await api(`/public/colleges/${slug}`);
      expect(r.status, slug).toBe(404);
      expect(r.json, slug).toEqual(unknown.json);
    }
  });

  it("list: only colleges the detail endpoint would serve, counts, sorted, ETag; flag off is a 404", async () => {
    const good = await org({ slug: `aaa-${uniq()}`.toLowerCase(), name: "Alpha Institute" });
    await eventOf(good.id, "registration_open");
    await eventOf(good.id, "live");
    const unverified = await org({ verified: false });
    await eventOf(unverified.id, "registration_open");
    const empty = await org();
    const r = await api("/public/colleges");
    expect(r.status).toBe(200);
    const items = r.json.items as { slug: string; name: string; tournaments: number; indexable: boolean; lastStartsAt: string | null }[];
    const mine = items.find((x) => x.slug === good.slug)!;
    expect(Object.keys(mine).sort()).toEqual(["indexable", "lastStartsAt", "name", "slug", "tournaments"]);
    expect(mine).toMatchObject({ name: "Alpha Institute", tournaments: 2, indexable: true });
    expect(items.find((x) => x.slug === unverified.slug)).toBeUndefined();
    expect(items.find((x) => x.slug === empty.slug)).toBeUndefined();
    for (const it of items) expect((await api(`/public/colleges/${it.slug}`)).status, it.slug).toBe(200); // every listed slug resolves
    expect([...items.map((x) => x.slug)]).toEqual([...items.map((x) => x.slug)].sort());
    expect(r.text).not.toMatch(/org[a-z0-9]{6,}|verified/);
    await flagsOn();
    expect((await api("/public/colleges")).status).toBe(404);
    expect((await api(`/public/colleges/${good.slug}`)).status).toBe(404);
  });
});

