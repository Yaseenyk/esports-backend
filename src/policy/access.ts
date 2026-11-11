import { getAuthzMode } from "../flags";
import { HttpError, type Ctx } from "../http";
import type { EventRow } from "../types";
import { decide, viewerBlocked, type AccessFacts } from "./decide";
import { eventRoleCan, type EventRole } from "./roles";
import type { EventCap } from "./caps";
import { shadowCompare } from "./shadow";

/**
 * The access layer (blueprint 5.2). The ONLY place that turns "this user, that event" into a role.
 *
 *  - legacy (DEFAULT, and any flag problem): exactly today's query and today's answers. Not one extra query beyond the 10-second cached flag read.
 *  - shadow: the access query below is run once, legacy is enforced, org is computed from the same row, a difference is logged and counted (shadow.ts).
 *  - org: the org decision is enforced. org_id NULL (or pointing at a missing organisation) falls back to the legacy rule, so an old Worker's insert during
 *    a deploy overlap is never a 404 for its creator.
 *
 * org_id is NEVER written here: the blueprint (A-17, T-20) withdrew heal-on-read. Healing is the one-off backfill (migrations-deferred/0042) plus the
 * daily invariant, never a read-path write.
 */
export type EventAccess = EventRow & { my_role: EventRole };

/** Today's SQL, unchanged. */
export const LEGACY_ACCESS_SQL =
  "SELECT e.*, CASE WHEN e.owner_id = ?1 THEN 'owner' ELSE m.role END AS my_role FROM events e LEFT JOIN event_members m ON m.event_id = e.id AND m.user_id = ?1 WHERE e.id = ?2 AND (e.owner_id = ?1 OR m.user_id = ?1)";

/** The org-aware access query (blueprint 5.2): one round trip, constant SQL, LEFT JOINs, explicit creator branch. */
export const ACCESS_SQL =
  "SELECT e.*, o.status AS org_status, om.role AS org_role, em.role AS guest_role, CASE WHEN e.owner_id = ?1 THEN 1 ELSE 0 END AS is_creator FROM events e LEFT JOIN organisations o ON o.id = e.org_id LEFT JOIN org_members om ON om.org_id = e.org_id AND om.user_id = ?1 LEFT JOIN event_members em ON em.event_id = e.id AND em.user_id = ?1 WHERE e.id = ?2 AND (e.owner_id = ?1 OR om.user_id IS NOT NULL OR em.user_id IS NOT NULL)";

type AccessRow = EventRow & AccessFacts & { org_id: string | null };

const NOT_FOUND = "Event not found";

/** Drops the join columns and adds my_role: the same shape the legacy query returned (plus the events table's own columns). */
function toAccess(row: AccessRow, role: EventRole): EventAccess {
  const { org_status: _s, org_role: _r, guest_role: _g, is_creator: _c, ...ev } = row;
  void _s; void _r; void _g; void _c;
  return { ...(ev as EventRow), my_role: role };
}

async function legacyLoad(c: Ctx, id: string): Promise<EventAccess> {
  const row = await c.env.DB.prepare("SELECT e.*, CASE WHEN e.owner_id = ?1 THEN 'owner' ELSE m.role END AS my_role FROM events e LEFT JOIN event_members m ON m.event_id = e.id AND m.user_id = ?1 WHERE e.id = ?2 AND (e.owner_id = ?1 OR m.user_id = ?1)").bind(c.get("userId"), id).first<EventAccess>();
  if (!row) throw new HttpError(404, NOT_FOUND);
  return row;
}

/** Loads the event for the signed-in user with their role, or 404 (never reveals existence). Does not apply the viewer method gate. */
export async function resolveEvent(c: Ctx, id: string): Promise<EventAccess> {
  const mode = await getAuthzMode(c.env.DB);
  if (mode === "legacy") return legacyLoad(c, id);

  const uid = c.get("userId");
  let row: AccessRow | null;
  try {
    row = await c.env.DB.prepare("SELECT e.*, o.status AS org_status, om.role AS org_role, em.role AS guest_role, CASE WHEN e.owner_id = ?1 THEN 1 ELSE 0 END AS is_creator FROM events e LEFT JOIN organisations o ON o.id = e.org_id LEFT JOIN org_members om ON om.org_id = e.org_id AND om.user_id = ?1 LEFT JOIN event_members em ON em.event_id = e.id AND em.user_id = ?1 WHERE e.id = ?2 AND (e.owner_id = ?1 OR om.user_id IS NOT NULL OR em.user_id IS NOT NULL)").bind(uid, id).first<AccessRow>();
  } catch (e) {
    if (mode === "shadow") return legacyLoad(c, id); // org tables not there yet: shadow must never change the result
    throw e;
  }
  if (!row) throw new HttpError(404, NOT_FOUND);

  if (mode === "shadow") {
    shadowCompare(c, { facts: row, userId: uid, eventId: id });
    const role = decide("legacy", row);
    if (!role) throw new HttpError(404, NOT_FOUND); // an org-only member: legacy answers 404
    return toAccess(row, role);
  }
  const role = decide("org", row);
  if (!role) throw new HttpError(404, NOT_FOUND);
  return toAccess(row, role);
}

/** The viewer method gate, as the legacy accessibleEvent applied it. */
export function enforceMethod(ev: { my_role: EventRole }, method: string): void {
  if (viewerBlocked(ev.my_role, method)) throw new HttpError(403, "You can view this event but not change it");
}

/** Requires a named capability on an already loaded event. `message` keeps each route's existing wording. */
export function requireCap(ev: { my_role: EventRole }, cap: EventCap, message: string): void {
  if (!eventRoleCan(ev.my_role, cap)) throw new HttpError(403, message);
}

/** True for a view-only member (replaces direct `my_role === 'viewer'` checks in modules as they are converted). */
export const isViewer = (ev: { my_role: EventRole }): boolean => ev.my_role === "viewer";
