import { Hono } from "hono";
import type { AppBindings, Env } from "../types";
import { HttpError, idStr, nowIso, rateLimit, rateLimitSubject, readJson, str } from "../http";
import { ownedEvent, requireUser } from "../auth";
import { resolveCaptainToken } from "../captains";
import { applyResult, listMatches, upsertMatches, type Match } from "../matches";
import type { RouteRules } from "./types";

/**
 * Team ready-check and forfeit timers.
 * A captain taps "we are here and ready" on their captain link; the organiser sees a live board and decides about forfeits (never automatic).
 * Matches change only through applyResult / upsertMatches.
 */
export const routes = new Hono<AppBindings>();

const EDIT = ["owner", "editor"] as const;

export const routeRules: RouteRules = {
  "GET /events/:id/ready": { roles: [...EDIT] },
  "PUT /events/:id/ready/settings": { roles: [...EDIT], limit: "60/hour/user" },
  "POST /events/:id/ready/:mid/forfeit": { roles: [...EDIT], limit: "300/hour/user" },
  "POST /events/:id/ready/:mid/clear": { roles: [...EDIT], limit: "300/hour/user" },
  "GET /public/ready/:token": { public: true, limit: "120/min/ip" },
  "POST /public/ready/:token/matches/:mid": { public: true, limit: "40/min/ip, 60/min/link" },
};

export const DEFAULT_GRACE = 10;
export const MAX_GRACE = 120;
export const READY_WINDOW_MIN = 60; // a captain may mark ready from this long before the start
export const LOOKAHEAD_H = 24;
const LOOKBACK_H = 6; // a match that should have started up to this long ago still shows (it is late)
const OPEN_STATUSES = ["scheduled", "ready", "live"];

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** Pure: the grace deadline as epoch ms, or null when the match has no start time. */
export function graceDeadline(startsAt: string | null, graceMinutes: number): number | null {
  const s = ms(startsAt);
  return s === null ? null : s + graceMinutes * 60_000;
}

/** Pure: may a captain change ready state now? From 60 minutes before the start until the match is live (or over). */
export function inReadyWindow(m: { status: string; startsAt: string | null }, now: number): boolean {
  if (m.status !== "scheduled" && m.status !== "ready") return false;
  const s = ms(m.startsAt);
  return s !== null && now >= s - READY_WINDOW_MIN * 60_000;
}

async function graceFor(env: Env, eventId: string): Promise<number> {
  const r = await env.DB.prepare("SELECT grace_minutes FROM ready_settings WHERE event_id = ?").bind(eventId).first<{ grace_minutes: number }>();
  return r ? r.grace_minutes : DEFAULT_GRACE;
}

/** match id -> set of normalised team names that are ready, with their time. */
async function readyMap(env: Env, eventId: string): Promise<Map<string, Map<string, string>>> {
  const r = await env.DB.prepare("SELECT match_id, team, ready_at FROM ready_checks WHERE event_id = ? LIMIT 2000")
    .bind(eventId).all<{ match_id: string; team: string; ready_at: string }>();
  const out = new Map<string, Map<string, string>>();
  for (const x of r.results ?? []) {
    let m = out.get(x.match_id);
    if (!m) out.set(x.match_id, (m = new Map()));
    m.set(norm(x.team), x.ready_at);
  }
  return out;
}

const sideOf = (m: Match, team: string): "a" | "b" | null => {
  const t = norm(team);
  if (t === "") return null;
  if (norm(m.a) === t) return "a";
  if (norm(m.b) === t) return "b";
  return null;
};

// ---------- organiser ----------

routes.get("/events/:id/ready", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  if (ev.my_role === "viewer") throw new HttpError(403, "Only the owner or an editor can run the ready board");
  const grace = await graceFor(c.env, ev.id);
  const ready = await readyMap(c.env, ev.id);
  const now = Date.now();
  const list = (await listMatches(c.env, ev.id)).filter((m) => OPEN_STATUSES.includes(m.status) && (m.a !== "" || m.b !== ""));
  const matches = list.map((m) => {
    const r = ready.get(m.id);
    const aAt = r?.get(norm(m.a)) ?? null;
    const bAt = r?.get(norm(m.b)) ?? null;
    const deadline = graceDeadline(m.startsAt, grace);
    const pastDeadline = deadline !== null && now > deadline && m.status !== "live";
    const late: ("a" | "b")[] = [];
    if (pastDeadline && m.a !== "" && !aAt) late.push("a");
    if (pastDeadline && m.b !== "" && !bAt) late.push("b");
    return {
      id: m.id, stage: m.stage, round: m.round, slot: m.slot, a: m.a, b: m.b, status: m.status, startsAt: m.startsAt,
      aReady: aAt !== null, bReady: bAt !== null, aReadyAt: aAt, bReadyAt: bAt,
      graceDeadline: deadline === null ? null : new Date(deadline).toISOString(), late,
    };
  });
  return c.json({ settings: { graceMinutes: grace }, serverTime: new Date(now).toISOString(), matches });
});

routes.put("/events/:id/ready/settings", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "readySettings", c.get("userId"), 60, 3600);
  const b = await readJson(c, 2_000);
  const g = b.graceMinutes;
  if (typeof g !== "number" || !Number.isInteger(g) || g < 0 || g > MAX_GRACE) throw new HttpError(400, `graceMinutes must be a whole number between 0 and ${MAX_GRACE}`);
  await c.env.DB.prepare("INSERT INTO ready_settings (event_id, grace_minutes, updated_at) VALUES (?, ?, ?) ON CONFLICT (event_id) DO UPDATE SET grace_minutes = excluded.grace_minutes, updated_at = excluded.updated_at")
    .bind(ev.id, g, nowIso()).run();
  return c.json({ settings: { graceMinutes: g } });
});

async function findMatch(env: Env, eventId: string, mid: string): Promise<Match> {
  const m = (await listMatches(env, eventId)).find((x) => x.id === mid);
  if (!m) throw new HttpError(404, "Match not found");
  return m;
}

routes.post("/events/:id/ready/:mid/forfeit", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "readyForfeit", c.get("userId"), 300, 3600);
  const mid = idStr(c.req.param("mid"), "match id");
  const b = await readJson(c, 2_000);
  const team = str(b.team, "team", 1, 60);
  if (b.noShow !== undefined && typeof b.noShow !== "boolean") throw new HttpError(400, "noShow must be a boolean");
  const noShow = b.noShow === true;
  const m = await findMatch(c.env, ev.id, mid);
  const side = sideOf(m, team);
  if (!side) throw new HttpError(400, "That team is not in this match");
  if (m.status !== "scheduled" && m.status !== "ready") throw new HttpError(409, "This match has already started or finished");
  const other = side === "a" ? m.b : m.a;
  if (other === "") throw new HttpError(400, "The other side of this match is not decided yet");
  if (!noShow) {
    const r = (await readyMap(c.env, ev.id)).get(m.id);
    if (!r?.has(norm(other))) throw new HttpError(409, "The other team has not marked itself ready. Confirm that no one showed up to forfeit anyway.");
  }
  const out = await applyResult(c.env, ev.id, m.id, { status: "forfeit", winner: side === "a" ? "b" : "a" }, c.get("userId"));
  return c.json({ match: out.match, changed: out.changed });
});

routes.post("/events/:id/ready/:mid/clear", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "readyClear", c.get("userId"), 300, 3600);
  const m = await findMatch(c.env, ev.id, idStr(c.req.param("mid"), "match id"));
  const r = await c.env.DB.prepare("DELETE FROM ready_checks WHERE event_id = ? AND match_id = ?").bind(ev.id, m.id).run();
  if (m.status === "ready") await upsertMatches(c.env, ev.id, { matches: [{ id: m.id, status: "scheduled" }] }, c.get("userId"));
  return c.json({ ok: true, cleared: r.meta?.changes ?? 0 });
});

// ---------- captain (public) ----------

routes.get("/public/ready/:token", async (c) => {
  await rateLimit(c, "readyPubGet", 120, 60);
  const ctx = await resolveCaptainToken(c.env, c.req.param("token"));
  if (!ctx) throw new HttpError(404, "This link is not valid. Ask the organiser for a new one.");
  const grace = await graceFor(c.env, ctx.eventId);
  const ready = await readyMap(c.env, ctx.eventId);
  const now = Date.now();
  const out = [];
  for (const m of await listMatches(c.env, ctx.eventId)) {
    const side = sideOf(m, ctx.team);
    if (!side || !OPEN_STATUSES.includes(m.status)) continue;
    const s = ms(m.startsAt);
    if (s === null || s > now + LOOKAHEAD_H * 3600_000 || s < now - LOOKBACK_H * 3600_000) continue;
    const opp = side === "a" ? m.b : m.a;
    const r = ready.get(m.id);
    const deadline = graceDeadline(m.startsAt, grace)!;
    out.push({
      id: m.id, stage: m.stage, round: m.round, opponent: opp, startsAt: m.startsAt, status: m.status,
      youReady: r?.has(norm(ctx.team)) === true, opponentReady: opp !== "" && r?.has(norm(opp)) === true,
      minutesToGrace: Math.ceil((deadline - now) / 60_000), canMark: opp !== "" && inReadyWindow(m, now),
    });
  }
  out.sort((x, y) => Date.parse(x.startsAt!) - Date.parse(y.startsAt!));
  const row = await c.env.DB.prepare("SELECT name FROM events WHERE id = ?").bind(ctx.eventId).first<{ name: string }>();
  c.header("Cache-Control", "no-store");
  return c.json({ team: ctx.team, eventName: row?.name ?? "", graceMinutes: grace, serverTime: new Date(now).toISOString(), matches: out });
});

routes.post("/public/ready/:token/matches/:mid", async (c) => {
  await rateLimit(c, "readyPubPost", 40, 60);
  const token = c.req.param("token");
  const ctx = await resolveCaptainToken(c.env, token);
  if (!ctx) throw new HttpError(404, "This link is not valid. Ask the organiser for a new one.");
  await rateLimitSubject(c, "readyPubLink", ctx.linkId, 60, 60);
  const mid = idStr(c.req.param("mid"), "match id");
  const b = await readJson(c, 1_000);
  if (typeof b.ready !== "boolean") throw new HttpError(400, "ready must be true or false");
  const m = (await listMatches(c.env, ctx.eventId)).find((x) => x.id === mid);
  const side = m ? sideOf(m, ctx.team) : null;
  if (!m || !side) throw new HttpError(404, "Match not found");
  const opp = side === "a" ? m.b : m.a;
  if (opp === "") throw new HttpError(409, "Your opponent is not decided yet.");
  if (m.status === "live") throw new HttpError(409, "This match is already live.");
  if (m.status !== "scheduled" && m.status !== "ready") throw new HttpError(409, "This match is already finished.");
  const s = ms(m.startsAt);
  if (s === null) throw new HttpError(409, "This match has no start time yet.");
  if (!inReadyWindow(m, Date.now())) throw new HttpError(409, `You can tap ready from ${READY_WINDOW_MIN} minutes before the start.`);

  if (b.ready) {
    await c.env.DB.prepare("INSERT INTO ready_checks (id, event_id, match_id, team, ready_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (match_id, team) DO NOTHING")
      .bind(crypto.randomUUID(), ctx.eventId, m.id, ctx.team, nowIso()).run();
  } else {
    await c.env.DB.prepare("DELETE FROM ready_checks WHERE event_id = ? AND match_id = ? AND team = ?").bind(ctx.eventId, m.id, ctx.team).run();
  }
  const r = (await readyMap(c.env, ctx.eventId)).get(m.id);
  const youReady = r?.has(norm(ctx.team)) === true;
  const opponentReady = r?.has(norm(opp)) === true;
  const both = youReady && opponentReady;
  let status = m.status;
  if (both && m.status === "scheduled") status = "ready";
  else if (!both && m.status === "ready") status = "scheduled";
  if (status !== m.status) await upsertMatches(c.env, ctx.eventId, { matches: [{ id: m.id, status }] }, null);
  return c.json({ ok: true, youReady, opponentReady, status });
});
