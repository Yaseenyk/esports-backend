-- S7: non-partial unique index, see 0032.
CREATE UNIQUE INDEX idx_regform_token_hash ON registration_forms(token_hash);
