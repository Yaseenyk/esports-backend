-- S7: non-partial unique index, see 0032.
CREATE UNIQUE INDEX idx_invites_token_hash ON invites(token_hash);
