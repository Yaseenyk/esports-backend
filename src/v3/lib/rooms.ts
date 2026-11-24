/** Pure rules for match rooms (flag v3.rooms). No I/O, no layer imports. */
export const ROOMS = {
  /** The latest a reveal may be set before the start (3 hours) and the earliest (the start itself). */
  REVEAL_MAX_MIN: 180,
  REVEAL_DEFAULT_MIN: 15,
  /** Credentials are deleted this long after the start (DATA_CONTRACT section 6: cleared 24 hours after the match). */
  PURGE_AFTER_SEC: 24 * 3600,
  /** At most this many rooms per event (an event of many matches still fits). */
  MAX_PER_EVENT: 200,
  CRED_MAX: 40,
  LABEL_MAX: 80,
  VIEWS_LIMIT: 500,
} as const;

/** A room ID or password as typed in the game: 1-40 visible characters, no control characters, no line breaks, trimmed. */
export function cleanCredential(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (t.length < 1 || Array.from(t).length > ROOMS.CRED_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(t)) return null;
  return t;
}

/** Reveal time from "minutes before the start". Whole minutes 0-180. */
export function revealAtFrom(startsAt: number, minutesBefore: number): number {
  return startsAt - minutesBefore * 60;
}

export type RoomPhase = "waiting" | "revealed" | "expired";
/** Where a room stands at `now`: before the reveal time, open, or past the 24-hour clean-up (or already purged). */
export function roomPhase(r: { revealAt: number; startsAt: number; purgedAt: number | null }, now: number): RoomPhase {
  if (r.purgedAt !== null || now >= r.startsAt + ROOMS.PURGE_AFTER_SEC) return "expired";
  return now >= r.revealAt ? "revealed" : "waiting";
}

/** Who a room is for: every confirmed team (match_id null) or the two teams of one match. Names compare case-insensitively, trimmed. */
export function roomIsForTeam(room: { matchTeams: readonly string[] | null }, teamKey: string): boolean {
  if (room.matchTeams === null) return true;
  return room.matchTeams.some((t) => t.trim().toLowerCase() === teamKey);
}
