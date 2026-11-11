import { Hono } from "hono";
import type { AppBindings } from "../types";
import { HttpError, idStr, optStr, rateLimitSubject, readJson } from "../http";
import { ownedEvent, requireUser } from "../auth";
import { applyResult, deleteMatches, listBr, listMatches, putBr, upsertMatches } from "../matches";
import type { RouteRules } from "./types";

export const routes = new Hono<AppBindings>();

const EDIT = ["owner", "editor"] as const;
const READ = ["owner", "editor", "viewer"] as const;

export const routeRules: RouteRules = {
  "GET /events/:id/matches": { roles: [...READ] },
  "PUT /events/:id/matches": { roles: [...EDIT], limit: "120/hour/user" },
  "DELETE /events/:id/matches": { roles: [...EDIT], limit: "60/hour/user" },
  "POST /events/:id/matches/:mid/result": { roles: [...EDIT], limit: "600/hour/user" },
  "GET /events/:id/br-results": { roles: [...READ] },
  "PUT /events/:id/br-results": { roles: [...EDIT], limit: "120/hour/user" },
};

// Authorisation (404 stranger, 403 viewer write) always comes before the body is read.
routes.get("/events/:id/matches", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  return c.json({ matches: await listMatches(c.env, ev.id), br: await listBr(c.env, ev.id) });
});

routes.put("/events/:id/matches", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "matchesPut", c.get("userId"), 120, 3600);
  const b = await readJson(c, 600_000);
  const matches = await upsertMatches(c.env, ev.id, { matches: b.matches, replaceStage: b.replaceStage }, c.get("userId"));
  return c.json({ matches });
});

routes.post("/events/:id/matches/:mid/result", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "matchResult", c.get("userId"), 600, 3600);
  const mid = c.req.param("mid");
  const b = await readJson(c, 4_000);
  return c.json(await applyResult(c.env, ev.id, idStr(mid, "match id"), b, c.get("userId")));
});

routes.delete("/events/:id/matches", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "matchesDelete", c.get("userId"), 60, 3600);
  const q = c.req.query("stage");
  const stage = q === undefined ? null : optStr(q, "stage", 40);
  if (q !== undefined && !stage) throw new HttpError(400, "stage must not be empty");
  return c.json({ ok: true, deleted: await deleteMatches(c.env, ev.id, stage) });
});

routes.get("/events/:id/br-results", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  return c.json({ results: await listBr(c.env, ev.id) });
});

routes.put("/events/:id/br-results", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "brPut", c.get("userId"), 120, 3600);
  const b = await readJson(c, 600_000);
  return c.json({ results: await putBr(c.env, ev.id, { results: b.results, replace: b.replace }) });
});
