/**
 * Server badges (flag v3.achievements). Badges come only from rows the platform recorded (see lib/badges.ts for the one list and its rules).
 *  - The verified part (tournaments, results, wins) is passed in by the player-page code, which already built it from verified rows only.
 *  - With the flag off, public pages carry `badges: []` and no badge table is read.
 *  - A badge the owner hid, or the whole section switched off with the "badges" page field, never leaves the Worker on a public payload.
 * Device-local XP (the site's XpProvider) is not a server badge and never reaches this code.
 */
import { HttpError } from "../../http";
import { BADGES, earnedBadges, isBadgeId, publicBadges, type BadgeFacts, type BadgeId } from "../lib/badges";
import { nowSec, toIso } from "../lib/ids";
import { bad } from "../lib/validate";
import * as repo from "../repositories/badge-repo";
import * as flags from "../repositories/flag-repo";
import * as users from "../repositories/user-repo";
import type { ResumeStats } from "../adapters/stats-adapter";

type Body = Record<string, unknown>;

/** What the player-page code already knows (from verified rows only). */
export interface VerifiedBase { tournaments: number; stats: ResumeStats; cardCreated: boolean }

/** Scrims are deleted 7 days after they start; the daily record looks back 8 days so none is missed. */
const RECORD_WINDOW_SEC = 8 * 86_400;

async function factsOf(db: D1Database, userId: string, base: VerifiedBase): Promise<BadgeFacts> {
  const [scrim, organised] = await Promise.all([repo.scrimPlayed(db, userId, nowSec()), repo.eventOrganised(db, userId)]);
  const s = base.stats;
  return {
    tournaments: base.tournaments,
    verifiedResults: s.matches.played + s.battleRoyale.matches,
    wins: s.matches.wins + s.battleRoyale.wins,
    scrimPlayed: scrim,
    eventOrganised: organised,
    cardCreated: base.cardCreated,
  };
}

async function earnedAndState(db: D1Database, userId: string, base: VerifiedBase) {
  const [facts, state] = await Promise.all([factsOf(db, userId, base), repo.stateRows(db, userId)]);
  const recorded = state.filter((r) => r.recorded_at !== null).map((r) => r.badge_id);
  return { earned: earnedBadges(facts, recorded), state };
}

/** The badges on a public player payload: [] when the flag is off (no badge table read), else earned and not hidden. */
export async function publicBadgesOf(db: D1Database, userId: string, base: VerifiedBase, sectionHidden: boolean): Promise<{ id: BadgeId; title: string }[]> {
  if (!(await flags.achievementsEnabled(db)) || sectionHidden) return [];
  const { earned, state } = await earnedAndState(db, userId, base);
  return publicBadges(earned, state.filter((r) => r.hidden === 1).map((r) => r.badge_id), false);
}

/** The owner's view: every badge with its rule, whether it is earned and whether it is hidden. Unearned badges show the rule to work towards. */
export async function ownBadgeView(db: D1Database, userId: string, base: VerifiedBase, sectionHidden: boolean) {
  const { earned, state } = await earnedAndState(db, userId, base);
  const st = new Map(state.map((r) => [r.badge_id, r]));
  return {
    items: BADGES.map((b) => ({ id: b.id, title: b.title, rule: b.rule, earned: earned.includes(b.id), hidden: st.get(b.id)?.hidden === 1, recordedAt: toIso(st.get(b.id)?.recorded_at ?? null) })),
    sectionHidden,
    source: "server_records" as const,
  };
}

/** PUT /v3/me/badges/hidden {badge, hidden}: the per-badge show/hide switch (allowed for a badge not earned yet, so it stays hidden when it is). */
export async function setBadgeHidden(db: D1Database, userId: string, b: Body): Promise<void> {
  if (!(await users.getUserV3(db, userId))) throw new HttpError(401, "Authentication required");
  if (!isBadgeId(b.badge)) throw bad("badge is not one of the listed badges", "invalid_badge");
  if (typeof b.hidden !== "boolean") throw bad("hidden must be true or false", "invalid_hidden");
  await repo.setHidden(db, userId, b.badge, b.hidden, nowSec());
}

/** Daily cron: records first_scrim for scrims that started recently, before their rows are deleted. Only while the flag is on; safe before 0091. */
export async function recordBadgesDaily(db: D1Database, now: number): Promise<number> {
  if (!(await flags.achievementsEnabled(db)) || !(await repo.badgeTableExists(db))) return 0;
  return repo.recordScrimBadges(db, "first_scrim", now, RECORD_WINDOW_SEC);
}
