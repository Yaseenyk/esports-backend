/**
 * Phase 3 (flag v3.profiles): public player profiles and team pages. Rules, authorisation and privacy live here; no SQL.
 *
 * Visibility (both kinds): private (default) | unlisted ("link only": readable by anyone with the link, never indexed, never listed) | public.
 *  - A player page is readable only when its owner confirmed 18+ AND gave resume consent AND the account is active AND moderation does not hide it, AND:
 *    by slug, the profile is public; by card link (the QR on a player card: 128 random bits, revocable), the profile is unlisted or public.
 *    Anything else is the same 404 as an unknown slug or token.
 *  - A team page is readable only when it is unlisted or public (legacy published = 1, set together with the captain-permission statement) AND its owner
 *    confirmed 18+ AND the account is active AND neither the legacy takedown nor the v3 moderation hides it.
 *  - Indexable only when public AND the page shows at least one verified result (the frontend ships everything else noindex).
 * Results, matches and certificates come ONLY from results the platform recorded (verified rows of public tournaments, registration approved).
 */
import { HttpError } from "../../http";
import { hidesAtOnce, isReason, sanitiseNote, AUTO_HIDE_AT } from "../../moderation/codes";
import { VISIBILITIES, isOneOf } from "../lib/enums";
import { newId, nowSec, toIso } from "../lib/ids";
import { playerSeoBlockers } from "../lib/player-seo";
import { bad, optBoolean, reqEnum } from "../lib/validate";
import { decryptToken, encryptToken, hashToken } from "../../links";
import { randomToken } from "../../crypto";
import {
  CARD_TOKEN_RE, cardPath, checkAchievements, checkHiddenFields, checkLinks, checkTeamName, storedAchievements, storedHidden, storedLinks,
} from "../lib/player-details";
import * as cards from "../repositories/player-card-repo";
import * as flags from "../repositories/flag-repo";
import type { ProfileRow } from "../repositories/profile-repo";
import * as profiles from "../repositories/profile-repo";
import * as repo from "../repositories/showcase-repo";
import * as tournaments from "../repositories/tournament-repo";
import * as users from "../repositories/user-repo";
import {
  buildShowcase, indexBlockers, itemKeyOf, NO_DETAILS, playerTeams, teamVisibility, toOwnPlayerPage, toOwnTeamPage, toPublicPlayerPage, toPublicTeamPage, type PageDetails,
  type PageVisibility, playerSeoInputOf, type Showcase,
} from "../adapters/showcase-adapter";
import { buildResumeStats, type ResumeStats } from "../adapters/stats-adapter";
import { ownBadgeView, publicBadgesOf, type VerifiedBase } from "./badge-service";

type Body = Record<string, unknown>;

/** The statement a team page owner confirms every time the page becomes visible (same words as the legacy team pages). */
export const TEAM_CONSENT_STATEMENT = "I have the team captain's permission to publish this page";
export const SHOWCASE = { LINK_CAP: 30 } as const;
/** At most this many profiles are considered for indexable pages per request (the weekly cap in the site build is far lower). */
const SEO_LIST_MAX = 200;

const PLAYER_SLUG = /^[a-z0-9-]{3,60}$/;
const TEAM_SLUG = /^[a-z2-7]{12}$/;
const notFound = (): HttpError => new HttpError(404, "Not found");

async function showcaseFor(db: D1Database, entries: repo.EntryRow[], hidden: string[], includeHidden: boolean) {
  if (entries.length === 0) return buildShowcase({ entries: [], matches: [], br: [], corrections: [], publicTeams: [], hidden, includeHidden });
  const pairs = JSON.stringify(entries.map((e) => ({ e: e.event_id, k: e.team_key })));
  const events = JSON.stringify([...new Set(entries.map((e) => e.event_id))]);
  const [matches, br, corrections, publicTeams] = await Promise.all([repo.matchesFor(db, pairs), repo.brFor(db, pairs), repo.correctionsForEvents(db, events), repo.publicTeamKeys(db, events)]);
  return buildShowcase({ entries, matches, br, corrections, publicTeams, hidden, includeHidden });
}

// ---------------------------------------------------------------- player pages
/** Secrets the player-page code needs: the database and LINK_KEY (the owner's re-displayable copy of the card link). */
export type CardEnv = { DB: D1Database; LINK_KEY?: string };

/** The owner's page details (migration 0081), parsed and re-validated. */
async function detailsOf(db: D1Database, userId: string): Promise<{ details: PageDetails; row: cards.DetailsRow | null }> {
  const row = await cards.getDetails(db, userId);
  if (!row) return { details: NO_DETAILS, row: null };
  return { details: { teamName: row.team_name, links: storedLinks(row.links), achievements: storedAchievements(row.achievements), hidden: storedHidden(row.hidden_fields), searchOptIn: row.search_opt_in_at !== null, searchSince: row.search_opt_in_at }, row };
}

/** The public showcase and verified stats of an account (hidden entries excluded), as every public page and the badges see them. */
async function publicShowcaseOf(db: D1Database, userId: string) {
  const [entries, hidden] = await Promise.all([repo.captainEntries(db, userId), repo.playerHiddenKeys(db, userId)]);
  const s = await showcaseFor(db, entries, hidden, false);
  const corrections = entries.length ? await repo.correctionsForEvents(db, JSON.stringify([...new Set(entries.map((e) => e.event_id))])) : [];
  return { s, stats: buildResumeStats(s.statRows.matches, s.statRows.br, corrections) };
}

/** The verified part of the badge facts (lib/badges.ts): tournaments shown, verified stats, whether a card link was made. */
const verifiedBase = (s: Showcase, stats: ResumeStats, row: cards.DetailsRow | null): VerifiedBase => ({ tournaments: s.entries.length, stats, cardCreated: !!row?.card_token_at });

/** A shared page for this profile row. The caller has already checked visibility, consent, 18+, account status and moderation. */
async function buildPublicPlayer(db: D1Database, profile: ProfileRow) {
  const userId = profile.userId;
  const [{ s, stats }, games, teamPages, d] = await Promise.all([publicShowcaseOf(db, userId), profiles.listGames(db, userId), repo.visibleTeamPagesOf(db, userId), detailsOf(db, userId)]);
  const badges = await publicBadgesOf(db, userId, verifiedBase(s, stats, d.row), d.details.hidden.includes("badges"));
  return toPublicPlayerPage(profile, games, stats, s, playerTeams(s.entries, teamPages), d.details, badges);
}

/** GET /v3/me/badges (flag v3.achievements): every badge with its rule, earned or not, and the owner's show/hide choices. */
export async function myBadges(env: CardEnv, userId: string) {
  await me(env.DB, userId);
  const [{ s, stats }, d] = await Promise.all([publicShowcaseOf(env.DB, userId), detailsOf(env.DB, userId)]);
  return ownBadgeView(env.DB, userId, verifiedBase(s, stats, d.row), d.details.hidden.includes("badges"));
}

/**
 * GET /public/profiles/players/:slug. Only a PUBLIC profile: a Link only profile opens through its card link (/public/profiles/cards/:token), never by
 * its slug, which a person picks and others can guess. Owner 18+ confirmed, consent given, account active, not hidden by moderation; else the same 404.
 */
export async function publicPlayerPage(db: D1Database, slug: string) {
  if (!PLAYER_SLUG.test(slug)) throw notFound();
  const r = await profiles.getProfileBySlugWithConsent(db, slug);
  if (!r || r.profile.visibility !== "public" || r.adultConfirmedAt === null || r.resumeConsentAt === null || r.userStatus !== "active") throw notFound();
  if ((await repo.moderationHiddenAt(db, "player", r.profile.userId)) !== null) throw notFound();
  return buildPublicPlayer(db, r.profile);
}

async function me(db: D1Database, userId: string) {
  const u = await users.getUserV3(db, userId);
  if (!u) throw new HttpError(401, "Authentication required");
  return u;
}

/** The owner's card link, decrypted. null when there is none (or the copy cannot be read, which the owner fixes with Reset). */
async function cardLinkOf(env: CardEnv, userId: string, row: cards.DetailsRow | null): Promise<string | null> {
  if (!row?.card_token_enc) return null;
  const t = await decryptToken(env, "pcard", userId, row.card_token_enc);
  return t && CARD_TOKEN_RE.test(t) ? cardPath(t) : null;
}

/** GET /v3/me/player-page: the owner's view (hidden entries included and marked, what still blocks indexing, page details, the card link). */
export async function myPlayerPage(env: CardEnv, userId: string) {
  const db = env.DB;
  const u = await me(db, userId);
  const p = await profiles.getProfile(db, userId);
  if (!p) return { page: null };
  const [entries, hidden, teamPages, hiddenAt, d, games] = await Promise.all([repo.captainEntries(db, userId), repo.playerHiddenKeys(db, userId), repo.visibleTeamPagesOf(db, userId), repo.moderationHiddenAt(db, "player", userId), detailsOf(db, userId), profiles.listGames(db, userId)]);
  const s = await showcaseFor(db, entries, hidden, true);
  const extra: string[] = [];
  if (u.adultConfirmedAt === null) extra.push("adult_required");
  if (u.resumeConsentAt === null) extra.push("consent_required");
  if (hiddenAt !== null) extra.push("hidden_by_moderation");
  const blockers = [...extra, ...playerSeoBlockers(playerSeoInputOf(p, games.length, s, d.details))]; // the quality gate for an indexable /players/<slug>/ page
  const link = await cardLinkOf(env, userId, d.row);
  return {
    page: toOwnPlayerPage(p, s, { blockers, moderationHidden: hiddenAt !== null, teams: playerTeams(s.entries, teamPages), details: d.details, cardPath: link, cardCreatedAt: link ? (d.row?.card_token_at ?? null) : null }),
  };
}

/** A fresh card link: 128 random bits, stored as a hash (lookup) and an AES-GCM copy (re-display). Replaces any old link in one statement. */
async function issueCardLink(env: CardEnv, userId: string): Promise<void> {
  const token = randomToken(16);
  await cards.setCardToken(env.DB, userId, await hashToken(token), await encryptToken(env, "pcard", userId, token), nowSec());
}

/**
 * PUT /v3/me/player-page/visibility {visibility}. Link only and Public both need the 18+ confirmation and resume consent.
 * Choosing Link only creates the card link when there is none yet: that link is the page's only address.
 */
export async function setMyPlayerVisibility(env: CardEnv, userId: string, b: Body) {
  const db = env.DB;
  const u = await me(db, userId);
  const visibility = reqEnum(b.visibility, VISIBILITIES, "visibility");
  const p = await profiles.getProfile(db, userId);
  if (!p) throw new HttpError(409, "Create your profile first", { code: "profile_required" });
  if (visibility !== "private") {
    if (u.adultConfirmedAt === null) throw new HttpError(409, "Confirm that you are 18 or older before sharing your profile", { code: "adult_required" });
    if (u.resumeConsentAt === null) throw new HttpError(409, "Give consent to a shared Esports Resume first", { code: "consent_required" });
  }
  await profiles.updateProfile(db, userId, { visibility, updatedAt: nowSec() });
  if (visibility === "unlisted" && !(await cardLinkOf(env, userId, await cards.getDetails(db, userId)))) await issueCardLink(env, userId);
  return myPlayerPage(env, userId);
}

/**
 * POST /v3/me/player-page/card-link: the link the player card's QR holds. Idempotent: an existing link is returned unchanged (printed cards keep working).
 * Never publishes anything: the profile must already be Link only or Public (else 409 share_first, and the screen sends the player to that one step).
 */
export async function ensureMyCardLink(env: CardEnv, userId: string) {
  const db = env.DB;
  const u = await me(db, userId);
  const p = await profiles.getProfile(db, userId);
  if (!p) throw new HttpError(409, "Create your profile first", { code: "profile_required" });
  if (p.visibility === "private" || u.adultConfirmedAt === null || u.resumeConsentAt === null) {
    throw new HttpError(409, "Share your profile (Link only or Public) before you put it on a card", { code: "share_first" });
  }
  if (!(await cardLinkOf(env, userId, await cards.getDetails(db, userId)))) await issueCardLink(env, userId);
  return myPlayerPage(env, userId);
}

/** POST /v3/me/player-page/card-link/reset: a new link; the old one (and every card printed with it) stops working at once. Allowed whatever the visibility. */
export async function resetMyCardLink(env: CardEnv, userId: string) {
  await me(env.DB, userId);
  if (!(await profiles.getProfile(env.DB, userId))) throw new HttpError(409, "Create your profile first", { code: "profile_required" });
  await issueCardLink(env, userId);
  return myPlayerPage(env, userId);
}

/** PUT /v3/me/player-page/details {teamName?, links?, achievements?, hiddenFields?}: only the fields sent change. */
export async function setMyPageDetails(env: CardEnv, userId: string, b: Body) {
  const db = env.DB;
  await me(db, userId);
  if (!(await profiles.getProfile(db, userId))) throw new HttpError(409, "Create your profile first", { code: "profile_required" });
  const { details } = await detailsOf(db, userId);
  const teamName = checkTeamName(b.teamName);
  const next = {
    teamName: teamName === undefined ? details.teamName : teamName,
    links: b.links === undefined ? details.links : checkLinks(b.links),
    achievements: b.achievements === undefined ? details.achievements : checkAchievements(b.achievements),
    hidden: b.hiddenFields === undefined ? details.hidden : checkHiddenFields(b.hiddenFields),
  };
  const optIn = optBoolean(b.searchOptIn, "searchOptIn");
  // The opt-in time is kept while it stays on (the site's weekly cap of new indexable pages counts from it); switching off clears it.
  const searchOptInAt = optIn === undefined ? details.searchSince : optIn ? (details.searchSince ?? nowSec()) : null;
  await cards.upsertDetails(db, userId, { teamName: next.teamName, links: JSON.stringify(next.links), achievements: JSON.stringify(next.achievements), hiddenFields: JSON.stringify(next.hidden), searchOptInAt }, nowSec());
  return myPlayerPage(env, userId);
}

/** Every bad, revoked, private, hidden or unknown card link: the same 404 after the same work (one hash and one query). */
async function readableCardTarget(db: D1Database, token: string): Promise<cards.CardTarget> {
  const wellFormed = CARD_TOKEN_RE.test(token);
  const r = await cards.resolveCardToken(db, await hashToken(wellFormed ? token : "_".repeat(22)));
  if (!wellFormed || !r) throw notFound();
  const v = r.profile.visibility;
  if ((v !== "public" && v !== "unlisted") || r.adultConfirmedAt === null || r.resumeConsentAt === null || r.userStatus !== "active" || r.hiddenAt !== null) throw notFound();
  return r;
}

/** GET /public/profiles/cards/:token: the page a player card's QR opens. */
export async function publicPlayerByCard(db: D1Database, token: string) {
  return buildPublicPlayer(db, (await readableCardTarget(db, token)).profile);
}

/**
 * GET /public/profiles/players: the slugs that get a pre-rendered, indexable /players/<slug>/ page at the next site build (the quality gate passed).
 * `listedSince` (the opt-in time) lets the build hold back pages past its weekly cap. A profile that later fails the gate simply drops out of this list.
 */
export async function indexablePlayers(db: D1Database) {
  const items: { slug: string; listedSince: string | null; updatedAt: string | null }[] = [];
  for (const c of await cards.searchCandidates(db, SEO_LIST_MAX)) {
    const page = await buildPublicPlayer(db, c.profile);
    if (page.indexable && page.slug) items.push({ slug: page.slug, listedSince: toIso(c.searchSince), updatedAt: page.updatedAt });
  }
  return { items };
}

/** Account clean-up when the profile itself is deleted: the page details and the card link go with it. */
export async function deletePageDetails(db: D1Database, userId: string): Promise<void> {
  await cards.deleteDetails(db, userId);
}

function itemKeyFrom(b: Body): { key: string; hidden: boolean } {
  if (typeof b.itemKey !== "string" || b.itemKey.length < 3 || b.itemKey.length > 140) throw bad("itemKey is required", "invalid_itemKey");
  if (typeof b.hidden !== "boolean") throw bad("hidden must be true or false", "invalid_hidden");
  return { key: b.itemKey, hidden: b.hidden };
}

/** PUT /v3/me/player-page/hidden {itemKey, hidden}. Only entries that are on the page can be hidden (anything else is 404). */
export async function setMyPlayerHidden(env: CardEnv, userId: string, b: Body) {
  const db = env.DB;
  await me(db, userId);
  const { key, hidden } = itemKeyFrom(b);
  if (!(await profiles.getProfile(db, userId))) throw new HttpError(409, "Create your profile first", { code: "profile_required" });
  const entries = await repo.captainEntries(db, userId);
  if (!entries.some((e) => itemKeyOf(e.slug, e.team_key) === key)) throw notFound();
  await repo.setPlayerHidden(db, userId, key, hidden, nowSec());
  return myPlayerPage(env, userId);
}

// ---------------------------------------------------------------- team pages
function teamReadable(t: repo.TeamPageRow): boolean {
  return teamVisibility(t) !== "private" && t.owner_adult !== null && t.owner_status === "active";
}

/** GET /public/profiles/teams/:slug */
export async function publicTeamPage(db: D1Database, slug: string) {
  if (!TEAM_SLUG.test(slug)) throw notFound();
  const t = await repo.teamPageBySlug(db, slug);
  if (!t || !teamReadable(t)) throw notFound();
  if ((await repo.teamPageTakenDown(db, t.id)) || (await repo.moderationHiddenAt(db, "team", t.id)) !== null) throw notFound();
  const [entries, hidden] = await Promise.all([repo.teamPageEntries(db, t.id), repo.teamHiddenKeys(db, t.id)]);
  return toPublicTeamPage(t, await showcaseFor(db, entries, hidden, false));
}

async function ownTeam(db: D1Database, userId: string, id: string): Promise<repo.TeamPageRow> {
  const t = /^[A-Za-z0-9-]{8,64}$/.test(id) ? await repo.teamPageOwned(db, userId, id) : null;
  if (!t) throw notFound();
  return t;
}

async function teamBlockers(db: D1Database, t: repo.TeamPageRow, s: { hasVerifiedContent: boolean }) {
  const extra: string[] = [];
  if (t.owner_adult === null) extra.push("adult_required");
  const hiddenAt = await repo.moderationHiddenAt(db, "team", t.id);
  const takenDown = await repo.teamPageTakenDown(db, t.id);
  if (hiddenAt !== null || takenDown) extra.push("hidden_by_moderation");
  return { blockers: indexBlockers(teamVisibility(t), s, extra), moderationHidden: hiddenAt !== null || takenDown };
}

/** GET /v3/me/team-pages: the caller's team pages with their visibility and what blocks indexing. */
export async function myTeamPages(db: D1Database, userId: string) {
  await me(db, userId);
  const rows = await repo.teamPagesOf(db, userId);
  const items = [];
  for (const t of rows) {
    const [entries, hidden] = await Promise.all([repo.teamPageEntries(db, t.id), repo.teamHiddenKeys(db, t.id)]);
    const s = await showcaseFor(db, entries, hidden, true);
    const b = await teamBlockers(db, t, s);
    const own = toOwnTeamPage(t, null, b);
    items.push({ ...own, tournaments: s.entries.filter((e) => !e.hidden).length, certificates: s.certificates.filter((c) => !c.hidden).length });
  }
  return { items, consentStatement: TEAM_CONSENT_STATEMENT };
}

/** GET /v3/me/team-pages/:id: one page with every entry (hidden ones marked) and the tournaments the caller captained that could be added. */
export async function myTeamPage(db: D1Database, userId: string, id: string) {
  await me(db, userId);
  const t = await ownTeam(db, userId, id);
  const [entries, hidden, mine] = await Promise.all([repo.teamPageEntries(db, t.id), repo.teamHiddenKeys(db, t.id), repo.captainEntries(db, userId)]);
  const s = await showcaseFor(db, entries, hidden, true);
  const linked = new Set(entries.map((e) => `${e.event_id}|${e.team_key}`));
  const claimable = mine.filter((e) => !linked.has(`${e.event_id}|${e.team_key}`)).map((e) => ({ tournament: { slug: e.slug, title: e.title }, team: e.team_name }));
  return { page: toOwnTeamPage(t, s, { ...(await teamBlockers(db, t, s)), claimable }), consentStatement: TEAM_CONSENT_STATEMENT };
}

/**
 * PUT /v3/me/team-pages/:id/visibility {visibility, consent}. Link only and Public need the owner's 18+ confirmation and, every time, `consent: true` for the
 * captain-permission statement (stored with its time, cleared when the page goes private). The legacy published bit follows in the same batch.
 */
export async function setMyTeamVisibility(db: D1Database, userId: string, id: string, b: Body) {
  const u = await me(db, userId);
  const t = await ownTeam(db, userId, id);
  const visibility = reqEnum(b.visibility, VISIBILITIES, "visibility");
  if (visibility !== "private") {
    if (u.adultConfirmedAt === null) throw new HttpError(409, "Confirm that you are 18 or older before sharing a team page", { code: "adult_required" });
    if (b.consent !== true) throw new HttpError(400, `To share this page, confirm: ${TEAM_CONSENT_STATEMENT}`, { code: "consent_required", statement: TEAM_CONSENT_STATEMENT });
  }
  await repo.setTeamVisibility(db, { id: t.id, ownerId: userId, visibility, at: nowSec(), consentNote: visibility === "private" ? null : TEAM_CONSENT_STATEMENT });
  return myTeamPage(db, userId, t.id);
}

/**
 * POST /v3/me/team-pages/:id/claims {tournamentSlug, team?}: adds a tournament the caller captained (proved with the captain link) to their team page.
 * The page then shows that team's verified results there. `team` picks one when the caller captains several teams in that tournament.
 */
export async function linkMyClaim(db: D1Database, userId: string, id: string, b: Body) {
  await me(db, userId);
  const t = await ownTeam(db, userId, id);
  if (typeof b.tournamentSlug !== "string" || !PLAYER_SLUG.test(b.tournamentSlug)) throw bad("tournamentSlug is required", "invalid_tournamentSlug");
  const tour = await tournaments.findBySlug(db, b.tournamentSlug);
  if (!tour || !(tournaments.PUBLIC_STATUSES as readonly string[]).includes(tour.status)) throw notFound();
  const caps = await repo.captainTeamsInEvent(db, userId, tour.eventId);
  const want = typeof b.team === "string" ? b.team.trim().toLowerCase() : caps.length === 1 ? caps[0]!.team_key : "";
  const cap = caps.find((c) => c.team_key === want);
  if (!cap) throw new HttpError(403, "You can add a tournament only for a team you captained (claim it with the captain link first)", { code: "not_captain" });
  if (!(await repo.linkTeamPageEvent(db, t.id, tour.eventId, cap.team_name, nowSec(), SHOWCASE.LINK_CAP))) throw new HttpError(409, `A team page can cover at most ${SHOWCASE.LINK_CAP} tournaments`, { code: "link_cap" });
  return myTeamPage(db, userId, t.id);
}

/** PUT /v3/me/team-pages/:id/hidden {itemKey, hidden} */
export async function setMyTeamHidden(db: D1Database, userId: string, id: string, b: Body) {
  await me(db, userId);
  const t = await ownTeam(db, userId, id);
  const { key, hidden } = itemKeyFrom(b);
  const entries = await repo.teamPageEntries(db, t.id);
  if (!entries.some((e) => itemKeyOf(e.slug, e.team_key) === key)) throw notFound();
  await repo.setTeamHidden(db, t.id, key, hidden, nowSec());
  return myTeamPage(db, userId, t.id);
}

// ---------------------------------------------------------------- reports and staff
/**
 * A signed-in user reports a readable player or team page. One account counts once (salted hash). The page is hidden at once for a minor report, or at
 * AUTO_HIDE_AT distinct reporters, but only while takedown.enforce is on (reports are recorded either way). The answer never says whether it was hidden.
 */
export async function reportProfile(db: D1Database, reporter: string, userId: string, kind: "player" | "team", slug: string, b: Body) {
  let key: string;
  let ownerId: string;
  if (kind === "player") {
    await publicPlayerPage(db, slug); // 404 unless readable
    key = ownerId = (await repo.playerKeyBySlug(db, slug))!;
  } else {
    await publicTeamPage(db, slug);
    const t = (await repo.teamKeyBySlug(db, slug))!;
    key = t.id;
    ownerId = t.owner_user_id;
  }
  return fileReport(db, reporter, userId, kind, key, ownerId, b);
}

/** POST /v3/profiles/cards/:token/report: a report on a page opened through a card link (a Link only page has no other address). Same rules. */
export async function reportPlayerByCard(db: D1Database, reporter: string, userId: string, token: string, b: Body) {
  const owner = (await readableCardTarget(db, token)).profile.userId;
  return fileReport(db, reporter, userId, "player", owner, owner, b);
}

async function fileReport(db: D1Database, reporter: string, userId: string, kind: "player" | "team", key: string, ownerId: string, b: Body) {
  if (ownerId === userId) throw new HttpError(403, "You cannot report your own page", { code: "own_page" });
  if (!isReason(b.reason)) throw bad("reason is not one of the listed reasons", "invalid_reason");
  const enforce = await flags.takedownEnforced(db);
  await repo.fileProfileReport(db, { id: newId(), kind, key, reporter, reasonCode: b.reason, note: sanitiseNote(b.note), at: nowSec() }, AUTO_HIDE_AT, enforce, hidesAtOnce(b.reason));
  return { ok: true };
}

export async function hiddenProfiles(db: D1Database) {
  const rows = await repo.listHiddenProfiles(db);
  return { items: rows.map((r) => ({ kind: r.target_kind, slug: r.slug, label: r.label, reportCount: r.report_count, hiddenAt: new Date(r.hidden_at * 1000).toISOString() })) };
}

/** Staff: restore (clears the hide and the reports) or remove (the page goes private and stays hidden). Decided by kind + public slug. */
export async function decideProfile(db: D1Database, kindRaw: string, slug: string, decisionRaw: unknown) {
  if (!isOneOf(["player", "team"] as const, kindRaw)) throw notFound();
  if (!isOneOf(["restore", "remove"] as const, decisionRaw)) throw bad("decision must be restore or remove", "invalid_decision");
  const at = nowSec();
  let key: string | null;
  if (kindRaw === "player") key = PLAYER_SLUG.test(slug) ? await repo.playerKeyBySlug(db, slug) : null;
  else key = TEAM_SLUG.test(slug) ? ((await repo.teamKeyBySlug(db, slug))?.id ?? null) : null;
  if (!key) throw notFound();
  if (decisionRaw === "restore") {
    if (!(await repo.restoreProfile(db, kindRaw, key, at))) throw new HttpError(409, "This page is not hidden", { code: "not_hidden" });
  } else if (kindRaw === "player") await repo.removePlayerProfile(db, key, at);
  else await repo.removeTeamPage(db, key, at);
  return { ok: true, decision: decisionRaw };
}
