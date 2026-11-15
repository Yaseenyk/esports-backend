-- Esports Hub on-page feedback bot (flag feedback.enabled, default OFF; kill switch kill.feedback). Additive and idempotent: three new tables, one
-- trigger, a few indexes. No legacy table or column is changed. Every feedback route checks the flag BEFORE reading any of these tables, so a Worker can be deployed
-- before this file is applied. Rollback is "empty, do not drop".
--  feedback_reports          one row per report a visitor sent. page_path is a PATH ONLY (the database refuses a '?' or '#'); the visitor's address and raw
--                            user agent are never stored (ip_hash is a keyed hash; device_class and browser_family are derived from the user agent, which is then
--                            thrown away). user_id is set only when the visitor ticked "include my account" and sent a valid token. The attach token is stored
--                            only as a hash. Deleted after 12 months (cron) and with the account.
--  feedback_attachments      metadata of up to TWO screenshots per report (png, jpeg or webp, at most 400 KB, checked by magic bytes; the limit of two is enforced
--                            by a trigger, so it holds under concurrent uploads). purged_at marks bytes deleted by retention (90 days); the row stays.
--  feedback_attachment_blobs the bytes, in their own table so a list never reads them.
CREATE TABLE IF NOT EXISTS `feedback_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	`kind` text NOT NULL,
	`message` text NOT NULL,
	`page_path` text NOT NULL,
	`page_title` text,
	`referrer_path` text,
	`viewport_w` integer,
	`viewport_h` integer,
	`device_class` text,
	`browser_family` text,
	`locale` text,
	`build_id` text,
	`signed_in` integer DEFAULT 0 NOT NULL,
	`user_id` text,
	`contact` text,
	`client_errors` text,
	`consent_version` text NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`staff_note` text,
	`ip_hash` text,
	`attach_token_hash` text,
	`attach_expires_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "feedback_reports_kind_ck" CHECK(kind IN ('bug','idea','confusing','other')),
	CONSTRAINT "feedback_reports_message_ck" CHECK(length(message) >= 10 AND length(message) <= 2000),
	CONSTRAINT "feedback_reports_path_ck" CHECK(length(page_path) >= 1 AND length(page_path) <= 200 AND substr(page_path, 1, 1) = '/' AND instr(page_path, '?') = 0 AND instr(page_path, '#') = 0),
	CONSTRAINT "feedback_reports_title_ck" CHECK(page_title IS NULL OR length(page_title) <= 120),
	CONSTRAINT "feedback_reports_referrer_ck" CHECK(referrer_path IS NULL OR (length(referrer_path) <= 200 AND substr(referrer_path, 1, 1) = '/' AND instr(referrer_path, '?') = 0 AND instr(referrer_path, '#') = 0)),
	CONSTRAINT "feedback_reports_viewport_ck" CHECK((viewport_w IS NULL OR (viewport_w >= 1 AND viewport_w <= 20000)) AND (viewport_h IS NULL OR (viewport_h >= 1 AND viewport_h <= 20000))),
	CONSTRAINT "feedback_reports_device_ck" CHECK(device_class IS NULL OR device_class IN ('mobile','tablet','desktop')),
	CONSTRAINT "feedback_reports_browser_ck" CHECK(browser_family IS NULL OR length(browser_family) <= 24),
	CONSTRAINT "feedback_reports_locale_ck" CHECK(locale IS NULL OR length(locale) <= 35),
	CONSTRAINT "feedback_reports_build_ck" CHECK(build_id IS NULL OR length(build_id) <= 64),
	CONSTRAINT "feedback_reports_signed_in_ck" CHECK(signed_in IN (0,1)),
	CONSTRAINT "feedback_reports_user_ck" CHECK(user_id IS NULL OR signed_in = 1),
	CONSTRAINT "feedback_reports_contact_ck" CHECK(contact IS NULL OR (length(contact) >= 3 AND length(contact) <= 120)),
	CONSTRAINT "feedback_reports_errors_ck" CHECK(client_errors IS NULL OR (json_valid(client_errors) AND json_type(client_errors) = 'array' AND json_array_length(client_errors) <= 5)),
	CONSTRAINT "feedback_reports_consent_ck" CHECK(length(consent_version) >= 1 AND length(consent_version) <= 32),
	CONSTRAINT "feedback_reports_status_ck" CHECK(status IN ('new','triaged','fixed','wontfix')),
	CONSTRAINT "feedback_reports_note_ck" CHECK(staff_note IS NULL OR length(staff_note) <= 1000),
	CONSTRAINT "feedback_reports_iphash_ck" CHECK(ip_hash IS NULL OR length(ip_hash) <= 64)
);
CREATE INDEX IF NOT EXISTS `feedback_reports_status_idx` ON `feedback_reports` (`status`, `created_at`);
CREATE INDEX IF NOT EXISTS `feedback_reports_created_idx` ON `feedback_reports` (`created_at`);
CREATE INDEX IF NOT EXISTS `feedback_reports_page_idx` ON `feedback_reports` (`page_path`, `created_at`);
CREATE INDEX IF NOT EXISTS `feedback_reports_user_idx` ON `feedback_reports` (`user_id`) WHERE `user_id` IS NOT NULL;

CREATE TABLE IF NOT EXISTS `feedback_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`report_id` text NOT NULL,
	`mime` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	`purged_at` integer,
	FOREIGN KEY (`report_id`) REFERENCES `feedback_reports`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "feedback_attachments_mime_ck" CHECK(mime IN ('png','jpeg','webp')),
	CONSTRAINT "feedback_attachments_size_ck" CHECK(size_bytes >= 1 AND size_bytes <= 409600),
	CONSTRAINT "feedback_attachments_sha_ck" CHECK(length(sha256) = 64)
);
CREATE UNIQUE INDEX IF NOT EXISTS `feedback_attachments_hash_uq` ON `feedback_attachments` (`report_id`, `sha256`);
CREATE INDEX IF NOT EXISTS `feedback_attachments_live_idx` ON `feedback_attachments` (`created_at`) WHERE `purged_at` IS NULL;

CREATE TABLE IF NOT EXISTS `feedback_attachment_blobs` (
	`attachment_id` text PRIMARY KEY NOT NULL,
	`data` blob NOT NULL,
	FOREIGN KEY (`attachment_id`) REFERENCES `feedback_attachments`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "feedback_attachment_blobs_size_ck" CHECK(length(data) >= 1 AND length(data) <= 409600)
);

-- At most two screenshots per report, decided inside the insert itself: two uploads racing for the last slot cannot both win.
CREATE TRIGGER IF NOT EXISTS trg_feedback_attachments_max2 BEFORE INSERT ON feedback_attachments
WHEN (SELECT COUNT(*) FROM feedback_attachments WHERE report_id = NEW.report_id) >= 2
BEGIN SELECT RAISE(ABORT, 'feedback: at most 2 attachments per report'); END;
