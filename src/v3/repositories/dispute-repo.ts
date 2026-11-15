/** disputes, dispute_events, dispute_evidence(+blobs), v3_result_corrections, v3_team_captains. The only place these tables are queried. */
import { blobBytes } from "../../images";
import { resolveCaptainToken } from "../../captains";
import type { Env } from "../../types";

export interface DisputeRow {
  id: string;
  tournament_id: string;
  match_id: string | null;
  match_no: number | null;
  type: string;
  status: string;
  raised_by_user_id: string | null;
  raised_by_team: string | null;
  raised_by_team_key: string | null;
  against_team: string | null;
  against_team_key: string | null;
  summary: string;
  outcome: string | null;
  resolution_note: string | null;
  resolved_by_user_id: string | null;
  resolved_at: number | null;
  due_at: number;
  created_at: number;
  updated_at: number;
  // joined
  t_slug: string;
  t_title: string;
  t_event_id: string;
}

export async function findDispute(db: D1Database, id: string): Promise<DisputeRow | null> {
  return (await db.prepare("SELECT d.*, t.slug AS t_slug, t.title AS t_title, t.event_id AS t_event_id FROM disputes d JOIN tournaments t ON t.id = d.tournament_id WHERE d.id = ?1").bind(id).first<DisputeRow>()) ?? null;
}

// ---------------- captains (who is a party) ----------------
/** The team a legacy captain-link token belongs to (hash lookup in captain_links), or null. */
export async function captainTokenTeam(db: D1Database, token: string): Promise<{ eventId: string; team: string } | null> {
  const r = await resolveCaptainToken({ DB: db } as unknown as Env, token);
  return r ? { eventId: r.eventId, team: r.team } : null;
}
/** A team is registered in the event: an approved registration, or a roster team (legacy `teams`). Case-insensitive. */
export async function teamIsRegistered(db: D1Database, eventId: string, teamName: string): Promise<boolean> {
  const r = await db
    .prepare("SELECT 1 AS x FROM registrations WHERE event_id = ?1 AND lower(team_name) = lower(?2) AND status = 'approved' UNION ALL SELECT 1 AS x FROM teams WHERE event_id = ?1 AND lower(name) = lower(?2) LIMIT 1")
    .bind(eventId, teamName)
    .first();
  return r !== null;
}
export async function claimCaptain(db: D1Database, eventId: string, teamName: string, userId: string, at: number): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO v3_team_captains (event_id, team_key, team_name, user_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(eventId, teamName.toLowerCase(), teamName, userId, at)
    .run();
}
export async function captainTeams(db: D1Database, eventId: string, userId: string): Promise<{ team_key: string; team_name: string }[]> {
  const r = await db.prepare("SELECT team_key, team_name FROM v3_team_captains WHERE event_id = ?1 AND user_id = ?2").bind(eventId, userId).all<{ team_key: string; team_name: string }>();
  return r.results;
}

// ---------------- reads ----------------
export interface DisputeListRow extends DisputeRow { evidence_count: number }

export async function listForTournament(db: D1Database, tournamentId: string, limit: number): Promise<DisputeListRow[]> {
  const r = await db.prepare("SELECT d.*, (SELECT COUNT(*) FROM dispute_evidence e WHERE e.dispute_id = d.id) AS evidence_count, t.slug AS t_slug, t.title AS t_title, t.event_id AS t_event_id FROM disputes d JOIN tournaments t ON t.id = d.tournament_id WHERE d.tournament_id = ?1 ORDER BY d.due_at ASC, d.id LIMIT ?2").bind(tournamentId, limit).all<DisputeListRow>();
  return r.results;
}
/** Disputes this user raised, or where they are the proven captain of the raising or the named team. */
export async function listForUser(db: D1Database, userId: string, limit: number, tournamentId?: string): Promise<DisputeListRow[]> {
  const r = await db
    .prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM dispute_evidence e WHERE e.dispute_id = d.id) AS evidence_count, t.slug AS t_slug, t.title AS t_title, t.event_id AS t_event_id FROM disputes d JOIN tournaments t ON t.id = d.tournament_id WHERE (d.raised_by_user_id = ?1 OR EXISTS (SELECT 1 FROM v3_team_captains c WHERE c.user_id = ?1 AND c.event_id = t.event_id AND c.team_key IN (d.raised_by_team_key, d.against_team_key)))
       AND (?3 IS NULL OR d.tournament_id = ?3) ORDER BY d.created_at DESC LIMIT ?2`,
    )
    .bind(userId, limit, tournamentId ?? null)
    .all<DisputeListRow>();
  return r.results;
}
/** Staff queue: undecided disputes first (soonest due first), or one status. */
export async function listQueue(db: D1Database, status: string | null, offset: number, limit: number): Promise<DisputeListRow[]> {
  const r = await db
    .prepare(
      `SELECT d.*, (SELECT COUNT(*) FROM dispute_evidence e WHERE e.dispute_id = d.id) AS evidence_count, t.slug AS t_slug, t.title AS t_title, t.event_id AS t_event_id FROM disputes d JOIN tournaments t ON t.id = d.tournament_id WHERE (?1 IS NULL AND d.status IN ('open','evidence_requested','under_review','escalated')) OR d.status = ?1
       ORDER BY (d.status = 'escalated') DESC, d.due_at ASC, d.id LIMIT ?2 OFFSET ?3`,
    )
    .bind(status, limit, offset)
    .all<DisputeListRow>();
  return r.results;
}
export async function countOpenRaisedBy(db: D1Database, userId: string, tournamentId: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM disputes WHERE raised_by_user_id = ?1 AND tournament_id = ?2 AND status IN ('open','evidence_requested','under_review','escalated')")
    .bind(userId, tournamentId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export interface EventRowOut { id: string; actor_role: string; action: string; from_status: string | null; to_status: string | null; note: string | null; created_at: number }
export async function listEvents(db: D1Database, disputeId: string): Promise<EventRowOut[]> {
  const r = await db.prepare("SELECT id, actor_role, action, from_status, to_status, note, created_at FROM dispute_events WHERE dispute_id = ?1 ORDER BY created_at, rowid").bind(disputeId).all<EventRowOut>();
  return r.results;
}
export interface EvidenceMeta { id: string; mime_type: string; size_bytes: number; caption: string | null; created_at: number; purged_at: number | null; purge_after: number | null }
/** Metadata only: this query never touches dispute_evidence_blobs. */
export async function listEvidence(db: D1Database, disputeId: string): Promise<EvidenceMeta[]> {
  const r = await db.prepare("SELECT id, mime_type, size_bytes, caption, created_at, purged_at, purge_after FROM dispute_evidence WHERE dispute_id = ?1 ORDER BY created_at, rowid").bind(disputeId).all<EvidenceMeta>();
  return r.results;
}
export async function corrections(db: D1Database, disputeId: string): Promise<{ match_ref: string; old_value: string; new_value: string }[]> {
  const r = await db.prepare("SELECT match_ref, old_value, new_value FROM v3_result_corrections WHERE dispute_id = ?1 ORDER BY created_at, rowid").bind(disputeId).all<{ match_ref: string; old_value: string; new_value: string }>();
  return r.results;
}

export async function evidenceFile(db: D1Database, disputeId: string, evidenceId: string): Promise<{ mime: string; bytes: Uint8Array } | "purged" | null> {
  const m = await db.prepare("SELECT mime_type, purged_at FROM dispute_evidence WHERE id = ?1 AND dispute_id = ?2").bind(evidenceId, disputeId).first<{ mime_type: string; purged_at: number | null }>();
  if (!m) return null;
  if (m.purged_at !== null) return "purged";
  const b = await db.prepare("SELECT bytes FROM dispute_evidence_blobs WHERE evidence_id = ?1").bind(evidenceId).first<{ bytes: unknown }>();
  if (!b) return "purged";
  return { mime: m.mime_type, bytes: blobBytes(b.bytes) };
}
export async function evidenceHashExists(db: D1Database, disputeId: string, sha: string): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM dispute_evidence WHERE dispute_id = ?1 AND sha256 = ?2").bind(disputeId, sha).first()) !== null;
}

// ---------------- legacy reads for corrections ----------------
export async function legacyMatch(db: D1Database, eventId: string, matchId: string): Promise<{ score_a: number | null; score_b: number | null; winner: string | null } | null> {
  return (await db.prepare("SELECT score_a, score_b, winner FROM matches WHERE id = ?1 AND event_id = ?2").bind(matchId, eventId).first<{ score_a: number | null; score_b: number | null; winner: string | null }>()) ?? null;
}
export async function legacyBr(db: D1Database, eventId: string, matchNo: number, team: string): Promise<{ placement: number; kills: number } | null> {
  return (await db.prepare("SELECT placement, kills FROM br_results WHERE event_id = ?1 AND match_no = ?2 AND team = ?3").bind(eventId, matchNo, team).first<{ placement: number; kills: number }>()) ?? null;
}

// ---------------- writes ----------------
export interface NewDispute {
  id: string; tournamentId: string; matchId: string | null; matchNo: number | null; type: string; raisedByUserId: string; raisedByTeam: string | null; againstTeam: string | null;
  summary: string; at: number; dueAt: number; actorRole: string;
}
/** Inserts the dispute and its first event in ONE batch. */
export async function insertDispute(db: D1Database, d: NewDispute, eventId: string): Promise<void> {
  void eventId;
  await db.batch([
    db
      .prepare(
        "INSERT INTO disputes (id, tournament_id, match_id, match_no, type, status, raised_by_user_id, raised_by_team, raised_by_team_key, against_team, against_team_key, summary, due_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'open', ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)",
      )
      .bind(d.id, d.tournamentId, d.matchId, d.matchNo, d.type, d.raisedByUserId, d.raisedByTeam, d.raisedByTeam ? d.raisedByTeam.toLowerCase() : null, d.againstTeam, d.againstTeam ? d.againstTeam.toLowerCase() : null, d.summary, d.dueAt, d.at),
    eventStmt(db, d.id, d.raisedByUserId, d.actorRole, "raised", null, "open", d.summary.slice(0, 200), d.at, newEventId()),
  ]);
}

const newEventId = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
};

function eventStmt(db: D1Database, disputeId: string, actor: string | null, role: string, action: string, from: string | null, to: string | null, note: string | null, at: number, id: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO dispute_events (id, dispute_id, actor_user_id, actor_role, action, from_status, to_status, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
    .bind(id, disputeId, actor, role, action, from, to, note, at);
}

export async function addComment(db: D1Database, disputeId: string, actor: string, role: string, note: string, at: number): Promise<void> {
  await eventStmt(db, disputeId, actor, role, "comment", null, null, note, at, newEventId()).run();
}

export interface Transition {
  id: string; from: string; to: string; actor: string; actorRole: string; note: string | null; at: number;
  /** Final states: evidence purge date (resolution + 90 days). */
  purgeAfter?: number;
  resolution?: { outcome: string; note: string };
  corrections?: { eventId: string; matchRef: string; oldValue: string; newValue: string }[];
}
/**
 * Moves a dispute from `from` to `to` ONLY if it is still in `from` (a concurrent move makes this return false and writes nothing), appends the event, sets the
 * evidence purge date on a final state, and writes result corrections, all in one batch (one transaction).
 */
export async function applyTransition(db: D1Database, t: Transition): Promise<boolean> {
  const final = t.to === "resolved" || t.to === "rejected" || t.to === "withdrawn";
  const decided = t.to === "resolved" || t.to === "rejected";
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        "UPDATE disputes SET status = ?3, updated_at = ?4, outcome = CASE WHEN ?5 = 1 THEN ?6 ELSE outcome END, resolution_note = CASE WHEN ?5 = 1 THEN ?7 ELSE resolution_note END, resolved_by_user_id = CASE WHEN ?5 = 1 THEN ?8 ELSE resolved_by_user_id END, resolved_at = CASE WHEN ?5 = 1 THEN ?4 ELSE resolved_at END WHERE id = ?1 AND status = ?2",
      )
      .bind(t.id, t.from, t.to, t.at, decided ? 1 : 0, t.resolution?.outcome ?? null, t.resolution?.note ?? null, t.actor),
    db
      .prepare(
        "INSERT INTO dispute_events (id, dispute_id, actor_user_id, actor_role, action, from_status, to_status, note, created_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9 WHERE EXISTS (SELECT 1 FROM disputes WHERE id = ?2 AND status = ?7 AND updated_at = ?9)",
      )
      .bind(newEventId(), t.id, t.actor, t.actorRole, `status_${t.to}`, t.from, t.to, t.note, t.at),
  ];
  if (final && t.purgeAfter !== undefined) {
    stmts.push(
      db.prepare("UPDATE dispute_evidence SET purge_after = ?2 WHERE dispute_id = ?1 AND purge_after IS NULL AND EXISTS (SELECT 1 FROM disputes WHERE id = ?1 AND status = ?3 AND updated_at = ?4)").bind(t.id, t.purgeAfter, t.to, t.at),
    );
  }
  for (const c of t.corrections ?? []) {
    stmts.push(
      db
        .prepare(
          "INSERT INTO v3_result_corrections (id, dispute_id, event_id, match_ref, old_value, new_value, applied_by, created_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE EXISTS (SELECT 1 FROM disputes WHERE id = ?2 AND status = 'resolved' AND updated_at = ?8)",
        )
        .bind(newEventId(), t.id, c.eventId, c.matchRef, c.oldValue, c.newValue, t.actor, t.at),
    );
  }
  const res = await db.batch(stmts);
  return (res[0]?.meta.changes ?? 0) === 1;
}

export interface NewEvidence { id: string; disputeId: string; userId: string; actorRole: string; mime: string; size: number; sha: string; caption: string | null; at: number; bytes: Uint8Array; max: number }
/** Metadata, blob and event in one batch, only while the dispute has fewer than `max` files. Returns false at the cap. A duplicate hash throws a UNIQUE error (caller pre-checks). */
export async function insertEvidenceCapped(db: D1Database, e: NewEvidence): Promise<boolean> {
  const res = await db.batch([
    db
      .prepare(
        "INSERT INTO dispute_evidence (id, dispute_id, uploaded_by_user_id, mime_type, size_bytes, sha256, caption, created_at) SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE (SELECT COUNT(*) FROM dispute_evidence WHERE dispute_id = ?2) < ?9 AND EXISTS (SELECT 1 FROM disputes WHERE id = ?2 AND status IN ('open','evidence_requested','under_review','escalated'))",
      )
      .bind(e.id, e.disputeId, e.userId, e.mime, e.size, e.sha, e.caption, e.at, e.max),
    db.prepare("INSERT INTO dispute_evidence_blobs (evidence_id, bytes) SELECT ?1, ?2 WHERE EXISTS (SELECT 1 FROM dispute_evidence WHERE id = ?1)").bind(e.id, e.bytes.buffer as ArrayBuffer),
    db
      .prepare("INSERT INTO dispute_events (id, dispute_id, actor_user_id, actor_role, action, from_status, to_status, note, created_at) SELECT ?1, ?2, ?3, ?4, 'evidence_added', NULL, NULL, ?5, ?6 WHERE EXISTS (SELECT 1 FROM dispute_evidence WHERE id = ?7)")
      .bind(newEventId(), e.disputeId, e.userId, e.actorRole, e.caption ? e.caption.slice(0, 200) : `file ${e.mime}`, e.at, e.id),
  ]);
  return (res[0]?.meta.changes ?? 0) === 1;
}

// ---------------- retention (scheduled) ----------------
/** Deletes the bytes of evidence past its purge date and stamps purged_at. The metadata row stays. At most 200 files per run. */
export async function purgeDueEvidence(db: D1Database, now: number): Promise<number> {
  const due = await db.prepare("SELECT id FROM dispute_evidence WHERE purged_at IS NULL AND purge_after IS NOT NULL AND purge_after <= ?1 LIMIT 200").bind(now).all<{ id: string }>();
  if (due.results.length === 0) return 0;
  const ids = JSON.stringify(due.results.map((r) => r.id));
  await db.batch([
    db.prepare("DELETE FROM dispute_evidence_blobs WHERE evidence_id IN (SELECT value FROM json_each(?1))").bind(ids),
    db.prepare("UPDATE dispute_evidence SET purged_at = ?2 WHERE id IN (SELECT value FROM json_each(?1))").bind(ids, now),
  ]);
  return due.results.length;
}
