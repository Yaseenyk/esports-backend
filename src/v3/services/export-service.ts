/**
 * "Download my data" for the v3 features. Called by POST /me/export (src/orgs/export.ts). It covers the same personal data that
 * services/account-service.ts deletes (the shared table list is lib/personal-tables.ts). Only the user's OWN rows are read; other people's data
 * (applications received, the other team's evidence, other reporters) is never queried. A table that is not migrated yet gives an empty section.
 * The caller shrinks the result with a TruncationLevel when the JSON would be too large; it never fails the download.
 */
import * as repo from "../repositories/export-repo";
import * as scrims from "../repositories/scrim-repo";
import * as manager from "../repositories/scrim-manager-repo";
import { feedbackRows, feedbackTablesExist, type FeedbackExportRow } from "../repositories/feedback-repo";
import { buildV3Export, MAX_TRUNCATION_LEVEL, type TruncationLevel, type V3ExportInput } from "../adapters/export-adapter";

export const V3_EXPORT_NOT_INCLUDED = [
  "screenshot images (dispute evidence and feedback attachments): only their type, size and date are listed",
  "other people's data: applications to your listings (counted only), the other team's evidence, other people's reports",
  "secrets and security data: tokens, hashes, IP-derived values, your Discord account id (only whether one is linked)",
  "reviews of your organisation that moderators hid, and who wrote a review (only the name they chose to show is listed)",
] as const;

export async function loadV3Export(db: D1Database, userId: string): Promise<V3ExportInput> {
  const t = await repo.existingTables(db);
  const has = (n: string) => t.has(n);
  const empty = <T>(): Promise<T[]> => Promise.resolve([]);
  const feedbackOk = await feedbackTablesExist(db);
  const ratingsOk = await repo.ratingTableExists(db);
  const [account, profile, games, listings, sent, disputes, evidence, captains, feedback, teamPages, playerHidden, teamHidden, slots, scrimRequests, blocks, schedules, waitlistEntries, notices] = await Promise.all([
    repo.accountRow(db, userId),
    has("player_profiles") ? repo.profileRow(db, userId) : Promise.resolve(null),
    has("player_games") ? repo.gameRows(db, userId) : empty<repo.GameRow>(),
    has("lft_listings") ? repo.listingRows(db, userId, has("lft_applications")) : empty<repo.ListingRow>(),
    has("lft_applications") ? repo.sentApplicationRows(db, userId) : empty<repo.SentApplicationRow>(),
    has("disputes") ? repo.disputeRows(db, userId) : empty<repo.DisputeRow>(),
    has("dispute_evidence") ? repo.evidenceMetaRows(db, userId) : empty<repo.EvidenceMetaRow>(),
    has("v3_team_captains") ? repo.captainRows(db, userId) : empty<repo.CaptainRow>(),
    feedbackOk ? feedbackRows(db, userId) : empty<FeedbackExportRow>(),
    has("v3_team_pages") ? repo.teamPageSettingRows(db, userId) : empty<repo.TeamPageSettingRow>(),
    has("v3_player_hidden_items") ? repo.playerHiddenRows(db, userId) : empty<{ item_key: string; created_at: number }>(),
    has("v3_team_hidden_items") ? repo.teamHiddenRows(db, userId) : empty<{ slug: string; item_key: string; created_at: number }>(),
    has("scrim_slots") ? scrims.exportSlots(db, userId) : empty<scrims.SlotExportRow>(),
    has("scrim_requests") ? scrims.exportRequests(db, userId) : empty<scrims.RequestExportRow>(),
    has("scrim_blocks") ? scrims.exportBlocks(db, userId) : empty<{ label: string; created_at: number }>(),
    has("scrim_schedules") ? manager.exportSchedules(db, userId) : empty<Awaited<ReturnType<typeof manager.exportSchedules>>[number]>(),
    has("scrim_waitlist") ? manager.exportEntries(db, userId) : empty<{ slot_id: string; status: string; created_at: number }>(),
    has("scrim_notifications") ? manager.exportNotices(db, userId) : empty<{ kind: string; created_at: number; read_at: number | null }>(),
  ]);
  const [ratingsWritten, ratingsReceived] = ratingsOk
    ? await Promise.all([repo.ratingsWrittenRows(db, userId), repo.ratingsReceivedRows(db, userId)])
    : [[] as repo.RatingWrittenRow[], [] as repo.RatingReceivedRow[]];
  return { account, profile, games, listings, sent, disputes, evidence, captains, feedback, teamPages, playerHidden, teamHidden, slots, scrimRequests, blocks, schedules, waitlistEntries, notices, ratingsWritten, ratingsReceived };
}

export { buildV3Export, MAX_TRUNCATION_LEVEL, type TruncationLevel, type V3ExportInput };
