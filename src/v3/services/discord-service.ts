/**
 * Discord stage, organiser and user side: install a guild, link a user's Discord id, per-tournament settings, and every place a job is put in the outbox.
 * No SQL here (repositories) and no Discord HTTP details (discord/rest-client.ts). The Discord secrets arrive as a DiscordConfig built by the route.
 */
import { sha256 } from "../../crypto";
import { HttpError } from "../../http";
import { DiscordError, DiscordRest, INVITE_PERMISSIONS, PERM, memberHasPermissions } from "../discord/rest-client";
import { newId, nowSec } from "../lib/ids";
import type { OutboxKind } from "../lib/enums";
import { bad } from "../lib/validate";
import * as repo from "../repositories/discord-repo";
import { loadEventAccess, type EventAccessRow } from "../repositories/event-access-repo";
import { discordEnabled } from "../repositories/flag-repo";

export interface DiscordConfig {
  token?: string;
  publicKey?: string;
  appId?: string;
  appUrl: string;
  /** Tests inject a fake; production leaves it undefined (global fetch). */
  fetch?: typeof fetch;
}

export const SNOWFLAKE = /^\d{17,20}$/;
export const LINK_CODE_TTL_SEC = 600;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const configured = (cfg: DiscordConfig): boolean => !!cfg.token && !!cfg.appId;
export const inviteUrl = (cfg: DiscordConfig): string | null =>
  cfg.appId && SNOWFLAKE.test(cfg.appId) ? `https://discord.com/oauth2/authorize?client_id=${cfg.appId}&scope=${encodeURIComponent("bot applications.commands")}&permissions=${INVITE_PERMISSIONS}` : null;

const notConfigured = () => new HttpError(503, "Discord is not configured", { code: "discord_not_configured" });
function restOf(cfg: DiscordConfig): DiscordRest {
  if (!configured(cfg)) throw notConfigured();
  return new DiscordRest({ token: cfg.token!, fetch: cfg.fetch, maxCalls: 6 });
}

async function organiser(db: D1Database, userId: string, eventId: string, write: boolean): Promise<EventAccessRow> {
  const a = await loadEventAccess(db, userId, eventId);
  if (!a) throw new HttpError(404, "Event not found");
  if (write && !a.canWrite) throw new HttpError(403, "You can view this event but not change it");
  return a;
}

/** Maps a failed Discord call during an interactive request to a short, token-free answer. */
function discordFailure(e: unknown): HttpError {
  if (e instanceof DiscordError) {
    if (e.kind === "rate_limited") return new HttpError(429, "Discord is busy. Try again in a minute.", { code: "discord_rate_limited" });
    if (e.kind === "permanent") return new HttpError(409, "Discord did not accept that. Check that the bot is in your server and the ids are right.", { code: "discord_refused" });
    return new HttpError(502, "Could not reach Discord. Try again shortly.", { code: "discord_unavailable" });
  }
  return new HttpError(502, "Could not reach Discord. Try again shortly.", { code: "discord_unavailable" });
}

// ---------------- install ----------------
export interface GuildStatus {
  guildId: string;
  permissionsOk: boolean;
  missing: string[];
  installedAt: string;
  tournaments: { eventId: string; slug: string; categoryId: string | null }[];
  queue: Record<string, number>;
  inviteUrl: string | null;
}

async function statusOf(db: D1Database, cfg: DiscordConfig, g: repo.GuildRow, missing: string[]): Promise<GuildStatus> {
  return {
    guildId: g.guildId, permissionsOk: g.permissionsOk, missing, installedAt: new Date(g.installedAt * 1000).toISOString(),
    tournaments: await repo.tournamentsOfGuild(db, g.guildId), queue: await repo.outboxCounts(db, g.guildId), inviteUrl: inviteUrl(cfg),
  };
}

/** Does the bot sit in the guild, and may it manage channels and roles? Three Discord calls (guild, member, roles). */
async function checkBot(rest: DiscordRest, cfg: DiscordConfig, guildId: string): Promise<{ ownerId: string | null; missing: string[] }> {
  try {
    const guild = await rest.getGuild(guildId);
    const member = await rest.getMember(guildId, cfg.appId!);
    const roles = (await rest.getGuildRoles(guildId)) ?? [];
    const have = (need: bigint) => memberHasPermissions(guildId, member?.roles ?? [], roles, need);
    const missing: string[] = [];
    if (!have(PERM.MANAGE_CHANNELS)) missing.push("Manage Channels");
    if (!have(PERM.MANAGE_ROLES)) missing.push("Manage Roles");
    return { ownerId: guild?.ownerId ?? null, missing };
  } catch (e) {
    if (e instanceof DiscordError && e.kind === "permanent" && (e.status === 404 || e.status === 403)) {
      throw new HttpError(409, "The bot is not in that server yet. Invite it first, then try again.", { code: "bot_not_in_guild", inviteUrl: inviteUrl(cfg) });
    }
    throw discordFailure(e);
  }
}

/**
 * An organiser links a server to their tournament. The caller must (1) organise the tournament, (2) have linked their own Discord account, and
 * (3) be the OWNER of that Discord server: knowing a server id proves nothing, so without this anyone could point their tournament at your server.
 */
export async function registerGuild(db: D1Database, cfg: DiscordConfig, userId: string, b: Record<string, unknown>): Promise<GuildStatus> {
  const rest = restOf(cfg);
  if (typeof b.guildId !== "string" || !SNOWFLAKE.test(b.guildId)) throw bad("guildId must be a Discord server id (17 to 20 digits)", "invalid_guildId");
  if (typeof b.eventId !== "string" || !/^[A-Za-z0-9._~-]{1,48}$/.test(b.eventId)) throw bad("eventId is required", "invalid_eventId");
  const guildId = b.guildId;
  const access = await organiser(db, userId, b.eventId, true);
  const t = await repo.tournamentCtxByEvent(db, access.eventId);
  if (!t) throw new HttpError(404, "No tournament page for this event");
  const mine = await repo.getDiscordUserId(db, userId);
  if (!mine) throw new HttpError(409, "Link your own Discord account first (use /link in Discord), so the server owner can be checked", { code: "discord_not_linked" });
  const existing = await repo.findGuild(db, guildId);
  if (existing?.installedByUserId && existing.installedByUserId !== userId) throw new HttpError(409, "That server is already registered by another account", { code: "guild_taken" });

  const { ownerId, missing } = await checkBot(rest, cfg, guildId);
  if (ownerId !== mine) throw new HttpError(403, "Only the owner of the Discord server can link it", { code: "not_guild_owner" });
  const at = nowSec();
  await repo.upsertGuild(db, guildId, userId, missing.length === 0, at);
  await repo.setTournamentGuild(db, t.id, guildId, at);
  return statusOf(db, cfg, (await repo.findGuild(db, guildId))!, missing);
}

async function guildAccess(db: D1Database, userId: string, guildId: string): Promise<repo.GuildRow> {
  const g = SNOWFLAKE.test(guildId) ? await repo.findGuild(db, guildId) : null;
  if (!g) throw new HttpError(404, "Not found");
  if (g.installedByUserId === userId) return g;
  for (const t of await repo.tournamentsOfGuild(db, guildId)) {
    const a = await loadEventAccess(db, userId, t.eventId);
    if (a?.canWrite) return g;
  }
  throw new HttpError(404, "Not found"); // not yours and not there look the same
}

export async function guildStatus(db: D1Database, cfg: DiscordConfig, userId: string, guildId: string): Promise<GuildStatus> {
  const g = await guildAccess(db, userId, guildId);
  return statusOf(db, cfg, g, []);
}

/** Re-checks the bot's permissions (after the organiser fixed them in Discord). Re-enables the guild when they are fine. */
export async function reverifyGuild(db: D1Database, cfg: DiscordConfig, userId: string, guildId: string): Promise<GuildStatus> {
  const rest = restOf(cfg);
  const g = await guildAccess(db, userId, guildId);
  const { missing } = await checkBot(rest, cfg, g.guildId);
  await repo.setPermissionsOk(db, g.guildId, missing.length === 0);
  return statusOf(db, cfg, (await repo.findGuild(db, g.guildId))!, missing);
}

export async function setCategory(db: D1Database, cfg: DiscordConfig, userId: string, eventId: string, b: Record<string, unknown>) {
  const rest = restOf(cfg);
  const access = await organiser(db, userId, eventId, true);
  const t = await repo.tournamentCtxByEvent(db, access.eventId);
  if (!t) throw new HttpError(404, "No tournament page for this event");
  if (!t.guildId) throw new HttpError(409, "Link a Discord server to this tournament first", { code: "no_guild" });
  if (typeof b.categoryId !== "string" || !SNOWFLAKE.test(b.categoryId)) throw bad("categoryId must be a Discord category id (17 to 20 digits)", "invalid_categoryId");
  let ch;
  try {
    ch = await rest.getChannel(b.categoryId);
  } catch (e) {
    if (e instanceof DiscordError && e.kind === "permanent") throw bad("That category was not found. Check the id and that the bot can see it.", "category_not_found");
    throw discordFailure(e);
  }
  if (!ch || ch.type !== 4 || ch.guild_id !== t.guildId) throw bad("That id is not a category of the linked server", "category_not_in_guild");
  await repo.setTournamentCategory(db, t.id, ch.id, nowSec());
  return { guildId: t.guildId, categoryId: ch.id };
}

export async function getEventDiscord(db: D1Database, cfg: DiscordConfig, userId: string, eventId: string) {
  const access = await organiser(db, userId, eventId, false);
  const t = await repo.tournamentCtxByEvent(db, access.eventId);
  if (!t) throw new HttpError(404, "No tournament page for this event");
  const guild = t.guildId ? await repo.findGuild(db, t.guildId) : null;
  return {
    configured: configured(cfg), guildId: t.guildId, categoryId: t.categoryId, permissionsOk: guild?.permissionsOk ?? false,
    settings: await repo.getSettings(db, t.id), queue: t.guildId ? await repo.outboxCounts(db, t.guildId) : {}, inviteUrl: inviteUrl(cfg),
  };
}

export async function putSettings(db: D1Database, userId: string, eventId: string, b: Record<string, unknown>) {
  const access = await organiser(db, userId, eventId, true);
  const t = await repo.tournamentCtxByEvent(db, access.eventId);
  if (!t) throw new HttpError(404, "No tournament page for this event");
  const cur = await repo.getSettings(db, t.id);
  if (b.lobbyPingEnabled !== undefined && typeof b.lobbyPingEnabled !== "boolean") throw bad("lobbyPingEnabled must be true or false", "invalid_lobbyPingEnabled");
  if (b.archiveMode !== undefined && b.archiveMode !== "readonly" && b.archiveMode !== "delete") throw bad("archiveMode must be readonly or delete", "invalid_archiveMode");
  const next = { lobbyPingEnabled: (b.lobbyPingEnabled as boolean | undefined) ?? cur.lobbyPingEnabled, archiveMode: (b.archiveMode as "readonly" | "delete" | undefined) ?? cur.archiveMode };
  await repo.putSettings(db, t.id, next, nowSec());
  return next;
}

// ---------------- /link ----------------
/** A fresh single-use code for the signed-in user (10 minutes; a new code replaces the old one). Only its hash is stored. */
export async function createLinkCode(db: D1Database, userId: string) {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  const code = [...bytes].map((x) => CODE_ALPHABET[x % CODE_ALPHABET.length]).join("");
  const at = nowSec();
  await repo.putLinkCode(db, userId, await sha256(`dlink:${code}`), at + LINK_CODE_TTL_SEC, at);
  return { code, expiresInSeconds: LINK_CODE_TTL_SEC, command: `/link ${code}` };
}
export async function linkStatus(db: D1Database, userId: string) {
  return { linked: (await repo.getDiscordUserId(db, userId)) !== null };
}
/** Deterministic key of a role removal: the same registration, account and Discord id at the same unlink moment is one job, however often it is queued. */
export const removeRoleKey = (registrationId: string, userId: string, discordUserId: string, at: number): string => `remove_team_role:${registrationId}:${userId}:${discordUserId}:${at}`;

/**
 * Unlinking clears the Discord id and queues one `assign_team_role` job with remove:true per team role the user held (outbox, so it is retried and never
 * duplicated). The Discord id travels in the job payload only until the job is done (then it is scrubbed). Failing to queue never blocks the unlink.
 */
export async function unlinkDiscord(db: D1Database, userId: string) {
  const discordUserId = await repo.getDiscordUserId(db, userId);
  let jobs: repo.JobInsert[] = [];
  if (discordUserId) {
    try {
      const at = nowSec();
      jobs = (await repo.rolesOfCaptain(db, userId)).map((c) => job("assign_team_role", c.guildId, { registrationId: c.registrationId, userId, discordUserId, remove: true }, removeRoleKey(c.registrationId, userId, discordUserId, at), at));
    } catch {
      console.warn("discord: could not look up roles to remove");
    }
  }
  await repo.setDiscordUserId(db, userId, null);
  if (jobs.length) {
    try {
      await repo.enqueue(db, jobs, nowSec());
    } catch {
      console.warn("discord: could not queue role removal after unlink");
    }
  }
  return { linked: false };
}

export type LinkResult = "linked" | "bad_code" | "taken";
/** Used by the interactions endpoint. A late link also queues the role for the user's team channels (failure to queue never fails the link). */
export async function completeLink(db: D1Database, discordUserId: string, rawCode: string): Promise<LinkResult> {
  const code = rawCode.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 8) return "bad_code";
  const userId = await repo.consumeLinkCode(db, await sha256(`dlink:${code}`), nowSec());
  if (!userId) return "bad_code";
  if (!(await repo.setDiscordUserId(db, userId, discordUserId))) return "taken";
  try {
    const jobs = (await repo.channelsOfCaptain(db, userId)).map((c) => job("assign_team_role", c.guildId, { registrationId: c.registrationId, userId }, `assign_team_role:${c.registrationId}:u:${discordUserId}:${nowSec()}`, nowSec()));
    if (jobs.length) await repo.enqueue(db, jobs, nowSec());
  } catch {
    console.warn("discord: could not queue role after link");
  }
  return "linked";
}

// ---------------- outbox producers ----------------
const job = (kind: OutboxKind, guildId: string, payload: Record<string, unknown>, key: string, runAfter: number): repo.JobInsert => ({ id: newId(), kind, guildId, payload, key, runAfter });

/**
 * THE hook the legacy approval route calls. It can never throw: flag off, tables missing, no server or category set, a database error: all are swallowed
 * (the approval has already been committed). The job key is deterministic, so calling it twice, or running "sync" later, never makes a second job.
 * Returns true only when a job was newly queued (tests use it).
 */
export async function onRegistrationApproved(db: D1Database, eventId: string, registrationId: string): Promise<boolean> {
  try {
    if (!(await discordEnabled(db))) return false;
    const t = await repo.tournamentCtxByEvent(db, eventId);
    if (!t || !t.guildId || !t.categoryId) return false;
    const g = await repo.findGuild(db, t.guildId);
    if (!g || !g.permissionsOk) return false;
    return (await repo.enqueue(db, [job("create_team_channel", t.guildId, { registrationId }, `create_team_channel:${registrationId}`, nowSec())], nowSec())) > 0;
  } catch {
    console.warn("discord: approval hook failed (approval is not affected)");
    return false;
  }
}

/** Organiser button: queue channels for approved teams that approved before the server/category were set (or whose hook was missed). Idempotent. */
export async function syncApproved(db: D1Database, userId: string, eventId: string) {
  const access = await organiser(db, userId, eventId, true);
  const t = await readyTournament(db, access.eventId);
  const ids = await repo.approvedRegistrationIds(db, t.eventId);
  const queued = await repo.enqueue(db, ids.map((id) => job("create_team_channel", t.guildId!, { registrationId: id }, `create_team_channel:${id}`, nowSec())), nowSec());
  return { approved: ids.length, queued };
}

async function readyTournament(db: D1Database, eventId: string): Promise<repo.TournamentCtx> {
  const t = await repo.tournamentCtxByEvent(db, eventId);
  if (!t) throw new HttpError(404, "No tournament page for this event");
  if (!t.guildId || !t.categoryId) throw new HttpError(409, "Link a Discord server and pick a category first", { code: "discord_not_set_up" });
  const g = await repo.findGuild(db, t.guildId);
  if (!g?.permissionsOk) throw new HttpError(409, "The bot is missing permissions in that server", { code: "bot_permissions" });
  return t;
}

/** Lobby ping for every team channel at `at` (default now, at most 30 days ahead). Only when the organiser switched lobby pings on. */
export async function queueLobbyPing(db: D1Database, userId: string, eventId: string, b: Record<string, unknown>) {
  const access = await organiser(db, userId, eventId, true);
  const t = await readyTournament(db, access.eventId);
  if (!(await repo.getSettings(db, t.id)).lobbyPingEnabled) throw new HttpError(409, "Lobby pings are switched off for this tournament", { code: "lobby_ping_disabled" });
  const now = nowSec();
  let at = now;
  if (b.at !== undefined && b.at !== null) {
    const ms = typeof b.at === "string" ? Date.parse(b.at) : NaN;
    if (!Number.isFinite(ms)) throw bad("at must be an ISO date-time", "invalid_at");
    at = Math.floor(ms / 1000);
    if (at < now - 60 || at > now + 30 * 86_400) throw bad("at must be within the next 30 days", "invalid_at");
    at = Math.max(at, now);
  }
  const regs = await repo.liveChannelRegistrations(db, t.eventId);
  const queued = await repo.enqueue(db, regs.map((r) => job("ping_lobby", r.guildId, { registrationId: r.registrationId }, `ping_lobby:${r.registrationId}:${at}`, at)), now);
  return { channels: regs.length, queued, runsAt: new Date(at * 1000).toISOString() };
}

/** Result announcement in every team channel (once per hour at most per team: the hour is in the idempotency key). */
export async function queueResults(db: D1Database, userId: string, eventId: string) {
  const access = await organiser(db, userId, eventId, true);
  const t = await readyTournament(db, access.eventId);
  if (t.status !== "live" && t.status !== "completed") throw new HttpError(409, "Results can be posted once the tournament is live", { code: "tournament_not_live" });
  const now = nowSec();
  const hour = Math.floor(now / 3600);
  const regs = await repo.liveChannelRegistrations(db, t.eventId);
  const queued = await repo.enqueue(db, regs.map((r) => job("post_result", r.guildId, { registrationId: r.registrationId }, `post_result:${r.registrationId}:${hour}`, now)), now);
  return { channels: regs.length, queued };
}

/** Called by the tournament state machine when a tournament becomes `completed`. Never throws. */
export async function onTournamentCompleted(db: D1Database, eventId: string): Promise<void> {
  try {
    if (!(await discordEnabled(db))) return;
    const t = await repo.tournamentCtxByEvent(db, eventId);
    if (!t?.guildId) return;
    const regs = await repo.liveChannelRegistrations(db, eventId);
    const now = nowSec();
    await repo.enqueue(db, regs.map((r) => job("archive_channels", r.guildId, { registrationId: r.registrationId }, `archive_channels:${r.registrationId}`, now)), now);
  } catch {
    console.warn("discord: archive queue failed (the status change is not affected)");
  }
}

/** The three secrets are Worker secrets (never in wrangler.toml, never logged). Absent = Discord is not configured. */
export const discordConfigFromEnv = (env: { DISCORD_BOT_TOKEN?: string; DISCORD_PUBLIC_KEY?: string; DISCORD_APP_ID?: string; APP_URL?: string }): DiscordConfig => ({
  token: env.DISCORD_BOT_TOKEN || undefined,
  publicKey: env.DISCORD_PUBLIC_KEY || undefined,
  appId: env.DISCORD_APP_ID || undefined,
  appUrl: env.APP_URL || "https://esports.streamerosai.com",
});
