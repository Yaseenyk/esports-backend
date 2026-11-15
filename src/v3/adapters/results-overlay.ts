/**
 * THE DOCUMENTED ADAPTER HOOK for result corrections (dispute stage).
 *
 * Legacy result rows (matches, br_results) are NEVER overwritten by a dispute. A resolved dispute that corrects a result writes a row in
 * v3_result_corrections {match_ref, old_value, new_value}. Every public read of results passes the legacy rows through `overlayMatches` /
 * `overlayBr` below: a corrected row shows the NEW values plus `corrected: true` and `original` (the values before the correction).
 * The latest correction for a ref wins. Pure functions: no SQL, no I/O.
 *
 * match_ref formats:  "match:<matches.id>"  (value: {scoreA, scoreB, winner})   and   "br:<match_no>:<team name>"  (value: {placement, kills}).
 */
export interface CorrectionInput { match_ref: string; old_value: string; new_value: string; created_at: number }

export interface MatchResultOut {
  matchRef: string;
  stage: string;
  round: number;
  slot: number;
  teamA: string;
  teamB: string;
  status: string;
  scoreA: number | null;
  scoreB: number | null;
  winner: string | null;
  corrected: boolean;
  original?: { scoreA: number | null; scoreB: number | null; winner: string | null };
}
export interface BrResultOut {
  matchRef: string;
  matchNo: number;
  team: string;
  placement: number;
  kills: number;
  corrected: boolean;
  original?: { placement: number; kills: number };
}

function latest(corrections: readonly CorrectionInput[]): Map<string, CorrectionInput> {
  const m = new Map<string, CorrectionInput>();
  for (const c of [...corrections].sort((a, b) => a.created_at - b.created_at)) m.set(c.match_ref, c);
  return m;
}
function parse(v: string): Record<string, unknown> | null {
  try {
    const x: unknown = JSON.parse(v);
    return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
const num = (v: unknown, dflt: number | null): number | null => (typeof v === "number" && Number.isInteger(v) ? v : dflt);

export function overlayMatches(rows: readonly MatchResultOut[], corrections: readonly CorrectionInput[]): MatchResultOut[] {
  const by = latest(corrections);
  return rows.map((r) => {
    const c = by.get(r.matchRef);
    const nv = c ? parse(c.new_value) : null;
    if (!c || !nv) return r;
    const winner = nv.winner === "a" || nv.winner === "b" || nv.winner === "draw" ? nv.winner : r.winner;
    return {
      ...r,
      scoreA: num(nv.scoreA, r.scoreA),
      scoreB: num(nv.scoreB, r.scoreB),
      winner,
      corrected: true,
      original: { scoreA: r.scoreA, scoreB: r.scoreB, winner: r.winner },
    };
  });
}

export function overlayBr(rows: readonly BrResultOut[], corrections: readonly CorrectionInput[]): BrResultOut[] {
  const by = latest(corrections);
  return rows.map((r) => {
    const c = by.get(r.matchRef);
    const nv = c ? parse(c.new_value) : null;
    if (!c || !nv) return r;
    return {
      ...r,
      placement: num(nv.placement, r.placement) ?? r.placement,
      kills: num(nv.kills, r.kills) ?? r.kills,
      corrected: true,
      original: { placement: r.placement, kills: r.kills },
    };
  });
}

export const matchRef = (id: string): string => `match:${id}`;
export const brRef = (matchNo: number, team: string): string => `br:${matchNo}:${team}`;
