/**
 * Server badges (migration 0091): v3_badge_state, plus the READ-ONLY fact reads behind two badges (a scrim played, a tournament organised).
 * The only place v3_badge_state is queried. Constant SQL, every value bound. Decides nothing about who may see a badge (services/badge-service.ts does).
 * Before 0091 (or 0056 for the scrim tables) is applied the reads answer "nothing" instead of failing.
 */

const missingTable = (e: unknown): boolean => /no such table/i.test(String(e) + String((e as { cause?: unknown }).cause ?? ""));
async function orEmpty<T>(f: () => Promise<T>, empty: T): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (missingTable(e)) return empty;
    throw e;
  }
}

export async function badgeTableExists(db: D1Database): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'v3_badge_state'").first()) !== null;
}

export interface BadgeStateRow { badge_id: string; recorded_at: number | null; hidden: number; updated_at: number }
export function stateRows(db: D1Database, userId: string): Promise<BadgeStateRow[]> {
  return orEmpty(async () => (await db.prepare("SELECT badge_id, recorded_at, hidden, updated_at FROM v3_badge_state WHERE user_id = ?1 ORDER BY badge_id LIMIT 50").bind(userId).all<BadgeStateRow>()).results, []);
}

export async function setHidden(db: D1Database, userId: string, badgeId: string, hidden: boolean, at: number): Promise<void> {
  await db
    .prepare("INSERT INTO v3_badge_state (user_id, badge_id, hidden, updated_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (user_id, badge_id) DO UPDATE SET hidden = ?3, updated_at = ?4")
    .bind(userId, badgeId, hidden ? 1 : 0, at)
    .run();
}

/** True when the account took part in a scrim confirmed on the scrim finder whose start time has passed (a confirmed seat, or its own slot with a confirmed team). */
export function scrimPlayed(db: D1Database, userId: string, now: number): Promise<boolean> {
  return orEmpty(async () => {
    const r = await db
      .prepare(
        `SELECT 1 AS x FROM scrim_requests q JOIN scrim_slots s ON s.id = q.slot_id
         WHERE q.requester_user_id = ?1 AND q.status = 'accepted' AND s.starts_at <= ?2 AND s.status IN ('open','full') AND s.hidden_at IS NULL
         UNION ALL
         SELECT 1 AS x FROM scrim_slots s
         WHERE s.poster_user_id = ?1 AND s.starts_at <= ?2 AND s.status IN ('open','full') AND s.hidden_at IS NULL
           AND EXISTS (SELECT 1 FROM scrim_requests q WHERE q.slot_id = s.id AND q.status = 'accepted')
         LIMIT 1`,
      )
      .bind(userId, now)
      .first();
    return r !== null;
  }, false);
}

/** True when a tournament of an event the account created (events.created_by) is in a public status, not hidden by a takedown, its organisation not suspended. */
export function eventOrganised(db: D1Database, userId: string): Promise<boolean> {
  return orEmpty(async () => {
    const r = await db
      .prepare(
        `SELECT 1 AS x FROM tournaments t JOIN events e ON e.id = t.event_id
         WHERE e.created_by = ?1 AND t.status IN ('published','registration_open','registration_closed','live','completed')
           AND NOT EXISTS (SELECT 1 FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'event' AND k.target_id = e.id)
           AND NOT EXISTS (SELECT 1 FROM organisations o WHERE o.id = e.org_id AND o.status = 'suspended')
         LIMIT 1`,
      )
      .bind(userId)
      .first();
    return r !== null;
  }, false);
}

/**
 * Daily cron: records `badgeId` (first_scrim) for everyone in a scrim that started in the last `windowSec` (before the slot is deleted 7 days after its
 * start). Keeps an earlier record and the owner's hide choice. Returns the rows written.
 */
export async function recordScrimBadges(db: D1Database, badgeId: string, now: number, windowSec: number): Promise<number> {
  return orEmpty(async () => {
    const r = await db
      .prepare(
        `INSERT INTO v3_badge_state (user_id, badge_id, recorded_at, hidden, updated_at)
         SELECT DISTINCT u, ?1, ?2, 0, ?2 FROM (
           SELECT q.requester_user_id AS u FROM scrim_requests q JOIN scrim_slots s ON s.id = q.slot_id
           WHERE q.status = 'accepted' AND s.starts_at <= ?2 AND s.starts_at > ?2 - ?3 AND s.status IN ('open','full') AND s.hidden_at IS NULL
           UNION
           SELECT s.poster_user_id AS u FROM scrim_slots s
           WHERE s.starts_at <= ?2 AND s.starts_at > ?2 - ?3 AND s.status IN ('open','full') AND s.hidden_at IS NULL
             AND EXISTS (SELECT 1 FROM scrim_requests q WHERE q.slot_id = s.id AND q.status = 'accepted')
         ) WHERE u IN (SELECT id FROM users)
         ON CONFLICT (user_id, badge_id) DO UPDATE SET recorded_at = COALESCE(v3_badge_state.recorded_at, excluded.recorded_at) WHERE v3_badge_state.recorded_at IS NULL`,
      )
      .bind(badgeId, now, windowSec)
      .run();
    return r.meta?.changes ?? 0;
  }, 0);
}
