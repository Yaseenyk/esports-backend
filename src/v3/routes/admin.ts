/**
 * Moderator (platform staff) routes for the v3 layer, mounted INSIDE /admin/v1 after requireStaff (src/admin/routes.ts). Staff tokens only; reversible actions only.
 * Each answers 404 while its feature flag is off, like every other v3 route.
 */
import { Hono } from "hono";
import { getFlags } from "../../flags";
import { HttpError, readJson } from "../../http";
import type { AdminBindings } from "../../admin/session";
import { commentOnDispute, evidenceDownload, getDispute, resolveDispute, staffQueue, transitionDispute } from "../services/dispute-service";
import { decideListing, hiddenListings } from "../services/lft-service";
import { evidenceResponse } from "./disputes";

export const v3AdminRoutes = new Hono<AdminBindings>();

const need = (flag: "v3.disputes" | "v3.lft") => async (c: { env: AdminBindings["Bindings"] }): Promise<void> => {
  if (!(await getFlags(c.env.DB))[flag]) throw new HttpError(404, "Not found");
};
const disputesOn = need("v3.disputes");
const lftOn = need("v3.lft");
const actor = (c: { get(k: "staff"): { id: string } }) => ({ kind: "staff" as const, userId: c.get("staff").id });

v3AdminRoutes.get("/v3/disputes", async (c) => {
  await disputesOn(c);
  return c.json(await staffQueue(c.env.DB, { status: c.req.query("status"), after: c.req.query("after") }));
});
v3AdminRoutes.get("/v3/disputes/:id", async (c) => {
  await disputesOn(c);
  return c.json(await getDispute(c.env.DB, actor(c), c.req.param("id")));
});
v3AdminRoutes.get("/v3/disputes/:id/evidence/:evidenceId", async (c) => {
  await disputesOn(c);
  return evidenceResponse(await evidenceDownload(c.env.DB, actor(c), c.req.param("id"), c.req.param("evidenceId")), c.req.param("evidenceId"));
});
v3AdminRoutes.post("/v3/disputes/:id/comment", async (c) => {
  await disputesOn(c);
  return c.json(await commentOnDispute(c.env.DB, actor(c), c.req.param("id"), await readJson(c as never, 4_000)), 201);
});
v3AdminRoutes.post("/v3/disputes/:id/transition", async (c) => {
  await disputesOn(c);
  return c.json(await transitionDispute(c.env.DB, actor(c), c.req.param("id"), await readJson(c as never, 4_000)));
});
v3AdminRoutes.post("/v3/disputes/:id/resolve", async (c) => {
  await disputesOn(c);
  return c.json(await resolveDispute(c.env.DB, actor(c), c.req.param("id"), await readJson(c as never, 16_000)));
});
v3AdminRoutes.get("/v3/lft/hidden", async (c) => {
  await lftOn(c);
  return c.json(await hiddenListings(c.env.DB));
});
v3AdminRoutes.post("/v3/lft/:id/decide", async (c) => {
  await lftOn(c);
  const b = await readJson(c as never, 1024);
  return c.json(await decideListing(c.env.DB, c.req.param("id"), b.decision));
});

export const V3_ADMIN_ROUTES: readonly { method: string; path: string }[] = [
  { method: "GET", path: "/admin/v1/v3/disputes" },
  { method: "GET", path: "/admin/v1/v3/disputes/:id" },
  { method: "GET", path: "/admin/v1/v3/disputes/:id/evidence/:evidenceId" },
  { method: "POST", path: "/admin/v1/v3/disputes/:id/comment" },
  { method: "POST", path: "/admin/v1/v3/disputes/:id/transition" },
  { method: "POST", path: "/admin/v1/v3/disputes/:id/resolve" },
  { method: "GET", path: "/admin/v1/v3/lft/hidden" },
  { method: "POST", path: "/admin/v1/v3/lft/:id/decide" },
];
