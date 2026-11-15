/**
 * "Download my data" for the v3 features. Called by POST /me/export (src/orgs/export.ts). It covers the same personal data that
 * services/account-service.ts deletes (the shared table list is lib/personal-tables.ts). Only the user's OWN rows are read; other people's data
 * (applications received, the other team's evidence, other reporters) is never queried. A table that is not migrated yet gives an empty section.
 * The caller shrinks the result with a TruncationLevel when the JSON would be too large; it never fails the download.
 */
import * as repo from "../repositories/export-repo";
import { feedbackRows, feedbackTablesExist, type FeedbackExportRow } from "../repositories/feedback-repo";
import { buildV3Export, MAX_TRUNCATION_LEVEL, type TruncationLevel, type V3ExportInput } from "../adapters/export-adapter";

export const V3_EXPORT_NOT_INCLUDED = [
  "screenshot images (dispute evidence and feedback attachments): only their type, size and date are listed",
  "other people's data: applications to your listings (counted only), the other team's evidence, other people's reports",
  "secrets and security data: tokens, hashes, IP-derived values, your Discord account id (only whether one is linked)",
] as const;

export async function loadV3Export(db: D1Database, userId: string): Promise<V3ExportInput> {
  const t = await repo.existingTables(db);
  const has = (n: string) => t.has(n);
  const empty = <T>(): Promise<T[]> => Promise.resolve([]);
  const feedbackOk = await feedbackTablesExist(db);
  const [account, profile, games, listings, sent, disputes, evidence, captains, feedback] = await Promise.all([
    repo.accountRow(db, userId),
    has("player_profiles") ? repo.profileRow(db, userId) : Promise.resolve(null),
    has("player_games") ? repo.gameRows(db, userId) : empty<repo.GameRow>(),
    has("lft_listings") ? repo.listingRows(db, userId, has("lft_applications")) : empty<repo.ListingRow>(),
    has("lft_applications") ? repo.sentApplicationRows(db, userId) : empty<repo.SentApplicationRow>(),
    has("disputes") ? repo.disputeRows(db, userId) : empty<repo.DisputeRow>(),
    has("dispute_evidence") ? repo.evidenceMetaRows(db, userId) : empty<repo.EvidenceMetaRow>(),
    has("v3_team_captains") ? repo.captainRows(db, userId) : empty<repo.CaptainRow>(),
    feedbackOk ? feedbackRows(db, userId) : empty<FeedbackExportRow>(),
  ]);
  return { account, profile, games, listings, sent, disputes, evidence, captains, feedback };
}

export { buildV3Export, MAX_TRUNCATION_LEVEL, type TruncationLevel, type V3ExportInput };
