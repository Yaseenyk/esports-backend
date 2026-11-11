/**
 * Hand-written oracle (blueprint 6.3 item 2, dev B-16): principal x method x capability -> 200 | 403 | 404, written by a person from the blueprint tables.
 * It deliberately imports NOTHING from src/policy, so the role table cannot be checked against itself.
 */
export interface Facts {
  is_creator: 0 | 1;
  org_id: string | null;
  org_status: string | null;
  org_role: "admin" | "member" | null;
  guest_role: "editor" | "viewer" | null;
}

const none = { is_creator: 0, org_id: "org-o", org_status: "active", org_role: null, guest_role: null } as const;

export const PRINCIPALS: Record<string, Facts> = {
  // today's world after the backfill: the creator is admin of their personal organisation
  owner: { is_creator: 1, org_id: "org-o", org_status: "active", org_role: "admin", guest_role: null },
  editor: { ...none, guest_role: "editor" },
  viewer: { ...none, guest_role: "viewer" },
  stranger: { ...none },
  // team organisation members who are not guests
  orgAdmin: { ...none, org_id: "org-t", org_role: "admin" },
  orgMember: { ...none, org_id: "org-t", org_role: "member" },
  orgMemberAndViewerGuest: { ...none, org_id: "org-t", org_role: "member", guest_role: "viewer" },
  orgAdminAndViewerGuest: { ...none, org_id: "org-t", org_role: "admin", guest_role: "viewer" },
  // created the event, then was removed from the team organisation
  removedCreator: { is_creator: 1, org_id: "org-t", org_status: "active", org_role: null, guest_role: null },
  // an event an old Worker inserted during a deploy overlap: no organisation yet
  creatorNullOrg: { is_creator: 1, org_id: null, org_status: null, org_role: null, guest_role: null },
  guestNullOrg: { is_creator: 0, org_id: null, org_status: null, org_role: null, guest_role: "editor" },
  // org_id points at an organisation row that does not exist
  creatorMissingOrg: { is_creator: 1, org_id: "org-gone", org_status: null, org_role: null, guest_role: null },
};

export type Cap = "event.delete" | "event.members.manage" | "passes.read" | "secrets.read" | "checkins.reset" | "people.export" | "-";

/** [principal, mode, method, capability ("-" = just reach the event), expected status]. */
export const EVENT_ORACLE: [string, "legacy" | "org", string, Cap, 200 | 403 | 404][] = [
  ["owner", "legacy", "GET", "-", 200],
  ["owner", "legacy", "PUT", "-", 200],
  ["owner", "legacy", "DELETE", "event.delete", 200],
  ["owner", "legacy", "GET", "event.members.manage", 200],
  ["owner", "legacy", "GET", "passes.read", 200],
  ["owner", "legacy", "GET", "people.export", 200],
  ["editor", "legacy", "GET", "-", 200],
  ["editor", "legacy", "PUT", "-", 200],
  ["editor", "legacy", "DELETE", "event.delete", 403],
  ["editor", "legacy", "POST", "event.members.manage", 403],
  ["editor", "legacy", "GET", "passes.read", 200],
  ["editor", "legacy", "GET", "secrets.read", 200],
  ["editor", "legacy", "DELETE", "checkins.reset", 200], // today yes; Phase 2a flips this row
  ["editor", "legacy", "POST", "people.export", 403],
  ["viewer", "legacy", "GET", "-", 200],
  ["viewer", "legacy", "PUT", "-", 403],
  ["viewer", "legacy", "DELETE", "event.delete", 403],
  ["viewer", "legacy", "GET", "passes.read", 403],
  ["viewer", "legacy", "GET", "secrets.read", 403],
  ["viewer", "legacy", "GET", "checkins.reset", 403],
  ["stranger", "legacy", "GET", "-", 404],
  ["stranger", "legacy", "PUT", "-", 404],
  ["stranger", "legacy", "DELETE", "event.delete", 404],
  ["stranger", "org", "GET", "-", 404],
  ["orgAdmin", "legacy", "GET", "-", 404], // legacy knows nothing of organisations
  ["orgAdmin", "org", "GET", "-", 200],
  ["orgAdmin", "org", "DELETE", "event.delete", 200],
  ["orgAdmin", "org", "POST", "event.members.manage", 200],
  ["orgMember", "legacy", "GET", "-", 404],
  ["orgMember", "org", "GET", "-", 200],
  ["orgMember", "org", "PUT", "-", 200],
  ["orgMember", "org", "DELETE", "event.delete", 403],
  ["orgMember", "org", "POST", "event.members.manage", 403],
  ["orgMember", "org", "POST", "people.export", 403],
  ["orgMember", "org", "DELETE", "checkins.reset", 200],
  ["removedCreator", "legacy", "GET", "-", 200],
  ["removedCreator", "org", "GET", "-", 404], // a removed club member loses access on the very next request
  ["removedCreator", "org", "DELETE", "event.delete", 404],
  ["creatorNullOrg", "org", "GET", "-", 200], // never a 404 for the creator of an event with no organisation yet
  ["creatorNullOrg", "org", "DELETE", "event.delete", 200],
  ["guestNullOrg", "org", "PUT", "-", 200],
  ["creatorMissingOrg", "org", "GET", "-", 200], // a dangling org_id behaves like NULL
  ["orgMemberAndViewerGuest", "org", "PUT", "-", 200], // an explicit viewer grant never lowers an org role
  ["orgAdminAndViewerGuest", "org", "DELETE", "event.delete", 200],
  ["viewer", "org", "PUT", "-", 403],
  ["editor", "org", "DELETE", "event.delete", 403],
  ["editor", "org", "GET", "secrets.read", 200],
];

export type OrgCapName = "org.read" | "org.people.manage" | "org.events.create" | "org.audit.read";

/** [org role or null (not a member), capability, allowed]. */
export const ORG_ORACLE: ["admin" | "member" | null, OrgCapName, boolean][] = [
  ["admin", "org.read", true],
  ["member", "org.read", true],
  [null, "org.read", false],
  ["admin", "org.people.manage", true],
  ["member", "org.people.manage", false],
  ["admin", "org.events.create", true],
  ["member", "org.events.create", true],
  ["admin", "org.audit.read", true],
  ["member", "org.audit.read", false],
  [null, "org.events.create", false],
];

/** The ten names, exactly. A new capability needs a row above, a golden entry and a reviewer. */
export const TEN_CAPS = [
  "event.delete", "event.members.manage", "passes.read", "secrets.read", "checkins.reset", "people.export",
  "org.read", "org.people.manage", "org.events.create", "org.audit.read",
];
