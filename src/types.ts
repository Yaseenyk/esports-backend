export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  ALLOWED_ORIGINS?: string;
  PBKDF2_ITERATIONS?: string;
  RESEND_API_KEY?: string; // secret: wrangler secret put RESEND_API_KEY
  MAIL_FROM?: string;
  APP_URL?: string;
  LINK_KEY?: string; // secret: wrangler secret put LINK_KEY (S7: encrypts the re-displayable copy of share, invite and registration tokens)
  TRACK?: { writeDataPoint(p: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void }; // optional Analytics Engine binding for tool_complete; absent = dropped (OD-C amended)
  STAFF_JWT_SECRET?: string; // secret: wrangler secret put STAFF_JWT_SECRET (Phase 1: signs staff tokens, audience "staff"; absent = /admin/v1 answers 404)
  TOTP_KEK?: string; // secret: wrangler secret put TOTP_KEK (Phase 1: seals the TOTP seeds of platform staff; absent = /admin/v1 answers 404)
  GOOGLE_CLIENT_ID?: string; // public OAuth client id (a var, not a secret); absent = POST /auth/google answers 404
  DISCORD_BOT_TOKEN?: string; // secret (Discord stage): the bot token. Absent = the drain is a no-op and the install endpoint says "Discord is not configured"
  DISCORD_PUBLIC_KEY?: string; // secret: the application public key (hex) that verifies Discord interaction signatures
  DISCORD_APP_ID?: string; // secret: the application id (= the bot user id); used for the bot permission check and the invite URL
  FEEDBACK_SALT?: string; // secret (feedback bot): keys the hash of the visitor address (rate limits). Absent = derived from JWT_SECRET (see src/v3/lib/feedback.ts)
  ROOM_CREDENTIALS_KEY?: string; // secret (v3.rooms): encrypts match-room IDs and passwords at rest (AES-GCM). 32+ characters. Absent = room create/rotate/reveal answer 503 rooms_not_configured
  HASH_KEY?: string; // secret: keys unsubscribe tokens (S10); falls back to JWT_SECRET until set
}

export type AppBindings = {
  Bindings: Env;
  Variables: { userId: string; gateEventId: string; gateKeyId: string; gateLabel: string };
};

export interface EventRow {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  game: string;
  organiser: string;
  date: string;
  venue: string;
  emergency: string;
  rules: string;
  settings: string;
  starts_on?: string | null;
  org_id?: string | null;
  created_by?: string | null;
  signing_secret: string;
  created_at: string;
  updated_at: string;
}
