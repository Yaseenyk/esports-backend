import { env } from "cloudflare:workers";
import { resetFlagsCache } from "../../src/flags";
import { todayIst, addDays } from "../../src/v3/lib/community";
import { uniq } from "../helpers";
import { addMatch, addRegistration, api, captainToken, db, nowSec, tournament, user, type U } from "./helpers";

export type CommunityFlag = "v3.calendar" | "v3.trust" | "v3.tournaments" | "v3.disputes" | "kill.public_writes" | "kill.directory" | "admin.enabled" | "takedown.enforce";

/** Exactly the listed flags ON (every v3 flag and the kill switches used here are removed first = default OFF). */
export async function communityOn(...on: CommunityFlag[]): Promise<void> {
  await db.prepare("DELETE FROM flags WHERE key LIKE 'v3.%' OR key IN ('takedown.enforce','kill.directory','kill.public_writes')").run();
  for (const k of on) await db.prepare("INSERT INTO flags (key, value, updated_by, updated_at, note) VALUES (?1, 'true', 'test', ?2, '') ON CONFLICT (key) DO UPDATE SET value = 'true'").bind(k, new Date().toISOString()).run();
  resetFlagsCache();
}

export const today = () => todayIst();
export const day = (n: number) => addDays(todayIst(), n);

/** A verified (or not) team organisation with the given members. Returns its id and slug. */
export async function org(members: { u: U; role?: "admin" | "member" }[], opts: { verified?: boolean; status?: string; name?: string } = {}) {
  const id = `org${uniq()}`;
  const slug = `college-${uniq()}`.toLowerCase();
  await db
    .prepare("INSERT INTO organisations (id, name, kind, status, created_at, slug, verified_at) VALUES (?1, ?2, 'team', ?3, ?4, ?5, ?6)")
    .bind(id, opts.name ?? `Test College ${uniq()}`, opts.status ?? "active", new Date().toISOString(), slug, opts.verified === false ? null : nowSec())
    .run();
  for (const m of members) await db.prepare("INSERT INTO org_members (org_id, user_id, role, added_at) VALUES (?1, ?2, ?3, ?4)").bind(id, m.u.id, m.role ?? "admin", new Date().toISOString()).run();
  return { id, slug };
}

/** A tournament that ENDED `endedDaysAgo` days ago (negative = ends in the future), moved to `status`, optionally owned by an organisation. */
export async function pastTournament(endedDaysAgo = 1, status = "completed", orgId?: string) {
  const t = await tournament({}, "registration_open");
  if (orgId) await db.prepare("UPDATE events SET org_id = ?1 WHERE id = ?2").bind(orgId, t.eventId).run();
  const end = nowSec() - endedDaysAgo * 86_400;
  await db.prepare("UPDATE tournaments SET starts_at = ?1, ends_at = ?2 WHERE id = ?3").bind(end - 7200, end, t.id).run();
  for (const to of ["registration_closed", "live", "completed"].slice(0, ["registration_open", "registration_closed", "live", "completed"].indexOf(status))) {
    const s = await api(`/v3/events/${t.eventId}/tournament/status`, { token: t.owner.token, body: { to } });
    if (s.status !== 200) throw new Error(`transition ${to} ${s.status} ${s.text}`);
  }
  return t;
}

/** A roster person with a pass link (real share route) and, optionally, a gate check-in. */
export async function rosterPass(t: { eventId: string; owner: U }, o: { checkedIn?: boolean; minor?: boolean } = {}) {
  const pid = `P${uniq()}`;
  await db.prepare("INSERT INTO teams (event_id, id, name) VALUES (?1, ?2, 'Team') ON CONFLICT DO NOTHING").bind(t.eventId, "T1").run();
  await db.prepare("INSERT INTO people (event_id, id, team_id, name, role, minor) VALUES (?1, ?2, 'T1', 'Roster Player', 'Player', ?3)").bind(t.eventId, pid, o.minor ? 1 : 0).run();
  const r = await api(`/events/${t.eventId}/people/${pid}/share`, { token: t.owner.token, body: {} });
  if (r.status !== 201 && r.status !== 200) throw new Error(`share ${r.status} ${r.text}`);
  if (o.checkedIn !== false) await db.prepare("INSERT INTO checkins (event_id, person_id, at) VALUES (?1, ?2, ?3)").bind(t.eventId, pid, new Date().toISOString()).run();
  return { personId: pid, token: r.json.token as string, link: `https://esports.streamerosai.com/pass/?t=${r.json.token as string}` };
}

/** An approved team with a finished match (it "played"), and its captain link. */
export async function playedTeam(eventId: string, team: string, opponent = `Opp ${uniq()}`) {
  await addRegistration(eventId, team);
  await addRegistration(eventId, opponent);
  await addMatch(eventId, team, opponent);
  return { token: await captainToken(eventId, team) };
}

export const rateBody = (proof: Record<string, unknown>, over: Record<string, unknown> = {}) => ({
  stars: 4, onTime: 4, fair: 5, communication: 3, displayName: "Riya K", review: "Started on time and the points table was right after every match.", proof, ...over,
});

export { api, db, user, env };
