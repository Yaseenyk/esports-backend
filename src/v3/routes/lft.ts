/** Looking-for-Team board routes (flag v3.lft). Per-user rate limits use the existing rate_limits table (src/http.ts). */
import { Hono } from "hono";
import { requireUser } from "../../auth";
import { HttpError, rateLimitSoft, rateLimitSubject, readJson } from "../../http";
import type { AppBindings } from "../../types";
import {
  applyToListing, bumpMyListing, closeMyListing, createListing, listingApplications, myApplications, myListings, publicList, publicOne, reportListing,
  respondToApplication, withdrawApplication,
} from "../services/lft-service";
import { lftReporterHash } from "../lib/reporter";
import { cachedJson, flagGate, killMw, killReadMw, noStore } from "./common";

export const lftRoutes = new Hono<AppBindings>();
const gate = flagGate("v3.lft");
const writes = killMw("kill.public_writes");
const idOf = (v: string | undefined): string => v ?? "";

// ---- public ----
lftRoutes.get("/public/lft", gate, killReadMw, async (c) => {
  rateLimitSoft(c, "v3-lft", 120, 60);
  return cachedJson(c, await publicList(c.env.DB, c.req.query()), 30, 60);
});
lftRoutes.get("/public/lft/:id", gate, killReadMw, async (c) => {
  rateLimitSoft(c, "v3-lft", 120, 60);
  return cachedJson(c, await publicOne(c.env.DB, idOf(c.req.param("id"))), 30, 60);
});

// ---- author ----
lftRoutes.post("/v3/lft", gate, writes, requireUser, async (c) => {
  noStore(c);
  const uid = c.get("userId");
  await rateLimitSubject(c, "lft-create", uid, 5, 3600);
  return c.json(await createListing(c.env.DB, uid, await readJson(c, 8_000)), 201);
});
lftRoutes.get("/v3/me/lft", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await myListings(c.env.DB, c.get("userId")));
});
lftRoutes.post("/v3/lft/:id/close", gate, writes, requireUser, async (c) => {
  noStore(c);
  return c.json(await closeMyListing(c.env.DB, c.get("userId"), idOf(c.req.param("id")), await readJson(c, 1024)));
});
lftRoutes.post("/v3/lft/:id/bump", gate, writes, requireUser, async (c) => {
  noStore(c);
  return c.json(await bumpMyListing(c.env.DB, c.get("userId"), idOf(c.req.param("id"))));
});

// ---- applications ----
lftRoutes.post("/v3/lft/:id/applications", gate, writes, requireUser, async (c) => {
  noStore(c);
  const uid = c.get("userId");
  await rateLimitSubject(c, "lft-apply", uid, 20, 86_400);
  return c.json(await applyToListing(c.env.DB, uid, idOf(c.req.param("id")), await readJson(c, 4_000)), 201);
});
lftRoutes.get("/v3/lft/:id/applications", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await listingApplications(c.env.DB, c.get("userId"), idOf(c.req.param("id"))));
});
lftRoutes.get("/v3/me/lft/applications", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await myApplications(c.env.DB, c.get("userId")));
});
lftRoutes.post("/v3/lft-applications/:id/respond", gate, writes, requireUser, async (c) => {
  noStore(c);
  return c.json(await respondToApplication(c.env.DB, c.get("userId"), idOf(c.req.param("id")), await readJson(c, 1024)));
});
lftRoutes.post("/v3/lft-applications/:id/withdraw", gate, writes, requireUser, async (c) => {
  noStore(c);
  return c.json(await withdrawApplication(c.env.DB, c.get("userId"), idOf(c.req.param("id"))));
});

// ---- report ----
lftRoutes.post("/v3/lft/:id/report", gate, writes, requireUser, async (c) => {
  noStore(c);
  const uid = c.get("userId");
  await rateLimitSubject(c, "lft-report", uid, 20, 3600);
  const b = await readJson(c, 2_000);
  if (!uid) throw new HttpError(401, "Authentication required");
  const reporter = await lftReporterHash(c.env, uid);
  return c.json(await reportListing(c.env.DB, reporter, uid, idOf(c.req.param("id")), b), 202);
});
