import { describe, expect, it } from "vitest";
import { canChangeOrgRole, canGrantGuestRole, canGrantOrgRole, canManageOrgPeople, canRemoveOrgMember } from "../../src/policy/roles";

describe("escalation table", () => {
  it("a member (or a non-member) cannot invite, an admin can", () => {
    expect(canManageOrgPeople("member")).toBe(false);
    expect(canManageOrgPeople(null)).toBe(false);
    expect(canManageOrgPeople("admin")).toBe(true);
    expect(canGrantOrgRole("member", "member")).toBe(false);
    expect(canGrantOrgRole("member", "admin")).toBe(false);
    expect(canGrantOrgRole(null, "member")).toBe(false);
    expect(canGrantOrgRole("admin", "member")).toBe(true);
  });

  it("an admin cannot grant a role that does not exist above their own", () => {
    expect(canGrantOrgRole("admin", "owner" as never)).toBe(false);
    expect(canGrantOrgRole("admin", "root" as never)).toBe(false);
  });

  it("nobody changes their own role", () => {
    expect(canChangeOrgRole({ actorId: "u1", actor: "admin", targetId: "u1", to: "member" })).toBe(false);
    expect(canChangeOrgRole({ actorId: "u1", actor: "member", targetId: "u1", to: "admin" })).toBe(false);
    expect(canChangeOrgRole({ actorId: "u1", actor: "admin", targetId: "u2", to: "member" })).toBe(true);
    expect(canChangeOrgRole({ actorId: "u1", actor: "member", targetId: "u2", to: "member" })).toBe(false);
  });

  it("the last admin cannot leave or be removed; others can leave; only an admin removes others", () => {
    const base = { actorId: "u1", targetId: "u1", targetRole: "admin" as const };
    expect(canRemoveOrgMember({ ...base, actor: "admin", adminCount: 1 })).toBe(false); // sole admin leaving
    expect(canRemoveOrgMember({ ...base, actor: "admin", adminCount: 2 })).toBe(true);
    expect(canRemoveOrgMember({ actorId: "u2", actor: "admin", targetId: "u1", targetRole: "admin", adminCount: 1 })).toBe(false);
    expect(canRemoveOrgMember({ actorId: "u2", actor: "admin", targetId: "u3", targetRole: "member", adminCount: 1 })).toBe(true);
    expect(canRemoveOrgMember({ actorId: "u3", actor: "member", targetId: "u3", targetRole: "member", adminCount: 1 })).toBe(true); // leave
    expect(canRemoveOrgMember({ actorId: "u3", actor: "member", targetId: "u4", targetRole: "member", adminCount: 1 })).toBe(false);
    expect(canRemoveOrgMember({ actorId: "x", actor: null, targetId: "u4", targetRole: "member", adminCount: 2 })).toBe(false);
  });

  it("event guests: only an owner grants, only editor or viewer, never owner", () => {
    expect(canGrantGuestRole("owner", "editor")).toBe(true);
    expect(canGrantGuestRole("owner", "viewer")).toBe(true);
    expect(canGrantGuestRole("owner", "owner")).toBe(false);
    expect(canGrantGuestRole("editor", "viewer")).toBe(false);
    expect(canGrantGuestRole("viewer", "viewer")).toBe(false);
    expect(canGrantGuestRole(null, "viewer")).toBe(false);
  });
});
