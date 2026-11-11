-- S7 phase A: AES-GCM copy of the token so the organiser can see the same link again.
ALTER TABLE share_links ADD COLUMN token_enc TEXT;
