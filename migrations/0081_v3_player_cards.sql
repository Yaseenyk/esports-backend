-- Esports Hub v3: player cards (25 Nov 2026). PURELY ADDITIVE: one new table and one index, every statement IF NOT EXISTS, so the file is idempotent
-- and safe to apply twice (staging: wrangler d1 execute --file; production: migrations apply). No existing table or column changes.
-- Read only by the v3.profiles routes. A Worker with the code but not the table treats every player as having no extra details and no card link.
--
-- v3_player_page_details: what a player adds to their public player page beyond the resume (current team, social links, achievements they typed),
-- which fields they chose to hide, and the revocable QR link of their player card.
--  - card_token_hash = base64url(SHA-256(token)), looked up through the unique index. The token itself (128 random bits) is never stored in clear;
--    card_token_enc is the AES-GCM copy under LINK_KEY (src/links.ts, kind "pcard") so the owner can print the same QR again.
--  - "Reset QR link" overwrites both columns: every printed card with the old QR stops working at once.
--  - search_opt_in_at: the player switched on "Show my profile in Google search" (NULL = off, the default). Only then, and only for a Public profile that
--    passes the quality gate (services/showcase-service.ts), does the site pre-render an indexable /players/<slug>/ page.
-- No contact details, dates of birth, government ids, IP addresses or money columns.
CREATE TABLE IF NOT EXISTS v3_player_page_details (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  team_name TEXT CHECK (team_name IS NULL OR length(team_name) <= 60),
  links TEXT NOT NULL DEFAULT '[]' CHECK (length(links) <= 2000),
  achievements TEXT NOT NULL DEFAULT '[]' CHECK (length(achievements) <= 2000),
  hidden_fields TEXT NOT NULL DEFAULT '[]' CHECK (length(hidden_fields) <= 400),
  card_token_hash TEXT CHECK (card_token_hash IS NULL OR length(card_token_hash) = 43),
  card_token_enc TEXT CHECK (card_token_enc IS NULL OR length(card_token_enc) <= 200),
  card_token_at INTEGER,
  search_opt_in_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS v3_player_page_details_card_uq ON v3_player_page_details (card_token_hash) WHERE card_token_hash IS NOT NULL;
