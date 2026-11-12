/**
 * Account deletion must never silently delete events that other people work on (events.owner_id cascades from users).
 * Read first, then hand over in one batch with the user delete. All SQL is constant.
 *
 *  - an event with at least one editor besides the leaver: re-homed to the editor added earliest (ties by user id);
 *    that editor's membership row is removed (they are the owner now) and the event's brand kit follows.
 *  - the new owner already has an event with the same key (slug): conflict, nothing is changed.
 *  - an event with only viewers: needs the caller's explicit confirmation, then it is deleted with the account.
 *  - an event nobody else is part of: deleted with the account. Review N-14: that cascade is unbounded inside one DELETE FROM users, so above
 *    SOLO_CHUNK_THRESHOLD such events the route deletes them one event per batch first (S1c, routes/auth.ts) and asks for a typed count.
 *  - brand: an event that relied on the leaver's account kit gets a copy of it as an event kit first (review N-1), so the public
 *    brand is identical before and after.
 *  - E1 (blueprint 5.3): an event handed over inside a personal organisation moves to the new owner's personal organisation, and the leaver's personal
 *    organisation is deleted after the user (a foreign key still pointing at it refuses the whole batch: the route answers 409 ownership_conflict, N-15).
 *  - E2 (Phase 2a): an event in a TEAM organisation goes to the earliest other organisation admin and keeps its org_id; guests are used only for events
 *    outside a team organisation. The last admin of a team organisation that has other members or other people's events cannot delete the account (sole_owner).
 */

export const MAX_HANDOVERS = 50;
/** S1c: above this many solo events the account delete removes them one event per batch before the final batch (review N-14). */
export const SOLO_CHUNK_THRESHOLD = 20;
/** At most this many solo events are removed in one request (a free-tier Worker allows about 50 subrequests and each batch is one). */
export const SOLO_PER_REQUEST = 35;

/** The id of a user's personal organisation. The ONLY place outside src/policy and the backfill that builds an organisation id from a user id. */
export const personalOrgId = (userId: string): string => "org-" + userId;

export interface SharedEvent { id: string; name: string; slug: string; newOwnerId: string | null; newOwnerName: string | null; hasConflict: boolean }
export interface Handover {
  id: string;
  name: string;
  slug: string;
  newOwnerId: string;
  newOwnerName: string;
  /** E2: the event stays in its team organisation (its org_id is not touched). */
  keepOrg?: boolean;
}
export interface HandoverPlan {
  /** More than MAX_HANDOVERS events are shared with other people. */
  tooMany: boolean;
  handovers: Handover[];
  conflicts: { id: string; name: string; slug: string; newOwnerName: string }[];
  /** Events with viewers but no editor: deleted only on explicit confirmation. */
  needDeleteConfirmation: { id: string; name: string }[];
}

export async function planOwnershipHandover(db: D1Database, userId: string): Promise<HandoverPlan> {
  // One CTE row per event the leaver created: the candidate is the earliest other admin when the event lives in a team organisation (E2),
  // otherwise the earliest editor guest (S1). An event is "shared" when it has a guest of any kind or a candidate.
  const rows = await db.prepare(
    `WITH c AS (
       SELECT e.id AS id, e.name AS name, e.slug AS slug, e.created_at AS created_at,
         EXISTS (SELECT 1 FROM organisations t WHERE t.id = e.org_id AND t.kind = 'team') AS team_org,
         EXISTS (SELECT 1 FROM event_members o WHERE o.event_id = e.id AND o.user_id <> ?1) AS has_guests,
         CASE WHEN EXISTS (SELECT 1 FROM organisations t WHERE t.id = e.org_id AND t.kind = 'team')
           THEN (SELECT a.user_id FROM org_members a WHERE a.org_id = e.org_id AND a.role = 'admin' AND a.user_id <> ?1 ORDER BY a.added_at, a.user_id LIMIT 1)
           ELSE (SELECT m.user_id FROM event_members m WHERE m.event_id = e.id AND m.role = 'editor' AND m.user_id <> ?1 ORDER BY m.added_at, m.user_id LIMIT 1)
         END AS new_owner_id
       FROM events e WHERE e.owner_id = ?1)
     SELECT c.id AS id, c.name AS name, c.slug AS slug, c.team_org AS team_org, c.new_owner_id AS new_owner_id,
       (SELECT u.name FROM users u WHERE u.id = c.new_owner_id) AS new_owner_name,
       EXISTS (SELECT 1 FROM events x WHERE x.slug = c.slug AND x.owner_id = c.new_owner_id) AS has_conflict
     FROM c WHERE c.has_guests = 1 OR c.new_owner_id IS NOT NULL
     ORDER BY c.created_at, c.id LIMIT ?2`,
  ).bind(userId, MAX_HANDOVERS + 1).all<{ id: string; name: string; slug: string; team_org: number; new_owner_id: string | null; new_owner_name: string | null; has_conflict: number }>();
  const plan: HandoverPlan = { tooMany: rows.results.length > MAX_HANDOVERS, handovers: [], conflicts: [], needDeleteConfirmation: [] };
  for (const r of rows.results.slice(0, MAX_HANDOVERS)) {
    if (!r.new_owner_id) plan.needDeleteConfirmation.push({ id: r.id, name: r.name });
    else if (r.has_conflict) plan.conflicts.push({ id: r.id, name: r.name, slug: r.slug, newOwnerName: r.new_owner_name ?? "Your co-organiser" });
    else plan.handovers.push({ id: r.id, name: r.name, slug: r.slug, newOwnerId: r.new_owner_id, newOwnerName: r.new_owner_name ?? "Your co-organiser", keepOrg: !!r.team_org });
  }
  return plan;
}

export interface OrgExitPlan {
  /** Team organisations where the leaver is the last admin and other people, or other people's events, depend on them: the delete is refused (sole_owner). */
  blocked: { id: string; name: string }[];
  /** Team organisations nobody else belongs to and no one else's event uses: deleted with the account. */
  soleTeamOrgIds: string[];
}

/** E2 read: what leaving every team organisation means for this user. Constant SQL, at most 20 organisations looked at. */
export async function planOrgExit(db: D1Database, userId: string): Promise<OrgExitPlan> {
  const rows = await db.prepare(
    `SELECT o.id AS id, o.name AS name, m.role AS role,
       (SELECT COUNT(*) FROM org_members a WHERE a.org_id = o.id AND a.role = 'admin' AND a.user_id <> ?1) AS other_admins,
       (SELECT COUNT(*) FROM org_members a WHERE a.org_id = o.id AND a.user_id <> ?1) AS other_members,
       (SELECT COUNT(*) FROM events x WHERE x.org_id = o.id AND x.owner_id <> ?1) AS other_events
     FROM org_members m JOIN organisations o ON o.id = m.org_id WHERE m.user_id = ?1 AND o.kind = 'team' LIMIT 20`,
  ).bind(userId).all<{ id: string; name: string; role: string; other_admins: number; other_members: number; other_events: number }>();
  const plan: OrgExitPlan = { blocked: [], soleTeamOrgIds: [] };
  for (const r of rows.results) {
    const dependants = r.other_members > 0 || r.other_events > 0;
    if (r.role === "admin" && r.other_admins === 0 && dependants) plan.blocked.push({ id: r.id, name: r.name });
    else if (!dependants) plan.soleTeamOrgIds.push(r.id);
  }
  return plan;
}

/** S1c: the leaver's events that no one can take over (everything not in `handedOverIds`), oldest first. The typed confirmation repeats the count. */
export async function soloEvents(db: D1Database, userId: string, handedOverIds: readonly string[]): Promise<{ id: string; name: string }[]> {
  const rows = await db.prepare("SELECT id, name FROM events WHERE owner_id = ?1 AND id NOT IN (SELECT value FROM json_each(?2)) ORDER BY created_at, id").bind(userId, JSON.stringify(handedOverIds)).all<{ id: string; name: string }>();
  return rows.results;
}

/**
 * E1 seam: an event handed over inside a personal organisation moves to the new owner's personal organisation (the old one is deleted with the leaver).
 * The subselect answers NULL when that organisation does not exist (an account from before the backfill), so the foreign key can never fail here.
 * E2: an event of a team organisation keeps its org_id.
 */
export function extraPerHandover(db: D1Database, h: Handover): D1PreparedStatement[] {
  if (h.keepOrg) return [];
  return [db.prepare("UPDATE events SET org_id = (SELECT id FROM organisations WHERE id = ?1) WHERE id = ?2 AND owner_id = ?3").bind(personalOrgId(h.newOwnerId), h.id, h.newOwnerId)];
}

/**
 * Seam run after the user delete, in the same batch: the leaver's personal organisation (E1) and the team organisations nobody else depends on (E2).
 * Deliberately NOT guarded by "nothing references it": a foreign key that still points at the organisation (a stray event) refuses the batch, which rolls
 * back whole, and the route answers 409 ownership_conflict (review N-15). The membership rows were removed by the user delete cascade.
 */
export function afterUserDelete(db: D1Database, userId: string, soleTeamOrgIds: readonly string[] = []): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM organisations WHERE id = ?1 AND kind = 'personal'").bind(personalOrgId(userId)),
    ...soleTeamOrgIds.map((id) => db.prepare("DELETE FROM organisations WHERE id = ?1 AND kind = 'team'").bind(id)),
  ];
}

/** Four statements per handed-over event (five in a personal organisation), each guarded by the old owner id, so a concurrent change makes them no-ops. */
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
