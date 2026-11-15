import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SKEW_SEC, verifyDiscordSignature } from "../../src/v3/lib/discord-sig";
import { onRegistrationApproved } from "../../src/v3/services/discord-service";
import { uniq } from "../helpers";
import { APP_ID, CATEGORY, FakeDiscord, GUILD, TOKEN, keyPair, sign } from "./fake-discord";
import { addRegistration, api, db, flagsOn, nowSec, tournament, user } from "./helpers";

vi.setConfig({ testTimeout: 30_000 }); // these tests make many requests; a loaded runner must not time them out
let kp: Awaited<ReturnType<typeof keyPair>>;
let other: Awaited<ReturnType<typeof keyPair>>;
beforeAll(async () => { kp = await keyPair(); other = await keyPair(); });

const cfgEnv = (extra: Record<string, unknown> = {}) => ({ ...env, DISCORD_BOT_TOKEN: TOKEN, DISCORD_APP_ID: APP_ID, DISCORD_PUBLIC_KEY: kp.publicHex, ...extra }) as typeof env;
const snow = () => `5${String(Date.now()).slice(-8)}${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`.slice(0, 18);

let fake: FakeDiscord;
const realFetch = globalThis.fetch;
beforeEach(async () => {
  fake = new FakeDiscord();
  globalThis.fetch = fake.fetch as typeof fetch; // the REST client uses the global fetch: the real Discord can never be called from a test
  await db.prepare("DELETE FROM discord_outbox").run();
  await db.prepare("DELETE FROM discord_guilds").run();
  await db.prepare("UPDATE users SET discord_user_id = NULL WHERE discord_user_id IS NOT NULL").run(); // fixed fake ids are reused across tests
});
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

async function interact(body: unknown, o: { key?: CryptoKey; ts?: string; env?: typeof env; tamper?: boolean; signature?: string } = {}) {
  const raw = JSON.stringify(body);
  const ts = o.ts ?? String(nowSec());
  const signature = o.signature ?? (await sign(o.key ?? kp.privateKey, ts, raw));
  return api("/v3/discord/interactions", { raw: o.tamper ? raw.replace("1", "2") + " " : raw, method: "POST", headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": ts }, env: o.env ?? cfgEnv() });
}
const cmd = (name: string, discordId: string, options?: { name: string; value: string }[]) => ({ type: 2, data: { name, options }, member: { user: { id: discordId } } });

describe("Ed25519 signature check (generated key pair, Web Crypto)", () => {
  it("accepts a valid signature and rejects tampering, a wrong key, a stale or future timestamp, junk and a missing key", async () => {
    const raw = '{"type":1}';
    const ts = String(nowSec());
    const sig = await sign(kp.privateKey, ts, raw);
    const base = { publicKeyHex: kp.publicHex, signatureHex: sig, timestamp: ts, rawBody: raw, nowSec: nowSec() };
    expect(await verifyDiscordSignature(base)).toBe(true);
    expect(await verifyDiscordSignature({ ...base, rawBody: '{"type":2}' })).toBe(false); // tampered body
    expect(await verifyDiscordSignature({ ...base, publicKeyHex: other.publicHex })).toBe(false); // wrong key
    expect(await verifyDiscordSignature({ ...base, timestamp: String(nowSec() + 1) })).toBe(false); // timestamp is part of the signed text
    const old = String(nowSec() - MAX_SKEW_SEC - 10);
    expect(await verifyDiscordSignature({ ...base, timestamp: old, signatureHex: await sign(kp.privateKey, old, raw) })).toBe(false); // correct signature, stale
    const fut = String(nowSec() + MAX_SKEW_SEC + 10);
    expect(await verifyDiscordSignature({ ...base, timestamp: fut, signatureHex: await sign(kp.privateKey, fut, raw) })).toBe(false);
    for (const bad of ["", "zz", "ab".repeat(63), "ab".repeat(65), "not hex at all"]) expect(await verifyDiscordSignature({ ...base, signatureHex: bad })).toBe(false);
    expect(await verifyDiscordSignature({ ...base, publicKeyHex: undefined })).toBe(false);
    expect(await verifyDiscordSignature({ ...base, publicKeyHex: "abcd" })).toBe(false);
    expect(await verifyDiscordSignature({ ...base, signatureHex: null })).toBe(false);
    expect(await verifyDiscordSignature({ ...base, timestamp: null })).toBe(false);
  });
});

describe("POST /v3/discord/interactions", () => {
  beforeEach(() => flagsOn("v3.discord"));

  it("answers PING with PONG when the signature is valid", async () => {
    const r = await interact({ type: 1 });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ type: 1 });
  });

  it("401 for a bad signature, a tampered body, the wrong key, a stale timestamp and when no public key is configured; nothing is parsed or read first", async () => {
    expect((await interact({ type: 1 }, { signature: "00".repeat(64) })).status).toBe(401);
    expect((await interact({ type: 1 }, { tamper: true })).status).toBe(401);
    expect((await interact({ type: 1 }, { key: other.privateKey })).status).toBe(401);
    expect((await interact({ type: 1 }, { ts: String(nowSec() - 3600) })).status).toBe(401);
    expect((await interact({ type: 1 }, { env: cfgEnv({ DISCORD_PUBLIC_KEY: undefined }) })).status).toBe(401);
    expect((await api("/v3/discord/interactions", { raw: "{}", method: "POST", env: cfgEnv() })).status).toBe(401); // no signature headers at all
  });

  it("404 (like any unknown route) when the flag is off, even with a valid signature", async () => {
    await flagsOn();
    expect((await interact({ type: 1 })).status).toBe(404);
  });

  it("an unknown command or a non-command interaction gets an ephemeral 'not supported'", async () => {
    const r = await interact(cmd("hack", "400000000000000009"));
    expect(r.json.type).toBe(4);
    expect(r.json.data.flags).toBe(64);
    expect(r.json.data.content).toMatch(/not supported/);
    const c = await interact({ type: 3, data: {}, member: { user: { id: "400000000000000009" } } });
    expect(c.json.data.content).toMatch(/not supported/);
  });

  it("/link: a single-use code (stored hashed, 10 minutes) links the caller's Discord id; reuse, expiry and a taken id are refused", async () => {
    const u = await user("Linker");
    const did = snow();
    const code = (await api("/v3/discord/link-code", { token: u.token, method: "POST", body: {} })).json;
    expect(code.expiresInSeconds).toBe(600);
    expect(code.code).toMatch(/^[A-Z2-9]{8}$/);
    const stored = await db.prepare("SELECT code_hash, expires_at FROM discord_link_codes WHERE user_id = ?1").bind(u.id).first<{ code_hash: string; expires_at: number }>();
    expect(stored!.code_hash).not.toContain(code.code);
    expect(stored!.expires_at - nowSec()).toBeLessThanOrEqual(600);

    expect((await api("/v3/discord/link", { token: u.token })).json.linked).toBe(false);
    const ok = await interact(cmd("link", did, [{ name: "code", value: code.code }]));
    expect(ok.json.data.content).toMatch(/Linked/);
    expect(ok.json.data.flags).toBe(64);
    expect((await db.prepare("SELECT discord_user_id FROM users WHERE id = ?1").bind(u.id).first<{ discord_user_id: string }>())!.discord_user_id).toBe(did);
    expect((await api("/v3/discord/link", { token: u.token })).json.linked).toBe(true);

    expect((await interact(cmd("link", snow(), [{ name: "code", value: code.code }]))).json.data.content).toMatch(/not valid or has expired/); // single use
    expect((await interact(cmd("link", snow(), [{ name: "code", value: "WRONGCOD" }]))).json.data.content).toMatch(/not valid or has expired/);
    expect((await interact(cmd("link", snow(), []))).json.data.content).toMatch(/Use \/link/);

    const v = await user("Second");
    const c2 = (await api("/v3/discord/link-code", { token: v.token, method: "POST", body: {} })).json.code;
    expect((await interact(cmd("link", did, [{ name: "code", value: c2 }]))).json.data.content).toMatch(/already linked to another/); // that Discord id belongs to Linker

    const w = await user("Expired");
    const c3 = (await api("/v3/discord/link-code", { token: w.token, method: "POST", body: {} })).json.code;
    await db.prepare("UPDATE discord_link_codes SET expires_at = ?2 WHERE user_id = ?1").bind(w.id, nowSec() - 1).run();
    expect((await interact(cmd("link", snow(), [{ name: "code", value: c3 }]))).json.data.content).toMatch(/not valid or has expired/);

    expect((await api("/v3/discord/link", { token: u.token, method: "DELETE" })).json.linked).toBe(false); // unlink
    expect((await api("/v3/discord/link-code", { method: "POST", body: {} })).status).toBe(401);
  });

  it("/team shows only the caller's own team channel; /dispute only points to the app and creates nothing", async () => {
    await flagsOn("v3.tournaments", "v3.discord");
    const t = await tournament({}, "live");
    const reg = await addRegistration(t.eventId, "Alpha Wolves");
    const me = await user("Mine");
    const stranger = await user("Stranger");
    const mine = snow(), theirs = snow();
    await db.prepare("UPDATE users SET discord_user_id = ?2 WHERE id = ?1").bind(me.id, mine).run();
    await db.prepare("UPDATE users SET discord_user_id = ?2 WHERE id = ?1").bind(stranger.id, theirs).run();
    await db.prepare("INSERT INTO v3_team_captains (event_id, team_key, team_name, user_id) VALUES (?1, 'alpha wolves', 'Alpha Wolves', ?2)").bind(t.eventId, me.id).run();
    await db.prepare("INSERT INTO v3_registration_discord (registration_id, event_id, guild_id, role_id, channel_id) VALUES (?1, ?2, ?3, '555', '666000000000000001')").bind(reg, t.eventId, GUILD).run();

    const a = await interact(cmd("team", mine));
    expect(a.json.data.content).toContain(`https://discord.com/channels/${GUILD}/666000000000000001`);
    expect(a.json.data.content).toContain("Alpha Wolves");
    const b = await interact(cmd("team", theirs));
    expect(b.json.data.content).not.toContain("666000000000000001");
    expect((await interact(cmd("team", snow()))).json.data.content).toMatch(/Link your account first/);

    const before = (await db.prepare("SELECT COUNT(*) AS n FROM disputes").first<{ n: number }>())!.n;
    const d = await interact(cmd("dispute", mine));
    expect(d.json.data.content).toContain("https://esports.streamerosai.com/app/disputes/");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM disputes").first<{ n: number }>())!.n).toBe(before);
  });
});

describe("install flow", () => {
  async function organiserWorld(linkedTo?: string) {
    await flagsOn("v3.tournaments", "v3.discord");
    const t = await tournament({}, "registration_open");
    if (linkedTo) await db.prepare("UPDATE users SET discord_user_id = ?2 WHERE id = ?1").bind(t.owner.id, linkedTo).run();
    return t;
  }

  it("says 'Discord is not configured' (503) when the secrets are not set, and never calls Discord", async () => {
    const t = await organiserWorld(fakeOwner());
    for (const e of [{ ...env }, { ...env, DISCORD_BOT_TOKEN: TOKEN }]) {
      const r = await api("/v3/discord/guilds", { token: t.owner.token, body: { guildId: GUILD, eventId: t.eventId }, env: e as typeof env });
      expect(r.status).toBe(503);
      expect(r.json.error).toBe("Discord is not configured");
      expect(r.json.code).toBe("discord_not_configured");
    }
    expect((await api(`/v3/events/${t.eventId}/discord/category`, { method: "PUT", token: t.owner.token, body: { categoryId: CATEGORY }, env: { ...env } as typeof env })).status).toBe(503);
    expect(fake.calls.length).toBe(0);
  });

  it("registers a guild owned by the caller, sets permissions_ok, then GET status and PUT category", async () => {
    const t = await organiserWorld(fake.owner);
    const r = await api("/v3/discord/guilds", { token: t.owner.token, body: { guildId: GUILD, eventId: t.eventId }, env: cfgEnv() });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ guildId: GUILD, permissionsOk: true, missing: [] });
    expect(r.json.inviteUrl).toContain(`client_id=${APP_ID}`);
    expect(r.json.inviteUrl).toContain("scope=bot%20applications.commands");
    expect(r.json.inviteUrl).toContain("permissions=268438544");
    expect(fake.calls.length).toBe(3); // guild, member, roles
    expect(fake.calls.every((c) => c.auth === `Bot ${TOKEN}`)).toBe(true);
    expect((await db.prepare("SELECT permissions_ok FROM discord_guilds WHERE guild_id = ?1").bind(GUILD).first<{ permissions_ok: number }>())!.permissions_ok).toBe(1);
    expect((await db.prepare("SELECT discord_guild_id FROM tournaments WHERE id = ?1").bind(t.id).first<{ discord_guild_id: string }>())!.discord_guild_id).toBe(GUILD);

    const s = await api(`/v3/discord/guilds/${GUILD}`, { token: t.owner.token, env: cfgEnv() });
    expect(s.status).toBe(200);
    expect(s.json.tournaments[0].eventId).toBe(t.eventId);

    const c = await api(`/v3/events/${t.eventId}/discord/category`, { method: "PUT", token: t.owner.token, body: { categoryId: CATEGORY }, env: cfgEnv() });
    expect(c.status).toBe(200);
    expect(c.json).toEqual({ guildId: GUILD, categoryId: CATEGORY });
    expect((await db.prepare("SELECT discord_category_id FROM tournaments WHERE id = ?1").bind(t.id).first<{ discord_category_id: string }>())!.discord_category_id).toBe(CATEGORY);
    // a non-category or foreign channel, or a malformed id, is refused
    fake.channelsMeta["200000000000000002"] = { id: "200000000000000002", type: 0, guild_id: GUILD };
    fake.channelsMeta["200000000000000003"] = { id: "200000000000000003", type: 4, guild_id: "999999999999999999" };
    for (const id of ["200000000000000002", "200000000000000003", "200000000000000004", "abc", 5]) {
      expect((await api(`/v3/events/${t.eventId}/discord/category`, { method: "PUT", token: t.owner.token, body: { categoryId: id }, env: cfgEnv() })).status, String(id)).toBe(400);
    }
    const d = await api(`/v3/events/${t.eventId}/discord`, { token: t.owner.token, env: cfgEnv() });
    expect(d.json).toMatchObject({ configured: true, guildId: GUILD, categoryId: CATEGORY, permissionsOk: true, settings: { lobbyPingEnabled: false, archiveMode: "readonly" } });
    expect(JSON.stringify(d.json)).not.toContain(TOKEN);
  });

  it("refuses: not an organiser (404), no linked Discord (409), bot not in the guild (409), not the server owner (403), a server another account registered (409), bad ids (400)", async () => {
    const t = await organiserWorld();
    const stranger = await user("Stranger");
    const body = { guildId: GUILD, eventId: t.eventId };
    expect((await api("/v3/discord/guilds", { token: stranger.token, body, env: cfgEnv() })).status).toBe(404);
    expect((await api("/v3/discord/guilds", { body, env: cfgEnv() })).status).toBe(401);
    const noLink = await api("/v3/discord/guilds", { token: t.owner.token, body, env: cfgEnv() });
    expect(noLink.status).toBe(409);
    expect(noLink.json.code).toBe("discord_not_linked");

    await db.prepare("UPDATE users SET discord_user_id = ?2 WHERE id = ?1").bind(t.owner.id, fake.owner).run();
    fake.botInGuild = false;
    const notIn = await api("/v3/discord/guilds", { token: t.owner.token, body, env: cfgEnv() });
    expect(notIn.status).toBe(409);
    expect(notIn.json.code).toBe("bot_not_in_guild");
    expect(notIn.json.inviteUrl).toContain("client_id");
    fake.botInGuild = true;
    expect((await api("/v3/discord/guilds", { token: t.owner.token, body: { guildId: "999999999999999999", eventId: t.eventId }, env: cfgEnv() })).json.code).toBe("bot_not_in_guild");

    fake.owner = "400000000000000777"; // somebody else owns the server
    const notOwner = await api("/v3/discord/guilds", { token: t.owner.token, body, env: cfgEnv() });
    expect(notOwner.status).toBe(403);
    expect(notOwner.json.code).toBe("not_guild_owner");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM discord_guilds").first<{ n: number }>())!.n).toBe(0);

    for (const bad of [{ guildId: "12", eventId: t.eventId }, { guildId: GUILD }, { guildId: 5, eventId: t.eventId }]) {
      expect((await api("/v3/discord/guilds", { token: t.owner.token, body: bad, env: cfgEnv() })).status).toBe(400);
    }

    // a second account cannot take over a registered server
    fake.owner = "400000000000000001";
    expect((await api("/v3/discord/guilds", { token: t.owner.token, body, env: cfgEnv() })).status).toBe(201);
    const t2 = await tournament({}, "registration_open");
    await db.prepare("UPDATE users SET discord_user_id = ?2 WHERE id = ?1").bind(t2.owner.id, "400000000000000002").run();
    fake.owner = "400000000000000002";
    const taken = await api("/v3/discord/guilds", { token: t2.owner.token, body: { guildId: GUILD, eventId: t2.eventId }, env: cfgEnv() });
    expect(taken.status).toBe(409);
    expect(taken.json.code).toBe("guild_taken");
    // and cannot read its status
    expect((await api(`/v3/discord/guilds/${GUILD}`, { token: t2.owner.token, env: cfgEnv() })).status).toBe(404);
    expect((await api(`/v3/discord/guilds/${GUILD}`, { token: stranger.token, env: cfgEnv() })).status).toBe(404);
  });

  it("records permissions_ok false and the missing permission names; /verify turns it back on after the fix", async () => {
    const t = await organiserWorld(fake.owner);
    fake.botRolePerms = String(1n << 4n); // Manage Channels only
    const r = await api("/v3/discord/guilds", { token: t.owner.token, body: { guildId: GUILD, eventId: t.eventId }, env: cfgEnv() });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ permissionsOk: false, missing: ["Manage Roles"] });
    fake.botRolePerms = String(1n << 3n); // Administrator implies everything
    const v = await api(`/v3/discord/guilds/${GUILD}/verify`, { method: "POST", token: t.owner.token, body: {}, env: cfgEnv() });
    expect(v.json).toMatchObject({ permissionsOk: true, missing: [] });
  });

  it("settings: lobby ping is off by default, archive defaults to read-only, bad values are refused, a viewer cannot change them", async () => {
    const t = await organiserWorld();
    const s = await api(`/v3/events/${t.eventId}/discord/settings`, { method: "PUT", token: t.owner.token, body: { lobbyPingEnabled: true, archiveMode: "delete" }, env: cfgEnv() });
    expect(s.json).toEqual({ lobbyPingEnabled: true, archiveMode: "delete" });
    expect((await api(`/v3/events/${t.eventId}/discord/settings`, { method: "PUT", token: t.owner.token, body: { archiveMode: "shred" }, env: cfgEnv() })).status).toBe(400);
    expect((await api(`/v3/events/${t.eventId}/discord/settings`, { method: "PUT", token: t.owner.token, body: { lobbyPingEnabled: "yes" }, env: cfgEnv() })).status).toBe(400);
    const stranger = await user("Nope");
    expect((await api(`/v3/events/${t.eventId}/discord/settings`, { method: "PUT", token: stranger.token, body: { lobbyPingEnabled: false }, env: cfgEnv() })).status).toBe(404);
  });

  it("Discord failures during install never leak the token and map to short messages (429, 5xx, network)", async () => {
    const t = await organiserWorld(fake.owner);
    const body = { guildId: GUILD, eventId: t.eventId };
    fake.fail(() => true, () => new Response(JSON.stringify({ retry_after: 3, echo: `Bot ${TOKEN}` }), { status: 429, headers: { "retry-after": "3" } }), 1);
    const a = await api("/v3/discord/guilds", { token: t.owner.token, body, env: cfgEnv() });
    expect(a.status).toBe(429);
    fake.fail(() => true, () => new Response("boom " + TOKEN, { status: 500 }), 1);
    const b = await api("/v3/discord/guilds", { token: t.owner.token, body, env: cfgEnv() });
    expect(b.status).toBe(502);
    globalThis.fetch = (async () => { throw new Error(`socket closed for Bot ${TOKEN}`); }) as typeof fetch;
    const c = await api("/v3/discord/guilds", { token: t.owner.token, body, env: cfgEnv() });
    expect(c.status).toBe(502);
    for (const r of [a, b, c]) expect(r.text).not.toContain(TOKEN);
  });
});

function fakeOwner(): string { return "400000000000000001"; }

describe("the approval hook (legacy registration approval)", () => {
  async function approvalWorld(configured = true) {
    await flagsOn("v3.tournaments", "v3.discord");
    const t = await tournament({}, "registration_open");
    if (configured) {
      await db.prepare("INSERT INTO discord_guilds (guild_id, installed_by_user_id, permissions_ok) VALUES (?1, ?2, 1)").bind(GUILD, t.owner.id).run();
      await db.prepare("UPDATE tournaments SET discord_guild_id = ?2, discord_category_id = ?3 WHERE id = ?1").bind(t.id, GUILD, CATEGORY).run();
    }
    return t;
  }
  const approve = (t: { owner: { token: string }; eventId: string }, rid: string, e: typeof env = env) => api(`/events/${t.eventId}/registrations/${rid}/approve`, { method: "POST", token: t.owner.token, body: {}, env: e });
  const jobs = async () => (await db.prepare("SELECT kind, guild_id, payload, idempotency_key, status FROM discord_outbox").all<{ kind: string; guild_id: string; payload: string; idempotency_key: string; status: string }>()).results;

  it("flag ON and a server + category set: approval queues exactly one create_team_channel with ids only", async () => {
    const t = await approvalWorld();
    const rid = await addRegistration(t.eventId, "Alpha Wolves", "pending");
    const r = await approve(t, rid);
    expect(r.status).toBe(200);
    const q = await jobs();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ kind: "create_team_channel", guild_id: GUILD, idempotency_key: `create_team_channel:${rid}`, status: "pending" });
    expect(JSON.parse(q[0]!.payload)).toEqual({ registrationId: rid }); // ids only: no email, no contact, no team name
    expect(await onRegistrationApproved(db, t.eventId, rid)).toBe(false); // calling the hook again changes nothing
    expect(await jobs()).toHaveLength(1);
  });

  it("flag OFF: approval succeeds and nothing is queued or read from the Discord tables", async () => {
    const t = await approvalWorld();
    await flagsOn("v3.tournaments");
    const rid = await addRegistration(t.eventId, "Beta Hawks", "pending");
    const sql: string[] = [];
    const DB = new Proxy(env.DB, { get(x, p) { if (p === "prepare") return (s: string) => { sql.push(s); return x.prepare(s); }; if (p === "batch") return (s: D1PreparedStatement[]) => x.batch(s); const v = (x as any)[p]; return typeof v === "function" ? v.bind(x) : v; } });
    const r = await approve(t, rid, { ...env, DB } as typeof env);
    expect(r.status).toBe(200);
    expect((await db.prepare("SELECT status FROM registrations WHERE id = ?1").bind(rid).first<{ status: string }>())!.status).toBe("approved");
    expect(await jobs()).toHaveLength(0);
    for (const s of sql) expect(s).not.toMatch(/discord_|v3_registration_discord|v3_discord_settings/);
  });

  it("an enqueue failure can never break or roll back an approval (the hook throws on every Discord table)", async () => {
    const t = await approvalWorld();
    const rid = await addRegistration(t.eventId, "Gamma Gaur", "pending");
    const DB = new Proxy(env.DB, {
      get(x, p) {
        if (p === "prepare") return (s: string) => { if (/discord_|v3_registration_discord/.test(s) && !/^UPDATE registrations/.test(s)) throw new Error("boom: database is on fire"); return x.prepare(s); };
        if (p === "batch") return (s: D1PreparedStatement[]) => x.batch(s);
        const v = (x as any)[p]; return typeof v === "function" ? v.bind(x) : v;
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const r = await approve(t, rid, { ...env, DB } as typeof env);
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect((await db.prepare("SELECT status FROM registrations WHERE id = ?1").bind(rid).first<{ status: string }>())!.status).toBe("approved");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM teams WHERE event_id = ?1").bind(t.eventId).first<{ n: number }>())!.n).toBe(1);
    expect(await jobs()).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    expect(await onRegistrationApproved({ prepare() { throw new Error("x"); } } as unknown as D1Database, "e", "r")).toBe(false); // direct call: swallowed
  });

  it("nothing is queued while the tournament has no server/category or the server's permissions are not ok; sync queues the missed ones once", async () => {
    const t = await approvalWorld(false);
    const r1 = await addRegistration(t.eventId, "Delta", "pending");
    expect((await approve(t, r1)).status).toBe(200);
    expect(await jobs()).toHaveLength(0);
    await db.prepare("INSERT INTO discord_guilds (guild_id, installed_by_user_id, permissions_ok) VALUES (?1, ?2, 1)").bind(GUILD, t.owner.id).run();
    await db.prepare("UPDATE tournaments SET discord_guild_id = ?2, discord_category_id = ?3 WHERE id = ?1").bind(t.id, GUILD, CATEGORY).run();
    const s = await api(`/v3/events/${t.eventId}/discord/sync`, { method: "POST", token: t.owner.token, body: {}, env: cfgEnv() });
    expect(s.json).toEqual({ approved: 1, queued: 1 });
    expect((await api(`/v3/events/${t.eventId}/discord/sync`, { method: "POST", token: t.owner.token, body: {}, env: cfgEnv() })).json).toEqual({ approved: 1, queued: 0 });
    await db.prepare("UPDATE discord_guilds SET permissions_ok = 0").run();
    const r2 = await addRegistration(t.eventId, "Epsilon", "pending");
    expect((await approve(t, r2)).status).toBe(200);
    expect(await jobs()).toHaveLength(1); // still just the synced one
  });
});
