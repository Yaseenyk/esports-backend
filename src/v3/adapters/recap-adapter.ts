/** Recap facts payload (flag v3.recaps). Only results the organiser entered (with dispute corrections applied); the scoring is the organiser's own or null. */
import type { ScoringRow } from "../repositories/recap-repo";
import type { BrRow, CorrectionRow, MatchRow } from "../repositories/tournament-repo";
import { brRef, matchRef, overlayBr, overlayMatches } from "./results-overlay";

function scale(text: string): number[] {
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === "number" && Number.isFinite(x) && x >= 0).slice(0, 100) : [];
  } catch {
    return [];
  }
}

export function toRecapFacts(i: {
  event: { id: string; name: string; game: string };
  publicPath: string | null;
  scoring: ScoringRow | null;
  matches: MatchRow[];
  br: BrRow[];
  corrections: CorrectionRow[];
}) {
  const finished = i.matches.filter((m) => m.status === "finished" || m.status === "forfeit");
  const matches = overlayMatches(
    finished.map((m) => ({ matchRef: matchRef(m.id), stage: m.stage, round: m.round, slot: m.slot, teamA: m.a, teamB: m.b, status: m.status, scoreA: m.score_a, scoreB: m.score_b, winner: m.winner, corrected: false })),
    i.corrections,
  ).map(({ matchRef: ref, original: _o, ...rest }) => ({ id: ref.slice("match:".length), ...rest }));
  const battleRoyale = overlayBr(
    i.br.map((r) => ({ matchRef: brRef(r.match_no, r.team), matchNo: r.match_no, team: r.team, placement: r.placement, kills: r.kills, corrected: false })),
    i.corrections,
  ).map(({ matchRef: _r, original: _o, ...rest }) => rest);
  const s = i.scoring;
  const sc = s ? scale(s.scale) : [];
  return {
    event: i.event,
    publicPath: i.publicPath,
    scoring: s && sc.length ? { title: s.title, scale: sc, perKill: s.per_kill, winPts: s.win_pts, drawPts: s.draw_pts, lossPts: s.loss_pts } : null,
    matches,
    battleRoyale,
  };
}
