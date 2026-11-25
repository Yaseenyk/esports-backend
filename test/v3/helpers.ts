import { env } from "cloudflare:workers";
import app from "../../src/index";
import { createCaptainLink } from "../../src/captains";
import { resetFlagsCache } from "../../src/flags";
import type { Opts } from "../helpers";
import { freshIp, newEvent, newUser, uniq } from "../helpers";

export const db = env.DB;
export const nowSec = () => Math.floor(Date.now() / 1000);
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

export type V3Flag = "v3.tournaments" | "v3.resume" | "v3.lft" | "v3.disputes" | "v3.discord" | "v3.profiles" | "v3.scrims" | "v3.directory" | "v3.rooms" | "v3.recaps" | "v3.screenshots" | "v3.journal" | "v3.achievements" | "takedown.enforce" | "kill.directory" | "kill.public_writes" | "kill.uploads";

/** Turns exactly the listed flags ON (every other v3 flag is removed = default OFF) and forgets the isolate cache. */
export async function flagsOn(...on: V3Flag[]): Promise<void> {
  await db.prepare("DELETE FROM flags WHERE key LIKE 'v3.%' OR key IN ('takedown.enforce','kill.directory','kill.public_writes','kill.uploads')").run();
  for (const k of on) await db.prepare("INSERT INTO flags (key, value, updated_by, updated_at, note) VALUES (?1, 'true', 'test', ?2, '')").bind(k, new Date().toISOString()).run();
  resetFlagsCache();
}
export const allV3On = () => flagsOn("v3.tournaments", "v3.resume", "v3.lft", "v3.disputes");

/** Like test/helpers `call`, but calls the app directly and keeps the response bytes (evidence downloads) and an optional custom env. */
export async function api(path: string, o: Opts & { env?: unknown } = {}) {
  const headers: Record<string, string> = { "cf-connecting-ip": o.ip ?? freshIp(), ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  let body: BodyInit | undefined = o.raw;
  if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers["content-type"] = "application/json";
  }
  const res = await app.fetch(new Request(`https://api.test${path}`, { method: o.method ?? (body !== undefined ? "POST" : "GET"), headers, body }), (o.env ?? env) as typeof env, ctx);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const isImage = (res.headers.get("content-type") ?? "").startsWith("image/");
  const text = isImage ? "" : new TextDecoder().decode(bytes);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, bytes, headers: res.headers };
}

export interface U { id: string; token: string; email: string }
/** A user; `adult` also stores the 18+ confirmation (through the real endpoint when v3 flags are on, by SQL otherwise). */
export async function user(name = "Tester", adult = true): Promise<U> {
  const u = await newUser(name);
  if (adult) await db.prepare("UPDATE users SET adult_confirmed_at = ?1 WHERE id = ?2").bind(nowSec(), u.id).run();
  return u;
}

export const tBody = (over: Record<string, unknown> = {}) => ({
  title: `Gokte Cup ${uniq()}`, game: "bgmi", format: "battle_royale_points", venue: "offline", city: "Pune", state: "Maharashtra",
  summary: "A one-day college BGMI tournament for sixteen squads from Pune, played on a single Saturday with a points table.",
  description: "Sixteen squads play six matches in one day on a points table. ".repeat(4),
  rules: "Standard rules.", maxTeams: 16, startsAt: "2026-12-20T04:30:00Z", endsAt: "2026-12-20T12:00:00Z", ...over,
});

/** An event with a tournament wrapper; returns the organiser, the event id and the slug. */
export async function tournament(over: Record<string, unknown> = {}, status?: string) {
  const owner = await user("Organiser");
  const ev = await newEvent(owner.token, "Cup");
  const r = await api(`/v3/events/${ev.id}/tournament`, { token: owner.token, body: tBody(over) });
  if (r.status !== 201) throw new Error(`tournament create ${r.status} ${r.text}`);
  const t = { owner, eventId: ev.id, slug: r.json.slug as string, id: r.json.id as string };
  for (const to of status ? path(status) : []) {
    const s = await api(`/v3/events/${ev.id}/tournament/status`, { token: owner.token, body: { to } });
    if (s.status !== 200) throw new Error(`transition ${to} ${s.status} ${s.text}`);
  }
  return t;
}
const ORDER = ["published", "registration_open", "registration_closed", "live", "completed"];
const path = (to: string) => ORDER.slice(0, ORDER.indexOf(to) + 1);

export async function addRegistration(eventId: string, team: string, status = "approved") {
  const id = `r${uniq()}`;
  await db.prepare("INSERT INTO registrations (id, event_id, team_name, captain_name, captain_contact, players, status, created_at) VALUES (?1, ?2, ?3, 'Capt', 'secret-contact@example.com', '[]', ?4, ?5)")
    .bind(id, eventId, team, status, new Date().toISOString()).run();
  return id;
}
export async function addMatch(eventId: string, a: string, b: string, over: Partial<{ status: string; score_a: number; score_b: number; winner: string }> = {}) {
  const id = `m${uniq()}`;
  await db.prepare("INSERT INTO matches (id, event_id, a, b, status, score_a, score_b, winner, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)")
    .bind(id, eventId, a, b, over.status ?? "finished", over.score_a ?? 13, over.score_b ?? 9, over.winner ?? "a", new Date().toISOString()).run();
  return id;
}
export async function addBr(eventId: string, matchNo: number, team: string, placement: number, kills: number) {
  await db.prepare("INSERT INTO br_results (event_id, match_no, team, placement, kills, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(eventId, matchNo, team, placement, kills, new Date().toISOString()).run();
}
/** A published team page covering `team` in this event (makes it a PUBLIC team). */
export async function publishTeamPage(eventId: string, team: string, ownerId?: string) {
  const o = ownerId ?? (await user("TeamOwner")).id;
  const id = `tp${uniq()}`;
  await db.prepare("INSERT INTO team_profiles (id, owner_user_id, name, slug, published, updated_at) VALUES (?1, ?2, ?3, ?4, 1, ?5)").bind(id, o, team, `tm-${uniq()}`, new Date().toISOString()).run();
  await db.prepare("INSERT INTO team_profile_events (profile_id, event_id, team_name) VALUES (?1, ?2, ?3)").bind(id, eventId, team).run();
  return id;
}
export async function captainToken(eventId: string, team: string): Promise<string> {
  return (await createCaptainLink(env, eventId, team)).token;
}

/** A tournament in `live` with two approved teams, ready for disputes. Returns captains already claimed. */
export async function disputeWorld() {
  const t = await tournament({}, "live");
  await addRegistration(t.eventId, "Alpha Wolves");
  await addRegistration(t.eventId, "Beta Hawks");
  const a = await user("CaptainA");
  const b = await user("CaptainB");
  for (const [u, team] of [[a, "Alpha Wolves"], [b, "Beta Hawks"]] as const) {
    const r = await api(`/v3/tournaments/${t.slug}/captain-claim`, { token: u.token, body: { token: await captainToken(t.eventId, team) } });
    if (r.status !== 200) throw new Error(`claim ${r.status} ${r.text}`);
  }
  return { ...t, a, b };
}
export const PNG = (n = 200, seed = 1): Uint8Array => {
  const b = new Uint8Array(n);
  for (let i = 8; i < n; i++) b[i] = (i * 31 + seed * 7) & 255;
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
};

/** The four flags production has ON since 15 Nov 2026 plus the given phase 3-5 flags (the phases must never ride on the live flags). */
export const prodLikeOn = (...extra: V3Flag[]) => flagsOn("v3.tournaments", "v3.resume", "v3.lft", "v3.disputes", ...extra);

/** A team page (legacy team_profiles) owned by `ownerId`: private (published 0) unless `published`. Slug is 12 base32 characters like the real ones. */
export async function ownTeamPage(ownerId: string, name = `Team ${uniq()}`, published = false): Promise<{ id: string; slug: string; name: string }> {
  const id = crypto.randomUUID();
  const b32 = "abcdefghijklmnopqrstuvwxyz234567";
  const slug = Array.from(crypto.getRandomValues(new Uint8Array(12)), (x) => b32[x & 31]).join("");
  await db.prepare("INSERT INTO team_profiles (id, owner_user_id, name, slug, published, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(id, ownerId, name, slug, published ? 1 : 0, new Date().toISOString()).run();
  return { id, slug, name };
}
