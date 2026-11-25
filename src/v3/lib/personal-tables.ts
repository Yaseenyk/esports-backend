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
  // Phases 3-5 (migration 0056)
  v3_team_pages: { deletion: "cascade", export: "included", why: "goes with the team page (legacy team_profiles), which goes with the account" },
  v3_player_hidden_items: { deletion: "cascade", export: "included" },
  v3_team_hidden_items: { deletion: "cascade", export: "included" },
  v3_profile_reports: { deletion: "deleted", export: "none", why: "reporter is a one-way hash; reports ABOUT the user's pages are staff data and are deleted with the account" },
  v3_profile_moderation: { deletion: "deleted", export: "none", why: "staff moderation state of the page, deleted with the account" },
  scrim_slots: { deletion: "cascade", export: "included" },
  scrim_requests: { deletion: "cascade", export: "included", why: "only requests the user SENT; requests received are other captains' data (counts only)" },
  scrim_reports: { deletion: "deleted", export: "none", why: "reporter is a one-way hash; the report concerns another captain's slot" },
  scrim_blocks: { deletion: "cascade", export: "included", why: "only blocks the user made (the team name and date); who blocked the user is other people's data" },
  v3_tournament_directory: { deletion: "cascade", export: "none", why: "organiser setting that goes with the event" },
  // Phase 4b scrim manager (migration 0057)
  scrim_slot_assignments: { deletion: "cascade", export: "none", why: "seat numbers of a scrim; the user's own requests and slots are exported" },
  scrim_waitlist: { deletion: "cascade", export: "included" },
  scrim_notifications: { deletion: "cascade", export: "included" },
  scrim_schedules: { deletion: "cascade", export: "included" },
  // Organiser match tools (migration 0070)
  v3_match_rooms: { deletion: "unlinked", export: "none", why: "organiser-owned room details for an event; created_by is nulled and the credentials are encrypted and deleted 24 hours after the start" },
  v3_room_views: { deletion: "cascade", export: "none", why: "the organiser's audit log of who revealed a room; it holds no text the user wrote and is deleted with the account" },
  scrim_schedule_days: { deletion: "cascade", export: "none", why: "the day list generated from the user's schedule (the schedule itself is exported)" },
  // Player cards (migration 0081): page details the player typed and the card link (only its creation time is exported, never the token or its hash)
  v3_player_page_details: { deletion: "cascade", export: "included" },
  // Builder C (migration 0091): the private match journal and the badge show/hide choices (+ the server's record of a scrim badge)
  v3_journal_entries: { deletion: "cascade", export: "included" },
  v3_badge_state: { deletion: "cascade", export: "included" },
};
export const V3_TABLE_NAMES = Object.keys(V3_PERSONAL_TABLES);
