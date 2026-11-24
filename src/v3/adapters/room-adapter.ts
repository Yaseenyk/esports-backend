/** Room rows -> API payloads. The ONLY builder of room payloads: no payload ever carries ciphertext, a user id or (except `toRevealed`) a credential. */
import { toIso } from "../lib/ids";
import { roomPhase } from "../lib/rooms";
import type { CaptainRoomRow, RoomListRow, RoomRow, ViewRow } from "../repositories/room-repo";

const matchOf = (r: { match_id: string | null; match_a?: string | null; match_b?: string | null }) =>
  r.match_id ? { id: r.match_id, teamA: r.match_a ?? null, teamB: r.match_b ?? null } : null;

export function toOrganiserRoom(r: RoomRow | RoomListRow, now: number) {
  const l = r as Partial<RoomListRow>;
  return {
    id: r.id,
    label: r.label,
    match: matchOf(r),
    startsAt: toIso(r.starts_at),
    revealAt: toIso(r.reveal_at),
    revealMinutesBefore: Math.round((r.starts_at - r.reveal_at) / 60),
    phase: roomPhase({ revealAt: r.reveal_at, startsAt: r.starts_at, purgedAt: r.purged_at }, now),
    hasCredentials: !!r.has_secret,
    version: r.secret_version,
    rotatedAt: toIso(r.rotated_at),
    purgedAt: toIso(r.purged_at),
    views: l.views ?? 0,
    teamsSeenCurrent: l.teams_seen_current ?? 0,
    updatedAt: toIso(r.updated_at),
  };
}

export function toCaptainRoom(r: CaptainRoomRow, now: number) {
  return {
    id: r.id,
    event: { id: r.event_id, name: r.event_name },
    team: r.team_name,
    label: r.label,
    match: matchOf(r),
    startsAt: toIso(r.starts_at),
    revealAt: toIso(r.reveal_at),
    phase: roomPhase({ revealAt: r.reveal_at, startsAt: r.starts_at, purgedAt: r.purged_at }, now),
  };
}

export const toView = (v: ViewRow) => ({ team: v.team_name, version: v.secret_version, viewedAt: toIso(v.viewed_at) });

export function toRevealed(r: CaptainRoomRow, cred: { roomId: string; password: string }) {
  return { id: r.id, label: r.label, team: r.team_name, startsAt: toIso(r.starts_at), version: r.secret_version, roomId: cred.roomId, password: cred.password };
}
