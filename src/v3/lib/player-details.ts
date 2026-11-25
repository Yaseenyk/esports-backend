/**
 * What a player may add to their public player page and the show/hide switches, validated. Pure (no I/O); throws HttpError 400 through `bad`.
 *  - Links: http(s) only, no user:password, no port, at most LINKS_MAX. A social kind must point at that network's own hosts (allowlist) and is stored
 *    as https; "website" accepts any public host name except IP literals, localhost and phone-number hosts (wa.me, WhatsApp).
 *  - Achievements: short plain-text titles the player typed, an optional year. The page labels them "added by the player"; verified results are separate.
 *  - Team name and achievement titles: plain text, no markup, no links and no phone numbers (contact details stay off public pages).
 */
import { bad, optText } from "./validate";
import { hasLink, hasPhoneNumber } from "./lft-text";
import { isOneOf } from "./enums";

export const LINKS_MAX = 6;
export const ACHIEVEMENTS_MAX = 8;
export const TEAM_NAME_MAX = 60;
export const ACHIEVEMENT_MAX = 80;
export const URL_MAX = 200;

export const LINK_KINDS = ["youtube", "twitch", "instagram", "x", "discord", "facebook", "kick", "loco", "rooter", "website"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/** Host allowlist per social kind (lower case, exact match after dropping a leading "www." or "m."). */
const HOSTS: Record<Exclude<LinkKind, "website">, readonly string[]> = {
  youtube: ["youtube.com", "youtu.be"],
  twitch: ["twitch.tv"],
  instagram: ["instagram.com"],
  x: ["x.com", "twitter.com"],
  discord: ["discord.gg", "discord.com"],
  facebook: ["facebook.com", "fb.gg", "fb.com"],
  kick: ["kick.com"],
  loco: ["loco.com", "loco.gg"],
  rooter: ["rooter.gg", "rooter.io"],
};
/** Hosts that only carry a phone number or a private chat: never on a public page. */
const BLOCKED_HOSTS = ["wa.me", "whatsapp.com", "api.whatsapp.com", "chat.whatsapp.com", "t.me", "telegram.me"];

/** Fields the player can hide from the public page (the owner screen shows one switch each). */
export const HIDEABLE_FIELDS = ["bio", "location", "languages", "games", "roles", "team", "links", "achievements", "stats", "teams", "certificates", "matches", "badges"] as const;
export type HideableField = (typeof HIDEABLE_FIELDS)[number];

export interface PlayerLink { kind: LinkKind; url: string }
export interface Achievement { title: string; year: number | null }

const bareHost = (h: string): string => h.toLowerCase().replace(/^(?:www|m|mobile)\./, "");

/** One link, normalised; throws 400 `invalid_links` with a reason in the message. */
export function checkLink(kindRaw: unknown, urlRaw: unknown): PlayerLink {
  if (!isOneOf(LINK_KINDS, kindRaw)) throw bad(`links: kind must be one of ${LINK_KINDS.join(", ")}`, "invalid_links");
  if (typeof urlRaw !== "string" || urlRaw.trim() === "" || urlRaw.length > URL_MAX) throw bad(`links: url must be 1-${URL_MAX} characters`, "invalid_links");
  let u: URL;
  try {
    u = new URL(urlRaw.trim());
  } catch {
    throw bad("links: url is not a web address", "invalid_links");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw bad("links: only http and https addresses are allowed", "invalid_links");
  if (u.username || u.password) throw bad("links: an address with a user name or password is not allowed", "invalid_links");
  if (u.port) throw bad("links: an address with a port is not allowed", "invalid_links");
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes(".") || /^\d+(?:\.\d+){3}$/.test(host) || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw bad("links: use a public web address", "invalid_links");
  }
  const bare = bareHost(host);
  if (BLOCKED_HOSTS.some((b) => bare === b || bare.endsWith(`.${b}`))) throw bad("links: phone and private chat links are not allowed on a public page", "invalid_links");
  if (kindRaw !== "website") {
    if (!HOSTS[kindRaw].includes(bare)) throw bad(`links: a ${kindRaw} link must be on ${HOSTS[kindRaw].join(" or ")}`, "invalid_links");
    u.protocol = "https:";
  }
  u.hash = "";
  const url = u.toString();
  if (url.length > URL_MAX) throw bad(`links: url must be at most ${URL_MAX} characters`, "invalid_links");
  return { kind: kindRaw, url };
}

export function checkLinks(v: unknown): PlayerLink[] {
  if (v === null) return [];
  if (!Array.isArray(v) || v.length > LINKS_MAX) throw bad(`links must be a list of at most ${LINKS_MAX}`, "invalid_links");
  const out: PlayerLink[] = [];
  for (const x of v) {
    const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
    const l = checkLink(o.kind, o.url);
    if (!out.some((y) => y.url === l.url)) out.push(l);
  }
  return out;
}

function publicText(v: unknown, field: string, max: number, min = 0): string | null | undefined {
  const t = optText(v, field, max, min);
  if (typeof t === "string" && (hasLink(t) || hasPhoneNumber(t))) throw bad(`${field} must not hold links or phone numbers`, `invalid_${field}`);
  return t;
}

export const checkTeamName = (v: unknown): string | null | undefined => publicText(v, "teamName", TEAM_NAME_MAX);

export function checkAchievements(v: unknown): Achievement[] {
  if (v === null) return [];
  if (!Array.isArray(v) || v.length > ACHIEVEMENTS_MAX) throw bad(`achievements must be a list of at most ${ACHIEVEMENTS_MAX}`, "invalid_achievements");
  const out: Achievement[] = [];
  for (const x of v) {
    const o = x && typeof x === "object" ? (x as Record<string, unknown>) : {};
    const title = publicText(o.title, "achievements", ACHIEVEMENT_MAX, 2);
    if (typeof title !== "string") throw bad("achievements: each needs a title", "invalid_achievements");
    let year: number | null = null;
    if (o.year !== undefined && o.year !== null) {
      if (typeof o.year !== "number" || !Number.isInteger(o.year) || o.year < 2000 || o.year > 2100) throw bad("achievements: year must be a whole number from 2000 to 2100", "invalid_achievements");
      year = o.year;
    }
    out.push({ title, year });
  }
  return out;
}

export function checkHiddenFields(v: unknown): HideableField[] {
  if (v === null) return [];
  if (!Array.isArray(v) || v.length > HIDEABLE_FIELDS.length) throw bad("hiddenFields must be a list of field names", "invalid_hiddenFields");
  const out: HideableField[] = [];
  for (const x of v) {
    if (!isOneOf(HIDEABLE_FIELDS, x)) throw bad(`hiddenFields: each must be one of ${HIDEABLE_FIELDS.join(", ")}`, "invalid_hiddenFields");
    if (!out.includes(x)) out.push(x);
  }
  return out;
}

// ---- reading stored JSON back (defensive: a bad row gives an empty list, never a crash or an unsafe value) ----
const parse = (s: string | null | undefined): unknown[] => {
  try {
    const x: unknown = JSON.parse(s ?? "[]");
    return Array.isArray(x) ? x : [];
  } catch {
    return [];
  }
};
export function storedLinks(s: string | null | undefined): PlayerLink[] {
  const out: PlayerLink[] = [];
  for (const x of parse(s)) {
    try {
      const o = x as Record<string, unknown>;
      out.push(checkLink(o.kind, o.url)); // re-validated on every read: a rule tightened later applies to old rows too
    } catch {
      /* dropped */
    }
  }
  return out.slice(0, LINKS_MAX);
}
export function storedAchievements(s: string | null | undefined): Achievement[] {
  return parse(s)
    .map((x) => x as Record<string, unknown>)
    .filter((o) => typeof o.title === "string" && o.title.length <= ACHIEVEMENT_MAX)
    .map((o) => ({ title: o.title as string, year: typeof o.year === "number" && Number.isInteger(o.year) ? o.year : null }))
    .slice(0, ACHIEVEMENTS_MAX);
}
export const storedHidden = (s: string | null | undefined): HideableField[] => parse(s).filter((x): x is HideableField => isOneOf(HIDEABLE_FIELDS, x));

/** The QR token: 16 random bytes (128 bits), base64url without padding = 22 characters. */
export const CARD_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
export const cardPath = (token: string): string => `/p/?k=${token}`;
