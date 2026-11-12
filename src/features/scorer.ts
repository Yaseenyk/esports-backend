import { Hono } from "hono";
import type { AppBindings, Env } from "../types";
import { HttpError, idStr, inHours, nowIso, rateLimit, rateLimitSoft, rateLimitSubject, readJson, str, type Ctx } from "../http";
import { ownedEvent, requireUser } from "../auth";
import { randomToken, sha256 } from "../crypto";
import { applyResult, listBr, listMatches, putBr, upsertMatches, type Match } from "../matches";
import type { RouteRules } from "./types";
import { takenDown } from "../moderation/takedown";
import { killGate } from "../admin/kill";

/**
 * Scorer mode. An organiser makes a link; whoever holds it can enter results for the matches in its scope, nothing else.
 * Results are written only through applyResult / upsertMatches / putBr (src/matches.ts), never straight to the tables.
 */
export const routes = new Hono<AppBindings>();

const EDIT = ["owner", "editor"] as const;
const DEFAULT_HOURS = 12;
const MAX_HOURS = 72;
const MAX_ACTIVE_LINKS = 50;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
/** Stage name a link needs for battle royale entry when it is scoped to one stage. */
const BR_STAGE = "br";
/** The app offers Undo for 2 minutes; the server allows a little more for slow phones. */
const UNDO_WINDOW_MS = 5 * 60_000;

export const routeRules: RouteRules = {
  "GET /events/:id/scorer-links": { roles: [...EDIT] },
  "POST /events/:id/scorer-links": { roles: [...EDIT], limit: "30/hour/user" },
  "DELETE /events/:id/scorer-links/:linkId": { roles: [...EDIT], limit: "60/hour/user" },
  "GET /public/score/:token": { public: true, limit: "300/10min/token, 600/10min/IP, 20 failed lookups/10min/IP" },
  "POST /public/score/:token/matches/:mid/result": { public: true, limit: "120/10min/token, 600/10min/IP" },
  "POST /public/score/:token/br": { public: true, limit: "120/10min/token, 600/10min/IP" },
};

interface LinkRow { id: string; event_id: string; label: string; stage: string | null; expires_at: string; revoked_at: string | null; created_at: string }
interface Scope { linkId: string; eventId: string; label: string; stage: string | null; expiresAt: string }

function linkJson(r: LinkRow) {
  const state = r.revoked_at ? "revoked" : r.expires_at <= nowIso() ? "expired" : "active";
  return { id: r.id, label: r.label, stage: r.stage, expiresAt: r.expires_at, revokedAt: r.revoked_at, createdAt: r.created_at, state };
}

function noViewers(role: string): void {
  if (role === "viewer") throw new HttpError(403, "You can view this event but not manage scorer links");
}

routes.get("/events/:id/scorer-links", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  noViewers(ev.my_role);
  const r = await c.env.DB.prepare("SELECT id, event_id, label, stage, expires_at, revoked_at, created_at FROM scorer_links WHERE event_id = ? ORDER BY created_at DESC LIMIT 200")
    .bind(ev.id).all<LinkRow>();
  return c.json({ links: r.results.map(linkJson) });
});

routes.post("/events/:id/scorer-links", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  noViewers(ev.my_role);
  await rateLimitSubject(c, "scorerLinkMake", c.get("userId"), 30, 3600);
  const b = await readJson(c, 4_000);
  const label = str(b.label, "label", 1, 40).replace(/\s+/g, " ");
  let stage: string | null = null;
  if (b.stage !== undefined && b.stage !== null) stage = str(b.stage, "stage", 0, 40) || null;
  let hours = DEFAULT_HOURS;
  if (b.hours !== undefined && b.hours !== null) {
    if (typeof b.hours !== "number" || !Number.isFinite(b.hours) || b.hours < 0.25 || b.hours > MAX_HOURS) throw new HttpError(400, `hours must be a number between 0.25 and ${MAX_HOURS}`);
    hours = b.hours;
  }
  const now = nowIso();
  const active = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM scorer_links WHERE event_id = ? AND revoked_at IS NULL AND expires_at > ?").bind(ev.id, now).first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_ACTIVE_LINKS) throw new HttpError(409, "Too many active scorer links. Revoke some you no longer need.");
  const token = randomToken(24);
  const id = crypto.randomUUID();
  const expiresAt = inHours(hours)!;
  await c.env.DB.prepare("INSERT INTO scorer_links (id, event_id, label, token_hash, stage, expires_at, revoked_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)")
    .bind(id, ev.id, label, await sha256(token), stage, expiresAt, c.get("userId"), now).run();
  return c.json({ link: { id, label, stage, expiresAt, revokedAt: null, createdAt: now, state: "active" }, token }, 201);
});

routes.delete("/events/:id/scorer-links/:linkId", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  noViewers(ev.my_role);
  await rateLimitSubject(c, "scorerLinkRevoke", c.get("userId"), 60, 3600);
  const lid = idStr(c.req.param("linkId"), "link id");
  const r = await c.env.DB.prepare("UPDATE scorer_links SET revoked_at = ? WHERE id = ? AND event_id = ? AND revoked_at IS NULL").bind(nowIso(), lid, ev.id).run();
  if ((r.meta?.changes ?? 0) === 0) {
    const exists = await c.env.DB.prepare("SELECT 1 AS x FROM scorer_links WHERE id = ? AND event_id = ?").bind(lid, ev.id).first();
    if (!exists) throw new HttpError(404, "Scorer link not found");
  }
  return c.json({ ok: true });
});

// ---------- public side ----------

const notFound = () => new HttpError(404, "This scoring link is not valid. Ask the organiser for a new one.");

/** Resolves a token to its scope. Unknown, malformed, revoked and expired all give the same 404. Failed lookups are throttled per IP. */
async function resolve(c: Ctx, token: string, perTokenLimit: number): Promise<Scope> {
  rateLimitSoft(c, "scoreIp", 600, 600);
  if (typeof token !== "string" || !TOKEN_RE.test(token)) { await rateLimit(c, "scoreFail", 20, 600); throw notFound(); }
  const hash = await sha256(token);
  const r = await c.env.DB.prepare("SELECT id, event_id, label, stage, expires_at, revoked_at, created_at FROM scorer_links WHERE token_hash = ?").bind(hash).first<LinkRow>();
  if (!r || r.revoked_at !== null || r.expires_at <= nowIso()) { await rateLimit(c, "scoreFail", 20, 600); throw notFound(); }
  if (await takenDown(c.env.DB, { type: "event", id: r.event_id, eventId: r.event_id })) { await rateLimit(c, "scoreFail", 20, 600); throw notFound(); }
  await rateLimitSubject(c, `scoreTok${perTokenLimit}`, hash, perTokenLimit, 600);
  return { linkId: r.id, eventId: r.event_id, label: r.label, stage: r.stage, expiresAt: r.expires_at };
}

const inScope = (s: Scope, m: Match) => s.stage === null || m.stage === s.stage;
const brAllowed = (s: Scope) => s.stage === null || s.stage === BR_STAGE;

async function teamNames(env: Env, eventId: string, matches: Match[]): Promise<string[]> {
  const r = await env.DB.prepare("SELECT name FROM teams WHERE event_id = ? ORDER BY name LIMIT 600").bind(eventId).all<{ name: string }>();
  const set = new Set<string>(r.results.map((x) => x.name));
  for (const m of matches) { if (m.a) set.add(m.a); if (m.b) set.add(m.b); }
  return [...set].sort((x, y) => x.localeCompare(y)).slice(0, 600);
}

const scorerMatch = (m: Match) => ({ id: m.id, stage: m.stage, round: m.round, slot: m.slot, a: m.a, b: m.b, status: m.status, scoreA: m.scoreA, scoreB: m.scoreB, startsAt: m.startsAt, winner: m.winner });

routes.get("/public/score/:token", async (c) => {
  const s = await resolve(c, c.req.param("token"), 300);
  const ev = await c.env.DB.prepare("SELECT name FROM events WHERE id = ?").bind(s.eventId).first<{ name: string }>();
  if (!ev) throw notFound();
  const all = await listMatches(c.env, s.eventId);
  const allowBr = brAllowed(s);
  return c.json({
    event: { name: ev.name },
    label: s.label,
    stage: s.stage,
    expiresAt: s.expiresAt,
    matches: all.filter((m) => inScope(s, m)).map(scorerMatch),
    battleRoyale: { allowed: allowBr, teams: allowBr ? await teamNames(c.env, s.eventId, all) : [], rows: allowBr ? await listBr(c.env, s.eventId) : [] },
  }, 200, { "cache-control": "no-store" });
});

routes.post("/public/score/:token/matches/:mid/result", async (c) => {
  const off = await killGate(c, "kill.public_writes");
  if (off) return off;
  const s = await resolve(c, c.req.param("token"), 120);
  const mid = idStr(c.req.param("mid"), "match id");
  const b = await readJson(c, 4_000);
  const status = b.status === undefined || b.status === null ? "finished" : b.status;
  if (status !== "finished" && status !== "forfeit" && status !== "live") throw new HttpError(400, "status must be finished, forfeit or live");
  const all = await listMatches(c.env, s.eventId);
  const cur = all.find((m) => m.id === mid);
  if (!cur || !inScope(s, cur)) throw new HttpError(404, "Match not found");
  if (!cur.a || !cur.b) throw new HttpError(409, "Both teams must be decided before a result can be entered");
  const by = `scorer:${s.label}`;
  const wasFinal = cur.status === "finished" || cur.status === "forfeit";

  if (status === "live") {
    const patch: Record<string, unknown>[] = [{ id: mid, status: "live" }];
    if (b.scoreA !== undefined) patch[0]!.scoreA = b.scoreA;
    if (b.scoreB !== undefined) patch[0]!.scoreB = b.scoreB;
    if (wasFinal) {
      // Reopening a finished match is only the "Undo" of a save made moments ago, and only while the winner has not been played on from.
      if (b.undo !== true) throw new HttpError(409, "This match is already finished. Save the corrected result instead.");
      if (Date.now() - Date.parse(cur.updatedAt) > UNDO_WINDOW_MS) throw new HttpError(409, "It is too late to undo. Ask the organiser to change the result.");
      if (cur.nextId && cur.nextSide) {
        const next = all.find((m) => m.id === cur.nextId);
        if (next && (next.status === "finished" || next.status === "forfeit")) throw new HttpError(409, "The winner has already been played on, so this cannot be undone here. Ask the organiser.");
        if (next) patch.push({ id: next.id, [cur.nextSide]: "" });
      }
      patch[0]!.scoreA = b.scoreA ?? null;
      patch[0]!.scoreB = b.scoreB ?? null;
    }
    const list = await upsertMatches(c.env, s.eventId, { matches: patch }, by);
    return c.json({ match: scorerMatch(list.find((m) => m.id === mid)!), changed: [], correction: wasFinal, previous: wasFinal ? { status: cur.status, scoreA: cur.scoreA, scoreB: cur.scoreB } : null, downstreamReset: false });
  }

  const r = await applyResult(c.env, s.eventId, mid, { scoreA: b.scoreA, scoreB: b.scoreB, status, winner: b.winner }, by);
  return c.json({
    match: scorerMatch(r.match),
    changed: r.changed.filter((m) => inScope(s, m)).map(scorerMatch),
    correction: wasFinal,
    previous: wasFinal ? { status: cur.status, scoreA: cur.scoreA, scoreB: cur.scoreB } : null,
    downstreamReset: wasFinal && r.changed.length > 0,
  });
});

routes.post("/public/score/:token/br", async (c) => {
  const off = await killGate(c, "kill.public_writes");
  if (off) return off;
  const s = await resolve(c, c.req.param("token"), 120);
  if (!brAllowed(s)) throw new HttpError(403, "This link is not for battle royale results");
  const b = await readJson(c, 40_000);
  const matchNo = b.matchNo;
  if (typeof matchNo !== "number" || !Number.isInteger(matchNo) || matchNo < 1 || matchNo > 9999) throw new HttpError(400, "matchNo must be a whole number from 1 to 9999");
  if (!Array.isArray(b.rows) || b.rows.length === 0 || b.rows.length > 100) throw new HttpError(400, "rows must list between 1 and 100 teams");
  const allowed = new Set(await teamNames(c.env, s.eventId, await listMatches(c.env, s.eventId)));
  const seenTeam = new Set<string>();
  const seenPlace = new Set<number>();
  const results: { matchNo: number; team: string; placement: number; kills: unknown }[] = [];
  for (const raw of b.rows as unknown[]) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new HttpError(400, "each row must be an object");
    const row = raw as Record<string, unknown>;
    const team = str(row.team, "team", 1, 60);
    if (!allowed.has(team)) throw new HttpError(400, `${team} is not a team of this event`);
    if (seenTeam.has(team)) throw new HttpError(400, `${team} appears twice`);
    seenTeam.add(team);
    const placement = row.placement;
    if (typeof placement !== "number" || !Number.isInteger(placement) || placement < 1 || placement > 200) throw new HttpError(400, "placement must be a whole number from 1 to 200");
    if (seenPlace.has(placement)) throw new HttpError(400, `placement ${placement} is used twice`);
    seenPlace.add(placement);
    results.push({ matchNo, team, placement, kills: row.kills });
  }
  const rows = await putBr(c.env, s.eventId, { results });
  return c.json({ ok: true, saved: results.length, rows: rows.filter((x) => x.matchNo === matchNo) });
});
