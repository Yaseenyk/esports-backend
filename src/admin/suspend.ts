/**
 * Suspend and restore (blueprint 9.4, OD-P). Every action here is REVERSIBLE: there is no delete, erase or purge route in /admin/v1.
 *
 *  POST /admin/v1/users/:id/suspend   { reasonCode }   users.status active -> suspended   (requireUser then answers 401, /me explains)
 *  POST /admin/v1/users/:id/restore   { reasonCode }   suspended -> active                (pending_deletion is never touched here)
 *  POST /admin/v1/orgs/:id/suspend    { reasonCode }   organisations.status active -> suspended
 *  POST /admin/v1/orgs/:id/restore    { reasonCode }   suspended -> active
 *
 * Each needs a step-up code (403 `step_up_required` otherwise), a reason code (400 without), and writes ONE audit row in the same batch as the change.
 * Repeating the action on a target already in that state changes nothing and audits nothing (`changed: false`).
 * Staff may not suspend themselves or another active staff member (403 `protected_account`): staff removal is runbook SQL.
 * Enforcement on public pages and write routes belongs to the moderation join sweep; this file only moves the status.
 */
import { Hono } from "hono";
import { auditStmts, auditOff } from "../audit";
import { HttpError, ID_RE, readJson } from "../http";
import { reasonCodeOf } from "./flags";
import { requireStepUp, type ACtx, type AdminBindings } from "./session";

export const suspendRoutes = new Hono<AdminBindings>();

async function body(c: ACtx): Promise<{ id: string; reasonCode: ReturnType<typeof reasonCodeOf> }> {
  const id = c.req.param("id") ?? "";
  if (!ID_RE.test(id)) throw new HttpError(404, "Not found");
  const b = await readJson(c as never, 2048);
  return { id, reasonCode: reasonCodeOf(b) };
}

suspendRoutes.post("/users/:id/suspend", async (c) => {
  const staff = requireStepUp(c);
  const { id, reasonCode } = await body(c);
  if (id === staff.id) throw new HttpError(403, "Staff cannot suspend themselves", { code: "protected_account" });
  const u = await c.env.DB.prepare("SELECT u.status AS status, s.user_id AS staff_id FROM users u LEFT JOIN platform_staff s ON s.user_id = u.id AND s.removed_at IS NULL WHERE u.id = ?1").bind(id).first<{ status: string; staff_id: string | null }>();
  if (!u) throw new HttpError(404, "Not found");
  if (u.staff_id) throw new HttpError(403, "Staff accounts are managed with the runbook", { code: "protected_account" });
  if (u.status !== "active") return c.json({ ok: true, id, status: u.status, changed: false });
  const off = await auditOff(c.env.DB);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1 AND status = 'active'").bind(id),
    ...auditStmts(c.env.DB, { action: "account.suspended", actorType: "staff", actorId: staff.id, targetType: "user", targetId: id, reasonCode }, off),
  ]);
  return c.json({ ok: true, id, status: "suspended", changed: true });
});

suspendRoutes.post("/users/:id/restore", async (c) => {
  const staff = requireStepUp(c);
  const { id, reasonCode } = await body(c);
  const u = await c.env.DB.prepare("SELECT status FROM users WHERE id = ?1").bind(id).first<{ status: string }>();
  if (!u) throw new HttpError(404, "Not found");
  if (u.status !== "suspended") return c.json({ ok: true, id, status: u.status, changed: false });
  const off = await auditOff(c.env.DB);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?1 AND status = 'suspended'").bind(id),
    ...auditStmts(c.env.DB, { action: "account.restored", actorType: "staff", actorId: staff.id, targetType: "user", targetId: id, reasonCode }, off),
  ]);
  return c.json({ ok: true, id, status: "active", changed: true });
});

suspendRoutes.post("/orgs/:id/suspend", async (c) => {
  const staff = requireStepUp(c);
  const { id, reasonCode } = await body(c);
  const o = await c.env.DB.prepare("SELECT status FROM organisations WHERE id = ?1").bind(id).first<{ status: string }>();
  if (!o) throw new HttpError(404, "Not found");
  if (o.status !== "active") return c.json({ ok: true, id, status: o.status, changed: false });
  const off = await auditOff(c.env.DB);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE organisations SET status = 'suspended' WHERE id = ?1 AND status = 'active'").bind(id),
    ...auditStmts(c.env.DB, { action: "org.suspended", actorType: "staff", actorId: staff.id, orgId: id, targetType: "org", targetId: id, reasonCode }, off),
  ]);
  return c.json({ ok: true, id, status: "suspended", changed: true });
});

suspendRoutes.post("/orgs/:id/restore", async (c) => {
  const staff = requireStepUp(c);
  const { id, reasonCode } = await body(c);
  const o = await c.env.DB.prepare("SELECT status FROM organisations WHERE id = ?1").bind(id).first<{ status: string }>();
  if (!o) throw new HttpError(404, "Not found");
  if (o.status !== "suspended") return c.json({ ok: true, id, status: o.status, changed: false });
  const off = await auditOff(c.env.DB);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE organisations SET status = 'active' WHERE id = ?1 AND status = 'suspended'").bind(id),
    ...auditStmts(c.env.DB, { action: "org.restored", actorType: "staff", actorId: staff.id, orgId: id, targetType: "org", targetId: id, reasonCode }, off),
  ]);
  return c.json({ ok: true, id, status: "active", changed: true });
});
