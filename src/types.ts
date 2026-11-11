export interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  ALLOWED_ORIGINS?: string;
  PBKDF2_ITERATIONS?: string;
  RESEND_API_KEY?: string; // secret: wrangler secret put RESEND_API_KEY
  MAIL_FROM?: string;
  APP_URL?: string;
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
  signing_secret: string;
  created_at: string;
  updated_at: string;
}
