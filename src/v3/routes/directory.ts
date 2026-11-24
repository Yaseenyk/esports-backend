/**
 * Phase 5 routes: the public tournament directory (flag v3.directory, OFF by default; separate from v3.tournaments, which is on in production).
 * The public path is /public/tournament-directory (not /public/tournaments/directory, which a tournament slug route would shadow).
 */
import { Hono } from "hono";
import { requireUser } from "../../auth";
import { HttpError, rateLimitSoft, rateLimitSubject, readJson, type Ctx } from "../../http";
import type { AppBindings } from "../../types";
import { getDirectorySetting, publicDirectory, putDirectorySetting } from "../services/directory-service";
import { cachedJson, flagGate, killMw, killReadMw, noStore } from "./common";

export const directoryRoutes = new Hono<AppBindings>();
const gate = flagGate("v3.directory");
const eventId = (c: Ctx): string => {
  const id = c.req.param("eventId") ?? "";
  if (!/^[A-Za-z0-9._~-]{1,48}$/.test(id)) throw new HttpError(404, "Event not found");
  return id;
};

directoryRoutes.get("/public/tournament-directory", gate, killReadMw, async (c) => {
  rateLimitSoft(c, "v3-pub", 120, 60);
  return cachedJson(c, await publicDirectory(c.env, c.req.query()), 60, 300);
});

directoryRoutes.get("/v3/events/:eventId/tournament/directory", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await getDirectorySetting(c.env.DB, c.get("userId"), eventId(c)));
});
directoryRoutes.put("/v3/events/:eventId/tournament/directory", gate, killMw("kill.public_writes"), requireUser, async (c) => {
  noStore(c);
  await rateLimitSubject(c, "v3-directory-write", c.get("userId"), 60, 3600);
  return c.json(await putDirectorySetting(c.env.DB, c.get("userId"), eventId(c), await readJson(c, 1024)));
});
