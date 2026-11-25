/**
 * Squad availability planner routes (flag v3.planner, OFF by default). No sign-in: the share token and the keys travel in the JSON body, never in the
 * URL, so they do not end up in request logs or a Referer. Rate limits: create 10/hour, vote and delete 60/hour per address (exact, D1), open 60/minute (soft).
 */
import { Hono } from "hono";
import { rateLimit, rateLimitSoft, readJson } from "../../http";
import type { AppBindings } from "../../types";
import { createPlan, deletePlan, openPlan, unvote, vote } from "../services/planner-service";
import { flagGate, killMw, noStore } from "./common";

export const plannerRoutes = new Hono<AppBindings>();
const gate = flagGate("v3.planner");
const writes = killMw("kill.public_writes");

plannerRoutes.post("/public/planner", gate, writes, async (c) => {
  noStore(c);
  await rateLimit(c, "planner-create", 10, 3600);
  return c.json(await createPlan(c.env.DB, await readJson(c, 8_000)), 201);
});
plannerRoutes.post("/public/planner/open", gate, async (c) => {
  noStore(c);
  rateLimitSoft(c, "planner-open", 60, 60);
  return c.json(await openPlan(c.env.DB, await readJson(c, 1_024)));
});
plannerRoutes.post("/public/planner/vote", gate, writes, async (c) => {
  noStore(c);
  await rateLimit(c, "planner-vote", 60, 3600);
  return c.json(await vote(c.env.DB, await readJson(c, 4_000)));
});
plannerRoutes.post("/public/planner/unvote", gate, writes, async (c) => {
  noStore(c);
  await rateLimit(c, "planner-vote", 60, 3600);
  return c.json(await unvote(c.env.DB, await readJson(c, 1_024)));
});
plannerRoutes.post("/public/planner/delete", gate, async (c) => {
  noStore(c);
  await rateLimit(c, "planner-delete", 20, 3600);
  return c.json(await deletePlan(c.env.DB, await readJson(c, 1_024)));
});
