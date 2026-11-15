/** Tournament routes (flag v3.tournaments). Thin: parse, call a service, respond. */
import { Hono } from "hono";
import { requireUser } from "../../auth";
import { HttpError, rateLimitSoft, readJson, type Ctx } from "../../http";
import type { AppBindings } from "../../types";
import { listPublicColleges, publicCollege } from "../services/college-service";
import {
  createTournament, getTournamentForOrganiser, listPublicTournaments, publicLive, publicTournamentDetail, transitionTournament, updateTournament,
} from "../services/tournament-service";
import { cachedJson, flagGate, killReadMw, noStore } from "./common";

export const tournamentRoutes = new Hono<AppBindings>();
const gate = flagGate("v3.tournaments");
const eventId = (c: Ctx): string => {
  const id = c.req.param("eventId") ?? "";
  if (!/^[A-Za-z0-9._~-]{1,48}$/.test(id)) throw new HttpError(404, "Event not found");
  return id;
};

// ---- organiser (signed in) ----
tournamentRoutes.post("/v3/events/:eventId/tournament", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await createTournament(c.env.DB, c.get("userId"), eventId(c), await readJson(c, 64_000)), 201);
});
tournamentRoutes.get("/v3/events/:eventId/tournament", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await getTournamentForOrganiser(c.env.DB, c.get("userId"), eventId(c)));
});
tournamentRoutes.put("/v3/events/:eventId/tournament", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await updateTournament(c.env.DB, c.get("userId"), eventId(c), await readJson(c, 64_000)));
});
tournamentRoutes.post("/v3/events/:eventId/tournament/status", gate, requireUser, async (c) => {
  noStore(c);
  const b = await readJson(c, 2048);
  return c.json(await transitionTournament(c.env.DB, c.get("userId"), eventId(c), b.to));
});

// ---- public (no sign-in, cacheable) ----
const pub = [gate, killReadMw] as const;

tournamentRoutes.get("/public/tournaments", ...pub, async (c) => {
  rateLimitSoft(c, "v3-pub", 120, 60);
  const r = await listPublicTournaments(c.env.DB, { status: c.req.query("status"), game: c.req.query("game"), limit: c.req.query("limit") });
  return cachedJson(c, { items: r.items }, 60, 300);
});
tournamentRoutes.get("/public/tournaments/:slug", ...pub, async (c) => {
  rateLimitSoft(c, "v3-pub", 120, 60);
  return cachedJson(c, await publicTournamentDetail(c.env.DB, c.req.param("slug")), 60, 300);
});
tournamentRoutes.get("/public/tournaments/:slug/live", ...pub, async (c) => {
  rateLimitSoft(c, "v3-live", 240, 60);
  return cachedJson(c, await publicLive(c.env.DB, c.req.param("slug")), 15, 30);
});

// ---- public colleges (verified organisations with at least one real tournament) ----
tournamentRoutes.get("/public/colleges", ...pub, async (c) => {
  rateLimitSoft(c, "v3-pub", 120, 60);
  return cachedJson(c, await listPublicColleges(c.env.DB), 300, 600);
});
tournamentRoutes.get("/public/colleges/:slug", ...pub, async (c) => {
  rateLimitSoft(c, "v3-pub", 120, 60);
  return cachedJson(c, await publicCollege(c.env.DB, c.req.param("slug")), 60, 300);
});
