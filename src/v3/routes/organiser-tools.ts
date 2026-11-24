/**
 * Organiser tools (each behind its own flag, all default OFF): match rooms (v3.rooms), match recap facts (v3.recaps) and saving results read from a
 * screenshot (v3.screenshots). Thin: parse, call a service, respond. Every answer is private: Cache-Control no-store.
 */
import { Hono } from "hono";
import { requireUser } from "../../auth";
import { HttpError, rateLimit, rateLimitSubject, readJson, type Ctx } from "../../http";
import type { AppBindings } from "../../types";
import { organiserTools, recapFacts } from "../services/recap-service";
import { claimRoomCaptain, createRoom, listEventRooms, myRooms, removeRoom, revealRoom, roomViews, rotateRoom, updateRoom } from "../services/room-service";
import { saveScreenshotResults, screenshotContext } from "../services/screenshot-service";
import { flagGate, killMw, noStore } from "./common";

export const organiserToolRoutes = new Hono<AppBindings>();
const rooms = flagGate("v3.rooms");
const recaps = flagGate("v3.recaps");
const shots = flagGate("v3.screenshots");
const writes = killMw("kill.public_writes");

const eventId = (c: Ctx): string => {
  const id = c.req.param("eventId") ?? "";
  if (!/^[A-Za-z0-9._~-]{1,48}$/.test(id)) throw new HttpError(404, "Event not found");
  return id;
};
const roomKey = (c: Ctx): string | undefined => c.env.ROOM_CREDENTIALS_KEY;

// ---- which tools are on (one probe for the event page; 404 while all three flags are off) ----
organiserToolRoutes.get("/v3/events/:eventId/tools", flagGate("v3.rooms", "v3.recaps", "v3.screenshots"), requireUser, async (c) => {
  noStore(c);
  return c.json(await organiserTools(c.env.DB, c.get("userId"), eventId(c)));
});

// ---- match rooms: organiser ----
organiserToolRoutes.get("/v3/events/:eventId/rooms", rooms, requireUser, async (c) => {
  noStore(c);
  return c.json(await listEventRooms(c.env.DB, c.get("userId"), eventId(c)));
});
organiserToolRoutes.post("/v3/events/:eventId/rooms", rooms, writes, requireUser, async (c) => {
  noStore(c);
  await rateLimitSubject(c, "v3-rooms-write", c.get("userId"), 120, 3600);
  return c.json(await createRoom(c.env.DB, roomKey(c), c.get("userId"), eventId(c), await readJson(c, 4096)), 201);
});
organiserToolRoutes.put("/v3/events/:eventId/rooms/:roomId", rooms, writes, requireUser, async (c) => {
  noStore(c);
  await rateLimitSubject(c, "v3-rooms-write", c.get("userId"), 120, 3600);
  return c.json(await updateRoom(c.env.DB, c.get("userId"), eventId(c), c.req.param("roomId") ?? "", await readJson(c, 4096)));
});
organiserToolRoutes.post("/v3/events/:eventId/rooms/:roomId/rotate", rooms, writes, requireUser, async (c) => {
  noStore(c);
  await rateLimitSubject(c, "v3-rooms-write", c.get("userId"), 120, 3600);
  return c.json(await rotateRoom(c.env.DB, roomKey(c), c.get("userId"), eventId(c), c.req.param("roomId") ?? "", await readJson(c, 4096)));
});
organiserToolRoutes.delete("/v3/events/:eventId/rooms/:roomId", rooms, writes, requireUser, async (c) => {
  noStore(c);
  return c.json(await removeRoom(c.env.DB, c.get("userId"), eventId(c), c.req.param("roomId") ?? ""));
});
organiserToolRoutes.get("/v3/events/:eventId/rooms/:roomId/views", rooms, requireUser, async (c) => {
  noStore(c);
  return c.json(await roomViews(c.env.DB, c.get("userId"), eventId(c), c.req.param("roomId") ?? ""));
});

// ---- match rooms: captain ----
organiserToolRoutes.post("/v3/rooms/captain-claim", rooms, writes, requireUser, async (c) => {
  noStore(c);
  await rateLimit(c, "v3-rooms-claim", 10, 600);
  return c.json(await claimRoomCaptain(c.env.DB, c.get("userId"), await readJson(c, 1024)));
});
organiserToolRoutes.get("/v3/me/rooms", rooms, requireUser, async (c) => {
  noStore(c);
  return c.json(await myRooms(c.env.DB, c.get("userId")));
});
organiserToolRoutes.post("/v3/me/rooms/:roomId/reveal", rooms, requireUser, async (c) => {
  noStore(c);
  await rateLimitSubject(c, "v3-rooms-reveal", c.get("userId"), 60, 3600);
  return c.json(await revealRoom(c.env.DB, roomKey(c), c.get("userId"), c.req.param("roomId") ?? ""));
});

// ---- match recap facts ----
organiserToolRoutes.get("/v3/events/:eventId/recap", recaps, requireUser, async (c) => {
  noStore(c);
  return c.json(await recapFacts(c.env.DB, c.get("userId"), eventId(c)));
});

// ---- results from a screenshot (the image never comes here) ----
organiserToolRoutes.get("/v3/events/:eventId/screenshot-results", shots, requireUser, async (c) => {
  noStore(c);
  return c.json(await screenshotContext(c.env.DB, c.get("userId"), eventId(c)));
});
organiserToolRoutes.post("/v3/events/:eventId/screenshot-results", shots, writes, requireUser, async (c) => {
  noStore(c);
  await rateLimitSubject(c, "v3-shots-write", c.get("userId"), 120, 3600);
  return c.json(await saveScreenshotResults(c.env.DB, c.get("userId"), eventId(c), await readJson(c, 32_000)), 201);
});
