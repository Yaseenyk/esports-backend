-- Which door (gate key label) made each check-in, kept as text so it survives the key being revoked or deleted.
ALTER TABLE checkins ADD COLUMN door TEXT;
