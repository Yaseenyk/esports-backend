-- Messages sent from the public contact form. Read them with: wrangler d1 execute esports-db --remote --command "SELECT * FROM contact_messages ORDER BY created_at DESC"
CREATE TABLE contact_messages (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_contact_created ON contact_messages(created_at);
