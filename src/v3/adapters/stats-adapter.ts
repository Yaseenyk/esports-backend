/**
 * Esports Resume stats, derived ONLY from verified results rows (see repositories/stats-repo.ts). Pure: no SQL, no I/O. Result corrections from resolved
 * disputes are applied through the same overlay the public tournament page uses, so a resume never disagrees with the tournament it came from.
 * The output has no event ids, team names, user ids or tournament links: counts only.
 */
import type { StatBrRow, StatCorrectionRow, StatMatchRow } from "../repositories/stats-repo";
import { brRef, matchRef, overlayBr, overlayMatches, type BrResultOut, type MatchResultOut } from "./results-overlay";

export interface GameStats { game: string; tournaments: number; matchesPlayed: number; matchWins: number; brMatches: number; brWins: number; kills: number }
export interface ResumeStats {
  /** Always "verified_results": every number is computed from results the platform holds, never typed by the player. */
  source: "verified_results";
  /** Always "team_captain": the link between a player and a result is a team the account captains (proven with the captain link). */
  basis: "team_captain";
  tournaments: number;
  matches: { played: number; wins: number; losses: number; draws: number };
  battleRoyale: { matches: number; wins: number; kills: number; bestPlacement: number | null; averagePlacement: number | null };
  byGame: GameStats[];
}

export function emptyStats(): ResumeStats {
  return { source: "verified_results", basis: "team_captain", tournaments: 0, matches: { played: 0, wins: 0, losses: 0, draws: 0 }, battleRoyale: { matches: 0, wins: 0, kills: 0, bestPlacement: null, averagePlacement: null }, byGame: [] };
}

export function buildResumeStats(matchRows: readonly StatMatchRow[], brRows: readonly StatBrRow[], corrections: readonly StatCorrectionRow[]): ResumeStats {
  const out = emptyStats();
  const events = new Set<string>();
  const games = new Map<string, GameStats>();
  const eventsByGame = new Map<string, Set<string>>();
  const g = (game: string): GameStats => {
    let x = games.get(game);
    if (!x) games.set(game, (x = { game, tournaments: 0, matchesPlayed: 0, matchWins: 0, brMatches: 0, brWins: 0, kills: 0 }));
    return x;
  };
  const seen = (game: string, ev: string) => {
    events.add(ev);
    let s = eventsByGame.get(game);
    if (!s) eventsByGame.set(game, (s = new Set()));
    s.add(ev);
  };

  const asOut = (m: StatMatchRow): MatchResultOut => ({ matchRef: matchRef(m.id), stage: m.stage, round: 0, slot: 0, teamA: "", teamB: "", status: "finished", scoreA: m.score_a, scoreB: m.score_b, winner: m.winner, corrected: false });
  const overlaid = overlayMatches(matchRows.map(asOut), corrections);
  matchRows.forEach((m, i) => {
    const w = overlaid[i]!.winner;
    if (w !== "a" && w !== "b" && w !== "draw") return; // no winner recorded: not a counted result
    seen(m.game, m.event_id);
    out.matches.played++;
    const gs = g(m.game);
    gs.matchesPlayed++;
    if (w === "draw") out.matches.draws++;
    else if (w === m.side) {
      out.matches.wins++;
      gs.matchWins++;
    } else out.matches.losses++;
  });

  const brOut: BrResultOut[] = brRows.map((r) => ({ matchRef: brRef(r.match_no, r.team), matchNo: r.match_no, team: r.team, placement: r.placement, kills: r.kills, corrected: false }));
  const brFinal = overlayBr(brOut, corrections);
  let placementSum = 0;
  brFinal.forEach((r, i) => {
    const row = brRows[i]!;
    seen(row.game, row.event_id);
    out.battleRoyale.matches++;
    out.battleRoyale.kills += r.kills;
    placementSum += r.placement;
    if (r.placement === 1) out.battleRoyale.wins++;
    out.battleRoyale.bestPlacement = out.battleRoyale.bestPlacement === null ? r.placement : Math.min(out.battleRoyale.bestPlacement, r.placement);
    const gs = g(row.game);
    gs.brMatches++;
    gs.kills += r.kills;
    if (r.placement === 1) gs.brWins++;
  });
  if (out.battleRoyale.matches > 0) out.battleRoyale.averagePlacement = Math.round((placementSum / out.battleRoyale.matches) * 10) / 10;

  out.tournaments = events.size;
  out.byGame = [...games.values()].map((x) => ({ ...x, tournaments: eventsByGame.get(x.game)?.size ?? 0 })).sort((a, b) => a.game.localeCompare(b.game));
  return out;
}
