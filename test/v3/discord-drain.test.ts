import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_CALLS, MAX_JOBS, QUERY_BUDGET, runDiscordDrain } from "../../src/v3/services/discord-drain-service";
import { onTournamentCompleted, type DiscordConfig } from "../../src/v3/services/discord-service";
import { uniq } from "../helpers";
import { APP_ID, CATEGORY, FakeDiscord, GUILD, TOKEN, forbidden, rateLimited, serverError } from "./fake-discord";
import { addRegistration, api, db, flagsOn, nowSec, tournament, user } from "./helpers";

vi.setConfig({ testTimeout: 30_000 }); // these tests make many requests; a loaded runner must not time them out
let fake: FakeDiscord;
const cfg = (over: Partial<DiscordConfig> = {}): DiscordConfig => ({ token: TOKEN, appId: APP_ID, publicKey: "ab".repeat(32), appUrl: "https://esports.test", fetch: fake.fetch as typeof fetch, ...over });
const drain = (o: Parameters<typeof runDiscordDrain>[2] = {}, c: DiscordConfig = cfg()) => runDiscordDrain(db, c, o);
const snow = () => `4${String(Date.now()).slice(-8)}${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`.slice(0, 18);

interface World { owner: { id: string; token: string }; eventId: string; id: string; slug: string }
async function world(): Promise<World> {
  await flagsOn("v3.tournaments", "v3.discord");
  await db.prepare("DELETE FROM discord_outbox").run();
  await db.prepare("DELETE FROM discord_guilds").run();
  const t = await tournament({}, "live");
  await db.prepare("INSERT INTO discord_guilds (guild_id, installed_by_user_id, permissions_ok) VALUES (?1, ?2, 1)").bind(GUILD, t.owner.id).run();
  await db.prepare("UPDATE tournaments SET discord_guild_id = ?2, discord_category_id = ?3 WHERE id = ?1").bind(t.id, GUILD, CATEGORY).run();
  return t;
}
const team = (t: World, name: string, status = "approved") => addRegistration(t.eventId, name, status);
const queue = async (t: World) => (await api(`/v3/events/${t.eventId}/discord/sync`, { method: "POST", token: t.owner.token, body: {}, env: { ...env, DISCORD_BOT_TOKEN: TOKEN, DISCORD_APP_ID: APP_ID } as typeof env })).json;
const jobsOf = async () => (await db.prepare("SELECT id, kind, status, attempts, run_after, last_error, idempotency_key FROM discord_outbox ORDER BY created_at, id").all<{ id: string; kind: string; status: string; attempts: number; run_after: number; last_error: string | null; idempotency_key: string }>()).results;
const statusCount = async (s: string, kind?: string) => (await jobsOf()).filter((j) => j.status === s && (!kind || j.kind === kind)).length;
async function captain(t: World, teamName: string, discordId: string | null, name = `Cap${uniq()}`) {
  const u = await user(name);
  await db.prepare("INSERT INTO v3_team_captains (event_id, team_key, team_name, user_id) VALUES (?1, ?2, ?3, ?4)").bind(t.eventId, teamName.toLowerCase(), teamName, u.id).run();
  if (discordId) await db.prepare("UPDATE users SET discord_user_id = ?2 WHERE id = ?1").bind(u.id, discordId).run();
  return { ...u, name };
}
const regRow = (id: string) => db.prepare("SELECT * FROM v3_registration_discord WHERE registration_id = ?1").bind(id).first<{ role_id: string | null; channel_id: string | null; intro_posted_at: number | null; archived_at: number | null }>();

beforeEach(() => { fake = new FakeDiscord(); });

describe("drain: refusals are clean no-ops", () => {
  it("no token (or no app id): nothing is called, jobs stay pending (not failed), no attempt is counted", async () => {
    const t = await world();
    await team(t, "Alpha Wolves");
    expect((await queue(t)).queued).toBe(1);
    for (const c of [cfg({ token: undefined }), cfg({ appId: undefined }), cfg({ token: "" })]) {
      const r = await drain({}, c);
      expect(r).toMatchObject({ ran: false, reason: "not_configured", jobs: 0, calls: 0 });
    }
    expect(fake.calls).toHaveLength(0);
    const j = await jobsOf();
    expect(j).toHaveLength(1);
    expect(j[0]).toMatchObject({ status: "pending", attempts: 0, last_error: null });
  });

  it("flag off: nothing is read from the Discord tables", async () => {
    const t = await world();
    await team(t, "Alpha Wolves");
    await queue(t);
    await flagsOn("v3.tournaments");
    const r = await drain();
    expect(r).toMatchObject({ ran: false, reason: "flag_off" });
    expect(r.queries).toBeLessThanOrEqual(1); // the flags read only
    expect(fake.calls).toHaveLength(0);
    expect(await statusCount("pending")).toBe(1);
  });

  it("jobs of a server whose permissions are not ok are left untouched", async () => {
    const t = await world();
    await team(t, "Alpha Wolves");
    await queue(t);
    await db.prepare("UPDATE discord_guilds SET permissions_ok = 0").run();
    expect(await drain()).toMatchObject({ ran: true, jobs: 0 });
    expect(await statusCount("pending")).toBe(1);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("drain: channel + role creation", () => {
  it("creates a private channel visible only to the team role and the bot, a role, assigns linked captains, and lists the ones who have not linked", async () => {
    const t = await world();
    const reg = await team(t, "Alpha Wolves");
    const linked = snow();
    await captain(t, "Alpha Wolves", linked, "Linked Lia");
    await captain(t, "Alpha Wolves", null, "Unlinked Uma");
    await queue(t);
    const r = await drain();
    expect(r).toMatchObject({ ran: true, jobs: 1, done: 1, dead: 0 });
    await drain(); // the assign job queued by the create job
    expect(await statusCount("done")).toBe(2);

    const role = fake.of("POST", /\/guilds\/\d+\/roles$/)[0]!;
    expect(role.body.permissions).toBe("0");
    const ch = fake.of("POST", /\/guilds\/\d+\/channels$/)[0]!;
    expect(ch.body).toMatchObject({ type: 0, parent_id: CATEGORY, name: "team-alpha-wolves" });
    const ow = ch.body.permission_overwrites as { id: string; type: number; allow: string; deny: string }[];
    expect(ow).toHaveLength(3);
    expect(ow[0]).toMatchObject({ id: GUILD, deny: String(1 << 10) }); // @everyone: cannot view
    const row = (await regRow(reg))!;
    expect(ow[1]).toMatchObject({ id: row.role_id, type: 0 }); // team role: view + send + history
    expect(BigInt(ow[1]!.allow) & ((1n << 10n) | (1n << 11n))).toBe((1n << 10n) | (1n << 11n));
    expect(ow[2]).toMatchObject({ id: APP_ID, type: 1 }); // the bot
    expect(row.channel_id).toMatch(/^6\d+$/);

    const assigns = fake.of("PUT", /\/members\/\d+\/roles\/\d+$/);
    expect(assigns).toHaveLength(1);
    expect(assigns[0]!.path).toContain(`/members/${linked}/roles/${row.role_id}`);
    const msg = fake.of("POST", /\/messages$/);
    expect(msg).toHaveLength(1);
    expect(msg[0]!.body.content).toContain("have not linked Discord");
    expect(msg[0]!.body.content).toContain("Unlinked Uma");
    expect(msg[0]!.body.content).not.toContain("Linked Lia");
    expect(msg[0]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(fake.calls.every((c) => c.auth === `Bot ${TOKEN}`)).toBe(true);
  });

  it("20 approved teams get exactly 20 channels and 20 roles, across several ticks, with a forced retry in the middle", async () => {
    const t = await world();
    const regs: string[] = [];
    for (let i = 0; i < 20; i++) regs.push(await team(t, `Team ${i}`));
    await queue(t);
    await queue(t); // a double click on sync queues nothing new
    expect(await statusCount("pending")).toBe(20);
    fake.fail((c) => c.method === "POST" && /\/channels$/.test(c.path), serverError, 3); // a few 502s while creating
    const all = { maxJobs: 10, maxCalls: 1000, queryBudget: 1000 };
    for (let i = 0; i < 12; i++) await drain({ ...all, now: nowSec() + i * 4000 });
    expect(fake.creates.channels).toBe(20 + 3); // 3 failed attempts are the forced retries (they returned 502, no channel existed)
    const rows = await Promise.all(regs.map((r) => regRow(r)));
    expect(rows.every((r) => r?.channel_id && r.role_id)).toBe(true);
    expect(new Set(rows.map((r) => r!.channel_id)).size).toBe(20);
    expect(fake.creates.roles).toBe(20); // the role is re-used on the retry
    expect(await statusCount("done", "create_team_channel")).toBe(20);
    expect(await statusCount("dead")).toBe(0);
  });

  it("replaying the drain after a crash between 'channel created' and 'job done' creates no second channel or role", async () => {
    const t = await world();
    const reg = await team(t, "Alpha Wolves");
    await queue(t);
    await drain({ maxJobs: 1 });
    const before = { ...fake.creates };
    expect(before).toMatchObject({ roles: 1, channels: 1 });
    // simulate the crash: the job is 'running' again (as if the invocation died before markDone) and the ids are already recorded
    await db.prepare("UPDATE discord_outbox SET status = 'running', updated_at = ?1 WHERE kind = 'create_team_channel'").bind(nowSec() - 3600).run();
    const r = await drain({ maxJobs: 1 });
    expect(r.done).toBe(1);
    expect(fake.creates.channels).toBe(1);
    expect(fake.creates.roles).toBe(1);
    // and with only the role recorded (crashed before the channel): the role is re-used, one channel is made
    const t2 = await world();
    const reg2 = await team(t2, "Beta Hawks");
    await db.prepare("INSERT INTO v3_registration_discord (registration_id, event_id, guild_id, role_id) VALUES (?1, ?2, ?3, '555000000000000001')").bind(reg2, t2.eventId, GUILD).run();
    await queue(t2);
    const rolesBefore = fake.creates.roles;
    await drain({ maxJobs: 1 });
    expect(fake.creates.roles).toBe(rolesBefore);
    expect((await regRow(reg2))!.role_id).toBe("555000000000000001");
    expect((await regRow(reg2))!.channel_id).toMatch(/^6/);
    expect(reg).not.toBe(reg2);
  });

  it("a duplicate enqueue (same idempotency key) can never produce a second job or channel", async () => {
    const t = await world();
    await team(t, "Alpha Wolves");
    expect((await queue(t)).queued).toBe(1);
    await drain({ maxJobs: 1 });
    expect((await queue(t)).queued).toBe(0); // the 'done' job still owns the key
    await drain();
    expect(fake.creates.channels).toBe(1);
    await expect(db.prepare("INSERT INTO discord_outbox (id, kind, guild_id, idempotency_key) VALUES ('dup', 'create_team_channel', ?1, ?2)").bind(GUILD, (await jobsOf())[0]!.idempotency_key).run()).rejects.toThrow();
  });

  it("a captain who links Discord later is given the role without a second message (queued by /link)", async () => {
    const t = await world();
    const reg = await team(t, "Alpha Wolves");
    const cap = await captain(t, "Alpha Wolves", null);
    await queue(t);
    await drain();
    await drain();
    expect(fake.of("PUT", /\/roles\//)).toHaveLength(0);
    expect(fake.creates.messages).toBe(1);
    const did = snow();
    const code = (await api("/v3/discord/link-code", { token: cap.token, method: "POST", body: {} })).json.code;
    const { completeLink } = await import("../../src/v3/services/discord-service");
    expect(await completeLink(db, did, code)).toBe("linked");
    await drain();
    expect(fake.of("PUT", /\/roles\//)).toHaveLength(1);
    expect(fake.creates.messages).toBe(1);
    expect(reg).toBeTruthy();
  });

  it("a captain who is not in the server yet (404) is listed, not a failure", async () => {
    const t = await world();
    await team(t, "Alpha Wolves");
    const ghost = snow();
    fake.notInGuild.add(ghost);
    await captain(t, "Alpha Wolves", ghost, "Ghost Gus");
    await queue(t);
    await drain();
    await drain();
    expect(await statusCount("dead")).toBe(0);
    expect(fake.of("POST", /\/messages$/)[0]!.body.content).toContain("Ghost Gus");
  });

  it("an unapproved or deleted registration is a permanent failure (dead), with a short message", async () => {
    const t = await world();
    const reg = await team(t, "Alpha Wolves");
    await queue(t);
    await db.prepare("UPDATE registrations SET status = 'rejected' WHERE id = ?1").bind(reg).run();
    await drain();
    const j = (await jobsOf())[0]!;
    expect(j).toMatchObject({ status: "dead", last_error: "registration is not approved" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("drain: failures, rate limits and secrecy", () => {
  it("429 with Retry-After reschedules the job at that time, refunds the attempt and stops the tick", async () => {
    const t = await world();
    await team(t, "Alpha Wolves");
    await team(t, "Beta Hawks");
    await queue(t);
    fake.fail((c) => /\/roles$/.test(c.path), () => rateLimited(42), 1);
    const now = nowSec();
    const r = await drain({ now });
    expect(r).toMatchObject({ jobs: 1, retried: 1, done: 0 });
    expect(fake.calls).toHaveLength(1); // the second job was not even tried
    const j = (await jobsOf()).find((x) => x.status === "pending" && x.run_after >= now + 40);
    expect(j).toBeTruthy();
    expect(j!.run_after).toBeGreaterThanOrEqual(now + 42);
    expect(j!.attempts).toBe(0);
    // too early: it is not picked up; after the delay it is
    expect((await drain({ now: now + 10 })).jobs).toBe(1); // only the other job is due
    expect((await drain({ now: now + 50 })).jobs).toBeGreaterThanOrEqual(1);
    expect(await statusCount("dead")).toBe(0);
  });

  it("5xx and network errors back off exponentially and the 5th failure is dead; the message is short and token-free", async () => {
    const t = await world();
    await team(t, "Alpha Wolves");
    await queue(t);
    fake.fail(() => true, () => new Response(`upstream said: Bot ${TOKEN}`, { status: 503 }));
    let now = nowSec();
    const gaps: number[] = [];
    for (let i = 1; i <= 5; i++) {
      await drain({ now });
      const j = (await jobsOf())[0]!;
      if (i < 5) {
        expect(j.status).toBe("pending");
        expect(j.attempts).toBe(i);
        gaps.push(j.run_after - now);
        now = j.run_after;
      } else {
        expect(j.status).toBe("dead");
        expect(j.last_error!.length).toBeLessThan(200);
        expect(j.last_error).not.toContain(TOKEN);
        expect(j.last_error).toMatch(/gave up after 5 attempts/);
      }
    }
    expect(gaps).toEqual([60, 120, 240, 480]);
    const before = fake.calls.length;
    await drain({ now: now + 99999 });
    expect(fake.calls.length).toBe(before); // dead jobs are never retried
  });

  it("a network error that mentions the token is stored as a fixed phrase only", async () => {
    const t = await world();
    await team(t, "Alpha Wolves");
    await queue(t);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const leaky = (async () => { throw new Error(`connect failed, headers: Authorization: Bot ${TOKEN}`); }) as unknown as typeof fetch;
    await drain({}, cfg({ fetch: leaky }));
    const j = (await jobsOf())[0]!;
    expect(j.status).toBe("pending");
    expect(j.last_error).toBe("network error talking to Discord");
    const everything = JSON.stringify([j, log.mock.calls, warn.mock.calls]);
    expect(everything).not.toContain(TOKEN);
  });

  it("a 4xx is permanent: dead on the first attempt with a short non-sensitive message; 403 'missing permissions' pauses the server instead", async () => {
    const t = await world();
    await team(t, "Alpha Wolves");
    await queue(t);
    fake.fail((c) => /\/roles$/.test(c.path), () => new Response(JSON.stringify({ message: `Invalid Form Body Bot ${TOKEN}`, code: 50035 }), { status: 400 }), 1);
    await drain();
    const j = (await jobsOf())[0]!;
    expect(j).toMatchObject({ status: "dead", attempts: 1 });
    expect(j.last_error).toBe("Discord refused the request (400, code 50035)");
    expect(j.last_error).not.toContain(TOKEN);

    const t2 = await world();
    await team(t2, "Beta Hawks");
    await queue(t2);
    fake.fail((c) => /\/roles$/.test(c.path), () => forbidden(50013), 1);
    await drain();
    expect((await db.prepare("SELECT permissions_ok FROM discord_guilds WHERE guild_id = ?1").bind(GUILD).first<{ permissions_ok: number }>())!.permissions_ok).toBe(0);
    const p = (await jobsOf())[0]!;
    expect(p).toMatchObject({ status: "pending", attempts: 0 });
    expect(p.last_error).toMatch(/missing permissions/);
    const calls = fake.calls.length;
    await drain({ now: nowSec() + 7200 });
    expect(fake.calls.length).toBe(calls); // paused until the organiser re-verifies
  });

  it("the bot token appears only in the Authorization header of Discord calls, never in the database or any response", async () => {
    const t = await world();
    await team(t, "Alpha Wolves");
    await captain(t, "Alpha Wolves", snow());
    await queue(t);
    await drain();
    await drain();
    const dump = JSON.stringify([(await db.prepare("SELECT * FROM discord_outbox").all()).results, (await db.prepare("SELECT * FROM v3_registration_discord").all()).results, (await db.prepare("SELECT * FROM discord_guilds").all()).results]);
    expect(dump).not.toContain(TOKEN);
    for (const c of fake.calls) expect(JSON.stringify(c.body ?? {})).not.toContain(TOKEN);
    const status = await api(`/v3/events/${t.eventId}/discord`, { token: t.owner.token, env: { ...env, DISCORD_BOT_TOKEN: TOKEN, DISCORD_APP_ID: APP_ID } as typeof env });
    expect(status.text).not.toContain(TOKEN);
  });
});

describe("drain: bounds per tick", () => {
  it("never runs more than 10 jobs, 25 Discord calls and ~24 prepared statements in one tick, and the rest wait for the next tick", async () => {
    expect([MAX_JOBS, MAX_CALLS, QUERY_BUDGET]).toEqual([10, 25, 24]);
    const t = await world();
    for (let i = 0; i < 30; i++) await team(t, `Squad ${i}`);
    await queue(t);
    const r = await drain();
    expect(r.calls).toBeLessThanOrEqual(MAX_CALLS);
    expect(fake.calls.length).toBe(r.calls);
    expect(r.jobs).toBeLessThanOrEqual(MAX_JOBS);
    expect(r.queries).toBeLessThanOrEqual(QUERY_BUDGET + 12); // the budget is checked before each job; one job is at most ~12 statements
    expect(r.jobs).toBeGreaterThan(0);
    expect((await statusCount("pending")) + (await statusCount("done"))).toBeGreaterThanOrEqual(30);
    // a job that hits the call budget part-way is rescheduled WITHOUT consuming an attempt and resumes without duplicates next tick
    for (let i = 0; i < 40 && (await statusCount("pending", "create_team_channel")) > 0; i++) await drain();
    expect(fake.creates.channels).toBe(30);
    expect(fake.creates.roles).toBe(30);
    expect(await statusCount("dead")).toBe(0);
    const worst = Math.max(...(await jobsOf()).map((j) => j.attempts));
    expect(worst).toBeLessThanOrEqual(1);
  });

  it("an idle tick (nothing due) costs only a few statements and no Discord call", async () => {
    await world();
    const r = await drain();
    expect(r.calls).toBe(0);
    expect(r.queries).toBeLessThanOrEqual(5);
  });
});

describe("lobby ping, results and archive", () => {
  async function liveTeams(n = 2) {
    const t = await world();
    const regs: string[] = [];
    for (let i = 0; i < n; i++) regs.push(await team(t, `Squad ${i}`));
    await queue(t);
    for (let i = 0; i < 6; i++) await drain();
    fake.calls = [];
    return { t, regs };
  }
  const call = (t: World, path: string, body: unknown = {}) => api(`/v3/events/${t.eventId}/discord/${path}`, { method: "POST", token: t.owner.token, body, env: { ...env, DISCORD_BOT_TOKEN: TOKEN, DISCORD_APP_ID: APP_ID } as typeof env });

  it("lobby ping is refused while the organiser has not enabled it; when enabled it posts only a pointer to the app (no room id or password)", async () => {
    const { t } = await liveTeams();
    const off = await call(t, "lobby-ping");
    expect(off.status).toBe(409);
    expect(off.json.code).toBe("lobby_ping_disabled");
    await db.prepare("INSERT INTO v3_discord_settings (tournament_id, lobby_ping_enabled) VALUES (?1, 1)").bind(t.id).run();
    const at = new Date(Date.now() + 3600_000).toISOString();
    const q = await call(t, "lobby-ping", { at });
    expect(q.json).toMatchObject({ channels: 2, queued: 2 });
    expect((await call(t, "lobby-ping", { at })).json.queued).toBe(0); // same time again: nothing new
    expect(await drain({ now: nowSec() + 10 })).toMatchObject({ jobs: 0 }); // not due yet: scheduled time respected
    await drain({ now: nowSec() + 3700 });
    const msgs = fake.of("POST", /\/messages$/);
    expect(msgs).toHaveLength(2);
    for (const m of msgs) {
      expect(m.body.content).toContain("Lobby details are in your team page");
      expect(m.body.content).toContain("https://esports.test/tournaments/");
      expect(m.body.content).not.toMatch(/password|room id|passcode/i);
    }
    expect((await call(t, "lobby-ping", { at: "tomorrow-ish" })).status).toBe(400);
    expect((await call(t, "lobby-ping", { at: new Date(Date.now() + 90 * 86400_000).toISOString() })).status).toBe(400);
  });

  it("a ping queued before the organiser switched pings off is dropped at run time", async () => {
    const { t } = await liveTeams(1);
    await db.prepare("INSERT INTO v3_discord_settings (tournament_id, lobby_ping_enabled) VALUES (?1, 1)").bind(t.id).run();
    await call(t, "lobby-ping", {});
    await db.prepare("UPDATE v3_discord_settings SET lobby_ping_enabled = 0 WHERE tournament_id = ?1").bind(t.id).run();
    await drain();
    expect(fake.creates.messages).toBe(0);
    expect(await statusCount("done", "ping_lobby")).toBe(1);
  });

  it("post_result posts a link to the public page in every team channel, once an hour per team", async () => {
    const { t } = await liveTeams();
    const a = await call(t, "results");
    expect(a.json).toMatchObject({ channels: 2, queued: 2 });
    expect((await call(t, "results")).json.queued).toBe(0);
    await drain();
    const msgs = fake.of("POST", /\/messages$/);
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.body.content).toContain(`https://esports.test/tournaments/${t.slug}`);
  });

  it("completing the tournament archives channels read-only (default): the team role loses Send Messages, nothing is deleted", async () => {
    const { t, regs } = await liveTeams();
    const r = await api(`/v3/events/${t.eventId}/tournament/status`, { token: t.owner.token, body: { to: "completed" } });
    expect(r.status).toBe(200);
    await drain();
    const puts = fake.of("PUT", /\/permissions\//);
    expect(puts).toHaveLength(2);
    expect(BigInt(puts[0]!.body.deny) & (1n << 11n)).toBe(1n << 11n);
    expect(BigInt(puts[0]!.body.allow) & (1n << 10n)).toBe(1n << 10n);
    expect(fake.of("DELETE", /./)).toHaveLength(0);
    expect((await regRow(regs[0]!))!.archived_at).not.toBeNull();
    await onTournamentCompleted(db, t.eventId); // nothing live is left, so nothing is queued
    expect(await statusCount("pending")).toBe(0);
  });

  it("archive mode delete removes the channel (an already deleted channel is fine)", async () => {
    const { t } = await liveTeams();
    await db.prepare("INSERT INTO v3_discord_settings (tournament_id, archive_mode) VALUES (?1, 'delete')").bind(t.id).run();
    fake.fail((c) => c.method === "DELETE", () => new Response(JSON.stringify({ code: 10003 }), { status: 404 }), 1);
    await api(`/v3/events/${t.eventId}/tournament/status`, { token: t.owner.token, body: { to: "completed" } });
    await drain();
    expect(fake.of("DELETE", /./)).toHaveLength(2);
    expect(await statusCount("dead")).toBe(0);
    expect(fake.of("PUT", /\/permissions\//)).toHaveLength(0);
  });

  it("with the flag off, completing a tournament queues nothing and stays 200", async () => {
    const { t } = await liveTeams(1);
    await flagsOn("v3.tournaments");
    const before = (await jobsOf()).length;
    const r = await api(`/v3/events/${t.eventId}/tournament/status`, { token: t.owner.token, body: { to: "completed" } });
    expect(r.status).toBe(200);
    expect((await jobsOf()).length).toBe(before);
  });
});
