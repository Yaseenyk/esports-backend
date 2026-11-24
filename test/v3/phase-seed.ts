/** One row in every table of migration 0056 for `me` (and the other captain), shared by the deletion and export tests. Needs v3.profiles, v3.scrims, v3.directory on. */
import { expect } from "vitest";
import { api, ownTeamPage, user, type U } from "./helpers";

const inHours = (h: number) => new Date(Date.now() + h * 3600_000).toISOString();

export async function seedPhases(o: { w: { slug: string; eventId: string; owner: U }; me: U; other: U; mark: string; slug: string }) {
  const { w, me, other, mark } = o;
  const ok = (r: { status: number; text: string }, want = 200) => expect(r.status, r.text).toBe(want);
  const itemKey = `${w.slug}:alpha wolves`;
  // team pages: mine covers my captained team, shared publicly, with one entry hidden; theirs is public too
  const myTeam = await ownTeamPage(me.id, `${mark} Wolves`);
  ok(await api(`/v3/me/team-pages/${myTeam.id}/claims`, { token: me.token, body: { tournamentSlug: w.slug } }));
  ok(await api(`/v3/me/team-pages/${myTeam.id}/visibility`, { method: "PUT", token: me.token, body: { visibility: "public", consent: true } }));
  ok(await api(`/v3/me/team-pages/${myTeam.id}/hidden`, { method: "PUT", token: me.token, body: { itemKey, hidden: true } }));
  ok(await api("/v3/me/player-page/hidden", { method: "PUT", token: me.token, body: { itemKey, hidden: true } }));
  const theirTeam = await ownTeamPage(other.id, "Beta Hawks Page");
  ok(await api(`/v3/me/team-pages/${theirTeam.id}/visibility`, { method: "PUT", token: other.token, body: { visibility: "public", consent: true } }));
  // profile reports both ways
  ok(await api(`/v3/profiles/players/${o.slug}/report`, { token: other.token, body: { reason: "spam" } }), 202);
  ok(await api(`/v3/profiles/teams/${theirTeam.slug}/report`, { token: me.token, body: { reason: "spam" } }), 202);
  // scrims: my slot (the other captain asks to join), their slot (I hold an accepted seat), a block and a report from me
  const slot = (u: U, team: string, note: string, contact: string) => api("/v3/scrims", { token: u.token, body: { teamProfileId: team, game: "bgmi", startsAt: inHours(6), region: "india", skillNote: note, slots: 2, contact } });
  const mine = await slot(me, myTeam.id, `${mark} tier two squads`, `${mark}c`);
  ok(mine, 201);
  const theirs = await slot(other, theirTeam.id, "OTHERSLOT tier one", "otherslot#1");
  ok(theirs, 201);
  ok(await api(`/v3/scrims/${mine.json.id}/requests`, { token: other.token, body: { teamProfileId: theirTeam.id, contact: "otherreq#1", message: "OTHERREQUEST at nine" } }), 201);
  const req = await api(`/v3/scrims/${theirs.json.id}/requests`, { token: me.token, body: { teamProfileId: myTeam.id, contact: `${mark}r`, message: `${mark} we can play` } });
  ok(req, 201);
  ok(await api(`/v3/scrim-requests/${req.json.id}/respond`, { token: other.token, body: { decision: "accept" } }));
  ok(await api(`/v3/scrims/${theirs.json.id}/report`, { token: me.token, body: { reason: "spam" } }), 202);
  // scrim manager (0057): the other captain's request on my slot is confirmed (a numbered seat); on their full 1-seat scrim I wait, the confirmed third team
  // drops and I get the offer (a waitlist row and a notice); my recurring schedule makes its days
  const otherReq = (await api(`/v3/scrims/${mine.json.id}/requests`, { token: me.token })).json.items[0].id;
  ok(await api(`/v3/scrim-requests/${otherReq}/respond`, { token: me.token, body: { decision: "accept" } }));
  const third = await user("ThirdCaptain");
  const thirdTeam = await ownTeamPage(third.id, "Third Squad");
  const small = await api("/v3/scrims", { token: other.token, body: { teamProfileId: theirTeam.id, game: "bgmi", startsAt: inHours(7), region: "india", slots: 1, contact: "otherslot#2" } });
  ok(small, 201);
  const tq = await api(`/v3/scrims/${small.json.id}/requests`, { token: third.token, body: { teamProfileId: thirdTeam.id, contact: "third#1" } });
  ok(await api(`/v3/scrim-requests/${tq.json.id}/respond`, { token: other.token, body: { decision: "accept" } }));
  ok(await api(`/v3/scrims/${small.json.id}/waitlist`, { token: me.token, body: { teamProfileId: myTeam.id, contact: `${mark}w` } }), 201);
  ok(await api(`/v3/scrim-requests/${tq.json.id}/withdraw`, { token: third.token, body: {} }));
  ok(await api("/v3/scrim-schedules", { token: me.token, body: { teamProfileId: myTeam.id, game: "bgmi", timeOfDay: "23:59", daysAhead: 3, region: "india", slots: 2, contact: `${mark}s`, skillNote: `${mark} daily` } }), 201);
  ok(await api(`/v3/scrims/${theirs.json.id}/block`, { token: me.token, body: {} }));
  // the directory opt-in on the tournament (organiser setting, no personal data)
  ok(await api(`/v3/events/${w.eventId}/tournament/directory`, { method: "PUT", token: w.owner.token, body: { signupPublic: true } }));
  return { myTeam, theirTeam, mySlot: mine.json.id as string, theirSlot: theirs.json.id as string, itemKey };
}
