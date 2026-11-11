-- 0B M6 (2 of 3): events.created_by. Informational, no foreign key, survives re-homing of an event.
ALTER TABLE events ADD COLUMN created_by TEXT;
