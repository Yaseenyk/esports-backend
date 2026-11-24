/**
 * Phase 4 payloads: the scrim finder. Pure. `toPublicSlot` is the ONLY public builder: no poster id, no contact, no report data.
 * Contacts appear only in the two signed-in views, and only on an ACCEPTED request (the poster's to the requester, the requester's to the poster).
 */
import { toIso } from "../lib/ids";
import type { MySlotRow, PublicSlotRow, RequestForPoster, RequestForRequester, ViewerSlotRow } from "../repositories/scrim-repo";

export function toPublicSlot(s: PublicSlotRow) {
  return {
    id: s.id,
    game: s.game,
    startsAt: toIso(s.starts_at),
    region: s.region,
    server: s.server,
    skillNote: s.skill_note,
    slotsTotal: s.slots_total,
    slotsLeft: Math.max(0, s.slots_total - s.slots_filled),
    teamName: s.team_name ?? "Team",
    createdAt: toIso(s.created_at),
  };
}
export const toViewerSlot = (s: ViewerSlotRow) => ({ ...toPublicSlot(s), mine: s.mine === 1, myRequest: s.my_request });

export function toOwnSlot(s: MySlotRow, now: number) {
  return {
    ...toPublicSlot(s),
    status: s.status,
    expired: s.starts_at <= now,
    hidden: s.hidden_at !== null,
    contact: s.contact,
    requests: { pending: s.pending, accepted: s.accepted },
  };
}

export const toRequestForPoster = (q: RequestForPoster) => ({
  id: q.id, teamName: q.team_name ?? "Team", message: q.message, status: q.status, createdAt: toIso(q.created_at), respondedAt: toIso(q.responded_at),
  contact: q.status === "accepted" ? q.contact : null,
  /** Phase 4b: the waitlist state of this request (null = a normal request) and its slot number once confirmed. */
  waitlist: q.waitlist_status, slotNo: q.slot_no,
});

export const toRequestForRequester = (q: RequestForRequester) => ({
  id: q.id, slotId: q.slot_id, status: q.status, game: q.game, startsAt: toIso(q.starts_at), region: q.region, slotStatus: q.slot_status,
  teamName: q.poster_team ?? "Team", myTeamName: q.my_team ?? "Team", createdAt: toIso(q.created_at), respondedAt: toIso(q.responded_at),
  contact: q.status === "accepted" ? q.poster_contact : null,
});

/** Opaque board cursor: "<starts_at>_<id>". */
export const encodeCursor = (ts: number, id: string): string => `${ts}_${id}`;
export function decodeCursor(v: string | undefined): { ts: number; id: string } | undefined | null {
  if (v === undefined || v === "") return undefined;
  const m = /^(\d{1,12})_([0-9a-f]{32})$/.exec(v);
  return m ? { ts: Number(m[1]), id: m[2]! } : null;
}
