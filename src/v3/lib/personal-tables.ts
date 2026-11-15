/**
 * The one list of v3 tables that can hold a user's data, and what each of the two privacy rights does with it. Dependency-free.
 * Account deletion (services/account-service.ts) and "Download my data" (services/export-service.ts) must cover the same tables:
 * test/v3/export.test.ts fails when a table is added here without a decision for both, and test/v3/deletion.test.ts takes its table list from here.
 *  - deletion: what happens to the user's rows when the account is deleted.
 *  - export: "included" (the user's own rows are exported), "metadata" (only non-content facts are exported), "none" (holds no data about the user,
 *    or only other people's data / system state, so nothing is exported, with the reason in `why`).
 */
export type DeletionMode = "deleted" | "anonymised" | "unlinked" | "cascade";
export type ExportMode = "included" | "metadata" | "none";
export const V3_PERSONAL_TABLES: Record<string, { deletion: DeletionMode; export: ExportMode; why?: string }> = {
  tournaments: { deletion: "cascade", export: "none", why: "organiser-owned content that goes with the event; the user's dispute rows carry the tournament slug" },
  player_profiles: { deletion: "cascade", export: "included" },
  player_games: { deletion: "cascade", export: "included" },
  lft_listings: { deletion: "cascade", export: "included" },
  lft_applications: { deletion: "cascade", export: "included", why: "only applications the user SENT; applications received are other people's data (counts only)" },
  lft_reports: { deletion: "deleted", export: "none", why: "reporter is a one-way hash; the report concerns another person's listing" },
  disputes: { deletion: "anonymised", export: "included" },
  dispute_events: { deletion: "anonymised", export: "none", why: "append-only history shared with the other team and the organiser" },
  dispute_evidence: { deletion: "anonymised", export: "metadata" },
  dispute_evidence_blobs: { deletion: "deleted", export: "none", why: "image bytes are not exported" },
  v3_result_corrections: { deletion: "unlinked", export: "none", why: "organiser audit rows" },
  v3_team_captains: { deletion: "cascade", export: "included" },
  discord_guilds: { deletion: "unlinked", export: "none", why: "server install state, not the user's data" },
  discord_outbox: { deletion: "unlinked", export: "none", why: "system job queue" },
  feedback_reports: { deletion: "deleted", export: "included" },
  feedback_attachments: { deletion: "deleted", export: "metadata" },
  feedback_attachment_blobs: { deletion: "deleted", export: "none", why: "image bytes are not exported" },
};
export const V3_TABLE_NAMES = Object.keys(V3_PERSONAL_TABLES);
