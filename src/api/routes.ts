import { Hono } from "hono";
import type { AppBindings } from "../types";
import { requireUser } from "../auth";
import { meAnalytics } from "./analytics";
import { createKey, listKeys, revokeKey } from "./keys";
import { v1 } from "./v1";
import { FREE_LIMITS, FREE_PLAN_ID, can, subjectOf } from "../plans";
import type { Ctx } from "../http";

/** Phases 4, 6, 7. Mounted by ONE line in src/index.ts. Everything under /me needs a user token; /api/v1 needs an API key. */
export const api = new Hono<AppBindings>();

api.get("/me/analytics", requireUser, meAnalytics);
api.get("/me/api-keys", requireUser, listKeys);
api.post("/me/api-keys", requireUser, createKey);
api.delete("/me/api-keys/:id", requireUser, revokeKey);

/** GET /me/entitlements: the free plan. No D1 read of entitlements yet (no row exists; absence means free), so no query and no write. */
api.get("/me/entitlements", requireUser, (c: Ctx) => {
  const subject = subjectOf("user", c.get("userId"));
  c.header("cache-control", "private, no-store");
  return c.json({ subject, plan: { id: FREE_PLAN_ID, name: "Free", limits: FREE_LIMITS }, since: null, features: { analytics: can(subject, "analytics"), apiKeys: can(subject, "api_keys"), apiRead: can(subject, "api_read") } });
});

api.route("/", v1);
