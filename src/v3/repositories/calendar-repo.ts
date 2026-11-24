/** College esports calendar: calendar_entries (+ organisations, org_members, tournaments reads). Constant SQL, every value bound. Decides nothing about who may see a row. */

export interface CalendarRow {
  id: string;
  org_id: string;
  org_name: string;
  org_slug: string | null;
  title: string;
  game: string;
  city: string;
  online: number;
  starts_on: string;
  ends_on: string;
  registration_url: string | null;
  tournament_slug: string | null;
  tournament_public: number;
  status: string;
  hidden_at: number | null;
  hidden_reason: string | null;
  created_at: number;
  updated_at: number;
}


// Every query repeats the same column list (tournament_slug only from a PUBLIC, not taken-down tournament, so a private draft never leaks) and the same
// "verified, active team organisation" condition (verified_at set by staff), written out in full because prepare() only takes constant strings.

export interface PublicFilter { from: string; to: string | null; game: string | null; city: string | null; limit: number }
/** Public calendar: listed or cancelled entries of verified organisations, not hidden, ending on or after `from`. Soonest first. */
export async function listPublic(db: D1Database, f: PublicFilter): Promise<CalendarRow[]> {
  const r = await db
    .prepare("SELECT c.id AS id, c.org_id AS org_id, o.name AS org_name, o.slug AS org_slug, c.title AS title, c.game AS game, c.city AS city, c.online AS online, c.starts_on AS starts_on, c.ends_on AS ends_on, c.registration_url AS registration_url, t.slug AS tournament_slug, CASE WHEN t.id IS NOT NULL AND t.status IN ('published','registration_open','registration_closed','live','completed') AND NOT EXISTS (SELECT 1 FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'event' AND k.target_id = t.event_id) THEN 1 ELSE 0 END AS tournament_public, c.status AS status, c.hidden_at AS hidden_at, c.hidden_reason AS hidden_reason, c.created_at AS created_at, c.updated_at AS updated_at FROM calendar_entries c JOIN organisations o ON o.id = c.org_id LEFT JOIN tournaments t ON t.id = c.tournament_id WHERE o.verified_at IS NOT NULL AND o.status = 'active' AND o.kind = 'team' AND c.hidden_at IS NULL AND c.ends_on >= ?1 AND (?2 IS NULL OR c.starts_on <= ?2) AND (?3 IS NULL OR c.game = ?3) AND (?4 IS NULL OR lower(c.city) = lower(?4)) ORDER BY c.starts_on, c.title, c.id LIMIT ?5")
    .bind(f.from, f.to, f.game, f.city, f.limit)
    .all<CalendarRow>();
  return r.results;
}

/** Upcoming entries that count towards the index threshold: listed (not cancelled), not hidden, verified organisation, ending today or later. */
export async function countUpcomingVerified(db: D1Database, today: string): Promise<number> {
  const r = await db
    .prepare("SELECT COUNT(*) AS n FROM calendar_entries c JOIN organisations o ON o.id = c.org_id WHERE o.verified_at IS NOT NULL AND o.status = 'active' AND o.kind = 'team' AND c.hidden_at IS NULL AND c.status = 'listed' AND c.ends_on >= ?1")
    .bind(today)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

export interface OrgRow { id: string; name: string; slug: string | null; role: string }
/** Verified organisations the user belongs to (admin or member). */
export async function verifiedOrgsOf(db: D1Database, userId: string): Promise<OrgRow[]> {
  const r = await db
    .prepare("SELECT o.id AS id, o.name AS name, o.slug AS slug, m.role AS role FROM org_members m JOIN organisations o ON o.id = m.org_id WHERE m.user_id = ?1 AND o.verified_at IS NOT NULL AND o.status = 'active' AND o.kind = 'team' ORDER BY o.name LIMIT 50")
    .bind(userId)
    .all<OrgRow>();
  return r.results;
}
export async function verifiedOrgOf(db: D1Database, userId: string, orgId: string): Promise<OrgRow | null> {
  return (
    (await db
      .prepare("SELECT o.id AS id, o.name AS name, o.slug AS slug, m.role AS role FROM org_members m JOIN organisations o ON o.id = m.org_id WHERE m.user_id = ?1 AND o.id = ?2 AND o.verified_at IS NOT NULL AND o.status = 'active' AND o.kind = 'team'")
      .bind(userId, orgId)
      .first<OrgRow>()) ?? null
  );
}

/** Every entry (any status, hidden ones too) of the given organisations, newest dates first. For the organiser's own list. */
export async function listForOrgs(db: D1Database, orgIds: readonly string[]): Promise<CalendarRow[]> {
  if (orgIds.length === 0) return [];
  const r = await db.prepare("SELECT c.id AS id, c.org_id AS org_id, o.name AS org_name, o.slug AS org_slug, c.title AS title, c.game AS game, c.city AS city, c.online AS online, c.starts_on AS starts_on, c.ends_on AS ends_on, c.registration_url AS registration_url, t.slug AS tournament_slug, CASE WHEN t.id IS NOT NULL AND t.status IN ('published','registration_open','registration_closed','live','completed') AND NOT EXISTS (SELECT 1 FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'event' AND k.target_id = t.event_id) THEN 1 ELSE 0 END AS tournament_public, c.status AS status, c.hidden_at AS hidden_at, c.hidden_reason AS hidden_reason, c.created_at AS created_at, c.updated_at AS updated_at FROM calendar_entries c JOIN organisations o ON o.id = c.org_id LEFT JOIN tournaments t ON t.id = c.tournament_id WHERE c.org_id IN (SELECT value FROM json_each(?1)) ORDER BY c.starts_on DESC, c.id LIMIT 300").bind(JSON.stringify(orgIds)).all<CalendarRow>();
  return r.results;
}

export async function findById(db: D1Database, id: string): Promise<CalendarRow | null> {
  return (await db.prepare("SELECT c.id AS id, c.org_id AS org_id, o.name AS org_name, o.slug AS org_slug, c.title AS title, c.game AS game, c.city AS city, c.online AS online, c.starts_on AS starts_on, c.ends_on AS ends_on, c.registration_url AS registration_url, t.slug AS tournament_slug, CASE WHEN t.id IS NOT NULL AND t.status IN ('published','registration_open','registration_closed','live','completed') AND NOT EXISTS (SELECT 1 FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'event' AND k.target_id = t.event_id) THEN 1 ELSE 0 END AS tournament_public, c.status AS status, c.hidden_at AS hidden_at, c.hidden_reason AS hidden_reason, c.created_at AS created_at, c.updated_at AS updated_at FROM calendar_entries c JOIN organisations o ON o.id = c.org_id LEFT JOIN tournaments t ON t.id = c.tournament_id WHERE c.id = ?1").bind(id).first<CalendarRow>()) ?? null;
}

export async function countUpcomingForOrg(db: D1Database, orgId: string, today: string, exceptId: string): Promise<number> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM calendar_entries WHERE org_id = ?1 AND status = 'listed' AND ends_on >= ?2 AND id != ?3").bind(orgId, today, exceptId).first<{ n: number }>();
  return r?.n ?? 0;
}

/** A public tournament whose event belongs to the organisation (so an organisation can only point at its own tournaments). */
export async function orgTournamentBySlug(db: D1Database, orgId: string, slug: string): Promise<{ id: string } | null> {
  return (
    (await db
      .prepare("SELECT t.id AS id FROM tournaments t JOIN events e ON e.id = t.event_id WHERE t.slug = ?1 AND e.org_id = ?2 AND t.status IN ('published','registration_open','registration_closed','live','completed')")
      .bind(slug, orgId)
      .first<{ id: string }>()) ?? null
  );
}

export interface EntryWrite {
  id: string; orgId: string; title: string; game: string; city: string; online: boolean; startsOn: string; endsOn: string;
  registrationUrl: string | null; tournamentId: string | null; createdBy: string; at: number;
}
export async function insert(db: D1Database, e: EntryWrite): Promise<void> {
  await db
    .prepare("INSERT INTO calendar_entries (id, org_id, title, game, city, online, starts_on, ends_on, registration_url, tournament_id, status, created_by, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'listed', ?11, ?12, ?12)")
    .bind(e.id, e.orgId, e.title, e.game, e.city, e.online ? 1 : 0, e.startsOn, e.endsOn, e.registrationUrl, e.tournamentId, e.createdBy, e.at)
    .run();
}
export async function update(db: D1Database, id: string, e: Omit<EntryWrite, "id" | "orgId" | "createdBy"> & { status: string }): Promise<void> {
  await db
    .prepare("UPDATE calendar_entries SET title = ?2, game = ?3, city = ?4, online = ?5, starts_on = ?6, ends_on = ?7, registration_url = ?8, tournament_id = ?9, status = ?10, updated_at = ?11 WHERE id = ?1")
    .bind(id, e.title, e.game, e.city, e.online ? 1 : 0, e.startsOn, e.endsOn, e.registrationUrl, e.tournamentId, e.status, e.at)
    .run();
}
export async function remove(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM calendar_entries WHERE id = ?1").bind(id).run();
}

/** Staff hide / restore with the log row and the audit row in ONE batch. */
export async function setHidden(db: D1Database, id: string, hidden: { at: number; reason: string } | null, log: { id: string; action: "hidden" | "restored"; reason: string; note: string; staffId: string; at: number }, audit: D1PreparedStatement[]): Promise<void> {
  await db.batch([
    db.prepare("UPDATE calendar_entries SET hidden_at = ?2, hidden_reason = ?3 WHERE id = ?1").bind(id, hidden?.at ?? null, hidden?.reason ?? null),
    db.prepare("INSERT INTO calendar_entry_actions (id, entry_id, action, reason_code, note, staff_user_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(log.id, id, log.action, log.reason, log.note, log.staffId, log.at),
    ...audit,
  ]);
}

export interface EntryActionRow { action: string; reason_code: string; note: string; staff_user_id: string; created_at: number }
export async function actionsOf(db: D1Database, id: string): Promise<EntryActionRow[]> {
  return (await db.prepare("SELECT action, reason_code, note, staff_user_id, created_at FROM calendar_entry_actions WHERE entry_id = ?1 ORDER BY created_at, id LIMIT 100").bind(id).all<EntryActionRow>()).results;
}
