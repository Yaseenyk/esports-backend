/**
 * Staff moderation for the community features, mounted INSIDE /admin/v1 after requireStaff (src/admin/routes.ts). Platform staff tokens only.
 * Reversible actions only (hide / restore / dismiss), each with a reason, a moderation log row and an audit_log row. 404 while the feature flag is off.
 */
import { Hono } from "hono";
import { getFlags } from "../../flags";
import { HttpError, readJson } from "../../http";
import type { AdminBindings } from "../../admin/session";
import { staffEntry, staffSetEntryHidden } from "../services/calendar-service";
import { staffDismissReport, staffRating, staffReportQueue, staffSetHidden } from "../services/trust-service";

export const communityAdminRoutes = new Hono<AdminBindings>();

const need = (flag: "v3.calendar" | "v3.trust") => async (c: { env: AdminBindings["Bindings"] }): Promise<void> => {
  if (!(await getFlags(c.env.DB))[flag]) throw new HttpError(404, "Not found");
};
const trustOn = need("v3.trust");
const calendarOn = need("v3.calendar");
const staffId = (c: { get(k: "staff"): { id: string } }) => c.get("staff").id;
const NO_STORE = { "cache-control": "no-store" };

communityAdminRoutes.get("/v3/trust/reports", async (c) => {
  await trustOn(c);
  return c.json(await staffReportQueue(c.env.DB, c.req.query("status")), 200, NO_STORE);
});
communityAdminRoutes.get("/v3/trust/ratings/:id", async (c) => {
  await trustOn(c);
  return c.json(await staffRating(c.env.DB, c.req.param("id")), 200, NO_STORE);
});
communityAdminRoutes.post("/v3/trust/ratings/:id/hide", async (c) => {
  await trustOn(c);
  return c.json(await staffSetHidden(c.env.DB, staffId(c), c.req.param("id"), true, await readJson(c as never, 2_000)), 200, NO_STORE);
});
communityAdminRoutes.post("/v3/trust/ratings/:id/restore", async (c) => {
  await trustOn(c);
  return c.json(await staffSetHidden(c.env.DB, staffId(c), c.req.param("id"), false, await readJson(c as never, 2_000)), 200, NO_STORE);
});
communityAdminRoutes.post("/v3/trust/reports/:id/dismiss", async (c) => {
  await trustOn(c);
  return c.json(await staffDismissReport(c.env.DB, staffId(c), c.req.param("id"), await readJson(c as never, 2_000)), 200, NO_STORE);
});
communityAdminRoutes.get("/v3/calendar/:id", async (c) => {
  await calendarOn(c);
  return c.json(await staffEntry(c.env.DB, c.req.param("id")), 200, NO_STORE);
});
communityAdminRoutes.post("/v3/calendar/:id/hide", async (c) => {
  await calendarOn(c);
  return c.json(await staffSetEntryHidden(c.env.DB, staffId(c), c.req.param("id"), true, await readJson(c as never, 2_000)), 200, NO_STORE);
});
communityAdminRoutes.post("/v3/calendar/:id/restore", async (c) => {
  await calendarOn(c);
  return c.json(await staffSetEntryHidden(c.env.DB, staffId(c), c.req.param("id"), false, await readJson(c as never, 2_000)), 200, NO_STORE);
});

export const COMMUNITY_ADMIN_ROUTES: readonly { method: string; path: string }[] = [
  { method: "GET", path: "/admin/v1/v3/trust/reports" },
  { method: "GET", path: "/admin/v1/v3/trust/ratings/:id" },
  { method: "POST", path: "/admin/v1/v3/trust/ratings/:id/hide" },
  { method: "POST", path: "/admin/v1/v3/trust/ratings/:id/restore" },
  { method: "POST", path: "/admin/v1/v3/trust/reports/:id/dismiss" },
  { method: "GET", path: "/admin/v1/v3/calendar/:id" },
  { method: "POST", path: "/admin/v1/v3/calendar/:id/hide" },
  { method: "POST", path: "/admin/v1/v3/calendar/:id/restore" },
];
