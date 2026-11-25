/**
 * Planner payloads. The ONLY builder of what a link holder sees: game, title, time zone, slot starts, and each teammate's display name and picks.
 * Never a token hash, a key hash or a plan id. Vote ids are random and let a browser find its own row.
 */
import { toIso } from "../lib/ids";
import { intList, slotCounts } from "../lib/planner";
import type { PlanRow, VoteRow } from "../repositories/planner-repo";

export function toPlanView(p: PlanRow, votes: VoteRow[]) {
  const slots = intList(p.slots);
  const people = votes.map((v) => ({ id: v.id, name: v.name, picks: intList(v.picks).filter((i) => i < slots.length) }));
  return {
    game: p.game,
    title: p.title,
    tz: p.tz,
    slotMinutes: p.slot_minutes,
    slots,
    people,
    counts: slotCounts(slots.length, people.map((x) => x.picks)),
    expiresAt: toIso(p.expires_at),
    createdAt: toIso(p.created_at),
  };
}
