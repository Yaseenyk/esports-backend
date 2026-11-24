-- Esports Hub v3 community features (flags v3.calendar and v3.trust, both default OFF). PURELY ADDITIVE AND IDEMPOTENT: five new tables, their indexes
-- and one append-only trigger. No legacy table or column is changed. Every route checks its flag BEFORE reading these tables, so a Worker can be
-- deployed before this file is applied. Rollback is "turn the flag off, leave the tables" (or drop them: nothing else references them).
--
--  calendar_entries          college / fest events listed by a VERIFIED organisation (organisations.verified_at, set by staff). Dates are local
--                            calendar days (YYYY-MM-DD). registration_url is https only and never holds a query string or fragment (secret links
--                            such as ?t= invite tokens can never be stored). An entry may point at a public tournament of the same organisation.
--  organiser_ratings         one rating per player per event, only from a player proved to have checked in (their pass) or played (captain of a team
--                            with results). proof_ref makes one pass / one team count once per event. The written review is tied to the account and
--                            shown with the display name the player typed (never anonymous). The organiser may reply once.
--  organiser_rating_reports  reports on a review or a reply. reporter_user_id cascades on account deletion; it is never shown to the organiser.
--  organiser_rating_actions  append-only staff moderation log (hide / restore / dismiss, with a reason). The same actions also go to audit_log.
--  calendar_entry_actions    append-only staff moderation log for calendar entries.
-- No money columns, no dates of birth, no id numbers.

CREATE TABLE IF NOT EXISTS `calendar_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`title` text NOT NULL,
	`game` text NOT NULL,
	`city` text NOT NULL,
	`online` integer DEFAULT 0 NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`registration_url` text,
	`tournament_id` text,
	`status` text DEFAULT 'listed' NOT NULL,
	`hidden_at` integer,
	`hidden_reason` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `organisations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "calendar_entries_title_ck" CHECK(length(title) BETWEEN 3 AND 100),
	CONSTRAINT "calendar_entries_city_ck" CHECK(length(city) BETWEEN 2 AND 60),
	CONSTRAINT "calendar_entries_game_ck" CHECK(game IN ('bgmi','free_fire','valorant','cod_mobile','cs2','other')),
	CONSTRAINT "calendar_entries_online_ck" CHECK(online IN (0,1)),
	CONSTRAINT "calendar_entries_status_ck" CHECK(status IN ('listed','cancelled')),
	CONSTRAINT "calendar_entries_dates_ck" CHECK(starts_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND ends_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND ends_on >= starts_on),
	CONSTRAINT "calendar_entries_url_ck" CHECK(registration_url IS NULL OR (length(registration_url) <= 300 AND substr(registration_url, 1, 8) = 'https://' AND instr(registration_url, '?') = 0 AND instr(registration_url, '#') = 0)),
	CONSTRAINT "calendar_entries_link_ck" CHECK(registration_url IS NOT NULL OR tournament_id IS NOT NULL OR status = 'cancelled')
);
CREATE INDEX IF NOT EXISTS `calendar_entries_dates_idx` ON `calendar_entries` (`ends_on`,`starts_on`);
CREATE INDEX IF NOT EXISTS `calendar_entries_org_idx` ON `calendar_entries` (`org_id`,`ends_on`);

CREATE TABLE IF NOT EXISTS `calendar_entry_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`action` text NOT NULL,
	`reason_code` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`staff_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `calendar_entries`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "calendar_entry_actions_action_ck" CHECK(action IN ('hidden','restored')),
	CONSTRAINT "calendar_entry_actions_reason_ck" CHECK(length(reason_code) BETWEEN 1 AND 24),
	CONSTRAINT "calendar_entry_actions_note_ck" CHECK(length(note) <= 300)
);
CREATE INDEX IF NOT EXISTS `calendar_entry_actions_entry_idx` ON `calendar_entry_actions` (`entry_id`,`created_at`);

CREATE TABLE IF NOT EXISTS `organiser_ratings` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`organiser_key` text NOT NULL,
	`user_id` text NOT NULL,
	`display_name` text NOT NULL,
	`proof_kind` text NOT NULL,
	`proof_ref` text NOT NULL,
	`stars` integer NOT NULL,
	`on_time` integer NOT NULL,
	`fair_play` integer NOT NULL,
	`communication` integer NOT NULL,
	`review` text,
	`reply` text,
	`reply_by` text,
	`reply_at` integer,
	`hidden_at` integer,
	`hidden_reason` text,
	`reply_hidden_at` integer,
	`reply_hidden_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reply_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "organiser_ratings_key_ck" CHECK(length(organiser_key) BETWEEN 1 AND 80),
	CONSTRAINT "organiser_ratings_name_ck" CHECK(length(display_name) BETWEEN 2 AND 40),
	CONSTRAINT "organiser_ratings_proof_ck" CHECK(proof_kind IN ('checked_in','played') AND length(proof_ref) BETWEEN 1 AND 128),
	CONSTRAINT "organiser_ratings_stars_ck" CHECK(stars BETWEEN 1 AND 5 AND on_time BETWEEN 1 AND 5 AND fair_play BETWEEN 1 AND 5 AND communication BETWEEN 1 AND 5),
	CONSTRAINT "organiser_ratings_text_ck" CHECK((review IS NULL OR length(review) <= 1000) AND (reply IS NULL OR length(reply) <= 1000))
);
CREATE UNIQUE INDEX IF NOT EXISTS `organiser_ratings_one_per_event_uq` ON `organiser_ratings` (`event_id`,`user_id`);
CREATE UNIQUE INDEX IF NOT EXISTS `organiser_ratings_one_per_proof_uq` ON `organiser_ratings` (`event_id`,`proof_ref`);
CREATE INDEX IF NOT EXISTS `organiser_ratings_organiser_idx` ON `organiser_ratings` (`organiser_key`,`created_at`);
CREATE INDEX IF NOT EXISTS `organiser_ratings_user_idx` ON `organiser_ratings` (`user_id`);

CREATE TABLE IF NOT EXISTS `organiser_rating_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`rating_id` text NOT NULL,
	`target` text NOT NULL,
	`reporter_user_id` text NOT NULL,
	`reason_code` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	FOREIGN KEY (`rating_id`) REFERENCES `organiser_ratings`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reporter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "organiser_rating_reports_target_ck" CHECK(target IN ('review','reply')),
	CONSTRAINT "organiser_rating_reports_reason_ck" CHECK(reason_code IN ('abuse','personal_info','false_claim','spam','conflict_of_interest','other')),
	CONSTRAINT "organiser_rating_reports_note_ck" CHECK(length(note) <= 200),
	CONSTRAINT "organiser_rating_reports_status_ck" CHECK(status IN ('open','actioned','dismissed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS `organiser_rating_reports_once_uq` ON `organiser_rating_reports` (`rating_id`,`target`,`reporter_user_id`);
CREATE INDEX IF NOT EXISTS `organiser_rating_reports_queue_idx` ON `organiser_rating_reports` (`status`,`created_at`);

CREATE TABLE IF NOT EXISTS `organiser_rating_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`rating_id` text NOT NULL,
	`target` text NOT NULL,
	`action` text NOT NULL,
	`reason_code` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`staff_user_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`rating_id`) REFERENCES `organiser_ratings`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "organiser_rating_actions_target_ck" CHECK(target IN ('review','reply')),
	CONSTRAINT "organiser_rating_actions_action_ck" CHECK(action IN ('hidden','restored','report_dismissed')),
	CONSTRAINT "organiser_rating_actions_reason_ck" CHECK(length(reason_code) BETWEEN 1 AND 24),
	CONSTRAINT "organiser_rating_actions_note_ck" CHECK(length(note) <= 300)
);
CREATE INDEX IF NOT EXISTS `organiser_rating_actions_rating_idx` ON `organiser_rating_actions` (`rating_id`,`created_at`);

-- The moderation logs are append-only: no row may change (a deleted rating removes its log by the foreign key cascade).
CREATE TRIGGER IF NOT EXISTS trg_organiser_rating_actions_append_only BEFORE UPDATE ON organiser_rating_actions
BEGIN SELECT RAISE(ABORT, 'organiser_rating_actions is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_calendar_entry_actions_append_only BEFORE UPDATE ON calendar_entry_actions
BEGIN SELECT RAISE(ABORT, 'calendar_entry_actions is append-only'); END;
