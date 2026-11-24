/**
 * Phase 5 (flag v3.directory): the public tournament directory. Rules only; no SQL.
 *  - Lists UPCOMING public tournaments (published, registration open or closed, live; a start date; not over yet), soonest first, filtered by game and city.
 *  - `indexable` is true only when at least DIRECTORY.MIN_FOR_INDEX upcoming public tournaments exist: below that the page is thin and the frontend ships it
 *    noindex and out of the sitemap (the site goes to an AdSense review; an almost empty list reads as thin content).
 *  - Register button: the organiser's team sign-up link is shown ONLY when the organiser opted in (v3_tournament_directory.signup_public) AND the tournament's
 *    registration is open AND the form is open, not past its closing time and not full. Otherwise the card opens the tournament page.
 */
import { HttpError } from "../../http";
import { revealToken } from "../../links";
import { GAMES } from "../lib/enums";
import { nowSec, toIso } from "../lib/ids";
import { bad, optBoolean, reqEnum } from "../lib/validate";
import * as repo from "../repositories/directory-repo";
import { loadEventAccess } from "../repositories/event-access-repo";
import * as tournaments from "../repositories/tournament-repo";
import { toDirectoryItem } from "../adapters/directory-adapter";

export const DIRECTORY = { MIN_FOR_INDEX: 5, PAGE_DEFAULT: 24, PAGE_MAX: 50 } as const;

type Env = { DB: D1Database; LINK_KEY?: string };

function formOpen(f: { open: number | null; closes_at: string | null; max_teams: number | null } | null, registered: number, now: number): boolean {
  if (!f || f.open !== 1) return false;
  if (f.closes_at !== null && Date.parse(f.closes_at) / 1000 < now) return false;
  return f.max_teams === null || registered < f.max_teams;
}
const tournamentOpen = (status: string, maxTeams: number | null, registered: number) => status === "registration_open" && (maxTeams === null || registered < maxTeams);

/** GET /public/tournament-directory?game=&city=&limit= */
export async function publicDirectory(env: Env, q: Record<string, string | undefined>) {
  const game = q.game === undefined || q.game === "" ? undefined : reqEnum(q.game, GAMES, "game");
  let city: string | undefined;
  if (q.city !== undefined && q.city !== "") {
    if (q.city.length > 60 || /[<>]/.test(q.city)) throw bad("city is not valid", "invalid_city");
    city = q.city.trim();
  }
  const n = q.limit === undefined ? DIRECTORY.PAGE_DEFAULT : Number(q.limit);
  if (!Number.isInteger(n) || n < 1) throw bad("limit must be a positive whole number", "invalid_limit");
  const now = nowSec();
  const [rows, facets] = await Promise.all([repo.listUpcoming(env.DB, { now, game, city, limit: Math.min(n, DIRECTORY.PAGE_MAX) }), repo.upcomingFacets(env.DB, now)]);
  const items = [];
  for (const r of rows) {
    const open = tournamentOpen(r.status, r.max_teams, r.registered);
    let url: string | null = null;
    if (open && r.signup_public === 1 && r.f_token !== null && formOpen({ open: r.f_open, closes_at: r.f_closes_at, max_teams: r.f_max_teams }, r.registered, now)) {
      const token = await revealToken(env, "regform", r.event_id, { token: r.f_token, token_enc: r.f_token_enc });
      if (token) url = `/register/?t=${encodeURIComponent(token)}`;
    }
    items.push(toDirectoryItem(r, url, open));
  }
  return { items, total: facets.total, indexable: facets.total >= DIRECTORY.MIN_FOR_INDEX, minForIndex: DIRECTORY.MIN_FOR_INDEX, cities: facets.cities, games: facets.games };
}

async function organiserTournament(db: D1Database, userId: string, eventId: string, write: boolean) {
  const a = await loadEventAccess(db, userId, eventId);
  if (!a) throw new HttpError(404, "Event not found");
  if (write && !a.canWrite) throw new HttpError(403, "You can view this event but not change it");
  const t = await tournaments.findByEventId(db, a.eventId);
  if (!t) throw new HttpError(404, "Create the tournament page first", { code: "tournament_missing" });
  return t;
}

async function settingView(db: D1Database, t: tournaments.TournamentRow) {
  const [s, f, counts] = await Promise.all([repo.getSetting(db, t.id), repo.formState(db, t.eventId), tournaments.registrationCounts(db, t.eventId)]);
  const now = nowSec();
  const upcoming = ["published", "registration_open", "registration_closed", "live"].includes(t.status) && t.startsAt !== null && (t.endsAt ?? t.startsAt + 86_400) >= now;
  const open = tournamentOpen(t.status, t.maxTeams, counts.registered);
  const form = formOpen(f, counts.registered, now);
  return {
    signupPublic: s?.signup_public === 1,
    listed: upcoming,
    registrationOpen: open,
    signupFormOpen: form,
    /** True when the Register button on the directory card would carry the sign-up link right now. */
    linkShown: s?.signup_public === 1 && open && form,
    updatedAt: toIso(s?.updated_at ?? null),
  };
}

/** GET /v3/events/:eventId/tournament/directory (owner, editor or viewer) */
export async function getDirectorySetting(db: D1Database, userId: string, eventId: string) {
  return settingView(db, await organiserTournament(db, userId, eventId, false));
}
/** PUT /v3/events/:eventId/tournament/directory {signupPublic} (owner or editor) */
export async function putDirectorySetting(db: D1Database, userId: string, eventId: string, b: Record<string, unknown>) {
  const t = await organiserTournament(db, userId, eventId, true);
  const v = optBoolean(b.signupPublic, "signupPublic");
  if (v === undefined) throw bad("signupPublic must be true or false", "invalid_signupPublic");
  await repo.setSetting(db, t.id, v, nowSec());
  return settingView(db, t);
}
