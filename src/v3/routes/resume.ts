/** Esports Resume routes (flag v3.resume; the status and 18+ routes also open with v3.lft or v3.disputes, which need the same facts). */
import { Hono } from "hono";
import { requireUser } from "../../auth";
import { rateLimitSoft, readJson } from "../../http";
import type { AppBindings } from "../../types";
import {
  confirmAdult, deleteMyGame, deleteMyProfile, getMyProfile, giveResumeConsent, myStatus, publicPlayer, putMyGame, putMyProfile, withdrawResumeConsent,
} from "../services/profile-service";
import { cachedJson, flagGate, killReadMw, noStore } from "./common";

export const resumeRoutes = new Hono<AppBindings>();
const resumeGate = flagGate("v3.resume");
const anyGate = flagGate("v3.resume", "v3.lft", "v3.disputes", "v3.calendar", "v3.trust"); // the account facts (18+) serve every feature that writes

// ---- shared account facts ----
resumeRoutes.get("/v3/me/status", anyGate, requireUser, async (c) => {
  noStore(c);
  return c.json(await myStatus(c.env.DB, c.get("userId")));
});
resumeRoutes.post("/v3/me/adult-confirmation", anyGate, requireUser, async (c) => {
  noStore(c);
  return c.json(await confirmAdult(c.env.DB, c.get("userId"), await readJson(c, 1024)));
});

// ---- resume ----
resumeRoutes.post("/v3/me/resume-consent", resumeGate, requireUser, async (c) => {
  noStore(c);
  return c.json(await giveResumeConsent(c.env.DB, c.get("userId"), await readJson(c, 1024)));
});
resumeRoutes.delete("/v3/me/resume-consent", resumeGate, requireUser, async (c) => {
  noStore(c);
  return c.json(await withdrawResumeConsent(c.env.DB, c.get("userId")));
});
resumeRoutes.get("/v3/me/profile", resumeGate, requireUser, async (c) => {
  noStore(c);
  return c.json(await getMyProfile(c.env.DB, c.get("userId")));
});
resumeRoutes.put("/v3/me/profile", resumeGate, requireUser, async (c) => {
  noStore(c);
  return c.json(await putMyProfile(c.env.DB, c.get("userId"), await readJson(c, 16_000)));
});
resumeRoutes.delete("/v3/me/profile", resumeGate, requireUser, async (c) => {
  noStore(c);
  return c.json(await deleteMyProfile(c.env.DB, c.get("userId")));
});
resumeRoutes.put("/v3/me/games/:game", resumeGate, requireUser, async (c) => {
  noStore(c);
  return c.json(await putMyGame(c.env.DB, c.get("userId"), c.req.param("game"), await readJson(c, 4096)));
});
resumeRoutes.delete("/v3/me/games/:game", resumeGate, requireUser, async (c) => {
  noStore(c);
  return c.json(await deleteMyGame(c.env.DB, c.get("userId"), c.req.param("game")));
});

// ---- public ----
resumeRoutes.get("/public/players/:slug", resumeGate, killReadMw, async (c) => {
  rateLimitSoft(c, "v3-pub", 120, 60);
  return cachedJson(c, await publicPlayer(c.env.DB, c.req.param("slug")), 0);
});
