import { Hono } from "hono";
import type { AppBindings } from "../types";
import type { RouteRules } from "./types";
import { HttpError, ID_RE, nowIso, rateLimitSoft, rateLimitSubject, readJson, type Ctx } from "../http";
import { sha256 } from "../crypto";
import { ownedEvent, requireUser } from "../auth";
import { deriveWinner, listBr, listMatches, type BrResult, type Match } from "../matches";

/**
 * Opt-in TEAM pages. Privacy rules: no player names, photos or emails anywhere; free text must not contain an email address or a phone-like number;
 * a page is public only while `published = 1`, and publishing needs an explicit consent statement that is stored with a time and cleared on unpublish.
 */
export const routes = new Hono<AppBindings>();

export const CONSENT_STATEMENT = "I have the team captain's permission to publish this page";
const SLUG_RE = /^[a-z2-7]{12}$/;
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const MAX_PROFILES = 20;
const MAX_LINKED = 30;
const MAX_LINKS = 5;
export const LINK_HOSTS = ["instagram.com", "youtube.com", "discord.gg", "x.com", "twitter.com", "facebook.com"];

const bad = (m: string): never => { throw new HttpError(400, m); };

function newSlug(): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  let s = "";
  for (const x of b) s += B32[x & 31];
  return s;
}

/** Plain text only: no control characters, no email address, no phone-like run of digits (a page about a team must not carry contact details). */
export function plainText(v: unknown, field: string, min: number, max: number): string {
  if (typeof v !== "string") return bad(`${field} must be a string`);
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  if (t.length < min || t.length > max) return bad(min > 0 ? `${field} must be ${min}-${max} characters` : `${field} must be at most ${max} characters`);
  if (/\S+@\S+\.\S+/.test(t)) return bad(`${field} must not contain an email address`);
  if (/(?:\d[\s().+-]*){8,}/.test(t)) return bad(`${field} must not contain a phone number`);
  return t;
}

/** Only https links to a short list of social sites. Returns the cleaned list. */
export function validateLinks(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) return bad("links must be an array");
  if (v.length > MAX_LINKS) return bad(`links can have at most ${MAX_LINKS} items`);
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string" || raw.length > 200) return bad("each link must be a text of at most 200 characters");
    let u: URL;
    try { u = new URL(raw.trim()); } catch { return bad("each link must be a full web address"); }
    if (u.protocol !== "https:") return bad("links must start with https://");
    if (u.username || u.password) return bad("links must not contain a login");
    const host = u.hostname.toLowerCase();
    if (!LINK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return bad(`links can only go to ${LINK_HOSTS.join(", ")}`);
    const href = u.href;
    if (!out.includes(href)) out.push(href);
  }
  return out;
}

// ---------- history (pure) ----------
export interface HistoryEntry {
  eventName: string;
  date: string;
  record: { played: number; wins: number; draws: number; losses: number } | null;
  br: { matches: number; bestPlacement: number; kills: number } | null;
}

const same = (x: string, y: string) => x.trim().toLowerCase() === y.trim().toLowerCase();

/** One team's record and battle royale numbers in one event. `null` parts mean nothing was played that way. */
export function computeTeamResults(team: string, matches: Match[], br: BrResult[]): Pick<HistoryEntry, "record" | "br"> {
  let played = 0, wins = 0, draws = 0, losses = 0;
  for (const m of matches) {
    if (m.status !== "finished" && m.status !== "forfeit") continue;
    const isA = same(m.a, team), isB = same(m.b, team);
    if (!isA && !isB) continue;
    const w = m.winner ?? (m.scoreA !== null && m.scoreB !== null ? deriveWinner(m.scoreA, m.scoreB) : null);
    if (!w) continue;
    played++;
    if (w === "draw") draws++;
    else if ((w === "a") === isA) wins++;
    else losses++;
  }
  const mine = br.filter((r) => same(r.team, team));
  return {
    record: played ? { played, wins, draws, losses } : null,
    br: mine.length ? { matches: mine.length, bestPlacement: Math.min(...mine.map((r) => r.placement)), kills: mine.reduce((s, r) => s + r.kills, 0) } : null,
  };
}

// ---------- rows ----------
interface ProfileRow { id: string; owner_user_id: string; name: string; slug: string; published: number; blurb: string; links: string; consent_note: string | null; consent_at: string | null; updated_at: string }
interface LinkRow { profile_id: string; event_id: string; team_name: string }

const parseLinks = (s: string): string[] => { try { const v = JSON.parse(s); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; } catch { return []; } };

const readOwn = (c: Ctx, id: string) =>
  c.env.DB.prepare("SELECT id, owner_user_id, name, slug, published, blurb, links, consent_note, consent_at, updated_at FROM team_profiles WHERE id = ? AND owner_user_id = ?").bind(id, c.get("userId")).first<ProfileRow>();

async function ownProfile(c: Ctx): Promise<ProfileRow> {
  const id = c.req.param("id") ?? "";
  const row = ID_RE.test(id) ? await readOwn(c, id) : null;
  if (!row) throw new HttpError(404, "Profile not found");
  return row;
}

async function ownerShape(c: Ctx, rows: ProfileRow[]) {
  const links = rows.length
    ? (await c.env.DB.prepare(
        "SELECT l.profile_id AS profile_id, l.event_id AS event_id, l.team_name AS team_name, e.name AS event_name FROM team_profile_events l JOIN events e ON e.id = l.event_id WHERE l.profile_id IN (SELECT id FROM team_profiles WHERE owner_user_id = ?) ORDER BY e.name, l.team_name LIMIT 700",
      ).bind(c.get("userId")).all<LinkRow & { event_name: string }>()).results
    : [];
  return rows.map((r) => ({
    id: r.id, name: r.name, slug: r.slug, published: r.published === 1, blurb: r.blurb, links: parseLinks(r.links),
    consentAt: r.consent_at, updatedAt: r.updated_at,
    events: links.filter((l) => l.profile_id === r.id).map((l) => ({ eventId: l.event_id, eventName: l.event_name, teamName: l.team_name })),
  }));
}

const listOwn = (c: Ctx) =>
  c.env.DB.prepare("SELECT id, owner_user_id, name, slug, published, blurb, links, consent_note, consent_at, updated_at FROM team_profiles WHERE owner_user_id = ? ORDER BY updated_at DESC LIMIT 25").bind(c.get("userId")).all<ProfileRow>();

routes.get("/profiles", requireUser, async (c) => c.json({ profiles: await ownerShape(c, (await listOwn(c)).results) }));

routes.post("/profiles", requireUser, async (c) => {
  await rateLimitSubject(c, "profilesWrite", c.get("userId"), 60, 3600);
  const b = await readJson(c, 20_000);
  const name = plainText(b.name, "name", 2, 60);
  const blurb = b.blurb === undefined || b.blurb === null ? "" : plainText(b.blurb, "blurb", 0, 200);
  const links = validateLinks(b.links);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM team_profiles WHERE owner_user_id = ?").bind(c.get("userId")).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_PROFILES) throw new HttpError(409, `You can have at most ${MAX_PROFILES} team pages`);
  const id = crypto.randomUUID();
  for (let attempt = 0; ; attempt++) {
    try {
      await c.env.DB.prepare("INSERT INTO team_profiles (id, owner_user_id, name, slug, published, blurb, links, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)")
        .bind(id, c.get("userId"), name, newSlug(), blurb, JSON.stringify(links), nowIso()).run();
      break;
    } catch (e) { if (attempt >= 4) throw e; }
  }
  return c.json((await ownerShape(c, [(await readOwn(c, id))!]))[0], 201);
});

routes.put("/profiles/:id", requireUser, async (c) => {
  const cur = await ownProfile(c);
  await rateLimitSubject(c, "profilesWrite", c.get("userId"), 60, 3600);
  const b = await readJson(c, 20_000);
  if (b.published !== undefined && typeof b.published !== "boolean") return bad("published must be a boolean");
  if (b.consent !== undefined && typeof b.consent !== "boolean") return bad("consent must be a boolean");
  const name = b.name === undefined ? cur.name : plainText(b.name, "name", 2, 60);
  const blurb = b.blurb === undefined ? cur.blurb : plainText(b.blurb, "blurb", 0, 200);
  const links = b.links === undefined ? parseLinks(cur.links) : validateLinks(b.links);
  let published = cur.published, consentNote = cur.consent_note, consentAt = cur.consent_at;
  if (b.published === true) {
    // Consent is asked every time a page goes public, never assumed from an earlier publish.
    if (b.consent !== true) throw new HttpError(400, `To publish, confirm: ${CONSENT_STATEMENT}`);
    published = 1; consentNote = CONSENT_STATEMENT; consentAt = nowIso();
  } else if (b.published === false) {
    published = 0; consentNote = null; consentAt = null;
  }
  await c.env.DB.prepare("UPDATE team_profiles SET name = ?, blurb = ?, links = ?, published = ?, consent_note = ?, consent_at = ?, updated_at = ? WHERE id = ? AND owner_user_id = ?")
    .bind(name, blurb, JSON.stringify(links), published, consentNote, consentAt, nowIso(), cur.id, c.get("userId")).run();
  return c.json((await ownerShape(c, [(await readOwn(c, cur.id))!]))[0]);
});

routes.delete("/profiles/:id", requireUser, async (c) => {
  const cur = await ownProfile(c);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM team_profile_events WHERE profile_id = ?").bind(cur.id),
    c.env.DB.prepare("DELETE FROM team_profiles WHERE id = ? AND owner_user_id = ?").bind(cur.id, c.get("userId")),
  ]);
  return c.json({ ok: true });
});

/** Reads {eventId, teamName}, after proving the caller can edit that event (owner or editor; a viewer gets 403, a stranger 404). */
async function linkTarget(c: Ctx): Promise<{ eventId: string; teamName: string }> {
  const b = await readJson(c, 5_000);
  if (typeof b.eventId !== "string" || !ID_RE.test(b.eventId)) return bad("eventId must be an event id");
  const ev = await ownedEvent(c, b.eventId);
  if (ev.my_role === "viewer") throw new HttpError(403, "You can view this event but not change it");
  return { eventId: ev.id, teamName: plainText(b.teamName, "teamName", 1, 60) };
}

routes.post("/profiles/:id/link", requireUser, async (c) => {
  const cur = await ownProfile(c);
  await rateLimitSubject(c, "profilesWrite", c.get("userId"), 60, 3600);
  const { eventId, teamName } = await linkTarget(c);
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM team_profile_events WHERE profile_id = ?").bind(cur.id).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_LINKED) throw new HttpError(409, `A team page can cover at most ${MAX_LINKED} events`);
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT OR IGNORE INTO team_profile_events (profile_id, event_id, team_name) VALUES (?, ?, ?)").bind(cur.id, eventId, teamName),
    c.env.DB.prepare("UPDATE team_profiles SET updated_at = ? WHERE id = ?").bind(nowIso(), cur.id),
  ]);
  return c.json((await ownerShape(c, [(await readOwn(c, cur.id))!]))[0], 201);
});

routes.post("/profiles/:id/unlink", requireUser, async (c) => {
  const cur = await ownProfile(c);
  const b = await readJson(c, 5_000);
  if (typeof b.eventId !== "string" || !ID_RE.test(b.eventId) || typeof b.teamName !== "string") return bad("eventId and teamName are required");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM team_profile_events WHERE profile_id = ? AND event_id = ? AND team_name = ?").bind(cur.id, b.eventId, b.teamName.trim()),
    c.env.DB.prepare("UPDATE team_profiles SET updated_at = ? WHERE id = ?").bind(nowIso(), cur.id),
  ]);
  return c.json((await ownerShape(c, [(await readOwn(c, cur.id))!]))[0]);
});

routes.get("/public/team/:slug", async (c) => {
  rateLimitSoft(c, "teamPublic", 240, 60);
  const slug = c.req.param("slug");
  if (!SLUG_RE.test(slug)) throw new HttpError(404, "not_found");
  const p = await c.env.DB.prepare("SELECT id, name, blurb, links, updated_at FROM team_profiles WHERE slug = ? AND published = 1")
    .bind(slug).first<{ id: string; name: string; blurb: string; links: string; updated_at: string }>();
  if (!p) throw new HttpError(404, "not_found");
  const links = (await c.env.DB.prepare(
    "SELECT l.event_id AS event_id, l.team_name AS team_name, e.name AS event_name, e.date AS date FROM team_profile_events l JOIN events e ON e.id = l.event_id WHERE l.profile_id = ? LIMIT 40",
  ).bind(p.id).all<{ event_id: string; team_name: string; event_name: string; date: string }>()).results;
  const cache = new Map<string, { matches: Match[]; br: BrResult[] }>();
  const history: HistoryEntry[] = [];
  for (const l of links) {
    let d = cache.get(l.event_id);
    if (!d) { d = { matches: await listMatches(c.env, l.event_id), br: await listBr(c.env, l.event_id) }; cache.set(l.event_id, d); }
    history.push({ eventName: l.event_name, date: l.date, ...computeTeamResults(l.team_name, d.matches, d.br) });
  }
  history.sort((x, y) => y.date.localeCompare(x.date) || x.eventName.localeCompare(y.eventName));
  const body = JSON.stringify({ name: p.name, blurb: p.blurb, links: parseLinks(p.links), history, updatedAt: p.updated_at });
  const etag = `"${(await sha256(body)).slice(0, 27)}"`;
  const headers = { "cache-control": "public, max-age=30", etag, "content-type": "application/json; charset=UTF-8" };
  const inm = c.req.header("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers: { "cache-control": headers["cache-control"], etag } });
  return new Response(body, { status: 200, headers });
});

export const routeRules: RouteRules = {
  "GET /profiles": { roles: ["owner", "editor", "viewer"], limit: "signed in; own profiles only" },
  "POST /profiles": { roles: ["owner", "editor", "viewer"], limit: "60 writes per hour per user, 20 pages per user" },
  "PUT /profiles/:id": { roles: ["owner", "editor", "viewer"], limit: "60 writes per hour per user; the profile must be the caller's own" },
  "DELETE /profiles/:id": { roles: ["owner", "editor", "viewer"], limit: "own profile only" },
  "POST /profiles/:id/link": { roles: ["owner", "editor"], limit: "60 writes per hour per user; caller must own or edit the event" },
  "POST /profiles/:id/unlink": { roles: ["owner", "editor", "viewer"], limit: "own profile only" },
  "GET /public/team/:slug": { public: true, limit: "240 per minute per address" },
};
