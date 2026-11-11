import type { EventCap, OrgCap } from "./caps";

/** Event roles are today's ladder. A viewer is a guest only. */
export type EventRole = "owner" | "editor" | "viewer";
/** Guest roles stored in event_members. */
export type GuestRole = "editor" | "viewer";
/** Organisation roles stored in org_members. `admin` acts as event owner on every event of the organisation, `member` as editor. */
export type OrgRole = "admin" | "member";

export const EVENT_RANK: Readonly<Record<EventRole, number>> = { viewer: 1, editor: 2, owner: 3 };
export const ORG_TO_EVENT: Readonly<Record<OrgRole, EventRole>> = { admin: "owner", member: "editor" };

export const isEventRole = (v: unknown): v is EventRole => v === "owner" || v === "editor" || v === "viewer";
export const isOrgRole = (v: unknown): v is OrgRole => v === "admin" || v === "member";

/** The higher of two event roles; null when neither applies. An unknown value counts as no role. */
export function maxRole(a: string | null | undefined, b: string | null | undefined): EventRole | null {
  const ra = isEventRole(a) ? a : null;
  const rb = isEventRole(b) ? b : null;
  if (!ra) return rb;
  if (!rb) return ra;
  return EVENT_RANK[ra] >= EVENT_RANK[rb] ? ra : rb;
}

/**
 * Role table for event capabilities. Today's behaviour: the owner does everything; an editor reads passes and secrets and may reset check-ins
 * (checkins.reset goes to owner-only from Phase 2a); a viewer holds none of the ten and is also blocked from every non-GET method (see decide.ts).
 */
export const EVENT_ROLE_CAPS: Readonly<Record<EventRole, readonly EventCap[]>> = {
  owner: ["event.delete", "event.members.manage", "passes.read", "secrets.read", "checkins.reset", "people.export"],
  editor: ["passes.read", "secrets.read", "checkins.reset"],
  viewer: [],
};

export const ORG_ROLE_CAPS: Readonly<Record<OrgRole, readonly OrgCap[]>> = {
  admin: ["org.read", "org.people.manage", "org.events.create", "org.audit.read"],
  member: ["org.read", "org.events.create"],
};

export const eventRoleCan = (role: EventRole | null, cap: EventCap): boolean => !!role && EVENT_ROLE_CAPS[role].includes(cap);
export const orgRoleCan = (role: OrgRole | null, cap: OrgCap): boolean => !!role && ORG_ROLE_CAPS[role].includes(cap);

/** What an organisation role acts as on the events of its organisation. */
export const actsAs = (role: OrgRole): EventRole => ORG_TO_EVENT[role];

// ---- escalation rules (pure; the organisation routes of Phase 2a call these) ----

/** Only an admin invites, changes roles or removes people. A member cannot. */
export const canManageOrgPeople = (actor: OrgRole | null): boolean => orgRoleCan(actor, "org.people.manage");

/** An admin may grant either organisation role (never above their own: there is nothing above admin); a member and a non-member may grant nothing. */
export function canGrantOrgRole(actor: OrgRole | null, granted: OrgRole): boolean {
  if (!canManageOrgPeople(actor)) return false;
  return isOrgRole(granted);
}

/** Changing a role: admin only, and nobody changes their own role (an admin cannot demote themselves into a last-admin-less club by accident). */
export function canChangeOrgRole(a: { actorId: string; actor: OrgRole | null; targetId: string; to: OrgRole }): boolean {
  if (a.actorId === a.targetId) return false;
  return canGrantOrgRole(a.actor, a.to);
}

/**
 * Removing a member, or leaving. Anyone may leave, except the last admin of an organisation (409 sole_owner in the API).
 * Removing someone else needs admin, and the last admin cannot be removed either.
 */
export function canRemoveOrgMember(a: { actorId: string; actor: OrgRole | null; targetId: string; targetRole: OrgRole; adminCount: number }): boolean {
  if (a.actor === null) return false;
  const lastAdmin = a.targetRole === "admin" && a.adminCount <= 1;
  if (lastAdmin) return false;
  if (a.actorId === a.targetId) return true;
  return canManageOrgPeople(a.actor);
}

/** Event guests: only an owner (or org admin) grants, and only editor or viewer: nobody grants owner. */
export const canGrantGuestRole = (actor: EventRole | null, granted: string): boolean => eventRoleCan(actor, "event.members.manage") && (granted === "editor" || granted === "viewer");
