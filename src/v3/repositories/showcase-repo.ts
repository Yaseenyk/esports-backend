/**
 * Phase 3 (migration 0056): public player profiles and team pages. The only place v3_team_pages, v3_player_hidden_items, v3_team_hidden_items,
 * v3_profile_reports and v3_profile_moderation are queried, plus the READ-ONLY result reads behind a profile. A repository never decides who may see a row:
 * the service checks visibility, consent, 18+ and moderation. Constant SQL only (test/hardening.test.ts); every value is bound.
 *
 * "Verified results" means the same thing as the resume stats (repositories/stats-repo.ts): finished or forfeited head-to-head matches and battle royale
 * rows of a tournament in a PUBLIC status, not hidden by a takedown, organiser not suspended, for a team whose registration the organiser APPROVED.
 */


/** True when migration 0056 is applied (one sqlite_master read). */
export async function showcaseTablesExist(db: D1Database): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'v3_team_pages'").first()) !== null;
}

// ---------------------------------------------------------------- entries (one tournament + one team)
export interface EntryRow { event_id: string; team_key: string; team_name: string; slug: string; title: string; game: string; status: string; starts_at: number | null; ends_at: number | null }

/** Teams the account captains (proved with the captain link) in public tournaments, registration approved. Newest first, at most 60. */
export async function captainEntries(db: D1Database, userId: string): Promise<EntryRow[]> {
  const r = await db
    .prepare(
      `SELECT c.event_id AS event_id, c.team_key AS team_key, c.team_name AS team_name, t.slug AS slug, t.title AS title, t.game AS game, t.status AS status, t.starts_at AS starts_at, t.ends_at AS ends_at
       FROM v3_team_captains c JOIN tournaments t ON t.event_id = c.event_id
       WHERE c.user_id = ?1 AND t.status IN ('published','registration_open','registration_closed','live','completed')
         AND EXISTS (SELECT 1 FROM registrations r WHERE r.event_id = c.event_id AND lower(r.team_name) = c.team_key AND r.status = 'approved')
         AND NOT EXISTS (SELECT 1 FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'event' AND k.target_id = c.event_id)
         AND NOT EXISTS (SELECT 1 FROM events e JOIN organisations o ON o.id = e.org_id WHERE e.id = c.event_id AND o.status = 'suspended')
       ORDER BY COALESCE(t.starts_at, 0) DESC, t.slug LIMIT 60`,
    )
    .bind(userId)
    .all<EntryRow>();
  return r.results;
}

/** The (event, team name) pairs a team page covers, in public tournaments, registration approved. Newest first, at most 60. */
export async function teamPageEntries(db: D1Database, profileId: string): Promise<EntryRow[]> {
  const r = await db
    .prepare(
      `SELECT l.event_id AS event_id, lower(l.team_name) AS team_key, l.team_name AS team_name, t.slug AS slug, t.title AS title, t.game AS game, t.status AS status, t.starts_at AS starts_at, t.ends_at AS ends_at
       FROM team_profile_events l JOIN tournaments t ON t.event_id = l.event_id
       WHERE l.profile_id = ?1 AND t.status IN ('published','registration_open','registration_closed','live','completed')
         AND EXISTS (SELECT 1 FROM registrations r WHERE r.event_id = l.event_id AND lower(r.team_name) = lower(l.team_name) AND r.status = 'approved')
         AND NOT EXISTS (SELECT 1 FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'event' AND k.target_id = l.event_id)
         AND NOT EXISTS (SELECT 1 FROM events e JOIN organisations o ON o.id = e.org_id WHERE e.id = l.event_id AND o.status = 'suspended')
       ORDER BY COALESCE(t.starts_at, 0) DESC, t.slug LIMIT 60`,
    )
    .bind(profileId)
    .all<EntryRow>();
  return r.results;
}

// ---------------------------------------------------------------- result rows for a set of (event, team key) pairs
export interface ShowMatchRow { event_id: string; team_key: string; id: string; stage: string; round: number; a: string; b: string; status: string; score_a: number | null; score_b: number | null; winner: string | null; starts_at: string | null }
/** `pairs` is a JSON array of {"e": eventId, "k": teamKey}. Finished or forfeited matches only. */
export async function matchesFor(db: D1Database, pairs: string): Promise<ShowMatchRow[]> {
  const r = await db
    .prepare(
      `SELECT m.event_id AS event_id, p.k AS team_key, m.id AS id, m.stage AS stage, m.round AS round, m.a AS a, m.b AS b, m.status AS status, m.score_a AS score_a, m.score_b AS score_b, m.winner AS winner, m.starts_at AS starts_at
       FROM (SELECT json_extract(value, '$.e') AS e, json_extract(value, '$.k') AS k FROM json_each(?1)) p
       JOIN matches m ON m.event_id = p.e AND (lower(m.a) = p.k OR lower(m.b) = p.k)
       WHERE m.status IN ('finished','forfeit') ORDER BY m.event_id, m.stage, m.round, m.slot LIMIT 1000`,
    )
    .bind(pairs)
    .all<ShowMatchRow>();
  return r.results;
}
export interface ShowBrRow { event_id: string; team_key: string; match_no: number; team: string; placement: number; kills: number }
export async function brFor(db: D1Database, pairs: string): Promise<ShowBrRow[]> {
  const r = await db
    .prepare(
      `SELECT b.event_id AS event_id, p.k AS team_key, b.match_no AS match_no, b.team AS team, b.placement AS placement, b.kills AS kills
       FROM (SELECT json_extract(value, '$.e') AS e, json_extract(value, '$.k') AS k FROM json_each(?1)) p
       JOIN br_results b ON b.event_id = p.e AND lower(b.team) = p.k ORDER BY b.event_id, b.match_no LIMIT 2000`,
    )
    .bind(pairs)
    .all<ShowBrRow>();
  return r.results;
}
export interface ShowCorrectionRow { event_id: string; match_ref: string; old_value: string; new_value: string; created_at: number }
/** `eventIds` is a JSON array of event ids. */
export async function correctionsForEvents(db: D1Database, eventIds: string): Promise<ShowCorrectionRow[]> {
  const r = await db
    .prepare("SELECT event_id, match_ref, old_value, new_value, created_at FROM v3_result_corrections WHERE event_id IN (SELECT value FROM json_each(?1)) ORDER BY created_at, id LIMIT 1000")
    .bind(eventIds)
    .all<ShowCorrectionRow>();
  return r.results;
}
export interface PublicTeamKeyRow { event_id: string; team_key: string }
/** Teams that chose to be public in these events (approved + a published, not hidden team page covers them): the only opponent names a profile shows. */
export async function publicTeamKeys(db: D1Database, eventIds: string): Promise<PublicTeamKeyRow[]> {
  const r = await db
    .prepare(
      `SELECT DISTINCT r.event_id AS event_id, lower(r.team_name) AS team_key FROM registrations r
       JOIN team_profile_events pe ON pe.event_id = r.event_id AND lower(pe.team_name) = lower(r.team_name)
       JOIN team_profiles p ON p.id = pe.profile_id AND p.published = 1
       WHERE r.event_id IN (SELECT value FROM json_each(?1)) AND r.status = 'approved'
         AND NOT EXISTS (SELECT 1 FROM takedowns t WHERE t.target_type = 'team_profile' AND t.target_id = p.id AND t.state = 'hidden') LIMIT 2000`,
    )
    .bind(eventIds)
    .all<PublicTeamKeyRow>();
  return r.results;
}

// ---------------------------------------------------------------- hidden items (owner's choice)
export async function playerHiddenKeys(db: D1Database, userId: string): Promise<string[]> {
  return (await db.prepare("SELECT item_key FROM v3_player_hidden_items WHERE user_id = ?1 LIMIT 200").bind(userId).all<{ item_key: string }>()).results.map((x) => x.item_key);
}
export async function teamHiddenKeys(db: D1Database, profileId: string): Promise<string[]> {
  return (await db.prepare("SELECT item_key FROM v3_team_hidden_items WHERE profile_id = ?1 LIMIT 200").bind(profileId).all<{ item_key: string }>()).results.map((x) => x.item_key);
}
export async function setPlayerHidden(db: D1Database, userId: string, key: string, hidden: boolean, at: number): Promise<void> {
  if (hidden) await db.prepare("INSERT OR IGNORE INTO v3_player_hidden_items (user_id, item_key, created_at) VALUES (?1, ?2, ?3)").bind(userId, key, at).run();
  else await db.prepare("DELETE FROM v3_player_hidden_items WHERE user_id = ?1 AND item_key = ?2").bind(userId, key).run();
}
export async function setTeamHidden(db: D1Database, profileId: string, key: string, hidden: boolean, at: number): Promise<void> {
  if (hidden) await db.prepare("INSERT OR IGNORE INTO v3_team_hidden_items (profile_id, item_key, created_at) VALUES (?1, ?2, ?3)").bind(profileId, key, at).run();
  else await db.prepare("DELETE FROM v3_team_hidden_items WHERE profile_id = ?1 AND item_key = ?2").bind(profileId, key).run();
}

// ---------------------------------------------------------------- team pages
export interface TeamPageRow {
  id: string; owner_user_id: string; name: string; slug: string; published: number; blurb: string; links: string; updated_at: string;
  v3_visibility: string | null; public_since: number | null; owner_adult: number | null; owner_status: string;
}

export async function teamPageBySlug(db: D1Database, slug: string): Promise<TeamPageRow | null> {
  return (
    (await db
      .prepare(
        `SELECT p.id AS id, p.owner_user_id AS owner_user_id, p.name AS name, p.slug AS slug, p.published AS published, p.blurb AS blurb, p.links AS links, p.updated_at AS updated_at,
           v.visibility AS v3_visibility, v.public_since AS public_since, u.adult_confirmed_at AS owner_adult, u.status AS owner_status
         FROM team_profiles p JOIN users u ON u.id = p.owner_user_id LEFT JOIN v3_team_pages v ON v.profile_id = p.id WHERE p.slug = ?1`,
      )
      .bind(slug)
      .first<TeamPageRow>()) ?? null
  );
}
export async function teamPageOwned(db: D1Database, userId: string, id: string): Promise<TeamPageRow | null> {
  return (
    (await db
      .prepare(
        `SELECT p.id AS id, p.owner_user_id AS owner_user_id, p.name AS name, p.slug AS slug, p.published AS published, p.blurb AS blurb, p.links AS links, p.updated_at AS updated_at,
           v.visibility AS v3_visibility, v.public_since AS public_since, u.adult_confirmed_at AS owner_adult, u.status AS owner_status
         FROM team_profiles p JOIN users u ON u.id = p.owner_user_id LEFT JOIN v3_team_pages v ON v.profile_id = p.id WHERE p.id = ?1 AND p.owner_user_id = ?2`,
      )
      .bind(id, userId)
      .first<TeamPageRow>()) ?? null
  );
}
export async function teamPagesOf(db: D1Database, userId: string): Promise<TeamPageRow[]> {
  return (
    await db
      .prepare(
        `SELECT p.id AS id, p.owner_user_id AS owner_user_id, p.name AS name, p.slug AS slug, p.published AS published, p.blurb AS blurb, p.links AS links, p.updated_at AS updated_at,
           v.visibility AS v3_visibility, v.public_since AS public_since, u.adult_confirmed_at AS owner_adult, u.status AS owner_status
         FROM team_profiles p JOIN users u ON u.id = p.owner_user_id LEFT JOIN v3_team_pages v ON v.profile_id = p.id WHERE p.owner_user_id = ?1 ORDER BY p.updated_at DESC LIMIT 25`,
      )
      .bind(userId)
      .all<TeamPageRow>()
  ).results;
}
/** True when the legacy moderation (takedowns, honouring takedown.enforce) hides this team page. Read by the service, which decides. */
export async function teamPageTakenDown(db: D1Database, profileId: string): Promise<boolean> {
  const r = await db.prepare("SELECT 1 AS x FROM takedowns WHERE target_type = 'team_profile' AND target_id = ?1 AND state = 'hidden'").bind(profileId).first();
  return r !== null;
}

/**
 * Sets the v3 visibility and keeps the legacy published bit in step in ONE batch: private -> published 0 and the consent cleared (as the legacy unpublish does);
 * unlisted/public -> published 1 with the consent statement and its time (ISO text, the legacy column type). public_since is set the first time a page goes public.
 */
export async function setTeamVisibility(db: D1Database, p: { id: string; ownerId: string; visibility: "private" | "unlisted" | "public"; at: number; consentNote: string | null }): Promise<void> {
  const iso = new Date(p.at * 1000).toISOString();
  const published = p.visibility === "private" ? 0 : 1;
  await db.batch([
    db
      .prepare(
        `INSERT INTO v3_team_pages (profile_id, visibility, public_since, updated_at) VALUES (?1, ?2, CASE WHEN ?2 = 'public' THEN ?3 ELSE NULL END, ?3)
         ON CONFLICT (profile_id) DO UPDATE SET visibility = ?2, public_since = CASE WHEN ?2 = 'public' THEN COALESCE(v3_team_pages.public_since, ?3) ELSE v3_team_pages.public_since END, updated_at = ?3`,
      )
      .bind(p.id, p.visibility, p.at),
    db
      .prepare("UPDATE team_profiles SET published = ?3, consent_note = CASE WHEN ?3 = 1 THEN ?4 ELSE NULL END, consent_at = CASE WHEN ?3 = 1 THEN ?5 ELSE NULL END, updated_at = ?5 WHERE id = ?1 AND owner_user_id = ?2")
      .bind(p.id, p.ownerId, published, p.consentNote, iso),
  ]);
}

/** Links a (tournament event, team name) to a team page, at most `cap` links per page. Returns false when the cap is reached. Idempotent. */
export async function linkTeamPageEvent(db: D1Database, profileId: string, eventId: string, teamName: string, at: number, cap: number): Promise<boolean> {
  const iso = new Date(at * 1000).toISOString();
  const res = await db.batch([
    db
      .prepare("INSERT OR IGNORE INTO team_profile_events (profile_id, event_id, team_name) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM team_profile_events WHERE profile_id = ?1) < ?4 OR EXISTS (SELECT 1 FROM team_profile_events WHERE profile_id = ?1 AND event_id = ?2 AND team_name = ?3)")
      .bind(profileId, eventId, teamName, cap),
    db.prepare("UPDATE team_profiles SET updated_at = ?2 WHERE id = ?1").bind(profileId, iso),
  ]);
  if ((res[0]?.meta.changes ?? 0) === 1) return true;
  return (await db.prepare("SELECT 1 AS x FROM team_profile_events WHERE profile_id = ?1 AND event_id = ?2 AND team_name = ?3").bind(profileId, eventId, teamName).first()) !== null;
}

/** The account's captain claim on a team in an event (lower-cased key), or null. */
export async function captainClaim(db: D1Database, userId: string, eventId: string, teamKey: string): Promise<{ team_name: string } | null> {
  return (await db.prepare("SELECT team_name FROM v3_team_captains WHERE event_id = ?1 AND team_key = ?2 AND user_id = ?3").bind(eventId, teamKey, userId).first<{ team_name: string }>()) ?? null;
}
export async function captainTeamsInEvent(db: D1Database, userId: string, eventId: string): Promise<{ team_key: string; team_name: string }[]> {
  return (await db.prepare("SELECT team_key, team_name FROM v3_team_captains WHERE event_id = ?1 AND user_id = ?2 ORDER BY team_key LIMIT 20").bind(eventId, userId).all<{ team_key: string; team_name: string }>()).results;
}

/** Team pages owned by the user that are visible by link or public (published = 1) and not taken down, with their names: links from a player profile. */
export async function visibleTeamPagesOf(db: D1Database, userId: string): Promise<{ slug: string; name: string }[]> {
  return (
    await db
      .prepare(
        `SELECT p.slug AS slug, p.name AS name FROM team_profiles p WHERE p.owner_user_id = ?1 AND p.published = 1
           AND NOT EXISTS (SELECT 1 FROM takedowns t WHERE t.target_type = 'team_profile' AND t.target_id = p.id AND t.state = 'hidden')
           AND NOT EXISTS (SELECT 1 FROM v3_profile_moderation m WHERE m.target_kind = 'team' AND m.target_key = p.id AND m.hidden_at IS NOT NULL) LIMIT 25`,
      )
      .bind(userId)
      .all<{ slug: string; name: string }>()
  ).results;
}

// ---------------------------------------------------------------- moderation (reports, auto-hide, staff)
export async function moderationHiddenAt(db: D1Database, kind: "player" | "team", key: string): Promise<number | null> {
  const r = await db.prepare("SELECT hidden_at FROM v3_profile_moderation WHERE target_kind = ?1 AND target_key = ?2").bind(kind, key).first<{ hidden_at: number | null }>();
  return r?.hidden_at ?? null;
}

/**
 * One report per (target, reporter account). In the same batch: the distinct reporter count is refreshed, and the target is hidden when `autoHide` is on and
 * either `hideNow` (a minor report) or the count reached `threshold`. Returns whether a new report was stored.
 */
export async function fileProfileReport(
  db: D1Database,
  r: { id: string; kind: "player" | "team"; key: string; reporter: string; reasonCode: string; note: string; at: number },
  threshold: number,
  autoHide: boolean,
  hideNow: boolean,
): Promise<boolean> {
  const res = await db.batch([
    db.prepare("INSERT OR IGNORE INTO v3_profile_reports (id, target_kind, target_key, reporter, reason_code, note, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)").bind(r.id, r.kind, r.key, r.reporter, r.reasonCode, r.note, r.at),
    db
      .prepare(
        `INSERT INTO v3_profile_moderation (target_kind, target_key, hidden_at, report_count, updated_at)
         VALUES (?1, ?2, NULL, (SELECT COUNT(DISTINCT reporter) FROM v3_profile_reports WHERE target_kind = ?1 AND target_key = ?2), ?3)
         ON CONFLICT (target_kind, target_key) DO UPDATE SET report_count = (SELECT COUNT(DISTINCT reporter) FROM v3_profile_reports WHERE target_kind = ?1 AND target_key = ?2), updated_at = ?3`,
      )
      .bind(r.kind, r.key, r.at),
    db
      .prepare("UPDATE v3_profile_moderation SET hidden_at = ?3 WHERE target_kind = ?1 AND target_key = ?2 AND hidden_at IS NULL AND ?4 = 1 AND (?5 = 1 OR report_count >= ?6)")
      .bind(r.kind, r.key, r.at, autoHide ? 1 : 0, hideNow ? 1 : 0, threshold),
  ]);
  return (res[0]?.meta.changes ?? 0) === 1;
}

export interface HiddenProfileRow { target_kind: string; target_key: string; hidden_at: number; report_count: number; slug: string | null; label: string | null }
export async function listHiddenProfiles(db: D1Database): Promise<HiddenProfileRow[]> {
  return (
    await db
      .prepare(
        `SELECT m.target_kind AS target_kind, m.target_key AS target_key, m.hidden_at AS hidden_at, m.report_count AS report_count,
           CASE m.target_kind WHEN 'player' THEN (SELECT slug FROM player_profiles WHERE user_id = m.target_key) ELSE (SELECT slug FROM team_profiles WHERE id = m.target_key) END AS slug,
           CASE m.target_kind WHEN 'player' THEN (SELECT handle FROM player_profiles WHERE user_id = m.target_key) ELSE (SELECT name FROM team_profiles WHERE id = m.target_key) END AS label
         FROM v3_profile_moderation m WHERE m.hidden_at IS NOT NULL ORDER BY m.hidden_at DESC LIMIT 100`,
      )
      .all<HiddenProfileRow>()
  ).results;
}
/** The moderation key behind a public slug (staff decisions are made by slug). */
export async function playerKeyBySlug(db: D1Database, slug: string): Promise<string | null> {
  return (await db.prepare("SELECT user_id FROM player_profiles WHERE slug = ?1").bind(slug).first<{ user_id: string }>())?.user_id ?? null;
}
export async function teamKeyBySlug(db: D1Database, slug: string): Promise<{ id: string; owner_user_id: string } | null> {
  return (await db.prepare("SELECT id, owner_user_id FROM team_profiles WHERE slug = ?1").bind(slug).first<{ id: string; owner_user_id: string }>()) ?? null;
}
/** Staff restore: clears the hide AND the old reports (the same reporters cannot re-hide it at once). */
export async function restoreProfile(db: D1Database, kind: "player" | "team", key: string, at: number): Promise<boolean> {
  const res = await db.batch([
    db.prepare("UPDATE v3_profile_moderation SET hidden_at = NULL, report_count = 0, updated_at = ?3 WHERE target_kind = ?1 AND target_key = ?2 AND hidden_at IS NOT NULL").bind(kind, key, at),
    db.prepare("DELETE FROM v3_profile_reports WHERE target_kind = ?1 AND target_key = ?2").bind(kind, key),
  ]);
  return (res[0]?.meta.changes ?? 0) === 1;
}
/** Staff remove: the profile or team page goes private AND stays hidden (only a staff restore lifts the hide). */
export async function removePlayerProfile(db: D1Database, userId: string, at: number): Promise<void> {
  await db.batch([
    db.prepare("UPDATE player_profiles SET visibility = 'private', updated_at = ?2 WHERE user_id = ?1").bind(userId, at),
    db
      .prepare("INSERT INTO v3_profile_moderation (target_kind, target_key, hidden_at, report_count, updated_at) VALUES ('player', ?1, ?2, 0, ?2) ON CONFLICT (target_kind, target_key) DO UPDATE SET hidden_at = COALESCE(hidden_at, ?2), updated_at = ?2")
      .bind(userId, at),
  ]);
}
export async function removeTeamPage(db: D1Database, profileId: string, at: number): Promise<void> {
  const iso = new Date(at * 1000).toISOString();
  await db.batch([
    db.prepare("UPDATE team_profiles SET published = 0, consent_note = NULL, consent_at = NULL, updated_at = ?2 WHERE id = ?1").bind(profileId, iso),
    db.prepare("INSERT INTO v3_team_pages (profile_id, visibility, updated_at) VALUES (?1, 'private', ?2) ON CONFLICT (profile_id) DO UPDATE SET visibility = 'private', updated_at = ?2").bind(profileId, at),
    db
      .prepare("INSERT INTO v3_profile_moderation (target_kind, target_key, hidden_at, report_count, updated_at) VALUES ('team', ?1, ?2, 0, ?2) ON CONFLICT (target_kind, target_key) DO UPDATE SET hidden_at = COALESCE(hidden_at, ?2), updated_at = ?2")
      .bind(profileId, at),
  ]);
}

// ---------------------------------------------------------------- account deletion and retention
/** Statements that run BEFORE `DELETE FROM users` in the same batch (see services/account-service.ts). Rows keyed by user id cascade on their own. */
export function accountDeletionStatements(db: D1Database, userId: string, reporterKey: string): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM v3_profile_reports WHERE reporter = ?1").bind(reporterKey),
    db.prepare("DELETE FROM v3_profile_reports WHERE (target_kind = 'player' AND target_key = ?1) OR (target_kind = 'team' AND target_key IN (SELECT id FROM team_profiles WHERE owner_user_id = ?1))").bind(userId),
    db.prepare("DELETE FROM v3_profile_moderation WHERE (target_kind = 'player' AND target_key = ?1) OR (target_kind = 'team' AND target_key IN (SELECT id FROM team_profiles WHERE owner_user_id = ?1))").bind(userId),
  ];
}
/** Daily: reports and moderation rows whose team page was deleted through the legacy route (no personal data, but nothing to keep them for). */
export async function deleteOrphanTeamModeration(db: D1Database): Promise<number> {
  const res = await db.batch([
    db.prepare("DELETE FROM v3_profile_reports WHERE target_kind = 'team' AND target_key NOT IN (SELECT id FROM team_profiles) AND rowid IN (SELECT rowid FROM v3_profile_reports WHERE target_kind = 'team' LIMIT 500)"),
    db.prepare("DELETE FROM v3_profile_moderation WHERE target_kind = 'team' AND target_key NOT IN (SELECT id FROM team_profiles)"),
  ]);
  return (res[0]?.meta.changes ?? 0) + (res[1]?.meta.changes ?? 0);
}
