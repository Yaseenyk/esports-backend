/**
 * alert_subscriptions, alert_rules, alert_sent_items, alert_day_budget (migration 0090), plus the read of the account email at send time.
 * The only place these tables are queried. A repository decides nothing: who may be emailed is the service's rule.
 */

export interface SubRow { user_id: string; status: "pending" | "active" | "stopped"; confirm_expires_at: number | null; confirmed_at: number | null; unsub_hash: string; last_digest_day: string | null; created_at: number }
export interface RuleRow { id: string; game: string; place: string; kind: string }

export async function alertTablesExist(db: D1Database): Promise<boolean> {
  const r = await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('alert_subscriptions','alert_rules','alert_sent_items','alert_day_budget')").first<{ n: number }>();
  return (r?.n ?? 0) === 4;
}

export async function accountEmail(db: D1Database, userId: string): Promise<string | null> {
  return (await db.prepare("SELECT email FROM users WHERE id = ?1 AND status = 'active'").bind(userId).first<{ email: string }>())?.email ?? null;
}

export async function findSub(db: D1Database, userId: string): Promise<SubRow | null> {
  return (await db.prepare("SELECT user_id, status, confirm_expires_at, confirmed_at, unsub_hash, last_digest_day, created_at FROM alert_subscriptions WHERE user_id = ?1").bind(userId).first<SubRow>()) ?? null;
}

export async function listRules(db: D1Database, userId: string): Promise<RuleRow[]> {
  return (await db.prepare("SELECT id, game, place, kind FROM alert_rules WHERE user_id = ?1 ORDER BY created_at, id LIMIT 10").bind(userId).all<RuleRow>()).results;
}

/** Replaces the account's rules in one batch. */
export async function replaceRules(db: D1Database, userId: string, rules: { id: string; game: string; place: string; kind: string }[], at: number): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM alert_rules WHERE user_id = ?1").bind(userId),
    ...rules.map((r) => db.prepare("INSERT INTO alert_rules (id, user_id, game, place, kind, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(r.id, userId, r.game, r.place, r.kind, at)),
  ]);
}

/** Creates the row (pending) or, for an existing row, sets a fresh confirm token. An active row stays active; a stopped row goes back to pending. */
export async function setPending(db: D1Database, userId: string, confirmHash: string, confirmExpiresAt: number, unsubHash: string, at: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO alert_subscriptions (user_id, status, confirm_hash, confirm_expires_at, confirmed_at, unsub_hash, last_digest_day, created_at, updated_at)
       VALUES (?1, 'pending', ?2, ?3, NULL, ?4, NULL, ?5, ?5)
       ON CONFLICT (user_id) DO UPDATE SET confirm_hash = ?2, confirm_expires_at = ?3, status = CASE WHEN status = 'active' THEN 'active' ELSE 'pending' END, updated_at = ?5`,
    )
    .bind(userId, confirmHash, confirmExpiresAt, unsubHash, at)
    .run();
}

/** Clears an unsent confirm token (the email could not be sent). */
export async function clearConfirm(db: D1Database, userId: string, confirmHash: string): Promise<void> {
  await db.prepare("UPDATE alert_subscriptions SET confirm_hash = NULL, confirm_expires_at = NULL WHERE user_id = ?1 AND confirm_hash = ?2").bind(userId, confirmHash).run();
}

/** The double opt-in click: a pending row with this unexpired token becomes active. Returns the user id, or null. */
export async function confirmByHash(db: D1Database, confirmHash: string, now: number): Promise<string | null> {
  const r = await db
    .prepare("UPDATE alert_subscriptions SET status = 'active', confirmed_at = COALESCE(confirmed_at, ?2), confirm_hash = NULL, confirm_expires_at = NULL, updated_at = ?2 WHERE confirm_hash = ?1 AND confirm_expires_at > ?2 RETURNING user_id")
    .bind(confirmHash, now)
    .first<{ user_id: string }>();
  return r?.user_id ?? null;
}

/** The one-click unsubscribe: any row with this token becomes stopped (a second click still answers ok). Returns whether a row matched. */
export async function stopByUnsubHash(db: D1Database, unsubHash: string, now: number): Promise<boolean> {
  const r = await db.prepare("UPDATE alert_subscriptions SET status = 'stopped', confirm_hash = NULL, confirm_expires_at = NULL, updated_at = ?2 WHERE unsub_hash = ?1 RETURNING user_id").bind(unsubHash, now).first<{ user_id: string }>();
  return r !== null;
}

export async function stopForUser(db: D1Database, userId: string, now: number): Promise<boolean> {
  const r = await db.prepare("UPDATE alert_subscriptions SET status = 'stopped', confirm_hash = NULL, confirm_expires_at = NULL, updated_at = ?2 WHERE user_id = ?1").bind(userId, now).run();
  return (r.meta?.changes ?? 0) === 1;
}

export async function setUnsubHash(db: D1Database, userId: string, unsubHash: string): Promise<void> {
  await db.prepare("UPDATE alert_subscriptions SET unsub_hash = ?2 WHERE user_id = ?1").bind(userId, unsubHash).run();
}

/** Everything about alerts for one account (the "delete my alerts" button). */
export async function deleteAll(db: D1Database, userId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM alert_rules WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM alert_sent_items WHERE user_id = ?1").bind(userId),
    db.prepare("DELETE FROM alert_subscriptions WHERE user_id = ?1").bind(userId),
  ]);
}

// ---------------- digest ----------------
export interface DueRow { user_id: string; email: string; confirmed_at: number; unsub_hash: string; created_at: number }
/** Confirmed, active accounts (18+, account active) whose digest has not run today. */
export async function listDue(db: D1Database, day: string, limit: number): Promise<DueRow[]> {
  const r = await db
    .prepare(
      `SELECT s.user_id, u.email, s.confirmed_at, s.unsub_hash, s.created_at FROM alert_subscriptions s JOIN users u ON u.id = s.user_id
       WHERE s.status = 'active' AND s.confirmed_at IS NOT NULL AND (s.last_digest_day IS NULL OR s.last_digest_day < ?1) AND u.status = 'active' AND u.adult_confirmed_at IS NOT NULL
       ORDER BY s.last_digest_day, s.user_id LIMIT ?2`,
    )
    .bind(day, limit)
    .all<DueRow>();
  return r.results;
}

/** Claims today's digest for one account (atomic: two cron runs cannot both send). */
export async function claimDay(db: D1Database, userId: string, day: string): Promise<boolean> {
  const r = await db.prepare("UPDATE alert_subscriptions SET last_digest_day = ?2 WHERE user_id = ?1 AND status = 'active' AND (last_digest_day IS NULL OR last_digest_day < ?2)").bind(userId, day).run();
  return (r.meta?.changes ?? 0) === 1;
}

export interface TournamentMatch { id: string; slug: string; title: string; game: string; venue: string; city: string | null; starts_at: number; status: string }
/**
 * Public tournaments (same visibility rule as the directory: public status, not taken down, organisation not suspended) that start in the future, were
 * published or opened registration since `since`, match one of the account's rules, and were never sent to it.
 */
export async function matchTournaments(db: D1Database, userId: string, since: number, now: number, limit: number): Promise<TournamentMatch[]> {
  const r = await db
    .prepare(
      `SELECT t.id, t.slug, t.title, t.game, t.venue, t.city, t.starts_at, t.status FROM tournaments t
       WHERE t.status IN ('published','registration_open') AND t.starts_at IS NOT NULL AND t.starts_at > ?3
         AND (COALESCE(t.published_at, 0) >= ?2 OR (t.status = 'registration_open' AND t.updated_at >= ?2))
         AND NOT EXISTS (SELECT 1 FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'event' AND k.target_id = t.event_id)
         AND NOT EXISTS (SELECT 1 FROM events e JOIN organisations o ON o.id = e.org_id WHERE e.id = t.event_id AND o.status = 'suspended')
         AND EXISTS (SELECT 1 FROM alert_rules r WHERE r.user_id = ?1 AND r.kind IN ('any','tournament') AND (r.game = 'any' OR r.game = t.game)
                     AND (r.place = 'any' OR (r.place = 'online' AND t.venue IN ('online','hybrid')) OR (t.city IS NOT NULL AND lower(t.city) = r.place)))
         AND NOT EXISTS (SELECT 1 FROM alert_sent_items s WHERE s.user_id = ?1 AND s.item_key = 't:' || t.id)
       ORDER BY t.starts_at, t.id LIMIT ?4`,
    )
    .bind(userId, since, now, limit)
    .all<TournamentMatch>();
  return r.results;
}

export interface CalendarMatch { id: string; title: string; game: string; city: string; online: number; starts_on: string }
/** Listed college calendar entries of verified, active organisations (same rule as the public calendar), added since `since`, starting today or later. */
export async function matchCalendar(db: D1Database, userId: string, since: number, today: string, limit: number): Promise<CalendarMatch[]> {
  const r = await db
    .prepare(
      `SELECT c.id, c.title, c.game, c.city, c.online, c.starts_on FROM calendar_entries c JOIN organisations o ON o.id = c.org_id
       WHERE o.verified_at IS NOT NULL AND o.status = 'active' AND o.kind = 'team' AND c.hidden_at IS NULL AND c.status = 'listed' AND c.starts_on >= ?3 AND c.created_at >= ?2
         AND EXISTS (SELECT 1 FROM alert_rules r WHERE r.user_id = ?1 AND r.kind IN ('any','college') AND (r.game = 'any' OR r.game = c.game)
                     AND (r.place = 'any' OR (r.place = 'online' AND c.online = 1) OR lower(c.city) = r.place))
         AND NOT EXISTS (SELECT 1 FROM alert_sent_items s WHERE s.user_id = ?1 AND s.item_key = 'c:' || c.id)
       ORDER BY c.starts_on, c.id LIMIT ?4`,
    )
    .bind(userId, since, today, limit)
    .all<CalendarMatch>();
  return r.results;
}

export async function markSent(db: D1Database, userId: string, keys: string[], at: number): Promise<void> {
  if (!keys.length) return;
  await db.batch(keys.map((k) => db.prepare("INSERT OR IGNORE INTO alert_sent_items (user_id, item_key, sent_at) VALUES (?1, ?2, ?3)").bind(userId, k, at)));
}
export async function unmarkSent(db: D1Database, userId: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await db.batch(keys.map((k) => db.prepare("DELETE FROM alert_sent_items WHERE user_id = ?1 AND item_key = ?2").bind(userId, k)));
}

/** Takes one email from the alerts' own daily cap. False when the cap is used up. */
export async function reserveAlertMail(db: D1Database, day: string, cap: number): Promise<boolean> {
  const r = await db.prepare("INSERT INTO alert_day_budget (day, sent) VALUES (?1, 1) ON CONFLICT (day) DO UPDATE SET sent = sent + 1 WHERE sent < ?2 RETURNING sent").bind(day, cap).first<{ sent: number }>();
  return r !== null && r.sent <= cap;
}
export async function refundAlertMail(db: D1Database, day: string): Promise<void> {
  await db.prepare("UPDATE alert_day_budget SET sent = sent - 1 WHERE day = ?1 AND sent > 0").bind(day).run();
}
/** Marks today as capped. Returns true only the first time (so the log line is written once a day). */
export async function markCapped(db: D1Database, day: string, at: number): Promise<boolean> {
  const r = await db.prepare("INSERT INTO alert_day_budget (day, sent, capped_at) VALUES (?1, 0, ?2) ON CONFLICT (day) DO UPDATE SET capped_at = ?2 WHERE capped_at IS NULL").bind(day, at).run();
  return (r.meta?.changes ?? 0) === 1;
}
export async function dayBudget(db: D1Database, day: string): Promise<{ sent: number; capped: boolean }> {
  const r = await db.prepare("SELECT sent, capped_at FROM alert_day_budget WHERE day = ?1").bind(day).first<{ sent: number; capped_at: number | null }>();
  return { sent: r?.sent ?? 0, capped: (r?.capped_at ?? null) !== null };
}

/** Retention: forgets sent items older than `before` and budget rows older than `dayBefore`. */
export async function purgeOld(db: D1Database, before: number, dayBefore: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM alert_sent_items WHERE sent_at < ?1").bind(before),
    db.prepare("DELETE FROM alert_day_budget WHERE day < ?1").bind(dayBefore),
    db.prepare("DELETE FROM alert_subscriptions WHERE status = 'pending' AND confirmed_at IS NULL AND (confirm_expires_at IS NULL OR confirm_expires_at < ?1)").bind(before),
  ]);
}
