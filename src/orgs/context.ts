import { HttpError, type Ctx } from "../http";
import { ORG_ROLE_CAPS, type OrgRole } from "../policy/roles";
import { planOrgExit, planOwnershipHandover, soloEvents, SOLO_CHUNK_THRESHOLD } from "../ownership";
import { teamOrgsOn } from "./access";

/**
 * GET /me/context (blueprint 11.2). Always works, whatever the flags say; it is how the shell learns whether the club screens exist.
 * `staff` is always null here: staff identity lives on /admin/v1 and never on a user token.
 */
export async function meContext(c: Ctx): Promise<Response> {
  const uid = c.get("userId");
  const db = c.env.DB;
  const [u, orgs, teamOrgs] = await Promise.all([
    db.prepare("SELECT id, email, name, email_verified_at, verify_required FROM users WHERE id = ?1").bind(uid).first<{ id: string; email: string; name: string; email_verified_at: string | null; verify_required: number }>(),
    db
      .prepare("SELECT o.id AS id, o.name AS name, o.kind AS kind, o.status AS status, m.role AS role FROM org_members m JOIN organisations o ON o.id = m.org_id WHERE m.user_id = ?1 ORDER BY m.added_at, o.id LIMIT 10")
      .bind(uid)
      .all<{ id: string; name: string; kind: string; status: string; role: OrgRole }>(),
    teamOrgsOn(db),
  ]);
  if (!u) throw new HttpError(401, "Authentication required");
  c.header("cache-control", "private, no-store");
  return c.json({
    user: { id: u.id, email: u.email, name: u.name, emailVerified: !!u.email_verified_at, verifyRequired: u.verify_required === 1 && !u.email_verified_at },
    orgs: orgs.results.map((o) => ({ id: o.id, name: o.name, kind: o.kind, status: o.status, role: o.role, caps: [...(ORG_ROLE_CAPS[o.role] ?? [])] })),
    staff: null,
    features: { teamOrgs },
  });
}

/**
 * GET /me/deletion-preview (privacy minimum, PM N3). What deleting the account would do, in the words the confirmation screen needs: the events that
 * go with the account, the events that are handed over (and to whom), the clubs that block it. Read only; nothing is changed. Always works.
 */
export async function deletionPreview(c: Ctx): Promise<Response> {
  const uid = c.get("userId");
  const db = c.env.DB;
  const [plan, exit] = await Promise.all([planOwnershipHandover(db, uid), planOrgExit(db, uid)]);
  const solo = await soloEvents(db, uid, plan.handovers.map((h) => h.id));
  c.header("cache-control", "private, no-store");
  return c.json({
    events: {
      deleted: solo.slice(0, 50).map((e) => ({ id: e.id, name: e.name })),
      deletedCount: solo.length,
      needsTypedCount: solo.length > SOLO_CHUNK_THRESHOLD,
      handedOver: plan.handovers.map((h) => ({ id: h.id, name: h.name, newOwnerName: h.newOwnerName })),
      conflicts: plan.conflicts.map((e) => ({ id: e.id, name: e.name, newOwnerName: e.newOwnerName })),
      needDeleteConfirmation: plan.needDeleteConfirmation.map((e) => ({ id: e.id, name: e.name })),
      tooManyShared: plan.tooMany,
    },
    clubs: { blocking: exit.blocked, deletedWithAccount: exit.soleTeamOrgIds.length },
  });
}
