/**
 * Phase 3 routes (flag v3.profiles, OFF by default; separate from v3.resume, which is already on in production). Thin: parse, call a service, respond.
 * With the flag off every route answers the router's own 404 before any table of migration 0056 is read.
 */
import { Hono } from "hono";
import { requireUser } from "../../auth";
import { rateLimit, rateLimitSoft, rateLimitSubject, readJson, type Ctx } from "../../http";
import type { AppBindings } from "../../types";
import { profileReporterHash } from "../lib/reporter";
import {
  ensureMyCardLink, indexablePlayers, linkMyClaim, myPlayerPage, myTeamPage, myTeamPages, publicPlayerByCard, publicPlayerPage, publicTeamPage, reportPlayerByCard, reportProfile, resetMyCardLink,
  setMyPageDetails, setMyPlayerHidden, setMyPlayerVisibility, setMyTeamHidden, setMyTeamVisibility,
} from "../services/showcase-service";
import { cachedJson, flagGate, killMw, killReadMw, noStore } from "./common";

export const profileRoutes = new Hono<AppBindings>();
const gate = flagGate("v3.profiles");
const writes = killMw("kill.public_writes");
const param = (c: Ctx, k: string): string => c.req.param(k) ?? "";
const writeLimit = (c: Ctx) => rateLimitSubject(c, "v3-profile-write", c.get("userId"), 60, 3600);

// ---- public (no sign-in). max-age 0: a change of visibility or a withdrawn consent takes effect at once ----
profileRoutes.get("/public/profiles/players/:slug", gate, killReadMw, async (c) => {
  rateLimitSoft(c, "v3-pub", 120, 60);
  return cachedJson(c, await publicPlayerPage(c.env.DB, param(c, "slug")), 0);
});
// The slugs that get an indexable /players/<slug>/ page at the next site build (read by the frontend build, like /public/tournaments).
profileRoutes.get("/public/profiles/players", gate, killReadMw, async (c) => {
  rateLimitSoft(c, "v3-pub", 120, 60);
  return cachedJson(c, await indexablePlayers(c.env.DB), 0);
});
// The page a player card's QR opens. Exact (D1) limit per address on top of the soft one: guessing 128-bit tokens is hopeless, and this keeps it so.
// no-store: a reset or a page made private must take effect at once, and the token must not sit in a shared cache.
profileRoutes.get("/public/profiles/cards/:token", gate, killReadMw, async (c) => {
  rateLimitSoft(c, "v3-pub", 120, 60);
  await rateLimit(c, "v3-card-resolve", 30, 60);
  noStore(c);
  c.header("x-robots-tag", "noindex, nofollow");
  c.header("referrer-policy", "no-referrer");
  return c.json(await publicPlayerByCard(c.env.DB, param(c, "token")));
});
profileRoutes.get("/public/profiles/teams/:slug", gate, killReadMw, async (c) => {
  rateLimitSoft(c, "v3-pub", 120, 60);
  return cachedJson(c, await publicTeamPage(c.env.DB, param(c, "slug")), 0);
});

// ---- my player page ----
profileRoutes.get("/v3/me/player-page", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await myPlayerPage(c.env, c.get("userId")));
});
profileRoutes.put("/v3/me/player-page/visibility", gate, writes, requireUser, async (c) => {
  noStore(c);
  await writeLimit(c);
  return c.json(await setMyPlayerVisibility(c.env, c.get("userId"), await readJson(c, 1024)));
});
profileRoutes.put("/v3/me/player-page/hidden", gate, writes, requireUser, async (c) => {
  noStore(c);
  await writeLimit(c);
  return c.json(await setMyPlayerHidden(c.env, c.get("userId"), await readJson(c, 1024)));
});

profileRoutes.put("/v3/me/player-page/details", gate, writes, requireUser, async (c) => {
  noStore(c);
  await writeLimit(c);
  return c.json(await setMyPageDetails(c.env, c.get("userId"), await readJson(c, 8_000)));
});
// The card link: created on request (never by a GET), reset on request. Both are limited per account.
profileRoutes.post("/v3/me/player-page/card-link", gate, writes, requireUser, async (c) => {
  noStore(c);
  await writeLimit(c);
  return c.json(await ensureMyCardLink(c.env, c.get("userId")));
});
profileRoutes.post("/v3/me/player-page/card-link/reset", gate, writes, requireUser, async (c) => {
  noStore(c);
  await rateLimitSubject(c, "v3-card-reset", c.get("userId"), 10, 3600);
  return c.json(await resetMyCardLink(c.env, c.get("userId")));
});

// ---- my team pages ----
profileRoutes.get("/v3/me/team-pages", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await myTeamPages(c.env.DB, c.get("userId")));
});
profileRoutes.get("/v3/me/team-pages/:id", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await myTeamPage(c.env.DB, c.get("userId"), param(c, "id")));
});
profileRoutes.put("/v3/me/team-pages/:id/visibility", gate, writes, requireUser, async (c) => {
  noStore(c);
  await writeLimit(c);
  return c.json(await setMyTeamVisibility(c.env.DB, c.get("userId"), param(c, "id"), await readJson(c, 1024)));
});
profileRoutes.post("/v3/me/team-pages/:id/claims", gate, writes, requireUser, async (c) => {
  noStore(c);
  await writeLimit(c);
  return c.json(await linkMyClaim(c.env.DB, c.get("userId"), param(c, "id"), await readJson(c, 1024)));
});
profileRoutes.put("/v3/me/team-pages/:id/hidden", gate, writes, requireUser, async (c) => {
  noStore(c);
  await writeLimit(c);
  return c.json(await setMyTeamHidden(c.env.DB, c.get("userId"), param(c, "id"), await readJson(c, 1024)));
});

// ---- reports (signed in; 20 an hour per account) ----
for (const kind of ["player", "team"] as const) {
  profileRoutes.post(`/v3/profiles/${kind}s/:slug/report`, gate, writes, requireUser, async (c) => {
    noStore(c);
    const uid = c.get("userId");
    await rateLimitSubject(c, "v3-profile-report", uid, 20, 3600);
    const b = await readJson(c, 2_000);
    return c.json(await reportProfile(c.env.DB, await profileReporterHash(c.env, uid), uid, kind, param(c, "slug"), b), 202);
  });
}
profileRoutes.post("/v3/profiles/cards/:token/report", gate, writes, requireUser, async (c) => {
  noStore(c);
  const uid = c.get("userId");
  await rateLimitSubject(c, "v3-profile-report", uid, 20, 3600);
  const b = await readJson(c, 2_000);
  return c.json(await reportPlayerByCard(c.env.DB, await profileReporterHash(c.env, uid), uid, param(c, "token"), b), 202);
});
