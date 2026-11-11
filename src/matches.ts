import type { Env } from "./types";
import { HttpError, ID_RE, nowIso } from "./http";

/** Match core. Other features (scorer, results, ready, stages) call these after their own authorisation; none writes the matches table itself. */

export const MAX_MATCHES = 512;
export const MAX_BR_ROWS = 4000;
const MAX_HOPS = 128; // guards against a corrupt next_id loop

export type MatchStatus = "scheduled" | "ready" | "live" | "finished" | "forfeit";
export type Side = "a" | "b";
export type Winner = Side | "draw";
const STATUSES: readonly string[] = ["scheduled", "ready", "live", "finished", "forfeit"];

export interface Match {
  id: string;
  stage: string;
  round: number;
  slot: number;
  a: string;
  b: string;
  status: MatchStatus;
  scoreA: number | null;
  scoreB: number | null;
  winner: Winner | null;
  startsAt: string | null;
  nextId: string | null;
  nextSide: Side | null;
  updatedAt: string;
}

export interface BrResult { matchNo: number; team: string; placement: number; kills: number }

interface MatchRow {
  id: string; event_id: string; stage: string; round: number; slot: number; a: string; b: string; status: MatchStatus;
  score_a: number | null; score_b: number | null; winner: Winner | null; starts_at: string | null;
  next_id: string | null; next_side: Side | null; updated_at: string; updated_by: string | null;
}

const toMatch = (r: MatchRow): Match => ({
  id: r.id, stage: r.stage, round: r.round, slot: r.slot, a: r.a, b: r.b, status: r.status,
  scoreA: r.score_a, scoreB: r.score_b, winner: r.winner, startsAt: r.starts_at, nextId: r.next_id, nextSide: r.next_side, updatedAt: r.updated_at,
});

async function rows(env: Env, eventId: string): Promise<MatchRow[]> {
  const r = await env.DB.prepare("SELECT id, event_id, stage, round, slot, a, b, status, score_a, score_b, winner, starts_at, next_id, next_side, updated_at, updated_by FROM matches WHERE event_id = ? ORDER BY stage, round, slot, id LIMIT 600")
    .bind(eventId).all<MatchRow>();
  return r.results;
}

export async function listMatches(env: Env, eventId: string): Promise<Match[]> {
  return (await rows(env, eventId)).map(toMatch);
}

/** The subset of a match that is safe on a public page. */
export function publicMatch(m: Match) {
  return { id: m.id, stage: m.stage, round: m.round, slot: m.slot, a: m.a, b: m.b, status: m.status, scoreA: m.scoreA, scoreB: m.scoreB, startsAt: m.startsAt };
}

// ---------- validation helpers ----------
const bad = (m: string): never => { throw new HttpError(400, m); };
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function text(v: unknown, field: string, max: number): string {
  if (typeof v !== "string") return bad(`${field} must be a string`);
  const t = v.trim();
  if (t.length > max) return bad(`${field} must be at most ${max} characters`);
  return t;
}
function int(v: unknown, field: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return bad(`${field} must be a whole number between ${min} and ${max}`);
  return v;
}
function score(v: unknown, field: string): number | null {
  return v === null ? null : int(v, field, 0, 100000);
}
function side(v: unknown, field: string): Side | null {
  if (v === null) return null;
  if (v !== "a" && v !== "b") return bad(`${field} must be a or b`);
  return v;
}
function matchId(v: unknown, field: string): string {
  if (typeof v !== "string" || !ID_RE.test(v)) return bad(`${field} must be 1-48 characters of letters, digits, . _ ~ -`);
  return v;
}
function startsAt(v: unknown): string | null {
  if (v === null) return null;
  const t = text(v, "startsAt", 40);
  if (t === "") return null;
  if (Number.isNaN(Date.parse(t)) || !/^\d{4}-\d{2}-\d{2}/.test(t)) return bad("startsAt must be an ISO time");
  return t;
}

/** Winner implied by the scores of a finished match. */
export function deriveWinner(scoreA: number, scoreB: number): Winner {
  return scoreA > scoreB ? "a" : scoreB > scoreA ? "b" : "draw";
}

/** Brings status, scores and winner into a consistent shape. Throws 400 when they cannot be consistent. */
function normalise(m: Match): void {
  if (m.status === "finished") {
    if (m.scoreA === null || m.scoreB === null) bad("a finished match needs both scores");
    const w = deriveWinner(m.scoreA!, m.scoreB!);
    if (m.winner !== null && m.winner !== w) bad("winner does not match the scores");
    m.winner = w;
  } else if (m.status === "forfeit") {
    if (m.winner !== "a" && m.winner !== "b") bad("a forfeit needs a winner of a or b");
  } else {
    m.winner = null;
  }
}

// ---------- upsert ----------

export interface UpsertInput { matches: unknown; replaceStage?: unknown }

/**
 * Upserts matches by id (new ids are generated), optionally replacing a whole stage first. Validates strictly, enforces the per-event cap,
 * refuses ids that belong to another event, and returns the full list. All writes happen in one batch.
 */
export async function upsertMatches(env: Env, eventId: string, input: UpsertInput, by: string | null): Promise<Match[]> {
  if (!Array.isArray(input.matches)) return bad("matches must be an array");
  if (input.matches.length > MAX_MATCHES) return bad(`matches can have at most ${MAX_MATCHES} items`);
  const replaceStage = input.replaceStage === undefined || input.replaceStage === null ? null : text(input.replaceStage, "replaceStage", 40);

  const existing = (await rows(env, eventId)).map(toMatch);
  const byId = new Map<string, Match>();
  for (const m of existing) if (replaceStage === null || m.stage !== replaceStage) byId.set(m.id, m);
  const now = nowIso();
  const touched = new Set<string>();
  const providedIds: string[] = [];

  for (let i = 0; i < input.matches.length; i++) {
    const raw: unknown = input.matches[i];
    const f = `matches[${i}]`;
    if (!isObj(raw)) return bad(`${f} must be an object`);
    const id = raw.id === undefined || raw.id === null ? crypto.randomUUID() : matchId(raw.id, `${f}.id`);
    if (touched.has(id)) return bad(`${f}.id appears twice`);
    touched.add(id);
    if (raw.id !== undefined && raw.id !== null) providedIds.push(id);
    const cur = byId.get(id);
    const m: Match = cur ? { ...cur } : { id, stage: "main", round: 1, slot: 1, a: "", b: "", status: "scheduled", scoreA: null, scoreB: null, winner: null, startsAt: null, nextId: null, nextSide: null, updatedAt: now };
    if (raw.stage !== undefined) { m.stage = text(raw.stage, `${f}.stage`, 40); if (!m.stage) bad(`${f}.stage must not be empty`); }
    if (raw.round !== undefined) m.round = int(raw.round, `${f}.round`, 1, 999);
    if (raw.slot !== undefined) m.slot = int(raw.slot, `${f}.slot`, 1, 999);
    if (raw.a !== undefined) m.a = text(raw.a, `${f}.a`, 60);
    if (raw.b !== undefined) m.b = text(raw.b, `${f}.b`, 60);
    if (raw.status !== undefined) {
      if (typeof raw.status !== "string" || !STATUSES.includes(raw.status)) return bad(`${f}.status must be one of ${STATUSES.join(", ")}`);
      m.status = raw.status as MatchStatus;
    }
    if (raw.scoreA !== undefined) m.scoreA = score(raw.scoreA, `${f}.scoreA`);
    if (raw.scoreB !== undefined) m.scoreB = score(raw.scoreB, `${f}.scoreB`);
    if (raw.winner !== undefined) {
      if (raw.winner !== null && raw.winner !== "a" && raw.winner !== "b" && raw.winner !== "draw") return bad(`${f}.winner must be a, b, draw or null`);
      m.winner = raw.winner as Winner | null;
    }
    if (raw.startsAt !== undefined) m.startsAt = startsAt(raw.startsAt);
    if (raw.nextId !== undefined) m.nextId = raw.nextId === null ? null : matchId(raw.nextId, `${f}.nextId`);
    if (raw.nextSide !== undefined) m.nextSide = side(raw.nextSide, `${f}.nextSide`);
    if ((m.nextId === null) !== (m.nextSide === null)) return bad(`${f}: nextId and nextSide go together`);
    if (m.nextId === m.id) return bad(`${f}.nextId cannot point at the match itself`);
    // a status change away from finished clears a stale winner unless the caller sent one
    if (cur && raw.status !== undefined && raw.winner === undefined && m.status !== "forfeit") m.winner = null;
    try { normalise(m); } catch (e) { return bad(`${f}: ${(e as Error).message}`); }
    m.updatedAt = now;
    byId.set(id, m);
  }

  if (byId.size > MAX_MATCHES) return bad(`an event can have at most ${MAX_MATCHES} matches`);
  for (const m of byId.values()) {
    if (m.nextId !== null && !byId.has(m.nextId)) return bad(`match ${m.id}: nextId ${m.nextId} is not a match of this event`);
  }
  for (const start of byId.values()) {
    let hops = 0;
    for (let cur: Match | undefined = start; cur && cur.nextId; cur = byId.get(cur.nextId)) {
      if (++hops > byId.size) return bad("nextId chains must not loop");
    }
  }

  const db = env.DB;
  if (providedIds.length) {
    const clash = await db.prepare("SELECT id FROM matches WHERE event_id <> ?1 AND id IN (SELECT value FROM json_each(?2)) LIMIT 1")
      .bind(eventId, JSON.stringify(providedIds)).first<{ id: string }>();
    if (clash) throw new HttpError(409, "A match id is already used by another event");
  }
  const stmts = [];
  if (replaceStage !== null) stmts.push(db.prepare("DELETE FROM matches WHERE event_id = ? AND stage = ?").bind(eventId, replaceStage));
  for (const id of touched) {
    const m = byId.get(id)!;
    stmts.push(db.prepare(
      "INSERT INTO matches (id, event_id, stage, round, slot, a, b, status, score_a, score_b, winner, starts_at, next_id, next_side, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET stage = excluded.stage, round = excluded.round, slot = excluded.slot, a = excluded.a, b = excluded.b, status = excluded.status, score_a = excluded.score_a, score_b = excluded.score_b, winner = excluded.winner, starts_at = excluded.starts_at, next_id = excluded.next_id, next_side = excluded.next_side, updated_at = excluded.updated_at, updated_by = excluded.updated_by WHERE matches.event_id = excluded.event_id",
    ).bind(m.id, eventId, m.stage, m.round, m.slot, m.a, m.b, m.status, m.scoreA, m.scoreB, m.winner, m.startsAt, m.nextId, m.nextSide, m.updatedAt, by));
  }
  if (stmts.length) await db.batch(stmts);
  return listMatches(env, eventId);
}

/** Deletes every match of the event, or of one stage. Returns how many were removed. */
export async function deleteMatches(env: Env, eventId: string, stage: string | null): Promise<number> {
  const r = stage === null
    ? await env.DB.prepare("DELETE FROM matches WHERE event_id = ?").bind(eventId).run()
    : await env.DB.prepare("DELETE FROM matches WHERE event_id = ? AND stage = ?").bind(eventId, stage).run();
  return r.meta.changes ?? 0;
}

// ---------- results and knockout advancement ----------
export interface ResultInput { scoreA?: unknown; scoreB?: unknown; status?: unknown; winner?: unknown }


const hasResult = (m: MatchRow) => m.status === "finished" || m.status === "forfeit" || m.winner !== null;

/**
 * Applies a result. winner is derived from the scores (draws included) unless the match is a forfeit, which needs an explicit winner.
 * If the match has nextId/nextSide, the winner's name goes into that slot (a draw or an unset name empties it). Re-applying the same result changes nothing
 * downstream; changing a result changes the next slot and, if that slot's match already had a result, resets it and everything that depended on it.
 * Returns the updated match and the downstream matches that changed.
 */
export async function applyResult(env: Env, eventId: string, matchId: string, input: ResultInput, by: string | null): Promise<{ match: Match; changed: Match[] }> {
  const status = input.status === undefined || input.status === null ? "finished" : input.status;
  if (status !== "finished" && status !== "forfeit") return bad("status must be finished or forfeit");
  let sa: number | null = null;
  let sb: number | null = null;
  if (status === "finished") {
    sa = int(input.scoreA, "scoreA", 0, 100000);
    sb = int(input.scoreB, "scoreB", 0, 100000);
  } else {
    sa = input.scoreA === undefined ? null : score(input.scoreA, "scoreA");
    sb = input.scoreB === undefined ? null : score(input.scoreB, "scoreB");
  }
  if (input.winner !== undefined && input.winner !== null && input.winner !== "a" && input.winner !== "b") return bad("winner must be a or b");

  const all = await rows(env, eventId);
  const map = new Map(all.map((r) => [r.id, r]));
  const target = map.get(matchId);
  if (!target) throw new HttpError(404, "Match not found");

  let winner: Winner;
  if (status === "finished") {
    winner = deriveWinner(sa!, sb!);
    if (input.winner !== undefined && input.winner !== null && input.winner !== winner) return bad("winner does not match the scores");
  } else {
    if (input.winner !== "a" && input.winner !== "b") return bad("a forfeit needs a winner of a or b");
    winner = input.winner;
  }

  const now = nowIso();
  const dirty = new Set<string>([target.id]);
  target.status = status;
  target.score_a = sa;
  target.score_b = sb;
  target.winner = winner;
  target.updated_at = now;
  target.updated_by = by;

  // Puts `value` into a slot of match `id`; if that changes the slot and the match already has a result, the result is stale: reset it and unwind what it advanced.
  const setSlot = (id: string, s: Side, value: string, hops: number): void => {
    if (hops > MAX_HOPS) return;
    const m = map.get(id);
    if (!m || m[s] === value) return;
    m[s] = value;
    m.updated_at = now;
    m.updated_by = by;
    dirty.add(id);
    if (hasResult(m)) {
      m.status = "scheduled";
      m.score_a = null;
      m.score_b = null;
      m.winner = null;
      if (m.next_id && m.next_side) setSlot(m.next_id, m.next_side, "", hops + 1);
    }
  };

  if (target.next_id && target.next_side) {
    setSlot(target.next_id, target.next_side, winner === "a" ? target.a : winner === "b" ? target.b : "", 0);
  }

  const db = env.DB;
  await db.batch([...dirty].map((id) => {
    const m = map.get(id)!;
    return db.prepare(
      "UPDATE matches SET a = ?, b = ?, status = ?, score_a = ?, score_b = ?, winner = ?, updated_at = ?, updated_by = ? WHERE id = ? AND event_id = ?",
    ).bind(m.a, m.b, m.status, m.score_a, m.score_b, m.winner, m.updated_at, m.updated_by, m.id, eventId);
  }));
  return { match: toMatch(target), changed: [...dirty].filter((id) => id !== target.id).map((id) => toMatch(map.get(id)!)) };
}

// ---------- battle royale ----------
export async function listBr(env: Env, eventId: string): Promise<BrResult[]> {
  const r = await env.DB.prepare("SELECT match_no, team, placement, kills FROM br_results WHERE event_id = ? ORDER BY match_no, placement, team LIMIT 4100")
    .bind(eventId).all<{ match_no: number; team: string; placement: number; kills: number }>();
  return r.results.map((x) => ({ matchNo: x.match_no, team: x.team, placement: x.placement, kills: x.kills }));
}


/** Upserts battle royale rows by (matchNo, team); `replace` removes every existing row first. Returns the full list. */
export async function putBr(env: Env, eventId: string, input: { results: unknown; replace?: unknown }): Promise<BrResult[]> {
  if (!Array.isArray(input.results)) return bad("results must be an array");
  if (input.results.length > MAX_BR_ROWS) return bad(`results can have at most ${MAX_BR_ROWS} items`);
  if (input.replace !== undefined && typeof input.replace !== "boolean") return bad("replace must be a boolean");
  const replace = input.replace === true;
  const incoming = new Map<string, BrResult>();
  input.results.forEach((raw: unknown, i: number) => {
    if (!isObj(raw)) return bad(`results[${i}] must be an object`);
    const team = text(raw.team, `results[${i}].team`, 60);
    if (!team) return bad(`results[${i}].team must not be empty`);
    const r: BrResult = {
      matchNo: int(raw.matchNo, `results[${i}].matchNo`, 1, 9999),
      team,
      placement: int(raw.placement, `results[${i}].placement`, 1, 200),
      kills: raw.kills === undefined ? 0 : int(raw.kills, `results[${i}].kills`, 0, 999),
    };
    incoming.set(`${r.matchNo}|${r.team}`, r);
  });
  const cur = replace ? [] : await listBr(env, eventId);
  const keys = new Set(cur.map((x) => `${x.matchNo}|${x.team}`));
  for (const k of incoming.keys()) keys.add(k);
  if (keys.size > MAX_BR_ROWS) return bad(`an event can have at most ${MAX_BR_ROWS} battle royale rows`);
  const db = env.DB;
  const now = nowIso();
  const stmts = [];
  if (replace) stmts.push(db.prepare("DELETE FROM br_results WHERE event_id = ?").bind(eventId));
  for (const r of incoming.values()) stmts.push(db.prepare(
      "INSERT INTO br_results (event_id, match_no, team, placement, kills, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (event_id, match_no, team) DO UPDATE SET placement = excluded.placement, kills = excluded.kills, updated_at = excluded.updated_at",
    ).bind(eventId, r.matchNo, r.team, r.placement, r.kills, now));
  if (stmts.length) await db.batch(stmts);
  return listBr(env, eventId);
}
