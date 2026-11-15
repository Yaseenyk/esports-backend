/** Dispute payloads. They carry team NAMES and role labels, never user ids or emails. Only the two teams, the organiser and moderators ever receive them. */
import { toIso } from "../lib/ids";
import type { DisputeListRow, DisputeRow, EventRowOut, EvidenceMeta } from "../repositories/dispute-repo";

export const UNDECIDED = ["open", "evidence_requested", "under_review", "escalated"] as const;
export const isOverdue = (status: string, dueAt: number, now: number): boolean => (UNDECIDED as readonly string[]).includes(status) && now > dueAt;

export function toDisputeListItem(d: DisputeListRow, now: number) {
  return {
    id: d.id,
    tournament: { slug: d.t_slug, title: d.t_title },
    type: d.type,
    status: d.status,
    summary: d.summary.length > 200 ? `${d.summary.slice(0, 197)}...` : d.summary,
    raisedByTeam: d.raised_by_team,
    againstTeam: d.against_team,
    evidenceCount: d.evidence_count,
    dueAt: toIso(d.due_at),
    overdue: isOverdue(d.status, d.due_at, now),
    createdAt: toIso(d.created_at),
  };
}

export interface Permissions {
  canComment: boolean;
  canUploadEvidence: boolean;
  canWithdraw: boolean;
  /** Statuses this caller may move the dispute to with POST /transition. */
  transitions: string[];
  canResolve: boolean;
  role: "moderator" | "organiser" | "team" | "raiser";
}

export function toDisputeDetail(d: DisputeRow, events: EventRowOut[], evidence: EvidenceMeta[], corrections: { match_ref: string; old_value: string; new_value: string }[], perms: Permissions, now: number) {
  const j = (v: string): unknown => {
    try {
      return JSON.parse(v);
    } catch {
      return null;
    }
  };
  return {
    id: d.id,
    tournament: { slug: d.t_slug, title: d.t_title },
    type: d.type,
    status: d.status,
    summary: d.summary,
    raisedByTeam: d.raised_by_team,
    againstTeam: d.against_team,
    matchId: d.match_id,
    matchNo: d.match_no,
    outcome: d.outcome,
    resolutionNote: d.resolution_note,
    resolvedAt: toIso(d.resolved_at),
    dueAt: toIso(d.due_at),
    overdue: isOverdue(d.status, d.due_at, now),
    createdAt: toIso(d.created_at),
    updatedAt: toIso(d.updated_at),
    events: events.map((e) => ({ id: e.id, actorRole: e.actor_role, action: e.action, fromStatus: e.from_status, toStatus: e.to_status, note: e.note, createdAt: toIso(e.created_at) })),
    evidence: evidence.map((x) => ({ id: x.id, mimeType: x.mime_type, sizeBytes: x.size_bytes, caption: x.caption, createdAt: toIso(x.created_at), purged: x.purged_at !== null, purgeAfter: toIso(x.purge_after) })),
    corrections: corrections.map((c) => ({ matchRef: c.match_ref, oldValue: j(c.old_value), newValue: j(c.new_value) })),
    permissions: perms,
  };
}
