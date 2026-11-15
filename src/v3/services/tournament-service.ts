/** Tournament rules, authorisation and the state machine. No SQL here: everything goes through repositories. */
import { HttpError } from "../../http";
import { GAMES, TOURNAMENT_FORMATS, TOURNAMENT_STATUSES, VENUES, isOneOf, type TournamentStatus } from "../lib/enums";
import { newId, nowSec } from "../lib/ids";
import { seoVerdict } from "../lib/seo-guard";
import { checkSlug, slugify } from "../lib/slug";
import { TOURNAMENT_MOVES, canMove } from "../lib/state-machines";
import { bad, optDate, optEnum, optInt, optText, reqEnum, reqText } from "../lib/validate";
import { loadEventAccess, type EventAccessRow } from "../repositories/event-access-repo";
import * as repo from "../repositories/tournament-repo";
import { onTournamentCompleted } from "./discord-service";
import type { TournamentRow } from "../repositories/tournament-repo";
import { toOrganiserTournament, toPublicDetail, toPublicLive, toPublicTournament } from "../adapters/tournament-adapter";

type Body = Record<string, unknown>;

/** Owner or editor (an org admin acts as owner). A viewer may read, not change. Unknown event or no access: 404. */
async function organiserAccess(db: D1Database, userId: string, eventId: string, write: boolean): Promise<EventAccessRow> {
  const a = await loadEventAccess(db, userId, eventId);
  if (!a) throw new HttpError(404, "Event not found");
  if (write && !a.canWrite) throw new HttpError(403, "You can view this event but not change it");
  return a;
}

async function seoFor(db: D1Database, t: TournamentRow) {
  const [titleUsed, results] = await Promise.all([repo.titleUsedByOther(db, t.title, t.id), repo.hasVerifiedResults(db, t.eventId)]);
  return seoVerdict({
    title: t.title, titleIsUnique: !titleUsed, summary: t.summary, description: t.description, startsAt: t.startsAt, venue: t.venue, city: t.city,
    status: t.status, hasVerifiedResults: results, publishedAt: t.publishedAt,
  });
}

async function refreshSeo(db: D1Database, t: TournamentRow): Promise<{ row: TournamentRow; failures: string[] }> {
  const v = await seoFor(db, t);
  if (v.ready !== t.seoReady) {
    await repo.update(db, t.id, { seoReady: v.ready, updatedAt: nowSec() });
    return { row: { ...t, seoReady: v.ready }, failures: v.failures };
  }
  return { row: t, failures: v.failures };
}

const TEXT_LIMITS = { summary: 300, description: 8000, rules: 8000, city: 60, state: 60 } as const;

function patchFrom(b: Body): Partial<repo.TournamentInsert> {
  const p: Partial<repo.TournamentInsert> = {};
  const title = optText(b.title, "title", 120, 3);
  if (title !== undefined) p.title = title ?? "";
  const summary = optText(b.summary, "summary", TEXT_LIMITS.summary);
  if (summary !== undefined) p.summary = summary;
  const description = optText(b.description, "description", TEXT_LIMITS.description);
  if (description !== undefined) p.description = description;
  const rules = optText(b.rules, "rules", TEXT_LIMITS.rules);
  if (rules !== undefined) p.rules = rules;
  const city = optText(b.city, "city", TEXT_LIMITS.city);
  if (city !== undefined) p.city = city;
  const state = optText(b.state, "state", TEXT_LIMITS.state);
  if (state !== undefined) p.state = state;
  const game = optEnum(b.game, GAMES, "game");
  if (game) p.game = game;
  const format = optEnum(b.format, TOURNAMENT_FORMATS, "format");
  if (format) p.format = format;
  const venue = optEnum(b.venue, VENUES, "venue");
  if (venue) p.venue = venue;
  const maxTeams = optInt(b.maxTeams, "maxTeams", 2, 1024);
  if (maxTeams !== undefined) p.maxTeams = maxTeams;
  const startsAt = optDate(b.startsAt, "startsAt");
  if (startsAt !== undefined) p.startsAt = startsAt;
  const endsAt = optDate(b.endsAt, "endsAt");
  if (endsAt !== undefined) p.endsAt = endsAt;
  return p;
}

export async function createTournament(db: D1Database, userId: string, eventId: string, b: Body) {
  const access = await organiserAccess(db, userId, eventId, true);
  if (await repo.findByEventId(db, access.eventId)) throw new HttpError(409, "This event already has a tournament page", { code: "tournament_exists" });
  const title = reqText(b.title, "title", 3, 120);
  const game = reqEnum(b.game, GAMES, "game");
  const format = reqEnum(b.format, TOURNAMENT_FORMATS, "format");
  const patch = patchFrom(b);
  if (patch.startsAt && patch.endsAt && patch.endsAt < patch.startsAt) throw bad("endsAt must not be before startsAt", "invalid_endsAt");

  let slug: string;
  if (b.slug !== undefined) {
    const c = checkSlug(b.slug);
    if (!c.ok) throw bad(`slug is not allowed (${c.reason})`, `slug_${c.reason}`);
    if (await repo.slugTaken(db, c.slug)) throw new HttpError(409, "That slug is taken", { code: "slug_taken" });
    slug = c.slug;
  } else {
    let base = slugify(title);
    if (!checkSlug(base).ok) base = `tournament-${base}`.replace(/-+$/, "");
    slug = base;
    if (!checkSlug(slug).ok || (await repo.slugTaken(db, slug))) slug = `${slugify(title, 40) || "tournament"}-${newId().slice(0, 5)}`;
  }
  const row: repo.TournamentInsert = { ...patch, id: newId(), eventId: access.eventId, slug, title, game, format, status: "draft", venue: patch.venue ?? "online", seoReady: false };
  if (!(await repo.insert(db, row))) throw new HttpError(409, "That slug or event already has a tournament page", { code: "slug_taken" });
  const t = (await repo.findByEventId(db, access.eventId))!;
  return toOrganiserTournament(t, (await seoFor(db, t)).failures);
}

export async function getTournamentForOrganiser(db: D1Database, userId: string, eventId: string) {
  const access = await organiserAccess(db, userId, eventId, false);
  const t = await repo.findByEventId(db, access.eventId);
  if (!t) throw new HttpError(404, "No tournament page for this event");
  return toOrganiserTournament(t, (await seoFor(db, t)).failures);
}

export async function updateTournament(db: D1Database, userId: string, eventId: string, b: Body) {
  const access = await organiserAccess(db, userId, eventId, true);
  const t = await repo.findByEventId(db, access.eventId);
  if (!t) throw new HttpError(404, "No tournament page for this event");
  if (t.status === "completed" || t.status === "cancelled") throw new HttpError(409, "A finished tournament cannot be edited", { code: "tournament_final" });
  const patch = patchFrom(b);
  if (b.slug !== undefined && b.slug !== t.slug) {
    if (t.publishedAt) throw new HttpError(409, "The slug is stable once the page has been published", { code: "slug_locked" });
    const c = checkSlug(b.slug);
    if (!c.ok) throw bad(`slug is not allowed (${c.reason})`, `slug_${c.reason}`);
    if (await repo.slugTaken(db, c.slug)) throw new HttpError(409, "That slug is taken", { code: "slug_taken" });
    patch.slug = c.slug;
  }
  const starts = patch.startsAt !== undefined ? patch.startsAt : t.startsAt;
  const ends = patch.endsAt !== undefined ? patch.endsAt : t.endsAt;
  if (starts && ends && ends < starts) throw bad("endsAt must not be before startsAt", "invalid_endsAt");
  // A page that is already open for registration keeps its description and start date.
  if (["registration_open", "registration_closed", "live"].includes(t.status)) {
    const desc = patch.description !== undefined ? patch.description : t.description;
    if (!desc || !starts) throw new HttpError(409, "An open tournament needs a description and a start date", { code: "needs_description_and_start" });
  }
  await repo.update(db, t.id, { ...patch, updatedAt: nowSec() });
  const next = (await repo.findById(db, t.id))!;
  const r = await refreshSeo(db, next);
  return toOrganiserTournament(r.row, r.failures);
}

export async function transitionTournament(db: D1Database, userId: string, eventId: string, toRaw: unknown) {
  const access = await organiserAccess(db, userId, eventId, true);
  const t = await repo.findByEventId(db, access.eventId);
  if (!t) throw new HttpError(404, "No tournament page for this event");
  if (!isOneOf(TOURNAMENT_STATUSES, toRaw)) throw bad("to must be a tournament status", "invalid_to");
  const to: TournamentStatus = toRaw;
  if (!canMove(TOURNAMENT_MOVES, t.status, to)) throw new HttpError(409, `A tournament cannot go from ${t.status} to ${to}`, { code: "bad_transition", from: t.status, allowed: TOURNAMENT_MOVES[t.status] });
  if (to === "registration_open" && (!t.description?.trim() || !t.startsAt)) {
    throw new HttpError(409, "A description and a start date are needed before registration can open", { code: "needs_description_and_start" });
  }
  if (to === "completed" && (await repo.undecidedDisputes(db, t.id)) > 0) {
    throw new HttpError(409, "Decide every open dispute before the tournament is completed", { code: "disputes_open" });
  }
  const at = nowSec();
  await repo.update(db, t.id, { status: to, publishedAt: t.publishedAt ?? (to === "published" ? at : null), updatedAt: at });
  if (to === "completed") await onTournamentCompleted(db, t.eventId); // Discord: archive team channels (flag-guarded, never throws)
  const next = (await repo.findById(db, t.id))!;
  const r = await refreshSeo(db, next);
  return toOrganiserTournament(r.row, r.failures);
}

// ---------------- public reads ----------------

const LIST_MAX = 50;
export async function listPublicTournaments(db: D1Database, q: { status?: string; game?: string; limit?: string }) {
  if (q.status !== undefined && !(repo.PUBLIC_STATUSES as readonly string[]).includes(q.status)) throw bad("status is not a public status", "invalid_status");
  if (q.game !== undefined && !isOneOf(GAMES, q.game)) throw bad("game is not valid", "invalid_game");
  const n = q.limit === undefined ? 24 : Number(q.limit);
  if (!Number.isInteger(n) || n < 1) throw bad("limit must be a positive whole number", "invalid_limit");
  const rows = await repo.listPublic(db, { status: q.status, game: q.game, limit: Math.min(n, LIST_MAX) });
  const items: ReturnType<typeof toPublicTournament>[] = [];
  for (const t of rows) {
    if (await repo.eventHidden(db, t.eventId)) continue;
    items.push(toPublicTournament(t, t.seoReady));
  }
  return { items };
}

async function publicRow(db: D1Database, slug: string): Promise<TournamentRow> {
  if (!/^[a-z0-9-]{3,60}$/.test(slug)) throw new HttpError(404, "Not found");
  const t = await repo.findBySlug(db, slug);
  if (!t || !(repo.PUBLIC_STATUSES as readonly string[]).includes(t.status)) throw new HttpError(404, "Not found");
  if (await repo.eventHidden(db, t.eventId)) throw new HttpError(404, "Not found");
  return t;
}

export async function publicTournamentDetail(db: D1Database, slug: string) {
  const t = await publicRow(db, slug);
  const [counts, teams, matches, br, corrections, v] = await Promise.all([
    repo.registrationCounts(db, t.eventId), repo.publicTeams(db, t.eventId), repo.legacyMatches(db, t.eventId), repo.legacyBrResults(db, t.eventId),
    repo.correctionsFor(db, t.eventId), seoFor(db, t),
  ]);
  return toPublicDetail({ t, seoReady: v.ready, counts, teams, matches, br, corrections });
}

export async function publicLive(db: D1Database, slug: string) {
  const t = await publicRow(db, slug);
  return toPublicLive(t, await repo.registrationCounts(db, t.eventId));
}
