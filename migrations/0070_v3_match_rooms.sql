-- v3 organiser tools (flag v3.rooms, default OFF): the custom-room ID and password of a match, sent to the captains of confirmed teams from a reveal time.
-- Additive and idempotent: two new tables, no change to any existing table. Safe to re-run.
--  * v3_match_rooms: one row per room. The room ID and password are NEVER stored in clear: `secret_enc` is AES-GCM ciphertext ("v1.<iv>.<ct>", base64url)
--    made with the Worker secret ROOM_CREDENTIALS_KEY and bound to the room id and event id. It is set to NULL (purged_at set) 24 hours after the start.
--    match_id NULL = every confirmed team of the event (a battle royale lobby); otherwise the legacy matches.id, and only its two teams.
--  * v3_room_views: the audit log of who revealed the credentials (one row per reveal), and which rotation (`secret_version`) they saw.
CREATE TABLE IF NOT EXISTS `v3_match_rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`match_id` text,
	`label` text NOT NULL,
	`starts_at` integer NOT NULL,
	`reveal_at` integer NOT NULL,
	`secret_enc` text,
	`secret_version` integer DEFAULT 1 NOT NULL,
	`rotated_at` integer,
	`purged_at` integer,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT `v3_match_rooms_reveal_ck` CHECK(reveal_at <= starts_at),
	CONSTRAINT `v3_match_rooms_label_ck` CHECK(length(label) BETWEEN 1 AND 80)
);
CREATE INDEX IF NOT EXISTS `v3_match_rooms_event_idx` ON `v3_match_rooms` (`event_id`,`starts_at`);
CREATE INDEX IF NOT EXISTS `v3_match_rooms_purge_idx` ON `v3_match_rooms` (`purged_at`,`starts_at`);

CREATE TABLE IF NOT EXISTS `v3_room_views` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`event_id` text NOT NULL,
	`user_id` text,
	`team_name` text NOT NULL,
	`secret_version` integer NOT NULL,
	`viewed_at` integer NOT NULL,
	FOREIGN KEY (`room_id`) REFERENCES `v3_match_rooms`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX IF NOT EXISTS `v3_room_views_room_idx` ON `v3_room_views` (`room_id`,`viewed_at`);
CREATE INDEX IF NOT EXISTS `v3_room_views_user_idx` ON `v3_room_views` (`user_id`);
