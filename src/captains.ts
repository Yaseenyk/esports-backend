import { randomToken, sha256 } from "./crypto";
import type { Env } from "./types";

/**
 * Captain links are shared by the features that talk to team captains (result submission, ready-check).
 * A link is bound to one team of one event. Only the hash of the token is stored, and a link can be revoked.
 * Authorisation of who may CREATE links is the caller's job (owner or editor of the event); resolving a token needs no sign-in.
 */
export interface CaptainLink { id: string; eventId: string; team: string; createdAt: string; revokedAt: string | null }
export interface CaptainContext { linkId: string; eventId: string; team: string }

const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
const row = (r: { id: string; event_id: string; team: string; created_at: string; revoked_at: string | null }): CaptainLink => ({ id: r.id, eventId: r.event_id, team: r.team, createdAt: r.created_at, revokedAt: r.revoked_at });

/** Makes a fresh link for a team and revokes the team's older active ones, so there is only ever one live link per team. The token is returned once. */
export async function createCaptainLink(env: Env, eventId: string, team: string): Promise<{ link: CaptainLink; token: string }> {
  const name = team.replace(/\s+/g, " ").trim().slice(0, 60);
  if (!name) throw new Error("team name is required");
  const token = randomToken(24);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE captain_links SET revoked_at = ? WHERE event_id = ? AND team = ? AND revoked_at IS NULL").bind(now, eventId, name),
    env.DB.prepare("INSERT INTO captain_links (id, event_id, team, token_hash, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)").bind(id, eventId, name, await sha256(token), now),
  ]);
  return { link: { id, eventId, team: name, createdAt: now, revokedAt: null }, token };
}

/** The team and event a token belongs to, or null for anything unknown, malformed or revoked. */
export async function resolveCaptainToken(env: Env, token: string): Promise<CaptainContext | null> {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
  const r = await env.DB.prepare("SELECT id, event_id, team FROM captain_links WHERE token_hash = ? AND revoked_at IS NULL").bind(await sha256(token)).first<{ id: string; event_id: string; team: string }>();
  return r ? { linkId: r.id, eventId: r.event_id, team: r.team } : null;
}

export async function listCaptainLinks(env: Env, eventId: string): Promise<CaptainLink[]> {
  const r = await env.DB.prepare("SELECT id, event_id, team, created_at, revoked_at FROM captain_links WHERE event_id = ? ORDER BY team, created_at DESC LIMIT 512").bind(eventId).all<{ id: string; event_id: string; team: string; created_at: string; revoked_at: string | null }>();
  return (r.results ?? []).map(row);
}

export async function revokeCaptainLink(env: Env, eventId: string, id: string): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE captain_links SET revoked_at = ? WHERE id = ? AND event_id = ? AND revoked_at IS NULL").bind(new Date().toISOString(), id, eventId).run();
  return (r.meta?.changes ?? 0) > 0;
}
