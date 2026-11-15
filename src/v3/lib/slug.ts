/** Slug rules for public URLs (tournaments and player profiles). Pure. */
export const RESERVED_SLUGS: readonly string[] = [
  "admin", "api", "app", "auth", "login", "logout", "register", "signup", "sign-in", "sign-up", "me", "new", "edit", "settings", "account", "dashboard",
  "tournaments", "tournament", "players", "player", "teams", "team", "lft", "looking-for-team", "looking-for-player", "disputes", "dispute", "discord",
  "public", "live", "events", "event", "games", "cities", "about", "contact", "help", "support", "terms", "privacy", "legal", "static", "assets", "null",
  "undefined", "esports", "hub", "official", "moderator", "staff", "system", "root", "streamer", "streamerosai",
];
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;

export type SlugCheck = { ok: true; slug: string } | { ok: false; reason: "format" | "reserved" | "double_hyphen" };

/** Validates a slug: 3 to 60 characters, a-z 0-9 and single hyphens, not reserved. Upper case is lowered. */
export function checkSlug(input: unknown): SlugCheck {
  if (typeof input !== "string") return { ok: false, reason: "format" };
  const s = input.trim().toLowerCase();
  if (!SLUG_RE.test(s)) return { ok: false, reason: "format" };
  if (s.includes("--")) return { ok: false, reason: "double_hyphen" };
  if (RESERVED_SLUGS.includes(s)) return { ok: false, reason: "reserved" };
  return { ok: true, slug: s };
}

/** A candidate slug from free text (a title). May still fail checkSlug (too short, reserved). */
export function slugify(text: string, max = 48): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
}
