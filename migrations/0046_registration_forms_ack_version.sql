-- Phase 2a-i privacy minimum: the version of the organiser acknowledgement text that was ticked (value 'interim-1' until counsel replaces it). One ALTER per file.
ALTER TABLE registration_forms ADD COLUMN ack_version TEXT;
