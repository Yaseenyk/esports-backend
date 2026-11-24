/**
 * Community routes: the college esports calendar (flag v3.calendar) and the organiser trust score (flag v3.trust). Thin: parse, call a service, respond.
 * Each route is gated by its flag BEFORE sign-in and before any community table is read (off = the unknown-route 404).
 */
import { Hono } from "hono";
import { requireUser } from "../../auth";
import { getFlags } from "../../flags";
import { rateLimitSoft, rateLimitSubject, readJson } from "../../http";
import type { AppBindings } from "../../types";
import { createEntry, deleteEntry, myCalendar, publicCalendar, updateEntry } from "../services/calendar-service";
import { deleteMyRating, myRatings, myTrust, publicTrust, rateOrganiser, replyToReview, reportReview } from "../services/trust-service";
import { cachedJson, flagGate, killMw, killReadMw, noStore } from "./common";

export const communityRoutes = new Hono<AppBindings>();
const calendar = flagGate("v3.calendar");
const trust = flagGate("v3.trust");
const writes = killMw("kill.public_writes");
const p = (v: string | undefined): string => v ?? "";

// ---- which community features are on (the frontend build reads this once; 404 while both are off) ----
communityRoutes.get("/public/community/status", flagGate("v3.calendar", "v3.trust"), async (c) => {
  rateLimitSoft(c, "v3-pub", 120, 60);
  const f = await getFlags(c.env.DB);
  return cachedJson(c, { calendar: f["v3.calendar"], trust: f["v3.trust"] }, 60, 300);
});

// ---- calendar: public ----
communityRoutes.get("/public/calendar", calendar, killReadMw, async (c) => {
  rateLimitSoft(c, "v3-pub", 120, 60);
  return cachedJson(c, await publicCalendar(c.env.DB, { game: c.req.query("game"), city: c.req.query("city"), from: c.req.query("from"), to: c.req.query("to") }), 120, 600);
});

// ---- calendar: verified organisations ----
communityRoutes.get("/v3/me/calendar", calendar, requireUser, async (c) => {
  noStore(c);
  return c.json(await myCalendar(c.env.DB, c.get("userId")));
});
communityRoutes.post("/v3/orgs/:orgId/calendar", calendar, writes, requireUser, async (c) => {
  noStore(c);
  const uid = c.get("userId");
  await rateLimitSubject(c, "cal-write", uid, 30, 3600);
  return c.json(await createEntry(c.env.DB, uid, p(c.req.param("orgId")), await readJson(c, 4_000)), 201);
});
communityRoutes.put("/v3/calendar/:id", calendar, writes, requireUser, async (c) => {
  noStore(c);
  const uid = c.get("userId");
  await rateLimitSubject(c, "cal-write", uid, 30, 3600);
  return c.json(await updateEntry(c.env.DB, uid, p(c.req.param("id")), await readJson(c, 4_000)));
});
communityRoutes.delete("/v3/calendar/:id", calendar, writes, requireUser, async (c) => {
  noStore(c);
  return c.json(await deleteEntry(c.env.DB, c.get("userId"), p(c.req.param("id"))));
});

// ---- trust: public ----
communityRoutes.get("/public/tournaments/:slug/trust", trust, killReadMw, async (c) => {
  rateLimitSoft(c, "v3-pub", 120, 60);
  return cachedJson(c, await publicTrust(c.env.DB, p(c.req.param("slug"))), 60, 300);
});

// ---- trust: players and organisers ----
communityRoutes.get("/v3/tournaments/:slug/trust/me", trust, requireUser, async (c) => {
  noStore(c);
  return c.json(await myTrust(c.env.DB, c.get("userId"), p(c.req.param("slug"))));
});
communityRoutes.post("/v3/tournaments/:slug/trust/ratings", trust, writes, requireUser, async (c) => {
  noStore(c);
  const uid = c.get("userId");
  await rateLimitSubject(c, "trust-rate", uid, 10, 3600);
  return c.json(await rateOrganiser(c.env.DB, uid, p(c.req.param("slug")), await readJson(c, 8_000)), 201);
});
communityRoutes.get("/v3/me/trust/ratings", trust, requireUser, async (c) => {
  noStore(c);
  return c.json(await myRatings(c.env.DB, c.get("userId")));
});
communityRoutes.delete("/v3/trust/ratings/:id", trust, writes, requireUser, async (c) => {
  noStore(c);
  return c.json(await deleteMyRating(c.env.DB, c.get("userId"), p(c.req.param("id"))));
});
communityRoutes.post("/v3/trust/ratings/:id/reply", trust, writes, requireUser, async (c) => {
  noStore(c);
  const uid = c.get("userId");
  await rateLimitSubject(c, "trust-reply", uid, 30, 3600);
  return c.json(await replyToReview(c.env.DB, uid, p(c.req.param("id")), await readJson(c, 4_000)));
});
communityRoutes.post("/v3/trust/ratings/:id/report", trust, writes, requireUser, async (c) => {
  noStore(c);
  const uid = c.get("userId");
  await rateLimitSubject(c, "trust-report", uid, 20, 86_400);
  return c.json(await reportReview(c.env.DB, uid, p(c.req.param("id")), await readJson(c, 2_000)), 201);
});
