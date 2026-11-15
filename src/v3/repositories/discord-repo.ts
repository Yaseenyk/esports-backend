/**
 * Discord stage tables: discord_guilds, discord_outbox, v3_registration_discord, discord_link_codes, v3_discord_settings, plus the reads and the two
 * writes on legacy rows it needs (tournaments.discord_*, users.discord_user_id). The only place these tables are queried. Plain SQL, constant text,
 * every value bound. Decides nothing about who may see a row.
 */
import type { OutboxKind } from "../lib/enums";

// ---------------- guilds ----------------
export interface GuildRow { guildId: string; installedByUserId: string | null; permissionsOk: boolean; installedAt: number }
export async function findGuild(db: D1Database, guildId: string): Promise<GuildRow | null> {
  const r = await db.prepare("SELECT guild_id, installed_by_user_id, permissions_ok, installed_at FROM discord_guilds WHERE guild_id = ?1").bind(guildId)
    .first<{ guild_id: string; installed_by_user_id: string | null; permissions_ok: number; installed_at: number }>();
  return r ? { guildId: r.guild_id, installedByUserId: r.installed_by_user_id, permissionsOk: !!r.permissions_ok, installedAt: r.installed_at } : null;
}
/** Inserts the guild or refreshes `permissions_ok`; an existing installer is kept (an orphaned row, installer deleted, is adopted by the caller). */
export async function upsertGuild(db: D1Database, guildId: string, userId: string, permissionsOk: boolean, at: number): Promise<void> {
  await db.prepare(
    "INSERT INTO discord_guilds (guild_id, installed_by_user_id, permissions_ok, installed_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(guild_id) DO UPDATE SET permissions_ok = ?3, installed_by_user_id = COALESCE(installed_by_user_id, ?2)",
  ).bind(guildId, userId, permissionsOk ? 1 : 0, at).run();
}
export async function setPermissionsOk(db: D1Database, guildId: string, ok: boolean): Promise<void> {
  await db.prepare("UPDATE discord_guilds SET permissions_ok = ?2 WHERE guild_id = ?1").bind(guildId, ok ? 1 : 0).run();
}
export async function tournamentsOfGuild(db: D1Database, guildId: string): Promise<{ eventId: string; slug: string; categoryId: string | null }[]> {
  const r = await db.prepare("SELECT event_id, slug, discord_category_id FROM tournaments WHERE discord_guild_id = ?1 ORDER BY slug LIMIT 50").bind(guildId)
    .all<{ event_id: string; slug: string; discord_category_id: string | null }>();
  return r.results.map((x) => ({ eventId: x.event_id, slug: x.slug, categoryId: x.discord_category_id }));
}
/** Points the tournament wrapper at a guild. Changing the guild clears the category (a category belongs to one guild). */
export async function setTournamentGuild(db: D1Database, tournamentId: string, guildId: string, at: number): Promise<void> {
  await db.prepare("UPDATE tournaments SET discord_category_id = CASE WHEN discord_guild_id IS ?2 THEN discord_category_id ELSE NULL END, discord_guild_id = ?2, updated_at = ?3 WHERE id = ?1")
    .bind(tournamentId, guildId, at).run();
}
export async function setTournamentCategory(db: D1Database, tournamentId: string, categoryId: string, at: number): Promise<void> {
  await db.prepare("UPDATE tournaments SET discord_category_id = ?2, updated_at = ?3 WHERE id = ?1").bind(tournamentId, categoryId, at).run();
}

// ---------------- settings ----------------
export interface SettingsRow { lobbyPingEnabled: boolean; archiveMode: "readonly" | "delete" }
export async function getSettings(db: D1Database, tournamentId: string): Promise<SettingsRow> {
  const r = await db.prepare("SELECT lobby_ping_enabled, archive_mode FROM v3_discord_settings WHERE tournament_id = ?1").bind(tournamentId)
    .first<{ lobby_ping_enabled: number; archive_mode: string }>();
  return { lobbyPingEnabled: !!r?.lobby_ping_enabled, archiveMode: r?.archive_mode === "delete" ? "delete" : "readonly" };
}
export async function putSettings(db: D1Database, tournamentId: string, s: SettingsRow, at: number): Promise<void> {
  await db.prepare(
    "INSERT INTO v3_discord_settings (tournament_id, lobby_ping_enabled, archive_mode, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(tournament_id) DO UPDATE SET lobby_ping_enabled = ?2, archive_mode = ?3, updated_at = ?4",
  ).bind(tournamentId, s.lobbyPingEnabled ? 1 : 0, s.archiveMode, at).run();
}

// ---------------- outbox ----------------
export interface JobInsert { id: string; kind: OutboxKind; guildId: string; payload: Record<string, unknown>; key: string; runAfter: number }
export interface JobRow { id: string; kind: OutboxKind; guildId: string; payload: string; key: string; attempts: number; runAfter: number }

const insertJob = (db: D1Database, j: JobInsert, at: number): D1PreparedStatement =>
  db.prepare("INSERT OR IGNORE INTO discord_outbox (id, kind, guild_id, payload, idempotency_key, status, attempts, run_after, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?7, ?7)")
    .bind(j.id, j.kind, j.guildId, JSON.stringify(j.payload), j.key, j.runAfter, at);

/** Returns how many jobs were really inserted (a repeated idempotency key inserts nothing). Chunks of 50 statements per batch. */
export async function enqueue(db: D1Database, jobs: JobInsert[], at: number): Promise<number> {
  let n = 0;
  for (let i = 0; i < jobs.length; i += 50) {
    const res = await db.batch(jobs.slice(i, i + 50).map((j) => insertJob(db, j, at)));
    for (const r of res) n += r.meta.changes ?? 0;
  }
  return n;
}
export async function dueJobs(db: D1Database, now: number, limit: number): Promise<JobRow[]> {
  const r = await db.prepare("SELECT id, kind, guild_id, payload, idempotency_key, attempts, run_after FROM discord_outbox WHERE status = 'pending' AND run_after <= ?1 AND guild_id IN (SELECT guild_id FROM discord_guilds WHERE permissions_ok = 1) ORDER BY run_after, created_at, id LIMIT ?2")
    .bind(now, limit).all<{ id: string; kind: OutboxKind; guild_id: string; payload: string; idempotency_key: string; attempts: number; run_after: number }>();
  return r.results.map((x) => ({ id: x.id, kind: x.kind, guildId: x.guild_id, payload: x.payload, key: x.idempotency_key, attempts: x.attempts, runAfter: x.run_after }));
}
/** pending -> running in ONE statement; true only for the invocation that won it. */
export async function lockJob(db: D1Database, id: string, at: number): Promise<boolean> {
  const r = await db.prepare("UPDATE discord_outbox SET status = 'running', attempts = attempts + 1, updated_at = ?2 WHERE id = ?1 AND status = 'pending'").bind(id, at).run();
  return (r.meta.changes ?? 0) === 1;
}
export async function markDone(db: D1Database, id: string, at: number): Promise<void> {
  await db.prepare("UPDATE discord_outbox SET status = 'done', last_error = NULL, updated_at = ?2 WHERE id = ?1").bind(id, at).run();
}
/** Back to pending for a later run. `refund` gives the attempt back (rate limit, budget: nothing was wrong with the job). */
export async function reschedule(db: D1Database, id: string, runAfter: number, error: string | null, refund: boolean, at: number): Promise<void> {
  await db.prepare("UPDATE discord_outbox SET status = 'pending', run_after = ?2, last_error = ?3, attempts = CASE WHEN ?4 = 1 AND attempts > 0 THEN attempts - 1 ELSE attempts END, updated_at = ?5 WHERE id = ?1")
    .bind(id, runAfter, error, refund ? 1 : 0, at).run();
}
export async function markDead(db: D1Database, id: string, error: string, at: number): Promise<void> {
  await db.prepare("UPDATE discord_outbox SET status = 'dead', last_error = ?2, updated_at = ?3 WHERE id = ?1").bind(id, error, at).run();
}
/** A job left `running` by an invocation that died: back to pending. Returns how many. */
export async function recoverStuck(db: D1Database, olderThan: number, at: number): Promise<number> {
  const r = await db.prepare("UPDATE discord_outbox SET status = 'pending', updated_at = ?2 WHERE status = 'running' AND updated_at < ?1").bind(olderThan, at).run();
  return r.meta.changes ?? 0;
}
export async function outboxCounts(db: D1Database, guildId: string): Promise<Record<string, number>> {
  const r = await db.prepare("SELECT status, COUNT(*) AS n FROM discord_outbox WHERE guild_id = ?1 GROUP BY status").bind(guildId).all<{ status: string; n: number }>();
  return Object.fromEntries(r.results.map((x) => [x.status, x.n]));
}
export async function outboxTablesExist(db: D1Database): Promise<boolean> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('discord_outbox','v3_registration_discord','discord_link_codes','v3_discord_settings')").first<{ n: number }>();
  return (r?.n ?? 0) === 4;
}

// ---------------- what the bot created for a registration ----------------
export interface RegDiscord { registrationId: string; eventId: string; guildId: string; roleId: string | null; channelId: string | null; introPostedAt: number | null; archivedAt: number | null }
export async function getRegDiscord(db: D1Database, registrationId: string): Promise<RegDiscord | null> {
  const r = await db.prepare("SELECT registration_id, event_id, guild_id, role_id, channel_id, intro_posted_at, archived_at FROM v3_registration_discord WHERE registration_id = ?1").bind(registrationId)
    .first<{ registration_id: string; event_id: string; guild_id: string; role_id: string | null; channel_id: string | null; intro_posted_at: number | null; archived_at: number | null }>();
  return r ? { registrationId: r.registration_id, eventId: r.event_id, guildId: r.guild_id, roleId: r.role_id, channelId: r.channel_id, introPostedAt: r.intro_posted_at, archivedAt: r.archived_at } : null;
}
/** Records ids as soon as Discord returned them. Never overwrites an id that is already stored (first one wins). */
export async function recordIds(db: D1Database, p: { registrationId: string; eventId: string; guildId: string; roleId?: string; channelId?: string }, at: number): Promise<void> {
  await db.prepare(
    "INSERT INTO v3_registration_discord (registration_id, event_id, guild_id, role_id, channel_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6) ON CONFLICT(registration_id) DO UPDATE SET role_id = COALESCE(role_id, ?4), channel_id = COALESCE(channel_id, ?5), updated_at = ?6",
  ).bind(p.registrationId, p.eventId, p.guildId, p.roleId ?? null, p.channelId ?? null, at).run();
}
export async function markIntroPosted(db: D1Database, registrationId: string, at: number): Promise<void> {
  await db.prepare("UPDATE v3_registration_discord SET intro_posted_at = ?2, updated_at = ?2 WHERE registration_id = ?1").bind(registrationId, at).run();
}
export async function markArchived(db: D1Database, registrationId: string, at: number): Promise<void> {
  await db.prepare("UPDATE v3_registration_discord SET archived_at = ?2, updated_at = ?2 WHERE registration_id = ?1").bind(registrationId, at).run();
}
export async function liveChannelRegistrations(db: D1Database, eventId: string): Promise<{ registrationId: string; guildId: string }[]> {
  const r = await db.prepare("SELECT registration_id, guild_id FROM v3_registration_discord WHERE event_id = ?1 AND channel_id IS NOT NULL AND archived_at IS NULL ORDER BY registration_id LIMIT 1100")
    .bind(eventId).all<{ registration_id: string; guild_id: string }>();
  return r.results.map((x) => ({ registrationId: x.registration_id, guildId: x.guild_id }));
}

export interface RegContext { id: string; eventId: string; teamName: string; status: string }
export async function registrationContext(db: D1Database, registrationId: string): Promise<RegContext | null> {
  const r = await db.prepare("SELECT id, event_id, team_name, status FROM registrations WHERE id = ?1").bind(registrationId).first<{ id: string; event_id: string; team_name: string; status: string }>();
  return r ? { id: r.id, eventId: r.event_id, teamName: r.team_name, status: r.status } : null;
}
export async function approvedRegistrationIds(db: D1Database, eventId: string): Promise<string[]> {
  const r = await db.prepare("SELECT id FROM registrations WHERE event_id = ?1 AND status = 'approved' ORDER BY created_at, id LIMIT 1100").bind(eventId).all<{ id: string }>();
  return r.results.map((x) => x.id);
}
/** Captains of a team (accounts that claimed the team) with their linked Discord id, if any. The name is the account display name. */
export async function captainsOfTeam(db: D1Database, eventId: string, teamName: string): Promise<{ userId: string; name: string; discordUserId: string | null }[]> {
  const r = await db.prepare("SELECT u.id AS id, u.name AS name, u.discord_user_id AS d FROM v3_team_captains c JOIN users u ON u.id = c.user_id WHERE c.event_id = ?1 AND c.team_key = lower(?2) ORDER BY c.created_at LIMIT 12")
    .bind(eventId, teamName).all<{ id: string; name: string; d: string | null }>();
  return r.results.map((x) => ({ userId: x.id, name: x.name, discordUserId: x.d }));
}
/** The caller's own team channels (they captain an approved registration that has a live channel). */
export async function channelsOfCaptain(db: D1Database, userId: string): Promise<{ registrationId: string; guildId: string; channelId: string; teamName: string; title: string }[]> {
  const r = await db.prepare(
    "SELECT rd.registration_id AS rid, rd.guild_id AS g, rd.channel_id AS ch, r.team_name AS team, t.title AS title FROM v3_team_captains c JOIN registrations r ON r.event_id = c.event_id AND lower(r.team_name) = c.team_key AND r.status = 'approved' JOIN v3_registration_discord rd ON rd.registration_id = r.id JOIN tournaments t ON t.event_id = c.event_id WHERE c.user_id = ?1 AND rd.channel_id IS NOT NULL AND rd.archived_at IS NULL ORDER BY rd.created_at LIMIT 10",
  ).bind(userId).all<{ rid: string; g: string; ch: string; team: string; title: string }>();
  return r.results.map((x) => ({ registrationId: x.rid, guildId: x.g, channelId: x.ch, teamName: x.team, title: x.title }));
}

/** Every team role the bot made for a team this user captains (channel archived or not): what an unlink must take back. */
export async function rolesOfCaptain(db: D1Database, userId: string): Promise<{ registrationId: string; guildId: string }[]> {
  const r = await db.prepare(
    "SELECT rd.registration_id AS rid, rd.guild_id AS g FROM v3_team_captains c JOIN registrations r ON r.event_id = c.event_id AND lower(r.team_name) = c.team_key JOIN v3_registration_discord rd ON rd.registration_id = r.id WHERE c.user_id = ?1 AND rd.role_id IS NOT NULL ORDER BY rd.created_at LIMIT 50",
  ).bind(userId).all<{ rid: string; g: string }>();
  return r.results.map((x) => ({ registrationId: x.rid, guildId: x.g }));
}
/** Drops the Discord id from a finished removal job: it is only kept until the role is gone. */
export async function scrubPayload(db: D1Database, id: string, payload: Record<string, unknown>): Promise<void> {
  await db.prepare("UPDATE discord_outbox SET payload = ?2 WHERE id = ?1").bind(id, JSON.stringify(payload)).run();
}

export interface JobContext { reg: RegContext; t: TournamentCtx | null; rd: RegDiscord | null }
/** Everything a drain job needs about one registration in ONE statement (registration + tournament wrapper + what the bot already created). */
export async function jobContext(db: D1Database, registrationId: string): Promise<JobContext | null> {
  const r = await db.prepare(
    "SELECT r.id AS rid, r.event_id AS eid, r.team_name AS team, r.status AS rstatus, t.id AS tid, t.slug AS slug, t.title AS title, t.status AS tstatus, t.discord_guild_id AS tg, t.discord_category_id AS tc, d.guild_id AS dg, d.role_id AS role_id, d.channel_id AS channel_id, d.intro_posted_at AS intro, d.archived_at AS archived FROM registrations r LEFT JOIN tournaments t ON t.event_id = r.event_id LEFT JOIN v3_registration_discord d ON d.registration_id = r.id WHERE r.id = ?1",
  ).bind(registrationId).first<Record<string, string | number | null>>();
  if (!r) return null;
  return {
    reg: { id: r.rid as string, eventId: r.eid as string, teamName: r.team as string, status: r.rstatus as string },
    t: r.tid ? { id: r.tid as string, eventId: r.eid as string, slug: r.slug as string, title: r.title as string, status: r.tstatus as string, guildId: r.tg as string | null, categoryId: r.tc as string | null } : null,
    rd: r.dg ? { registrationId: r.rid as string, eventId: r.eid as string, guildId: r.dg as string, roleId: r.role_id as string | null, channelId: r.channel_id as string | null, introPostedAt: r.intro as number | null, archivedAt: r.archived as number | null } : null,
  };
}

export interface TournamentCtx { id: string; eventId: string; slug: string; title: string; status: string; guildId: string | null; categoryId: string | null }
export async function tournamentCtxByEvent(db: D1Database, eventId: string): Promise<TournamentCtx | null> {
  const r = await db.prepare("SELECT id, event_id, slug, title, status, discord_guild_id, discord_category_id FROM tournaments WHERE event_id = ?1").bind(eventId)
    .first<{ id: string; event_id: string; slug: string; title: string; status: string; discord_guild_id: string | null; discord_category_id: string | null }>();
  return r ? { id: r.id, eventId: r.event_id, slug: r.slug, title: r.title, status: r.status, guildId: r.discord_guild_id, categoryId: r.discord_category_id } : null;
}

// ---------------- /link ----------------
export async function putLinkCode(db: D1Database, userId: string, codeHash: string, expiresAt: number, at: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM discord_link_codes WHERE expires_at < ?1").bind(at),
    db.prepare("INSERT INTO discord_link_codes (user_id, code_hash, expires_at, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(user_id) DO UPDATE SET code_hash = ?2, expires_at = ?3, created_at = ?4").bind(userId, codeHash, expiresAt, at),
  ]);
}
/** Single use: deleting is the check, so two racing /link commands cannot both succeed. Returns the user id, or null when unknown or expired. */
export async function consumeLinkCode(db: D1Database, codeHash: string, now: number): Promise<string | null> {
  const r = await db.prepare("DELETE FROM discord_link_codes WHERE code_hash = ?1 AND expires_at > ?2 RETURNING user_id").bind(codeHash, now).first<{ user_id: string }>();
  return r?.user_id ?? null;
}
/** false when that Discord account is already linked to another user (unique index). */
export async function setDiscordUserId(db: D1Database, userId: string, discordUserId: string | null): Promise<boolean> {
  try {
    await db.prepare("UPDATE users SET discord_user_id = ?2 WHERE id = ?1").bind(userId, discordUserId).run();
    return true;
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e) + String((e as { cause?: unknown }).cause ?? ""))) return false;
    throw e;
  }
}
export async function getDiscordUserId(db: D1Database, userId: string): Promise<string | null> {
  const r = await db.prepare("SELECT discord_user_id FROM users WHERE id = ?1").bind(userId).first<{ discord_user_id: string | null }>();
  return r?.discord_user_id ?? null;
}
export async function findUserIdByDiscord(db: D1Database, discordUserId: string): Promise<string | null> {
  const r = await db.prepare("SELECT id FROM users WHERE discord_user_id = ?1").bind(discordUserId).first<{ id: string }>();
  return r?.id ?? null;
}
