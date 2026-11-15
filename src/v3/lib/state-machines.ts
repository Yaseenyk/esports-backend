/** State machines of DATA_CONTRACT.md section 3. Pure tables plus one helper; the services enforce them. */
import type { ApplicationStatus, DisputeStatus, LftStatus, TournamentStatus } from "./enums";

export const TOURNAMENT_MOVES: Readonly<Record<TournamentStatus, readonly TournamentStatus[]>> = {
  draft: ["published", "cancelled"],
  published: ["registration_open", "cancelled"],
  registration_open: ["registration_closed", "cancelled"],
  registration_closed: ["live", "cancelled"],
  live: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

/**
 * Dispute: open -> evidence_requested <-> under_review -> resolved | rejected | escalated ; open -> withdrawn.
 * Decisions taken here (documented in API.md): open may go straight to under_review; a raiser may withdraw until a decision; escalated goes on
 * to resolved | rejected (moderator) or back to under_review (moderator); resolved, rejected and withdrawn are final.
 */
export const DISPUTE_MOVES: Readonly<Record<DisputeStatus, readonly DisputeStatus[]>> = {
  open: ["evidence_requested", "under_review", "withdrawn"],
  evidence_requested: ["under_review", "withdrawn"],
  under_review: ["evidence_requested", "resolved", "rejected", "escalated", "withdrawn"],
  escalated: ["under_review", "resolved", "rejected"],
  resolved: [],
  rejected: [],
  withdrawn: [],
};
export const DISPUTE_FINAL: readonly DisputeStatus[] = ["resolved", "rejected", "withdrawn"];
/** A tournament cannot complete while a dispute is in one of these (contract: open or under_review; escalated and evidence_requested are also undecided). */
export const DISPUTE_BLOCKS_COMPLETION: readonly DisputeStatus[] = ["open", "evidence_requested", "under_review", "escalated"];

export const APPLICATION_MOVES: Readonly<Record<ApplicationStatus, readonly ApplicationStatus[]>> = {
  sent: ["accepted", "declined", "withdrawn"],
  accepted: [],
  declined: [],
  withdrawn: [],
};
export const LFT_MOVES: Readonly<Record<LftStatus, readonly LftStatus[]>> = {
  open: ["filled", "closed", "expired", "removed"],
  filled: [],
  closed: [],
  expired: [],
  removed: [],
};

export const canMove = <S extends string>(table: Readonly<Record<S, readonly S[]>>, from: S, to: S): boolean => table[from]?.includes(to) ?? false;
