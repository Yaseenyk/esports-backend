-- S7: deliberately NOT partial (no WHERE token_hash IS NOT NULL): SQLite allows many NULLs in a unique index, and a plain index is always usable for a bound parameter.
CREATE UNIQUE INDEX idx_share_token_hash ON share_links(token_hash);
