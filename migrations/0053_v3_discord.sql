-- Esports Hub v3, Discord stage (flag v3.discord, default OFF). Additive and idempotent: three new tables and one partial unique index. No legacy
-- table or column is changed. Every Discord route and the drain job check the flag BEFORE reading any of these tables, so a Worker can be deployed
-- before this file is applied. Rollback is "empty, do not drop".
--  v3_registration_discord  what the bot created for one approved registration (role id, channel id). The drain writes each id as soon as Discord returns it,
--                           so a replay after a crash re-uses it instead of creating a second channel.
--  discord_link_codes       single-use /link codes (only the sha-256 of the code is stored; 10 minute expiry; one live code per user).
--  v3_discord_settings      per tournament: lobby ping on/off (default off) and what archiving does (default read-only).
--  users(discord_user_id)   one Discord account can be linked to one user only.
CREATE TABLE IF NOT EXISTS `v3_registration_discord` (
	`registration_id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`guild_id` text NOT NULL,
	`role_id` text,
	`channel_id` text,
	`intro_posted_at` integer,
	`archived_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`registration_id`) REFERENCES `registrations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE INDEX IF NOT EXISTS `v3_registration_discord_event_idx` ON `v3_registration_discord` (`event_id`);

CREATE TABLE IF NOT EXISTS `discord_link_codes` (
	`user_id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
CREATE UNIQUE INDEX IF NOT EXISTS `discord_link_codes_hash_uq` ON `discord_link_codes` (`code_hash`);

CREATE TABLE IF NOT EXISTS `v3_discord_settings` (
	`tournament_id` text PRIMARY KEY NOT NULL,
	`lobby_ping_enabled` integer DEFAULT 0 NOT NULL,
	`archive_mode` text DEFAULT 'readonly' NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`tournament_id`) REFERENCES `tournaments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "v3_discord_settings_archive_ck" CHECK(archive_mode IN ('readonly','delete')),
	CONSTRAINT "v3_discord_settings_ping_ck" CHECK(lobby_ping_enabled IN (0,1))
);

CREATE UNIQUE INDEX IF NOT EXISTS `users_discord_user_id_uq` ON `users` (`discord_user_id`) WHERE `discord_user_id` IS NOT NULL;
