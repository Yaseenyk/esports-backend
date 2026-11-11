import { describe, expect, it } from "vitest";
import { ALL_CAPS, EVENT_CAPS, ORG_CAPS } from "../../src/policy/caps";
import { authorise, decide } from "../../src/policy/decide";
import { orgRoleCan } from "../../src/policy/roles";
import { EVENT_ORACLE, ORG_ORACLE, PRINCIPALS, TEN_CAPS } from "../policy.oracle";

describe("policy oracle (hand-written, independent of the role table)", () => {
  it("has about 40 event rows and every named capability appears in at least one", () => {
    expect(EVENT_ORACLE.length).toBeGreaterThanOrEqual(40);
    for (const cap of EVENT_CAPS) expect(EVENT_ORACLE.some((r) => r[3] === cap), cap).toBe(true);
  });

  it.each(EVENT_ORACLE.map((r, i) => [i, ...r] as const))("row %i: %s in %s mode, %s, cap %s -> %i", (_i, who, mode, method, cap, expected) => {
    const facts = PRINCIPALS[who]!;
    expect(authorise(mode, facts, method, cap === "-" ? undefined : cap)).toBe(expected);
  });

  it.each(ORG_ORACLE)("org role %s, %s -> %s", (role, cap, allowed) => {
    expect(orgRoleCan(role, cap)).toBe(allowed);
  });

  it("the capability list is closed at exactly the ten names", () => {
    expect([...ALL_CAPS].sort()).toEqual([...TEN_CAPS].sort());
    expect(EVENT_CAPS.length + ORG_CAPS.length).toBe(10);
  });

  it("a stranger is never anything but 404, in every mode, whatever the method or capability", () => {
    for (const mode of ["legacy", "org"] as const) {
      for (const method of ["GET", "PUT", "POST", "DELETE"]) {
        for (const cap of [undefined, ...EVENT_CAPS]) expect(authorise(mode, PRINCIPALS.stranger!, method, cap)).toBe(404);
      }
    }
  });

  it("the viewer gate is by method: a viewer may GET and nothing else, in both modes", () => {
    for (const mode of ["legacy", "org"] as const) {
      expect(authorise(mode, PRINCIPALS.viewer!, "GET")).toBe(200);
      for (const m of ["POST", "PUT", "PATCH", "DELETE"]) expect(authorise(mode, PRINCIPALS.viewer!, m)).toBe(403);
    }
  });

  it("decide is pure: the same facts give the same answer and the facts object is not mutated", () => {
    const f = { ...PRINCIPALS.orgMemberAndViewerGuest! };
    const snapshot = JSON.stringify(f);
    expect(decide("org", f)).toBe(decide("org", f));
    expect(JSON.stringify(f)).toBe(snapshot);
  });

  it("garbage role values never grant access", () => {
    expect(decide("org", { is_creator: 0, org_id: "org-x", org_status: "active", org_role: "root", guest_role: "god" })).toBeNull();
  });
});
