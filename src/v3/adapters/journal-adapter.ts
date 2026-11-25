/** Journal payloads. The ONLY builder of an entry the owner sees: fields listed one by one (never the user id). Owner-only; never on a public page. */
import { toIso } from "../lib/ids";
import type { JournalRow } from "../repositories/journal-repo";

export function toJournalEntry(r: JournalRow) {
  return {
    id: r.id,
    playedOn: r.played_on,
    game: r.game,
    mode: r.mode,
    map: r.map,
    placement: r.placement,
    kills: r.kills,
    damage: r.damage,
    notes: r.notes,
    createdAt: toIso(r.created_at),
    updatedAt: toIso(r.updated_at),
  };
}
