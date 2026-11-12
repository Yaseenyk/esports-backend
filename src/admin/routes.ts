/**
 * The ONE mounting file for /admin/v1 (blueprint 11.3). src/index.ts mounts it with a single line: `app.route("/", admin)`.
 *
 * Order matters:
 *   1. adminGate         flag admin.enabled + secrets + soft IP limit, else plain 404
 *   2. sessionDoor       the only routes that take an ordinary USER token (POST /session, POST /session/enroll)
 *   3. requireStaff      from here on a valid staff token is required, else 404 (anonymous, ordinary user, expired, wrong audience, removed staff)
 *   4. staff routes      renew, step-up, lookup, audit, flags, suspend, usage. Stream R adds its routers (reports, takedowns) HERE, after requireStaff,
 *                        and lists them in ADMIN_ROUTES (test/admin/inventory.test.ts fails for any admin route missing from the list).
 *
 * ADMIN_ROUTES is the inventory: every route, who may call it, whether it needs a step-up code, and `irreversible` (must be false: Phase 1 has no
 * irreversible staff action; the inventory test also refuses DELETE routes and delete/erase/purge words in a path).
 */
import { Hono } from "hono";
import { flagRoutes } from "./flags";
import { lookupRoutes } from "./lookup";
import { moderationRoutes } from "./moderation";
import { adminGate, requireStaff, sessionDoor, sessionStaff, type AdminBindings } from "./session";
import { suspendRoutes } from "./suspend";
import { usageRoutes } from "./usage";

export interface AdminRouteInfo { method: string; path: string; auth: "user" | "staff"; stepUp: boolean | "kill"; irreversible: false }

export const ADMIN_ROUTES: readonly AdminRouteInfo[] = [
  { method: "POST", path: "/admin/v1/session", auth: "user", stepUp: false, irreversible: false },
  { method: "POST", path: "/admin/v1/session/enroll", auth: "user", stepUp: false, irreversible: false },
  { method: "POST", path: "/admin/v1/session/renew", auth: "staff", stepUp: false, irreversible: false },
  { method: "POST", path: "/admin/v1/session/step-up", auth: "staff", stepUp: false, irreversible: false },
  { method: "GET", path: "/admin/v1/lookup", auth: "staff", stepUp: false, irreversible: false },
  { method: "GET", path: "/admin/v1/audit", auth: "staff", stepUp: false, irreversible: false },
  { method: "GET", path: "/admin/v1/flags", auth: "staff", stepUp: false, irreversible: false },
  { method: "PUT", path: "/admin/v1/flags/:key", auth: "staff", stepUp: "kill", irreversible: false },
  { method: "POST", path: "/admin/v1/users/:id/suspend", auth: "staff", stepUp: true, irreversible: false },
  { method: "POST", path: "/admin/v1/users/:id/restore", auth: "staff", stepUp: true, irreversible: false },
  { method: "POST", path: "/admin/v1/orgs/:id/suspend", auth: "staff", stepUp: true, irreversible: false },
  { method: "POST", path: "/admin/v1/orgs/:id/restore", auth: "staff", stepUp: true, irreversible: false },
  { method: "GET", path: "/admin/v1/usage", auth: "staff", stepUp: false, irreversible: false },
  { method: "GET", path: "/admin/v1/reports", auth: "staff", stepUp: false, irreversible: false },
  { method: "POST", path: "/admin/v1/reports/:id/decide", auth: "staff", stepUp: false, irreversible: false },
  { method: "GET", path: "/admin/v1/takedowns", auth: "staff", stepUp: false, irreversible: false },
  { method: "POST", path: "/admin/v1/takedowns", auth: "staff", stepUp: false, irreversible: false },
  { method: "POST", path: "/admin/v1/takedowns/:type/:id/restore", auth: "staff", stepUp: false, irreversible: false },
];

export const admin = new Hono<AdminBindings>().basePath("/admin/v1");

admin.use("*", adminGate);
admin.route("/session", sessionDoor);
admin.use("*", requireStaff);
admin.route("/session", sessionStaff);
admin.route("/", lookupRoutes);
admin.route("/", flagRoutes);
admin.route("/", suspendRoutes);
admin.route("/", usageRoutes);
admin.route("/", moderationRoutes);
