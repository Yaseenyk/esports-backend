/**
 * The closed list of named capabilities (blueprint 6.1). It replaces the 70-permission catalogue: the owner / editor / viewer ladder carries everything
 * else, and these ten names carry the exceptions. Adding one needs a row in test/policy.oracle.ts, a golden entry and a reviewer.
 *
 * Event scope (decided from the caller's role on one event) and organisation scope (decided from the caller's role in one organisation).
 */
export const EVENT_CAPS = ["event.delete", "event.members.manage", "passes.read", "secrets.read", "checkins.reset", "people.export"] as const;
export const ORG_CAPS = ["org.read", "org.people.manage", "org.events.create", "org.audit.read"] as const;

export type EventCap = (typeof EVENT_CAPS)[number];
export type OrgCap = (typeof ORG_CAPS)[number];
export type Capability = EventCap | OrgCap;

export const ALL_CAPS: readonly Capability[] = [...EVENT_CAPS, ...ORG_CAPS];
