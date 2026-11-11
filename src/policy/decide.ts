import type { EventCap } from "./caps";
import { actsAs, eventRoleCan, isEventRole, isOrgRole, maxRole, type EventRole, type GuestRole, type OrgRole } from "./roles";

/**
 * The decision function (blueprint 5.2, 6.3 item 3). PURE: no D1, no clock, no flags. Both decisions are computed from one row of facts, so shadow
 * mode costs no extra query.
 */
export type DecideMode = "legacy" | "org";

/** What the access query returns about one (user, event) pair. */
export interface AccessFacts {
  /** events.owner_id equals the caller (1 or 0, or a boolean). */
  is_creator: number | boolean;
  /** events.org_id; null when not yet filled. */
  org_id: string | null;
  /** organisations.status through a LEFT JOIN: null when the organisation row does not exist (then the event behaves like org_id NULL). */
  org_status: string | null;
  /** The caller's org_members role in events.org_id, or null. */
  org_role: OrgRole | string | null;
  /** The caller's event_members role on this event, or null. */
  guest_role: GuestRole | string | null;
}

/** The role the caller holds on the event, or null for "no access" (answered as 404, never revealing existence). */
export type Role = EventRole | null;

/** Today's rule: the creator is the owner, else the guest role, else nothing. */
function legacyRole(f: AccessFacts): Role {
  if (f.is_creator) return "owner";
  return (f.guest_role as EventRole | null) ?? null;
}

/**
 * `legacy`: today. `org`: with no organisation (org_id NULL, or pointing at a missing organisation) the legacy rule; otherwise the higher of the
 * organisation role (admin acts as owner, member as editor) and the guest role. The creator branch is ignored when org_id is set and the creator is
 * not a member, so a removed club member loses access on the next request.
 */
export function decide(mode: DecideMode, f: AccessFacts): Role {
  if (mode === "legacy") return legacyRole(f);
  if (f.org_id == null || f.org_status == null) return legacyRole(f);
  const fromOrg = isOrgRole(f.org_role) ? actsAs(f.org_role) : null;
  return maxRole(fromOrg, f.guest_role);
}

/** A viewer may only read: any other method is refused with 403. */
export const viewerBlocked = (role: Role, method: string): boolean => role === "viewer" && method !== "GET";

export type Verdict = 200 | 403 | 404;

/** One full authorisation: role from the facts, the viewer method gate, and optionally a named capability. 404 first, then 403. */
export function authorise(mode: DecideMode, f: AccessFacts, method: string, cap?: EventCap): Verdict {
  const role = decide(mode, f);
  if (role === null || !isEventRole(role)) return 404;
  if (viewerBlocked(role, method)) return 403;
  if (cap && !eventRoleCan(role, cap)) return 403;
  return 200;
}
