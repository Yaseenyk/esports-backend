/**
 * Organiser trust score: organiser_ratings, organiser_rating_reports, organiser_rating_actions, plus the READ-ONLY legacy reads that prove a player took part
 * (share_links + checkins + people for a checked-in pass; captain_links / v3_team_captains + registrations + matches / br_results for a team that played).
 * Constant SQL, every value bound. Decides nothing about who may see a row.
 */

export interface EventFacts { eventId: string; orgId: string | null; organiserText: string; orgName: string | null; orgVerified: boolean }
export async function eventFacts(db: D1Database, eventId: string): Promise<EventFacts | null> {
  const r = await db
    .prepare("SELECT e.id AS id, e.org_id AS org_id, e.organiser AS organiser, o.name AS org_name, o.kind AS org_kind, o.verified_at AS verified_at FROM events e LEFT JOIN organisations o ON o.id = e.org_id WHERE e.id = ?1")
    .bind(eventId)
    .first<{ id: string; org_id: string | null; organiser: string; org_name: string | null; org_kind: string | null; verified_at: number | null }>();
  if (!r) return null;
  return { eventId: r.id, orgId: r.org_id, organiserText: r.organiser, orgName: r.org_kind === "team" ? r.org_name : null, orgVerified: r.org_kind === "team" && r.verified_at !== null };
}

// ---------------- proof of participation (legacy tables, read only) ----------------

export interface PassPerson { personId: string; minor: boolean; checkedIn: boolean }
/** The roster person behind a live (not revoked) pass link of THIS event, with whether they were scanned in at the gate. */
export async function passPerson(db: D1Database, eventId: string, tokenHash: string, token: string): Promise<PassPerson | null> {
  const r = await db
    .prepare(
      "SELECT s.person_id AS person_id, p.minor AS minor, EXISTS (SELECT 1 FROM checkins k WHERE k.event_id = s.event_id AND k.person_id = s.person_id) AS checked_in FROM share_links s JOIN people p ON p.event_id = s.event_id AND p.id = s.person_id WHERE s.event_id = ?1 AND s.revoked = 0 AND (s.token_hash = ?2 OR (s.token_hash IS NULL AND s.token = ?3)) AND NOT EXISTS (SELECT 1 FROM takedowns t WHERE t.target_type = 'pass' AND t.target_id = s.id AND t.state = 'hidden') LIMIT 1",
    )
    .bind(eventId, tokenHash, token)
    .first<{ person_id: string; minor: number; checked_in: number }>();
  return r ? { personId: r.person_id, minor: r.minor === 1, checkedIn: r.checked_in === 1 } : null;
}

/** The team a live captain link of THIS event belongs to. */
export async function captainLinkTeam(db: D1Database, eventId: string, tokenHash: string): Promise<string | null> {
  const r = await db.prepare("SELECT team FROM captain_links WHERE token_hash = ?1 AND event_id = ?2 AND revoked_at IS NULL").bind(tokenHash, eventId).first<{ team: string }>();
  return r?.team ?? null;
}
/** Teams the user already proved they captain in this event (dispute portal captain claims). */
export async function claimedTeams(db: D1Database, eventId: string, userId: string): Promise<string[]> {
  const r = await db.prepare("SELECT team_name FROM v3_team_captains WHERE event_id = ?1 AND user_id = ?2 ORDER BY team_name LIMIT 20").bind(eventId, userId).all<{ team_name: string }>();
  return r.results.map((x) => x.team_name);
}
/** True when the team has an APPROVED registration and appears in at least one verified result (finished or forfeited match, or a battle royale row). */
export async function teamPlayed(db: D1Database, eventId: string, team: string): Promise<boolean> {
  const r = await db
    .prepare(
      "SELECT 1 AS x FROM registrations r WHERE r.event_id = ?1 AND r.status = 'approved' AND lower(r.team_name) = lower(?2) AND (EXISTS (SELECT 1 FROM matches m WHERE m.event_id = ?1 AND m.status IN ('finished','forfeit') AND (lower(m.a) = lower(?2) OR lower(m.b) = lower(?2))) OR EXISTS (SELECT 1 FROM br_results b WHERE b.event_id = ?1 AND lower(b.team) = lower(?2))) LIMIT 1",
    )
    .bind(eventId, team)
    .first();
  return r !== null;
}

// ---------------- ratings ----------------

export interface RatingRow {
  id: string; event_id: string; organiser_key: string; user_id: string; display_name: string; proof_kind: string;
  stars: number; on_time: number; fair_play: number; communication: number; review: string | null;
  reply: string | null; reply_at: number | null; hidden_at: number | null; hidden_reason: string | null; reply_hidden_at: number | null; reply_hidden_reason: string | null;
  created_at: number; updated_at: number;
}

export interface RatingInsert {
  id: string; eventId: string; organiserKey: string; userId: string; displayName: string; proofKind: "checked_in" | "played"; proofRef: string;
  stars: number; onTime: number; fair: number; communication: number; review: string | null; at: number;
}
/** Inserts a rating. "dup_user" / "dup_proof" when the unique indexes refuse it (one per player per event, one per pass / team per event). */
export async function insertRating(db: D1Database, r: RatingInsert): Promise<"ok" | "dup_user" | "dup_proof"> {
  try {
    await db
      .prepare("INSERT INTO organiser_ratings (id, event_id, organiser_key, user_id, display_name, proof_kind, proof_ref, stars, on_time, fair_play, communication, review, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?13)")
      .bind(r.id, r.eventId, r.organiserKey, r.userId, r.displayName, r.proofKind, r.proofRef, r.stars, r.onTime, r.fair, r.communication, r.review, r.at)
      .run();
    return "ok";
  } catch (e) {
    const msg = String(e) + String((e as { cause?: unknown }).cause ?? "");
    if (/organiser_ratings\.event_id, organiser_ratings\.user_id|one_per_event/i.test(msg)) return "dup_user";
    if (/UNIQUE|constraint/i.test(msg)) return "dup_proof";
    throw e;
  }
}

export async function findRating(db: D1Database, id: string): Promise<RatingRow | null> {
  return (await db.prepare("SELECT r.id AS id, r.event_id AS event_id, r.organiser_key AS organiser_key, r.user_id AS user_id, r.display_name AS display_name, r.proof_kind AS proof_kind, r.stars AS stars, r.on_time AS on_time, r.fair_play AS fair_play, r.communication AS communication, r.review AS review, r.reply AS reply, r.reply_at AS reply_at, r.hidden_at AS hidden_at, r.hidden_reason AS hidden_reason, r.reply_hidden_at AS reply_hidden_at, r.reply_hidden_reason AS reply_hidden_reason, r.created_at AS created_at, r.updated_at AS updated_at FROM organiser_ratings r WHERE r.id = ?1").bind(id).first<RatingRow>()) ?? null;
}
export async function myRating(db: D1Database, eventId: string, userId: string): Promise<RatingRow | null> {
  return (await db.prepare("SELECT r.id AS id, r.event_id AS event_id, r.organiser_key AS organiser_key, r.user_id AS user_id, r.display_name AS display_name, r.proof_kind AS proof_kind, r.stars AS stars, r.on_time AS on_time, r.fair_play AS fair_play, r.communication AS communication, r.review AS review, r.reply AS reply, r.reply_at AS reply_at, r.hidden_at AS hidden_at, r.hidden_reason AS hidden_reason, r.reply_hidden_at AS reply_hidden_at, r.reply_hidden_reason AS reply_hidden_reason, r.created_at AS created_at, r.updated_at AS updated_at FROM organiser_ratings r WHERE r.event_id = ?1 AND r.user_id = ?2").bind(eventId, userId).first<RatingRow>()) ?? null;
}
export async function deleteRating(db: D1Database, id: string, userId: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM organiser_ratings WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
  return (r.meta.changes ?? 0) > 0;
}

/** Stars of every VISIBLE rating of the organiser (hidden ones do not count). Bounded. */
export async function visibleStars(db: D1Database, organiserKey: string): Promise<{ stars: number; on_time: number; fair_play: number; communication: number }[]> {
  const r = await db
    .prepare("SELECT stars, on_time, fair_play, communication FROM organiser_ratings WHERE organiser_key = ?1 AND hidden_at IS NULL LIMIT 20000")
    .bind(organiserKey)
    .all<{ stars: number; on_time: number; fair_play: number; communication: number }>();
  return r.results;
}

export interface PublicReviewRow extends RatingRow { t_slug: string | null; t_title: string | null }
/** Visible ratings of the organiser that carry a written review, newest first, with the tournament they belong to (only when it is public). */
export async function visibleReviews(db: D1Database, organiserKey: string, limit: number): Promise<PublicReviewRow[]> {
  const r = await db
    .prepare(
      "SELECT r.id AS id, r.event_id AS event_id, r.organiser_key AS organiser_key, r.user_id AS user_id, r.display_name AS display_name, r.proof_kind AS proof_kind, r.stars AS stars, r.on_time AS on_time, r.fair_play AS fair_play, r.communication AS communication, r.review AS review, r.reply AS reply, r.reply_at AS reply_at, r.hidden_at AS hidden_at, r.hidden_reason AS hidden_reason, r.reply_hidden_at AS reply_hidden_at, r.reply_hidden_reason AS reply_hidden_reason, r.created_at AS created_at, r.updated_at AS updated_at, CASE WHEN t.status IN ('published','registration_open','registration_closed','live','completed') THEN t.slug ELSE NULL END AS t_slug, CASE WHEN t.status IN ('published','registration_open','registration_closed','live','completed') THEN t.title ELSE NULL END AS t_title FROM organiser_ratings r LEFT JOIN tournaments t ON t.event_id = r.event_id WHERE r.organiser_key = ?1 AND r.hidden_at IS NULL AND r.review IS NOT NULL ORDER BY r.created_at DESC, r.id LIMIT ?2",
    )
    .bind(organiserKey, limit)
    .all<PublicReviewRow>();
  return r.results;
}

/** Sets the organiser's reply ONCE (the WHERE refuses a second one). Returns false when there already was a reply. */
export async function setReplyOnce(db: D1Database, id: string, text: string, by: string, at: number): Promise<boolean> {
  const r = await db.prepare("UPDATE organiser_ratings SET reply = ?2, reply_by = ?3, reply_at = ?4, updated_at = ?4 WHERE id = ?1 AND reply IS NULL").bind(id, text, by, at).run();
  return (r.meta.changes ?? 0) > 0;
}

// ---------------- reports ----------------

export async function insertReport(db: D1Database, r: { id: string; ratingId: string; target: string; reporterId: string; reason: string; note: string; at: number }): Promise<boolean> {
  try {
    await db
      .prepare("INSERT INTO organiser_rating_reports (id, rating_id, target, reporter_user_id, reason_code, note, status, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'open', ?7)")
      .bind(r.id, r.ratingId, r.target, r.reporterId, r.reason, r.note, r.at)
      .run();
    return true;
  } catch (e) {
    if (/UNIQUE|constraint/i.test(String(e) + String((e as { cause?: unknown }).cause ?? ""))) return false;
    throw e;
  }
}

export interface ReportQueueRow {
  id: string; rating_id: string; target: string; reason_code: string; note: string; status: string; created_at: number;
  review: string | null; reply: string | null; display_name: string; stars: number; hidden_at: number | null; reply_hidden_at: number | null; event_id: string;
}
export async function reportQueue(db: D1Database, status: string, limit: number): Promise<ReportQueueRow[]> {
  const r = await db
    .prepare(
      "SELECT p.id AS id, p.rating_id AS rating_id, p.target AS target, p.reason_code AS reason_code, p.note AS note, p.status AS status, p.created_at AS created_at, r.review AS review, r.reply AS reply, r.display_name AS display_name, r.stars AS stars, r.hidden_at AS hidden_at, r.reply_hidden_at AS reply_hidden_at, r.event_id AS event_id FROM organiser_rating_reports p JOIN organiser_ratings r ON r.id = p.rating_id WHERE p.status = ?1 ORDER BY p.created_at, p.id LIMIT ?2",
    )
    .bind(status, limit)
    .all<ReportQueueRow>();
  return r.results;
}
export async function findReport(db: D1Database, id: string): Promise<{ id: string; rating_id: string; target: string; status: string } | null> {
  return (await db.prepare("SELECT id, rating_id, target, status FROM organiser_rating_reports WHERE id = ?1").bind(id).first<{ id: string; rating_id: string; target: string; status: string }>()) ?? null;
}

// ---------------- moderation (one batch: the change, the log row, the open reports decided, the audit row) ----------------

export interface ModerationLog { id: string; ratingId: string; target: "review" | "reply"; action: "hidden" | "restored" | "report_dismissed"; reason: string; note: string; staffId: string; at: number }
const logStmt = (db: D1Database, l: ModerationLog) =>
  db.prepare("INSERT INTO organiser_rating_actions (id, rating_id, target, action, reason_code, note, staff_user_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)").bind(l.id, l.ratingId, l.target, l.action, l.reason, l.note, l.staffId, l.at);

export async function setVisibility(db: D1Database, l: ModerationLog, audit: D1PreparedStatement[]): Promise<void> {
  const hide = l.action === "hidden";
  const change =
    l.target === "review"
      ? db.prepare("UPDATE organiser_ratings SET hidden_at = ?2, hidden_reason = ?3 WHERE id = ?1").bind(l.ratingId, hide ? l.at : null, hide ? l.reason : null)
      : db.prepare("UPDATE organiser_ratings SET reply_hidden_at = ?2, reply_hidden_reason = ?3 WHERE id = ?1").bind(l.ratingId, hide ? l.at : null, hide ? l.reason : null);
  await db.batch([
    change,
    logStmt(db, l),
    db.prepare("UPDATE organiser_rating_reports SET status = ?3, decided_at = ?4, decided_by = ?5 WHERE rating_id = ?1 AND target = ?2 AND status = 'open'").bind(l.ratingId, l.target, hide ? "actioned" : "dismissed", l.at, l.staffId),
    ...audit,
  ]);
}

export async function dismissReport(db: D1Database, reportId: string, l: ModerationLog, audit: D1PreparedStatement[]): Promise<void> {
  await db.batch([
    db.prepare("UPDATE organiser_rating_reports SET status = 'dismissed', decided_at = ?2, decided_by = ?3 WHERE id = ?1 AND status = 'open'").bind(reportId, l.at, l.staffId),
    logStmt(db, l),
    ...audit,
  ]);
}

export interface ActionRow { target: string; action: string; reason_code: string; note: string; staff_user_id: string; created_at: number }
export async function actionsOf(db: D1Database, ratingId: string): Promise<ActionRow[]> {
  return (await db.prepare("SELECT target, action, reason_code, note, staff_user_id, created_at FROM organiser_rating_actions WHERE rating_id = ?1 ORDER BY created_at, id LIMIT 200").bind(ratingId).all<ActionRow>()).results;
}
export async function reportsOf(db: D1Database, ratingId: string): Promise<{ id: string; target: string; reason_code: string; note: string; status: string; created_at: number }[]> {
  return (await db.prepare("SELECT id, target, reason_code, note, status, created_at FROM organiser_rating_reports WHERE rating_id = ?1 ORDER BY created_at, id LIMIT 200").bind(ratingId).all<{ id: string; target: string; reason_code: string; note: string; status: string; created_at: number }>()).results;
}

/** For "my ratings": the user's own rows with the tournament slug and title. */
export async function ratingsOfUser(db: D1Database, userId: string): Promise<PublicReviewRow[]> {
  const r = await db
    .prepare("SELECT r.id AS id, r.event_id AS event_id, r.organiser_key AS organiser_key, r.user_id AS user_id, r.display_name AS display_name, r.proof_kind AS proof_kind, r.stars AS stars, r.on_time AS on_time, r.fair_play AS fair_play, r.communication AS communication, r.review AS review, r.reply AS reply, r.reply_at AS reply_at, r.hidden_at AS hidden_at, r.hidden_reason AS hidden_reason, r.reply_hidden_at AS reply_hidden_at, r.reply_hidden_reason AS reply_hidden_reason, r.created_at AS created_at, r.updated_at AS updated_at, t.slug AS t_slug, t.title AS t_title FROM organiser_ratings r LEFT JOIN tournaments t ON t.event_id = r.event_id WHERE r.user_id = ?1 ORDER BY r.created_at DESC, r.id LIMIT 200")
    .bind(userId)
    .all<PublicReviewRow>();
  return r.results;
}

/** The account's own name, offered as the default display name of a review (the player can change it before posting). */
export async function accountName(db: D1Database, userId: string): Promise<string | null> {
  return (await db.prepare("SELECT name FROM users WHERE id = ?1").bind(userId).first<{ name: string }>())?.name ?? null;
}
