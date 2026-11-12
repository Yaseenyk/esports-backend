-- Phase 2a-i privacy minimum: when the organiser ticked the acknowledgement. NULL = never acknowledged. One ALTER per file.
ALTER TABLE registration_forms ADD COLUMN ack_at TEXT;
