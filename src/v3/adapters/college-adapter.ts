/** Public college payloads. Explicit field lists: no organisation id, member, owner, event id or email can come along. */
import { toIso } from "../lib/ids";
import type { CollegeListRow, CollegeRow } from "../repositories/college-repo";
import type { TournamentRow } from "../repositories/tournament-repo";
import { toPublicTournament } from "./tournament-adapter";

export function toPublicCollege(c: CollegeRow, rows: TournamentRow[]) {
  const items = rows.map((t) => toPublicTournament(t, t.seoReady));
  return { slug: c.slug, name: c.name, indexable: items.some((i) => i.seoReady), tournaments: items };
}

export const toCollegeListItem = (r: CollegeListRow) => ({ slug: r.slug, name: r.name, tournaments: r.tournaments, indexable: r.indexable > 0, lastStartsAt: toIso(r.lastStartsAt) });
