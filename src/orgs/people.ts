import { audit } from "../audit";
import { HttpError, readJson, type Ctx } from "../http";
import { canChangeOrgRole, canManageOrgPeople, canRemoveOrgMember, isOrgRole, ORG_ROLE_CAPS, type OrgRole } from "../policy/roles";
import { orgMembership, requireOrg } from "./access";

/**
 * People of one organisation (blueprint 11.4). Escalation rules come from src/policy/roles.ts (tested there); this file adds the 404/403/409 wording and the
 * race-proof SQL: the last-admin guard is inside the statement, so two admins leaving at once cannot leave a club with none.
 */

/** GET /orgs/:id: the organisation as the caller sees it. Capability org.read. */
export async function getOrg(c: Ctx): Promise<Response> {
  const id = c.req.param("id")!;
  const m = await requireOrg(c, id, "org.read");
  const n = await c.env.DB
    .prepare("SELECT o.created_at AS created_at, (SELECT COUNT(*) FROM org_members WHERE org_id = o.id) AS members, (SELECT COUNT(*) FROM events WHERE org_id = o.id) AS events FROM organisations o WHERE o.id = ?1")
    .bind(id)
    .first<{ created_at: string; members: number; events: number }>();
  c.header("cache-control", "private, no-store");
  return c.json({ id, name: m.name, kind: m.kind, status: m.status, role: m.role, caps: [...ORG_ROLE_CAPS[m.role]], createdAt: n?.created_at ?? null, counts: { members: n?.members ?? 0, events: n?.events ?? 0 } });
}

/** GET /orgs/:id/members. Capability org.read. Emails are shown to admins only. */
export async function listMembers(c: Ctx): Promise<Response> {
  const id = c.req.param("id")!;
  const m = await requireOrg(c, id, "org.read");
  const rows = await c.env.DB
    .prepare("SELECT m.user_id AS user_id, u.name AS name, u.email AS email, m.role AS role, m.added_at AS added_at FROM org_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ?1 ORDER BY m.added_at, m.user_id LIMIT 100")
    .bind(id)
    .all<{ user_id: string; name: string; email: string; role: string; added_at: string }>();
  const me = c.get("userId");
  c.header("cache-control", "private, no-store");
  return c.json({
    role: m.role,
    members: rows.results.map((r) => ({ userId: r.user_id, name: r.name, email: canManageOrgPeople(m.role) ? r.email : null, role: r.role, addedAt: r.added_at, isYou: r.user_id === me })),
  });
}

/** PUT /orgs/:id/members/:userId { role }. Capability org.people.manage; nobody changes their own role; the last admin stays an admin. */
export async function changeRole(c: Ctx): Promise<Response> {
  const id = c.req.param("id")!;
  const target = c.req.param("userId")!;
  const me = await requireOrg(c, id, "org.read", { write: true });
  const b = await readJson(c);
  if (!isOrgRole(b.role)) throw new HttpError(400, "role must be admin or member");
  const to: OrgRole = b.role;
  if (!canManageOrgPeople(me.role)) throw new HttpError(403, "Only a club admin can change roles");
  if (target === c.get("userId")) throw new HttpError(403, "You cannot change your own role. Ask another admin.", { code: "self_role_change" });
  if (!canChangeOrgRole({ actorId: c.get("userId"), actor: me.role, targetId: target, to })) throw new HttpError(403, "You cannot give that role");
  const cur = await c.env.DB.prepare("SELECT role FROM org_members WHERE org_id = ?1 AND user_id = ?2").bind(id, target).first<{ role: string }>();
  if (!cur) throw new HttpError(404, "That person is not in this club");
  if (cur.role === to) return c.json({ ok: true, role: to });
  // Demoting an admin needs another admin to remain (always true here because the caller is one, but the statement does not trust the read above).
  const r = await c.env.DB
    .prepare("UPDATE org_members SET role = ?1 WHERE org_id = ?2 AND user_id = ?3 AND (?1 = 'admin' OR role <> 'admin' OR (SELECT COUNT(*) FROM org_members WHERE org_id = ?2 AND role = 'admin' AND user_id <> ?3) >= 1)")
    .bind(to, id, target)
    .run();
  if ((r.meta.changes ?? 0) === 0) throw new HttpError(409, "A club needs at least one admin.", { code: "last_admin" });
  await audit(c.env.DB, { action: "member.role_changed", actorType: "user", actorId: c.get("userId"), orgId: id, targetType: "user", targetId: target, meta: { role: to, prev: cur.role as OrgRole } });
  return c.json({ ok: true, role: to });
}

/**
 * DELETE /orgs/:id/members/:userId. Capability org.people.manage, or yourself (leave). The last admin cannot leave (409 sole_owner, "hand over the club first").
 * Removing someone never touches who created an event: a removed creator keeps nothing in `org` mode and loses access on their very next request.
 * Reminder copies for the club's events stop at once (OD-AA); a person who is still an editor guest of an event is re-added by the next sync.
 */
export async function removeMember(c: Ctx): Promise<Response> {
  const id = c.req.param("id")!;
  const target = c.req.param("userId")!;
  const actorId = c.get("userId");
  const me = await requireOrg(c, id, "org.read", { write: true });
  const tm = target === actorId ? me : await orgMembership(c.env.DB, id, target);
  if (!tm) throw new HttpError(404, "That person is not in this club");
  const adminCount = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?1 AND role = 'admin'").bind(id).first<{ n: number }>())?.n ?? 0;
  const ok = canRemoveOrgMember({ actorId, actor: me.role, targetId: target, targetRole: tm.role, adminCount });
  if (!ok) {
    if (target === actorId || (tm.role === "admin" && adminCount <= 1)) {
      throw new HttpError(409, "You are the only admin of this club. Hand over the club first: make someone else an admin, then leave.", { code: "sole_owner" });
    }
    throw new HttpError(403, "Only a club admin can remove people");
  }
  const res = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM org_members WHERE org_id = ?1 AND user_id = ?2 AND (role <> 'admin' OR (SELECT COUNT(*) FROM org_members WHERE org_id = ?1 AND role = 'admin') > 1)").bind(id, target),
    c.env.DB.prepare("DELETE FROM reminder_recipients WHERE kind = 'organiser' AND changes() = 1 AND email = (SELECT email FROM users WHERE id = ?1) AND event_id IN (SELECT id FROM events WHERE org_id = ?2)").bind(target, id),
  ]);
  if ((res[0]!.meta.changes ?? 0) === 0) throw new HttpError(409, "A club needs at least one admin.", { code: "last_admin" });
  if (target === actorId) await audit(c.env.DB, { action: "member.left", actorType: "user", actorId, orgId: id, targetType: "user", targetId: actorId });
  else await audit(c.env.DB, { action: "member.removed", actorType: "user", actorId, orgId: id, targetType: "user", targetId: target });
  return c.json({ ok: true });
}
