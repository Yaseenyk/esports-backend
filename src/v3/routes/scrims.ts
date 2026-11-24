/**
 * Phase 4 routes: the scrim finder (flag v3.scrims, OFF by default). Thin: parse, call a service, respond.
 * Per-account rate limits use the existing rate_limits table: create 10/hour, request 30/day, report 20/hour, block 30/hour, other writes 120/hour.
 */
import { Hono } from "hono";
import { requireUser } from "../../auth";
import { rateLimitSoft, rateLimitSubject, readJson, type Ctx } from "../../http";
import type { AppBindings } from "../../types";
import { scrimReporterHash } from "../lib/reporter";
import {
  blockPoster, blockRequester, cancelMySlot, createSlot, myBlocks, myRequests, mySlots, publicBoard, publicSlot, reportSlot, requestSlot, respondToRequest, slotRequests,
  unblock, viewerBoard, withdrawMyRequest,
} from "../services/scrim-service";
import {
  acceptOffer, createSchedule, declineOffer, deleteSchedule, editSlot, joinWaitlist, leaveWaitlist, myNotices, mySchedules, myWaitlist, readNotices, removeTeam, roster, skipScheduleDay, updateSchedule,
} from "../services/scrim-manager-service";
import { cachedJson, flagGate, killMw, killReadMw, noStore } from "./common";

export const scrimRoutes = new Hono<AppBindings>();
const gate = flagGate("v3.scrims");
const writes = killMw("kill.public_writes");
const id = (c: Ctx): string => c.req.param("id") ?? "";
const limit = (c: Ctx, scope: string, n: number, sec: number) => rateLimitSubject(c, scope, c.get("userId"), n, sec);

// ---- public board ----
scrimRoutes.get("/public/scrims", gate, killReadMw, async (c) => {
  rateLimitSoft(c, "v3-scrims", 120, 60);
  return cachedJson(c, await publicBoard(c.env.DB, c.req.query()), 30, 60);
});
scrimRoutes.get("/public/scrims/:id", gate, killReadMw, async (c) => {
  rateLimitSoft(c, "v3-scrims", 120, 60);
  return cachedJson(c, await publicSlot(c.env.DB, id(c)), 30, 60);
});

// ---- signed-in board and own slots ----
scrimRoutes.get("/v3/scrims", gate, killReadMw, requireUser, async (c) => {
  noStore(c);
  return c.json(await viewerBoard(c.env.DB, c.get("userId"), c.req.query()));
});
scrimRoutes.post("/v3/scrims", gate, writes, requireUser, async (c) => {
  noStore(c);
  await limit(c, "scrim-create", 10, 3600);
  return c.json(await createSlot(c.env.DB, c.get("userId"), await readJson(c, 4_000)), 201);
});
scrimRoutes.get("/v3/me/scrims", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await mySlots(c.env.DB, c.get("userId")));
});
scrimRoutes.post("/v3/scrims/:id/cancel", gate, writes, requireUser, async (c) => {
  noStore(c);
  await limit(c, "scrim-write", 120, 3600);
  return c.json(await cancelMySlot(c.env.DB, c.get("userId"), id(c)));
});
scrimRoutes.get("/v3/scrims/:id/requests", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await slotRequests(c.env.DB, c.get("userId"), id(c)));
});

// ---- requests ----
scrimRoutes.post("/v3/scrims/:id/requests", gate, writes, requireUser, async (c) => {
  noStore(c);
  await limit(c, "scrim-request", 30, 86_400);
  return c.json(await requestSlot(c.env.DB, c.get("userId"), id(c), await readJson(c, 2_000)), 201);
});
scrimRoutes.get("/v3/me/scrim-requests", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await myRequests(c.env.DB, c.get("userId")));
});
scrimRoutes.post("/v3/scrim-requests/:id/respond", gate, writes, requireUser, async (c) => {
  noStore(c);
  await limit(c, "scrim-write", 120, 3600);
  return c.json(await respondToRequest(c.env.DB, c.get("userId"), id(c), await readJson(c, 1_024)));
});
scrimRoutes.post("/v3/scrim-requests/:id/withdraw", gate, writes, requireUser, async (c) => {
  noStore(c);
  await limit(c, "scrim-write", 120, 3600);
  return c.json(await withdrawMyRequest(c.env.DB, c.get("userId"), id(c)));
});

// ---- blocks ----
scrimRoutes.post("/v3/scrims/:id/block", gate, writes, requireUser, async (c) => {
  noStore(c);
  await limit(c, "scrim-block", 30, 3600);
  return c.json(await blockPoster(c.env.DB, c.get("userId"), id(c)));
});
scrimRoutes.post("/v3/scrim-requests/:id/block", gate, writes, requireUser, async (c) => {
  noStore(c);
  await limit(c, "scrim-block", 30, 3600);
  return c.json(await blockRequester(c.env.DB, c.get("userId"), id(c)));
});
scrimRoutes.get("/v3/me/scrim-blocks", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await myBlocks(c.env.DB, c.get("userId")));
});
scrimRoutes.delete("/v3/me/scrim-blocks/:id", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await unblock(c.env.DB, c.get("userId"), id(c)));
});

// ---- report ----
scrimRoutes.post("/v3/scrims/:id/report", gate, writes, requireUser, async (c) => {
  noStore(c);
  const uid = c.get("userId");
  await limit(c, "scrim-report", 20, 3600);
  const b = await readJson(c, 2_000);
  return c.json(await reportSlot(c.env.DB, await scrimReporterHash(c.env, uid), uid, id(c), b), 202);
});

// ---- phase 4b: the scrim manager (migration 0057; same flag) ----
const sid = (c: Ctx): string => c.req.param("sid") ?? "";
scrimRoutes.get("/v3/scrims/:id/roster", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await roster(c.env.DB, c.get("userId"), id(c)));
});
scrimRoutes.put("/v3/scrims/:id", gate, writes, requireUser, async (c) => {
  noStore(c);
  await limit(c, "scrim-write", 120, 3600);
  return c.json(await editSlot(c.env.DB, c.get("userId"), id(c), await readJson(c, 4_000)));
});
scrimRoutes.post("/v3/scrims/:id/waitlist", gate, writes, requireUser, async (c) => {
  noStore(c);
  await limit(c, "scrim-request", 30, 86_400); // shares the request budget
  return c.json(await joinWaitlist(c.env.DB, c.get("userId"), id(c), await readJson(c, 2_000)), 201);
});
scrimRoutes.get("/v3/me/scrim-waitlist", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await myWaitlist(c.env.DB, c.get("userId")));
});
scrimRoutes.post("/v3/scrim-waitlist/:id/accept", gate, writes, requireUser, async (c) => {
  noStore(c);
  await limit(c, "scrim-write", 120, 3600);
  return c.json(await acceptOffer(c.env.DB, c.get("userId"), id(c)));
});
scrimRoutes.post("/v3/scrim-waitlist/:id/decline", gate, writes, requireUser, async (c) => {
  noStore(c);
  await limit(c, "scrim-write", 120, 3600);
  return c.json(await declineOffer(c.env.DB, c.get("userId"), id(c)));
});
scrimRoutes.post("/v3/scrim-waitlist/:id/leave", gate, writes, requireUser, async (c) => {
  noStore(c);
  await limit(c, "scrim-write", 120, 3600);
  return c.json(await leaveWaitlist(c.env.DB, c.get("userId"), id(c)));
});
scrimRoutes.post("/v3/scrim-requests/:id/remove", gate, writes, requireUser, async (c) => {
  noStore(c);
  await limit(c, "scrim-write", 120, 3600);
  return c.json(await removeTeam(c.env.DB, c.get("userId"), id(c)));
});
scrimRoutes.get("/v3/me/scrim-notifications", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await myNotices(c.env.DB, c.get("userId")));
});
scrimRoutes.post("/v3/me/scrim-notifications/read", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await readNotices(c.env.DB, c.get("userId")));
});
scrimRoutes.post("/v3/scrim-schedules", gate, writes, requireUser, async (c) => {
  noStore(c);
  await limit(c, "scrim-create", 10, 3600); // shares the create budget
  return c.json(await createSchedule(c.env.DB, c.get("userId"), await readJson(c, 4_000)), 201);
});
scrimRoutes.get("/v3/me/scrim-schedules", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await mySchedules(c.env.DB, c.get("userId")));
});
scrimRoutes.put("/v3/scrim-schedules/:sid", gate, writes, requireUser, async (c) => {
  noStore(c);
  await limit(c, "scrim-write", 120, 3600);
  return c.json(await updateSchedule(c.env.DB, c.get("userId"), sid(c), await readJson(c, 4_000)));
});
scrimRoutes.delete("/v3/scrim-schedules/:sid", gate, writes, requireUser, async (c) => {
  noStore(c);
  return c.json(await deleteSchedule(c.env.DB, c.get("userId"), sid(c)));
});
scrimRoutes.post("/v3/scrim-schedules/:sid/days/:day/skip", gate, writes, requireUser, async (c) => {
  noStore(c);
  await limit(c, "scrim-write", 120, 3600);
  return c.json(await skipScheduleDay(c.env.DB, c.get("userId"), sid(c), c.req.param("day") ?? ""));
});
