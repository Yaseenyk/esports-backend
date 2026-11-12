import { getFlag } from "../flags";
import { HttpError, type Ctx } from "../http";
import { isOrgRole, orgRoleCan, type OrgRole } from "../policy/roles";
import type { OrgCap } from "../policy/caps";

/**
 * Organisation-scope access (the counterpart of src/policy/access.ts for events). A caller who is not a member of an organisation gets the same 404 as a
 * missing id (never reveals existence). Constant SQL only.
 */
export interface OrgMembership {
  name: string;
  kind: "personal" | "team";
  status: "active" | "suspended" | "pending_deletion";
  role: OrgRole;
}

/** The caller's membership in one organisation, or null (no such organisation, or not a member: indistinguishable). */
export async function orgMembership(db: D1Database, orgId: string, userId: string): Promise<OrgMembership | null> {
  const row = await db
    .prepare("SELECT o.name AS name, o.kind AS kind, o.status AS status, m.role AS role FROM organisations o JOIN org_members m ON m.org_id = o.id WHERE o.id = ?1 AND m.user_id = ?2")
    .bind(orgId, userId)
    .first<{ name: string; kind: OrgMembership["kind"]; status: OrgMembership["status"]; role: string }>();
  if (!row || !isOrgRole(row.role)) return null;
  return { name: row.name, kind: row.kind, status: row.status, role: row.role };
}

/** Flag orgs.team (10 s isolate cache). */
export const teamOrgsOn = (db: D1Database): Promise<boolean> => getFlag(db, "orgs.team");

/**
 * Loads the membership or answers 404; requires a named organisation capability (403 otherwise, the caller already knows the organisation exists).
 * `write` also refuses a suspended organisation (403 org_suspended): reads stay allowed for members (blueprint 5.1).
 */
export async function requireOrg(c: Ctx, orgId: string, cap: OrgCap, opts: { write?: boolean } = {}): Promise<OrgMembership> {
  const m = await orgMembership(c.env.DB, orgId, c.get("userId"));
  if (!m) throw new HttpError(404, "Not found");
  if (!orgRoleCan(m.role, cap)) throw new HttpError(403, "Only a club admin can do this");
  if (opts.write && m.status !== "active") throw new HttpError(403, "This club is paused, so it cannot be changed right now", { code: "org_suspended" });
  return m;
}
