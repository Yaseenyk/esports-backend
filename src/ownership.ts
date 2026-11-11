/**
 * Account deletion must never silently delete events that other people work on (events.owner_id cascades from users).
 * Read first, then hand over in one batch with the user delete. All SQL is constant.
 *
 *  - an event with at least one editor besides the leaver: re-homed to the editor added earliest (ties by user id);
 *    that editor's membership row is removed (they are the owner now) and the event's brand kit follows.
 *  - the new owner already has an event with the same key (slug): conflict, nothing is changed.
 *  - an event with only viewers: needs the caller's explicit confirmation, then it is deleted with the account.
 *  - an event nobody else is part of: deleted with the account (unchanged behaviour, not examined here). Known limit (review N-14):
 *    that cascade is unbounded, so an account with very many large solo events can hit D1's limits and get a 500 with nothing
 *    deleted. Not bounded here; follow-up S1c (per-event chunked delete above 20 owned events) with the typed confirmation.
 *  - brand: an event that relied on the leaver's account kit gets a copy of it as an event kit first (review N-1), so the public
 *    brand is identical before and after.
 */

export const MAX_HANDOVERS = 50;

export interface SharedEvent { id: string; name: string; slug: string; newOwnerId: string | null; newOwnerName: string | null; hasConflict: boolean }
export interface HandoverPlan {
  /** More than MAX_HANDOVERS events are shared with other people. */
  tooMany: boolean;
  handovers: { id: string; name: string; slug: string; newOwnerId: string; newOwnerName: string }[];
  conflicts: { id: string; name: string; slug: string; newOwnerName: string }[];
  /** Events with viewers but no editor: deleted only on explicit confirmation. */
  needDeleteConfirmation: { id: string; name: string }[];
}

export async function planOwnershipHandover(db: D1Database, userId: string): Promise<HandoverPlan> {
  const rows = await db.prepare(
    `SELECT e.id AS id, e.name AS name, e.slug AS slug,
       (SELECT m.user_id FROM event_members m WHERE m.event_id = e.id AND m.role = 'editor' AND m.user_id <> ?1 ORDER BY m.added_at, m.user_id LIMIT 1) AS new_owner_id,
       (SELECT u.name FROM users u WHERE u.id = (SELECT m.user_id FROM event_members m WHERE m.event_id = e.id AND m.role = 'editor' AND m.user_id <> ?1 ORDER BY m.added_at, m.user_id LIMIT 1)) AS new_owner_name,
       EXISTS (SELECT 1 FROM events x WHERE x.slug = e.slug AND x.owner_id = (SELECT m.user_id FROM event_members m WHERE m.event_id = e.id AND m.role = 'editor' AND m.user_id <> ?1 ORDER BY m.added_at, m.user_id LIMIT 1)) AS has_conflict
     FROM events e
     WHERE e.owner_id = ?1 AND EXISTS (SELECT 1 FROM event_members o WHERE o.event_id = e.id AND o.user_id <> ?1)
     ORDER BY e.created_at, e.id LIMIT ?2`,
  ).bind(userId, MAX_HANDOVERS + 1).all<{ id: string; name: string; slug: string; new_owner_id: string | null; new_owner_name: string | null; has_conflict: number }>();
  const plan: HandoverPlan = { tooMany: rows.results.length > MAX_HANDOVERS, handovers: [], conflicts: [], needDeleteConfirmation: [] };
  for (const r of rows.results.slice(0, MAX_HANDOVERS)) {
    if (!r.new_owner_id) plan.needDeleteConfirmation.push({ id: r.id, name: r.name });
    else if (r.has_conflict) plan.conflicts.push({ id: r.id, name: r.name, slug: r.slug, newOwnerName: r.new_owner_name ?? "Your co-organiser" });
    else plan.handovers.push({ id: r.id, name: r.name, slug: r.slug, newOwnerId: r.new_owner_id, newOwnerName: r.new_owner_name ?? "Your co-organiser" });
  }
  return plan;
}

/** Seam: extra statements per handed-over event, run after the built-in ones. Empty today (organisations will add theirs). */
export function extraPerHandover(_db: D1Database, _h: HandoverPlan["handovers"][number]): D1PreparedStatement[] {
  return [];
}

/** Seam: extra statements run after the user delete, in the same batch. Empty today. */
export function afterUserDelete(_db: D1Database, _userId: string): D1PreparedStatement[] {
  return [];
}

/** Four statements per handed-over event (each guarded by the old owner id, so a concurrent change makes them no-ops), plus the seam. */
export function handoverStatements(db: D1Database, userId: string, handovers: HandoverPlan["handovers"]): D1PreparedStatement[] {
  const out: D1PreparedStatement[] = [];
  const now = new Date().toISOString();
  for (const h of handovers) {
    out.push(
      // N-1: pin the leaver's account kit to the event (only when the event has no kit of its own); the UPDATE below then moves it.
      db.prepare(
        "INSERT INTO brand_kits (id, owner_user_id, scope, name, logo, primary_color, secondary_color, updated_at) SELECT ?1, ?2, ?3, name, logo, primary_color, secondary_color, ?4 FROM brand_kits WHERE owner_user_id = ?5 AND scope = 'account' AND NOT EXISTS (SELECT 1 FROM brand_kits k WHERE k.owner_user_id = ?5 AND k.scope = ?3)",
      ).bind(crypto.randomUUID(), h.newOwnerId, h.id, now, userId),
      db.prepare("UPDATE events SET owner_id = ?1 WHERE id = ?2 AND owner_id = ?3").bind(h.newOwnerId, h.id, userId),
      db.prepare("DELETE FROM event_members WHERE event_id = ?1 AND user_id = ?2").bind(h.id, h.newOwnerId),
      db.prepare("UPDATE brand_kits SET owner_user_id = ?1 WHERE scope = ?2 AND owner_user_id = ?3").bind(h.newOwnerId, h.id, userId),
      ...extraPerHandover(db, h),
    );
  }
  return out;
}
