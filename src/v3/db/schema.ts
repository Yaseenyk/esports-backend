/**
 * Esports Hub v3 data layer on D1 (SQLite). Logical model: esports-hub/docs/ecosystem/v3/DATA_CONTRACT.md (the Postgres draft db/schema.ts).
 * Port rules (ADR-1 option A): ids are TEXT (random, from the Worker), enums are TEXT + CHECK, arrays and jsonb are JSON text,
 * timestamps are integer EPOCH SECONDS, no money columns, no dates of birth, no government ids.
 *
 * Trinity layer 3: ONLY repositories import this file. The SQL migration is generated with drizzle-kit (see drizzle.config.ts and
 * scripts/v3-migration.mjs) into migrations/0051_v3_core.sql; legacy tables (users, events, team_profiles) are NOT declared here for DDL.
 */
import { sql } from "drizzle-orm";
import { blob, check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { events, teamProfiles, users } from "./legacy-stubs";
import {
  APPLICATION_STATUSES, DISPUTE_OUTCOMES, DISPUTE_STATUSES, DISPUTE_TYPES, EVIDENCE_MIMES, GAMES, LFT_KINDS, LFT_STATUSES,
  OUTBOX_KINDS, OUTBOX_STATUSES, TOURNAMENT_FORMATS, TOURNAMENT_STATUSES, VENUES, VISIBILITIES,
} from "../lib/enums";

const inList = (col: string, list: readonly string[]) => sql.raw(`${col} IN (${list.map((v) => `'${v}'`).join(",")})`);
const now = sql`(unixepoch())`;
const createdAt = () => integer("created_at").notNull().default(now);
const updatedAt = () => integer("updated_at").notNull().default(now);

/** Public wrapper around ONE legacy event (1:1). Registrations, matches and results stay in the legacy tables and are read through it. */
export const tournaments = sqliteTable(
  "tournaments",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull().unique().references(() => events.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    game: text("game", { enum: GAMES }).notNull(),
    format: text("format", { enum: TOURNAMENT_FORMATS }).notNull(),
    status: text("status", { enum: TOURNAMENT_STATUSES }).notNull().default("draft"),
    venue: text("venue", { enum: VENUES }).notNull().default("online"),
    city: text("city"),
    state: text("state"),
    summary: text("summary"),
    description: text("description"),
    rules: text("rules"),
    maxTeams: integer("max_teams"),
    startsAt: integer("starts_at"),
    endsAt: integer("ends_at"),
    seoReady: integer("seo_ready", { mode: "boolean" }).notNull().default(false),
    /** Epoch seconds of the FIRST time the page became indexable (migration 0055). The weekly cap counts this date. NULL = never released (or released before the column existed). */
    seoReadyAt: integer("seo_ready_at"),
    publishedAt: integer("published_at"),
    discordGuildId: text("discord_guild_id"),
    discordCategoryId: text("discord_category_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("tournaments_slug_uq").on(t.slug),
    index("tournaments_status_start_idx").on(t.status, t.startsAt),
    index("tournaments_game_idx").on(t.game, t.startsAt),
    check("tournaments_status_ck", inList("status", TOURNAMENT_STATUSES)),
    check("tournaments_game_ck", inList("game", GAMES)),
    check("tournaments_format_ck", inList("format", TOURNAMENT_FORMATS)),
    check("tournaments_venue_ck", inList("venue", VENUES)),
    check("tournaments_dates_ck", sql`starts_at IS NULL OR ends_at IS NULL OR ends_at >= starts_at`),
  ],
);

export const playerProfiles = sqliteTable(
  "player_profiles",
  {
    userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    handle: text("handle").notNull(),
    bio: text("bio"),
    city: text("city"),
    state: text("state"),
    languages: text("languages").notNull().default("[]"), // JSON array of short strings
    visibility: text("visibility", { enum: VISIBILITIES }).notNull().default("private"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("player_profiles_slug_uq").on(t.slug),
    index("player_profiles_visibility_idx").on(t.visibility),
    check("player_profiles_visibility_ck", inList("visibility", VISIBILITIES)),
  ],
);

export const playerGames = sqliteTable(
  "player_games",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    game: text("game", { enum: GAMES }).notNull(),
    inGameName: text("in_game_name").notNull(),
    rankCode: text("rank_code"),
    rankOrdinal: integer("rank_ordinal"),
    roles: text("roles").notNull().default("[]"), // JSON array of player_role values
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("player_games_pk").on(t.userId, t.game),
    index("player_games_filter_idx").on(t.game, t.rankOrdinal),
    check("player_games_game_ck", inList("game", GAMES)),
  ],
);

export const lftListings = sqliteTable(
  "lft_listings",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: LFT_KINDS }).notNull(),
    authorUserId: text("author_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    /** looking_for_player: the team page (legacy team_profiles) the author owns. Null for a player's own listing. */
    teamProfileId: text("team_profile_id").references(() => teamProfiles.id, { onDelete: "cascade" }),
    game: text("game", { enum: GAMES }).notNull(),
    roles: text("roles").notNull().default("[]"),
    rankMinOrdinal: integer("rank_min_ordinal"),
    rankMaxOrdinal: integer("rank_max_ordinal"),
    state: text("state"),
    city: text("city"),
    onlineOk: integer("online_ok", { mode: "boolean" }).notNull().default(true),
    message: text("message").notNull(),
    /** Revealed to an accepted applicant only. */
    contact: text("contact"),
    status: text("status", { enum: LFT_STATUSES }).notNull().default("open"),
    /** Set by the 3-reporter auto-hide; cleared by a moderator restore. A hidden listing is never public. */
    hiddenAt: integer("hidden_at"),
    expiresAt: integer("expires_at").notNull(),
    lastBumpedAt: integer("last_bumped_at").notNull().default(now),
    reportCount: integer("report_count").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("lft_board_idx").on(t.status, t.game, t.kind, t.lastBumpedAt),
    index("lft_author_idx").on(t.authorUserId, t.status),
    index("lft_location_idx").on(t.game, t.state, t.city),
    index("lft_expiry_idx").on(t.status, t.expiresAt),
    check("lft_kind_ck", inList("kind", LFT_KINDS)),
    check("lft_status_ck", inList("status", LFT_STATUSES)),
    check("lft_team_kind_ck", sql`(kind = 'looking_for_player') = (team_profile_id IS NOT NULL)`),
    check("lft_rank_range_ck", sql`rank_min_ordinal IS NULL OR rank_max_ordinal IS NULL OR rank_max_ordinal >= rank_min_ordinal`),
    check("lft_message_len_ck", sql`length(message) <= 600`),
  ],
);

export const lftApplications = sqliteTable(
  "lft_applications",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id").notNull().references(() => lftListings.id, { onDelete: "cascade" }),
    applicantUserId: text("applicant_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    message: text("message"),
    /** Revealed to the listing author only after accept. */
    contact: text("contact"),
    status: text("status", { enum: APPLICATION_STATUSES }).notNull().default("sent"),
    respondedAt: integer("responded_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("lft_applications_once_uq").on(t.listingId, t.applicantUserId),
    index("lft_applications_applicant_idx").on(t.applicantUserId),
    check("lft_applications_status_ck", inList("status", APPLICATION_STATUSES)),
  ],
);

/** Reports on a listing. The reporter is stored only as a salted hash (same as the legacy reports table). */
export const lftReports = sqliteTable(
  "lft_reports",
  {
    id: text("id").primaryKey(),
    listingId: text("listing_id").notNull().references(() => lftListings.id, { onDelete: "cascade" }),
    reporter: text("reporter").notNull(),
    reasonCode: text("reason_code").notNull(),
    note: text("note").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("lft_reports_once_uq").on(t.listingId, t.reporter), check("lft_reports_note_ck", sql`length(note) <= 200`)],
);

/** Which signed-in user is captain of which team of which event, proven with the legacy captain link token. Defines the "two teams" of a dispute. */
export const v3TeamCaptains = sqliteTable(
  "v3_team_captains",
  {
    eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    teamKey: text("team_key").notNull(), // lower-cased team name
    teamName: text("team_name").notNull(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("v3_team_captains_pk").on(t.eventId, t.teamKey, t.userId), index("v3_team_captains_user_idx").on(t.userId)],
);

export const disputes = sqliteTable(
  "disputes",
  {
    id: text("id").primaryKey(),
    tournamentId: text("tournament_id").notNull().references(() => tournaments.id, { onDelete: "cascade" }),
    /** Legacy matches.id (head to head) or null. */
    matchId: text("match_id"),
    /** Legacy br_results.match_no (battle royale) or null. */
    matchNo: integer("match_no"),
    type: text("type", { enum: DISPUTE_TYPES }).notNull(),
    status: text("status", { enum: DISPUTE_STATUSES }).notNull().default("open"),
    raisedByUserId: text("raised_by_user_id").references(() => users.id, { onDelete: "set null" }),
    /** Team names inside the event (legacy teams are names, not rows). raisedByTeamKey is null when the organiser raised it. */
    raisedByTeam: text("raised_by_team"),
    raisedByTeamKey: text("raised_by_team_key"),
    againstTeam: text("against_team"),
    againstTeamKey: text("against_team_key"),
    summary: text("summary").notNull(),
    outcome: text("outcome", { enum: DISPUTE_OUTCOMES }),
    resolutionNote: text("resolution_note"),
    resolvedByUserId: text("resolved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: integer("resolved_at"),
    dueAt: integer("due_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("disputes_queue_idx").on(t.tournamentId, t.status, t.dueAt),
    index("disputes_raised_by_idx").on(t.raisedByUserId),
    check("disputes_type_ck", inList("type", DISPUTE_TYPES)),
    check("disputes_status_ck", inList("status", DISPUTE_STATUSES)),
    check("disputes_outcome_ck", sql`outcome IS NULL OR ${inList("outcome", DISPUTE_OUTCOMES)}`),
    check("disputes_resolved_ck", sql`(status IN ('resolved','rejected')) = (resolved_at IS NOT NULL)`),
    check("disputes_summary_len_ck", sql`length(summary) <= 1000`),
  ],
);

/** Screenshot METADATA. The bytes live in dispute_evidence_blobs so a list never reads a blob. */
export const disputeEvidence = sqliteTable(
  "dispute_evidence",
  {
    id: text("id").primaryKey(),
    disputeId: text("dispute_id").notNull().references(() => disputes.id, { onDelete: "cascade" }),
    uploadedByUserId: text("uploaded_by_user_id").references(() => users.id, { onDelete: "set null" }),
    mimeType: text("mime_type", { enum: EVIDENCE_MIMES }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    caption: text("caption"),
    /** Bytes are deleted from dispute_evidence_blobs from this time on (resolution + 90 days); the row stays with purged_at. */
    purgeAfter: integer("purge_after"),
    purgedAt: integer("purged_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("dispute_evidence_dispute_idx").on(t.disputeId),
    index("dispute_evidence_purge_idx").on(t.purgeAfter),
    uniqueIndex("dispute_evidence_hash_uq").on(t.disputeId, t.sha256),
    check("dispute_evidence_mime_ck", inList("mime_type", EVIDENCE_MIMES)),
    check("dispute_evidence_size_ck", sql`size_bytes > 0 AND size_bytes <= 409600`),
  ],
);

export const disputeEvidenceBlobs = sqliteTable("dispute_evidence_blobs", {
  evidenceId: text("evidence_id").primaryKey().references(() => disputeEvidence.id, { onDelete: "cascade" }),
  bytes: blob("bytes", { mode: "buffer" }).notNull(),
});

/** Append-only history. A trigger (migration) refuses any change except nulling actor_user_id when an account is deleted. */
export const disputeEvents = sqliteTable(
  "dispute_events",
  {
    id: text("id").primaryKey(),
    disputeId: text("dispute_id").notNull().references(() => disputes.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorRole: text("actor_role").notNull(), // raiser | team | organiser | moderator | system
    action: text("action").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [index("dispute_events_dispute_idx").on(t.disputeId, t.createdAt)],
);

/** A correction a resolved dispute applied. Legacy result rows are NEVER overwritten; the public read overlays these (adapters/results-overlay.ts). */
export const v3ResultCorrections = sqliteTable(
  "v3_result_corrections",
  {
    id: text("id").primaryKey(),
    disputeId: text("dispute_id").notNull().references(() => disputes.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
    /** "match:<matches.id>" or "br:<match_no>:<team>" */
    matchRef: text("match_ref").notNull(),
    oldValue: text("old_value").notNull(), // JSON
    newValue: text("new_value").notNull(), // JSON
    appliedBy: text("applied_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("v3_result_corrections_event_idx").on(t.eventId, t.matchRef), index("v3_result_corrections_dispute_idx").on(t.disputeId)],
);

/** Discord stage is LATER; the tables exist now so that stage needs no schema change. */
export const discordGuilds = sqliteTable("discord_guilds", {
  guildId: text("guild_id").primaryKey(),
  installedByUserId: text("installed_by_user_id").references(() => users.id, { onDelete: "set null" }),
  permissionsOk: integer("permissions_ok", { mode: "boolean" }).notNull().default(false),
  installedAt: integer("installed_at").notNull().default(now),
});

export const discordOutbox = sqliteTable(
  "discord_outbox",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: OUTBOX_KINDS }).notNull(),
    guildId: text("guild_id").notNull(),
    payload: text("payload").notNull().default("{}"), // JSON
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status", { enum: OUTBOX_STATUSES }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    runAfter: integer("run_after").notNull().default(now),
    lastError: text("last_error"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("discord_outbox_key_uq").on(t.idempotencyKey),
    index("discord_outbox_due_idx").on(t.status, t.runAfter),
    check("discord_outbox_kind_ck", inList("kind", OUTBOX_KINDS)),
    check("discord_outbox_status_ck", inList("status", OUTBOX_STATUSES)),
  ],
);
