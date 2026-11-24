/**
 * Account deletion for the v3 tables. Called by the existing DELETE /auth/account flow (src/routes/auth.ts) BEFORE the users row is deleted, in the same batch.
 *
 * What happens to a user's v3 rows:
 *  - player_profiles, player_games, lft_listings (and their applications and reports), lft_applications, v3_team_captains: deleted by ON DELETE CASCADE.
 *  - disputes the user RAISED: the row and its history stay (the other team and the organiser need them) but every personal pointer goes: the raiser id is
 *    nulled by the foreign key, the free text the user wrote (summary, event notes, captions, resolution note if they resolved it) is replaced by "[deleted]",
 *    and every screenshot THEY uploaded is deleted (blob and caption; the metadata row keeps purged_at).
 *  - dispute_events actor ids are nulled by the foreign key (the append-only trigger allows exactly that change).
 *  - reports the user filed on LFT listings are deleted (the reporter key is a hash of the account id).
 *  - discord_guilds.installed_by_user_id and v3_result_corrections.applied_by are nulled by their foreign keys.
 *  - Phases 3-5 (migration 0056): profile hidden items, team page settings, scrim slots, requests and blocks cascade with the account (team pages go with
 *    their legacy team_profiles row); reports the user filed (profiles, scrims) are deleted; reports and moderation rows ABOUT the user's profile and team
 *    pages are deleted; seats the user held on other captains' scrim slots are given back.
 * Does nothing (and costs one read) when the v3 tables are not migrated yet.
 */
import { accountDeletionStatements, v3TablesExist } from "../repositories/maintenance-repo";
import { feedbackTablesExist, accountDeletionStatements as feedbackDeletionStatements } from "../repositories/feedback-repo";
import { nowSec } from "../lib/ids";
import { lftReporterHash, profileReporterHash, scrimReporterHash } from "../lib/reporter";
import { accountDeletionStatements as showcaseDeletionStatements, showcaseTablesExist } from "../repositories/showcase-repo";
import { accountDeletionStatements as scrimDeletionStatements, scrimTablesExist } from "../repositories/scrim-repo";

export async function v3AccountDeletionStatements(env: { DB: D1Database; HASH_KEY?: string; JWT_SECRET: string }, userId: string): Promise<D1PreparedStatement[]> {
  const out: D1PreparedStatement[] = [];
  // Feedback bot (migration 0054): reports linked to this account are DELETED with their screenshots, not just unlinked.
  if (await feedbackTablesExist(env.DB)) out.push(...feedbackDeletionStatements(env.DB, userId));
  if (await v3TablesExist(env.DB)) out.push(...accountDeletionStatements(env.DB, userId, nowSec(), await lftReporterHash(env, userId)));
  if (await showcaseTablesExist(env.DB)) out.push(...showcaseDeletionStatements(env.DB, userId, await profileReporterHash(env, userId)));
  if (await scrimTablesExist(env.DB)) out.push(...scrimDeletionStatements(env.DB, userId, await scrimReporterHash(env, userId)));
  return out;
}
