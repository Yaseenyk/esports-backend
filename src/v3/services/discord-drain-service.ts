/**
 * The outbox drain (called from the every-15-minutes cron, and directly in tests).
 *
 * Order of refusals, cheapest first, none of them an error:
 *   1. flag v3.discord off            -> nothing is read or written (one cached flags read)
 *   2. bot token / app id not set     -> clean no-op, jobs stay `pending` (the owner has not created the Discord application yet)
 *   3. Discord tables not migrated    -> no-op
 * Then: due jobs of guilds whose permissions are ok are locked one by one (pending -> running in a single UPDATE), executed against a thin REST client, and
 * finished: done, rescheduled (429 with Retry-After, 5xx and network errors with exponential backoff, budget) or dead (permanent 4xx, or the 5th failed attempt).
 *
 * Bounds per tick (free plan: 50 subrequests and 50 D1 queries per Worker invocation, shared with the mail reminders and housekeeping in the same cron run):
 *   at most MAX_JOBS jobs, at most MAX_CALLS Discord calls, and the loop stops starting jobs once QUERY_BUDGET statements have been prepared.
 */
import { DiscordError, DiscordRest, PERM } from "../discord/rest-client";
import { countingDb } from "../discord/budget";
import { newId, nowSec } from "../lib/ids";
import * as repo from "../repositories/discord-repo";
import { discordEnabled } from "../repositories/flag-repo";
import { configured, type DiscordConfig } from "./discord-service";

export const MAX_JOBS = 10;
export const MAX_CALLS = 25;
export const QUERY_BUDGET = 24;
export const MAX_ATTEMPTS = 5;
export const STUCK_AFTER_SEC = 600;
const PAUSE_SEC = 3600;

export interface DrainResult {
  ran: boolean;
  reason?: "flag_off" | "not_configured" | "tables_missing";
  jobs: number;
  done: number;
  retried: number;
  dead: number;
  calls: number;
  queries: number;
}

/** A job that can never succeed (the registration is gone, the tournament lost its category): dead, with a fixed phrase. */
class JobFatal extends Error {}
/** The thing a job waits for is not there yet (the channel from the create job): try again soon, counts as an attempt. */
class JobNotReady extends Error {}

const backoff = (attempts: number): number => Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600);
const slug = (s: string, max: number): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max).replace(/-+$/g, "");
const READ_HISTORY = 1n << 16n;

export async function runDiscordDrain(
  rawDb: D1Database,
  cfg: DiscordConfig,
  opts: { now?: number; maxJobs?: number; maxCalls?: number; queryBudget?: number } = {},
): Promise<DrainResult> {
  const out: DrainResult = { ran: false, jobs: 0, done: 0, retried: 0, dead: 0, calls: 0, queries: 0 };
  const counted = countingDb(rawDb);
  const db = counted.db;
  const finish = (): DrainResult => ({ ...out, queries: counted.queries });
  const now = opts.now ?? nowSec();

  if (!(await discordEnabled(db))) return { ...finish(), reason: "flag_off" };
  if (!configured(cfg)) return { ...finish(), reason: "not_configured" };
  if (!(await repo.outboxTablesExist(db))) return { ...finish(), reason: "tables_missing" };
  out.ran = true;
  const rest = new DiscordRest({ token: cfg.token!, fetch: cfg.fetch, maxCalls: opts.maxCalls ?? MAX_CALLS });
  const budget = opts.queryBudget ?? QUERY_BUDGET;

  await repo.recoverStuck(db, now - STUCK_AFTER_SEC, now);
  const due = await repo.dueJobs(db, now, opts.maxJobs ?? MAX_JOBS);

  for (const j of due) {
    if (counted.queries >= budget) break;
    if (!(await repo.lockJob(db, j.id, now))) continue; // another invocation took it
    out.jobs++;
    const attempt = j.attempts + 1;
    try {
      await execute(db, rest, cfg, j);
      await repo.markDone(db, j.id, now);
      out.done++;
    } catch (e) {
      const t = now;
      if (e instanceof DiscordError && e.kind === "rate_limited") {
        await repo.reschedule(db, j.id, t + Math.max(1, e.retryAfterSec), "rate limited, retrying after the delay Discord asked for", true, t);
        out.retried++;
        break; // the limit is shared: stop this tick instead of hitting it again
      }
      if (e instanceof DiscordError && e.kind === "budget") {
        await repo.reschedule(db, j.id, t, null, true, t);
        break;
      }
      if (e instanceof DiscordError && e.kind === "permanent" && e.status === 403 && (e.discordCode === 50013 || e.discordCode === 50001)) {
        await repo.setPermissionsOk(db, j.guildId, false); // jobs of this server wait until the organiser re-verifies it
        await repo.reschedule(db, j.id, t + PAUSE_SEC, "the bot is missing permissions in this server", true, t);
        out.retried++;
        continue;
      }
      if (e instanceof JobFatal || (e instanceof DiscordError && e.kind === "permanent")) {
        await repo.markDead(db, j.id, e.message.slice(0, 160), t);
        out.dead++;
        continue;
      }
      // 5xx, network, not-ready or anything unexpected: backoff, then dead after MAX_ATTEMPTS. Only fixed phrases are stored, never e.message of an unknown error.
      const phrase = e instanceof DiscordError || e instanceof JobNotReady ? e.message : "unexpected error";
      if (attempt >= MAX_ATTEMPTS) {
        await repo.markDead(db, j.id, `gave up after ${MAX_ATTEMPTS} attempts: ${phrase}`.slice(0, 160), t);
        out.dead++;
      } else {
        await repo.reschedule(db, j.id, t + backoff(attempt), phrase.slice(0, 160), false, t);
        out.retried++;
      }
    }
  }
  out.calls = rest.calls;
  return finish();
}

interface Ctx { db: D1Database; rest: DiscordRest; cfg: DiscordConfig }

async function execute(db: D1Database, rest: DiscordRest, cfg: DiscordConfig, j: repo.JobRow): Promise<void> {
  let p: { registrationId?: unknown; userId?: unknown; discordUserId?: unknown; remove?: unknown };
  try { p = JSON.parse(j.payload); } catch { throw new JobFatal("payload is not valid"); }
  if (typeof p.registrationId !== "string") throw new JobFatal("payload has no registration");
  const jc = await repo.jobContext(db, p.registrationId);
  if (p.remove === true && j.kind === "assign_team_role") return removeTeamRole({ db, rest, cfg }, j, jc, typeof p.discordUserId === "string" ? p.discordUserId : null);
  if (!jc) throw new JobFatal("registration no longer exists");
  const c: Ctx = { db, rest, cfg };
  switch (j.kind) {
    case "create_team_channel": return createTeamChannel(c, j, jc);
    case "assign_team_role": return assignTeamRole(c, j, jc, typeof p.userId === "string" ? p.userId : null);
    case "ping_lobby": return pingLobby(c, j, jc);
    case "post_result": return postResult(c, j, jc);
    case "archive_channels": return archiveChannel(c, j, jc);
  }
}

function linkedTournament(j: repo.JobRow, jc: repo.JobContext): repo.TournamentCtx {
  if (!jc.t || jc.t.guildId !== j.guildId) throw new JobFatal("tournament is not linked to this server");
  return jc.t;
}

/** Role first, channel second, each id written to D1 the moment Discord returns it: a replay re-uses what exists and never creates a second one. */
async function createTeamChannel(c: Ctx, j: repo.JobRow, jc: repo.JobContext): Promise<void> {
  const { reg } = jc;
  if (reg.status !== "approved") throw new JobFatal("registration is not approved");
  const t = linkedTournament(j, jc);
  if (!t.categoryId) throw new JobFatal("tournament has no category");
  let roleId = jc.rd?.roleId ?? null;
  let channelId = jc.rd?.channelId ?? null;
  if (!roleId) {
    roleId = (await c.rest.createRole(j.guildId, reg.teamName.replace(/[\r\n\t]/g, " ").trim().slice(0, 60) || "Team"))!.id;
    await repo.recordIds(c.db, { registrationId: reg.id, eventId: reg.eventId, guildId: j.guildId, roleId }, nowSec());
  }
  if (!channelId) {
    const ch = await c.rest.createChannel(j.guildId, {
      name: `team-${slug(reg.teamName, 40) || "x"}`,
      type: 0,
      parent_id: t.categoryId,
      topic: `Private channel for ${reg.teamName.slice(0, 60)} in ${t.title.slice(0, 60)}`,
      permission_overwrites: [
        { id: j.guildId, type: 0, allow: "0", deny: String(PERM.VIEW_CHANNEL) }, // @everyone cannot see it
        { id: roleId, type: 0, allow: String(PERM.VIEW_CHANNEL | PERM.SEND_MESSAGES | READ_HISTORY), deny: "0" }, // the team role can
        { id: c.cfg.appId!, type: 1, allow: String(PERM.VIEW_CHANNEL | PERM.SEND_MESSAGES), deny: "0" }, // and the bot
      ],
    });
    channelId = ch!.id;
    await repo.recordIds(c.db, { registrationId: reg.id, eventId: reg.eventId, guildId: j.guildId, channelId }, nowSec());
  }
  await repo.enqueue(c.db, [{ id: newId(), kind: "assign_team_role", guildId: j.guildId, payload: { registrationId: reg.id }, key: `assign_team_role:${reg.id}:init`, runAfter: nowSec() }], nowSec());
}

/** The user unlinked Discord: take the team role back. Nothing to take back (registration gone, role never made, user not in the server) is success, not an error. */
async function removeTeamRole(c: Ctx, j: repo.JobRow, jc: repo.JobContext | null, discordUserId: string | null): Promise<void> {
  const roleId = jc?.rd?.roleId ?? null;
  if (discordUserId && roleId && jc?.rd?.guildId === j.guildId) {
    try {
      await c.rest.removeMemberRole(j.guildId, discordUserId, roleId);
    } catch (e) {
      if (!(e instanceof DiscordError && e.kind === "permanent" && e.status === 404)) throw e; // already not a member / role already gone
    }
  }
  await repo.scrubPayload(c.db, j.id, { registrationId: jc?.reg.id ?? null, remove: true, done: true });
}

async function assignTeamRole(c: Ctx, j: repo.JobRow, jc: repo.JobContext, onlyUser: string | null): Promise<void> {
  const { reg, rd } = jc;
  if (!rd?.roleId || !rd.channelId) throw new JobNotReady("team channel is not created yet");
  const captains = await repo.captainsOfTeam(c.db, reg.eventId, reg.teamName);
  const targets = onlyUser ? captains.filter((x) => x.userId === onlyUser) : captains;
  const missing: string[] = [];
  for (const m of targets) {
    if (!m.discordUserId) { missing.push(m.name); continue; }
    try {
      await c.rest.addMemberRole(j.guildId, m.discordUserId, rd.roleId);
    } catch (e) {
      if (e instanceof DiscordError && e.kind === "permanent" && e.status === 404) { missing.push(m.name); continue; } // not in the server (yet)
      throw e;
    }
  }
  if (onlyUser || rd.introPostedAt) return;
  const t = linkedTournament(j, jc);
  const lines = [`Welcome, ${reg.teamName}. This is your private channel for ${t.title}.`];
  if (captains.length === 0) lines.push("No captain has claimed this team in the app yet, so nobody has the team role. Captains: claim your team in the app, then run /link here.");
  else if (missing.length) lines.push(`These players have not linked Discord (or are not in this server): ${missing.join(", ")}. Get a code in the app and run /link.`);
  await c.rest.postMessage(rd.channelId, lines.join("\n"), `i${j.id}`.slice(0, 25));
  await repo.markIntroPosted(c.db, reg.id, nowSec());
}

const appLink = (c: Ctx, slugText: string): string => `${c.cfg.appUrl.replace(/\/$/, "")}/tournaments/${slugText}`;

async function pingLobby(c: Ctx, j: repo.JobRow, jc: repo.JobContext): Promise<void> {
  const { rd } = jc;
  if (!rd?.channelId || rd.archivedAt) return; // nothing to ping (done, not an error)
  const t = linkedTournament(j, jc);
  if (!(await repo.getSettings(c.db, t.id)).lobbyPingEnabled) return; // the organiser switched it off after queueing
  // Room id and password are stored encrypted in the legacy tables and are NEVER decrypted or sent here: the ping only points to the app.
  await c.rest.postMessage(rd.channelId, `Lobby time for ${t.title}. Lobby details are in your team page: ${appLink(c, t.slug)}`, `p${j.id}`.slice(0, 25));
}

async function postResult(c: Ctx, j: repo.JobRow, jc: repo.JobContext): Promise<void> {
  const { rd } = jc;
  if (!rd?.channelId || rd.archivedAt) return;
  const t = linkedTournament(j, jc);
  await c.rest.postMessage(rd.channelId, `Results for ${t.title} are published: ${appLink(c, t.slug)}. Disagree with a result? Use /dispute.`, `r${j.id}`.slice(0, 25));
}

async function archiveChannel(c: Ctx, j: repo.JobRow, jc: repo.JobContext): Promise<void> {
  const { reg, rd } = jc;
  if (!rd?.channelId || rd.archivedAt) return;
  const t = linkedTournament(j, jc);
  const mode = (await repo.getSettings(c.db, t.id)).archiveMode;
  try {
    if (mode === "delete") await c.rest.deleteChannel(rd.channelId);
    else if (rd.roleId) await c.rest.setOverwrite(rd.channelId, rd.roleId, String(PERM.VIEW_CHANNEL | READ_HISTORY), String(PERM.SEND_MESSAGES)); // read-only for the team
  } catch (e) {
    if (!(e instanceof DiscordError && e.kind === "permanent" && e.status === 404)) throw e; // already gone is fine
  }
  await repo.markArchived(c.db, reg.id, nowSec());
}
