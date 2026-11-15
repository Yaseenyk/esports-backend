/**
 * Row <-> domain <-> API payload for tournaments.
 * `toPublicTournament` / `toPublicDetail` are the ONLY functions that build a public tournament payload: they list fields explicitly, so a private
 * field (event id, owner, user ids, emails, lobby data, non-public teams) cannot leak by accident (test/v3/public-leak.test.ts pins the key sets).
 */
import { toIso } from "../lib/ids";
import type { TournamentRow, MatchRow, BrRow, PublicTeamRow, CorrectionRow } from "../repositories/tournament-repo";
import { brRef, matchRef, overlayBr, overlayMatches, type BrResultOut, type MatchResultOut } from "./results-overlay";

export const UNLISTED_TEAM = "Unlisted team";

export function toPublicTournament(t: TournamentRow, seoReady: boolean) {
  return {
    slug: t.slug,
    title: t.title,
    game: t.game,
    format: t.format,
    status: t.status,
    summary: t.summary,
    venue: t.venue,
    city: t.city,
    state: t.state,
    startsAt: toIso(t.startsAt),
    endsAt: toIso(t.endsAt),
    maxTeams: t.maxTeams,
    publishedAt: toIso(t.publishedAt),
    seoReady,
  };
}

export interface PublicDetailInput {
  t: TournamentRow;
  seoReady: boolean;
  counts: { registered: number; approved: number };
  teams: PublicTeamRow[];
  matches: MatchRow[];
  br: BrRow[];
  corrections: CorrectionRow[];
}

export function toPublicDetail(i: PublicDetailInput) {
  const visible = new Set(i.teams.map((x) => x.team_name.toLowerCase()));
  const mask = (name: string): string => (name === "" ? "" : visible.has(name.toLowerCase()) ? name : UNLISTED_TEAM);
  const finished = i.matches.filter((m) => m.status === "finished" || m.status === "forfeit");
  const toMatch = (m: MatchRow): MatchResultOut => ({
    matchRef: matchRef(m.id),
    stage: m.stage,
    round: m.round,
    slot: m.slot,
    teamA: mask(m.a),
    teamB: mask(m.b),
    status: m.status,
    scoreA: m.score_a,
    scoreB: m.score_b,
    winner: m.winner,
    corrected: false,
  });
  // Corrections are keyed by the REAL legacy ref; masking only changes the names shown.
  const results = overlayMatches(finished.map(toMatch), i.corrections);
  const brOut: BrResultOut[] = i.br.map((r) => ({ matchRef: brRef(r.match_no, r.team), matchNo: r.match_no, team: mask(r.team), placement: r.placement, kills: r.kills, corrected: false }));
  const battleRoyale = overlayBr(brOut, i.corrections).map(({ matchRef: _ref, ...rest }) => rest);
  const resultsOut = results.map(({ matchRef: _ref, ...rest }) => rest);
  const spotsLeft = i.t.maxTeams === null ? null : Math.max(0, i.t.maxTeams - i.counts.registered);
  return {
    tournament: { ...toPublicTournament(i.t, i.seoReady), description: i.t.description, rules: i.t.rules },
    registration: { open: i.t.status === "registration_open" && (spotsLeft === null || spotsLeft > 0), registered: i.counts.registered, approved: i.counts.approved, spotsLeft },
    teams: i.teams.map((x) => ({ name: x.team_name, teamSlug: x.slug })),
    schedule: i.matches.map((m) => ({ stage: m.stage, round: m.round, slot: m.slot, teamA: mask(m.a), teamB: mask(m.b), startsAt: m.starts_at, status: m.status })),
    results: { matches: resultsOut, battleRoyale },
    hasResults: resultsOut.length > 0 || battleRoyale.length > 0,
  };
}

/** GET /public/live/:slug: registration count and status only. */
export function toPublicLive(t: TournamentRow, counts: { registered: number; approved: number }) {
  const spotsLeft = t.maxTeams === null ? null : Math.max(0, t.maxTeams - counts.registered);
  return { slug: t.slug, status: t.status, registered: counts.registered, spotsLeft, open: t.status === "registration_open" && (spotsLeft === null || spotsLeft > 0) };
}

/** The organiser's own view of the wrapper (authenticated; includes ids and the SEO verdict). */
export function toOrganiserTournament(t: TournamentRow, seoFailures: string[]) {
  return {
    id: t.id,
    eventId: t.eventId,
    slug: t.slug,
    title: t.title,
    game: t.game,
    format: t.format,
    status: t.status,
    venue: t.venue,
    city: t.city,
    state: t.state,
    summary: t.summary,
    description: t.description,
    rules: t.rules,
    maxTeams: t.maxTeams,
    startsAt: toIso(t.startsAt),
    endsAt: toIso(t.endsAt),
    publishedAt: toIso(t.publishedAt),
    seoReady: t.seoReady,
    seoFailures,
    discordGuildId: t.discordGuildId,
    discordCategoryId: t.discordCategoryId,
    createdAt: toIso(t.createdAt),
    updatedAt: toIso(t.updatedAt),
  };
}
