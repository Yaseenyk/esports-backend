import { describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { checkContacts, matchScore } from "../../src/v3/lib/lft-match";
import { makeStaff } from "../admin/helpers";
import { uniq } from "../helpers";
import { api, db, flagsOn, ownTeamPage, user, type U } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
const on = () => flagsOn(...(["v3.lft", "v3.lft_match"] as never[]));
const lftOnly = () => flagsOn(...(["v3.lft"] as never[]));
const cityTag = () => `Mcity${uniq()}`.slice(0, 40);

async function teamListing(u: U, over: Record<string, unknown> = {}) {
  const team = await ownTeamPage(u.id);
  const r = await api("/v3/lft", { token: u.token, body: {
    kind: "looking_for_player", game: "bgmi", roles: ["igl"], teamProfileId: team.id, onlineOk: true,
    message: "Team looking for an IGL for evening scrims, Hindi or English comms.", contacts: { discord: "wolves#1234", instagram: "wolves_team" },
    languages: ["hi", "en"], playHours: ["evening", "night"], ...over } });
  if (r.status !== 201) throw new Error(`create ${r.status} ${r.text}`);
  return r.json as { id: string };
}
const request = (u: U, listingId: string, body: Record<string, unknown> = {}) =>
  api(`/v3/lft/${listingId}/applications`, { token: u.token, body: { message: "I can call in Hindi.", contacts: { discord: "ravi#4321" }, ...body } });

describe("lft match: pure rules", () => {
  it("contacts and the match score", () => {
    expect(checkContacts({ discord: "a#1234", ign: "Ravi" })).toEqual({ ok: true, contacts: { discord: "a#1234", ign: "Ravi" }, first: "a#1234" });
    expect(checkContacts({})).toMatchObject({ ok: false, code: "no_contacts" });
    expect(checkContacts({ whatsapp: "x" })).toMatchObject({ ok: false, code: "invalid_contacts" });
    expect(checkContacts({ other: "9876543210" })).toMatchObject({ ok: false, code: "has_phone" });
    expect(checkContacts({ other: "discord.gg/abc" })).toMatchObject({ ok: false });
    expect(checkContacts({ discord: "a1", instagram: "b2", telegram: "c3", ign: "d4" })).toMatchObject({ ok: false, code: "too_many_contacts" });
    expect(matchScore({ roles: [], languages: [], hours: [] }, { roles: ["igl"], languages: ["hi"], hours: [] })).toBeNull();
    expect(matchScore({ roles: ["igl"], languages: ["hi"], hours: ["evening", "night"] }, { roles: ["igl"], languages: ["hi"], hours: ["evening"] })).toEqual({ score: Math.round((6 / 7) * 100), reasons: ["role", "language", "hours"] });
    expect(matchScore({ roles: ["sniper"], languages: [], hours: [] }, { roles: [], languages: [], hours: [] })?.score).toBe(100); // any role
  });
});

describe("lft match: flag off keeps the board exactly as before", () => {
  it("new routes 404, extra fields are ignored and no contacts leave", async () => {
    await lftOnly();
    const u = await user();
    const unknown = await api("/v3/definitely-not-a-route");
    for (const [m, p] of [["POST", "/v3/lft-applications/x1/block"], ["GET", "/v3/me/lft-blocks"], ["DELETE", "/v3/me/lft-blocks/x1"], ["POST", "/v3/lft-applications/x1/report"]] as const) {
      const r = await api(p, { method: m, token: u.token, body: m === "POST" ? {} : undefined });
      expect([r.status, r.json], p).toEqual([404, unknown.json]);
    }
    const list = await api("/public/lft");
    expect(list.status).toBe(200);
    for (const i of list.json.items) expect(i).not.toHaveProperty("languages");
    // contacts without the legacy contact are refused while matching is off
    const team = await ownTeamPage(u.id);
    const r = await api("/v3/lft", { token: u.token, body: { kind: "looking_for_player", game: "bgmi", teamProfileId: team.id, message: "Team looking for a player, evenings.", contacts: { discord: "x#1234" } } });
    expect(r.json.code).toBe("contact_bad_contact");
    expect(app.routes.some((x) => x.path === "/v3/lft-applications/:id/block")).toBe(true);
  });
});

describe("lft match: filters and sort", () => {
  it("filters by language and play hours; the public board never carries contacts", async () => {
    await on();
    const c = cityTag();
    const a = await user("TeamA"), b = await user("TeamB");
    const la = await teamListing(a, { city: c, languages: ["ta"], playHours: ["morning"] });
    const lb = await teamListing(b, { city: c, languages: ["hi"], playHours: ["night"] });
    const ids = async (q: string) => (await api(`/public/lft?city=${c}${q}`)).json.items.map((i: { id: string }) => i.id);
    expect(await ids("&lang=ta")).toEqual([la.id]);
    expect(await ids("&hours=night")).toEqual([lb.id]);
    expect((await ids("")).sort()).toEqual([la.id, lb.id].sort());
    expect((await api("/public/lft?lang=klingon")).json.code).toBe("invalid_lang");
    expect((await api("/public/lft?hours=noon")).json.code).toBe("invalid_hours");
    const board = await api(`/public/lft?city=${c}`);
    expect(JSON.stringify(board.json)).not.toMatch(/wolves#1234|wolves_team|contact/);
    expect(board.json.items[0]).toHaveProperty("languages");
    expect(board.json.items[0]).toHaveProperty("playHours");
  });

  it("sort=match ranks by fit and says why", async () => {
    await on();
    const c = cityTag();
    const a = await user(), b = await user(), d = await user();
    const good = await teamListing(a, { city: c, roles: ["sniper"], languages: ["hi"], playHours: ["evening"] });
    const mid = await teamListing(b, { city: c, roles: ["sniper"], languages: ["ta"], playHours: ["morning"] });
    const poor = await teamListing(d, { city: c, roles: ["support"], languages: ["ta"], playHours: ["morning"] });
    const r = await api(`/public/lft?city=${c}&sort=match&want_roles=sniper&want_langs=hi&want_hours=evening`);
    expect(r.status, r.text).toBe(200);
    expect(r.json.items.map((i: { id: string }) => i.id)).toEqual([good.id, mid.id, poor.id]);
    expect(r.json.items[0].match).toEqual({ score: 100, reasons: ["role", "language", "hours"] });
    expect(r.json.nextCursor).toBeNull();
    expect((await api("/public/lft?sort=match&want_roles=pilot")).json.code).toBe("invalid_want");
  });
});

describe("lft match: request to join, contacts only after both agree", () => {
  it("reveals only the contacts each side chose, and only after accept", async () => {
    await on();
    const team = await user("Team"), player = await user("Player"), stranger = await user("Stranger");
    const l = await teamListing(team);
    const req = await request(player, l.id, { contacts: { discord: "ravi#4321", ign: "RaviIGL" } });
    expect(req.status, req.text).toBe(201);
    // before accept: neither side sees the other's contacts
    let inbox = await api(`/v3/lft/${l.id}/applications`, { token: team.token });
    expect(inbox.json.items[0]).toMatchObject({ status: "sent", contact: null, contacts: null });
    let mine = await api("/v3/me/lft/applications", { token: player.token });
    expect(mine.json.items[0]).toMatchObject({ status: "sent", contact: null, contacts: null });
    // a stranger cannot read the inbox or answer
    expect((await api(`/v3/lft/${l.id}/applications`, { token: stranger.token })).status).toBe(404);
    expect((await api(`/v3/lft-applications/${req.json.id}/respond`, { token: stranger.token, body: { decision: "accept" } })).status).toBe(404);
    // accept: both see what the other chose to share
    expect((await api(`/v3/lft-applications/${req.json.id}/respond`, { token: team.token, body: { decision: "accept" } })).json.contacts).toEqual({ discord: "ravi#4321", ign: "RaviIGL" });
    inbox = await api(`/v3/lft/${l.id}/applications`, { token: team.token });
    expect(inbox.json.items[0].contacts).toEqual({ discord: "ravi#4321", ign: "RaviIGL" });
    mine = await api("/v3/me/lft/applications", { token: player.token });
    expect(mine.json.items[0].contacts).toEqual({ discord: "wolves#1234", instagram: "wolves_team" });
    // a declined request never reveals anything
    const p2 = await user();
    const r2 = await request(p2, l.id);
    await api(`/v3/lft-applications/${r2.json.id}/respond`, { token: team.token, body: { decision: "decline" } });
    expect((await api("/v3/me/lft/applications", { token: p2.token })).json.items[0]).toMatchObject({ status: "declined", contact: null, contacts: null });
  });

  it("validates chosen contacts", async () => {
    await on();
    const team = await user(), player = await user();
    const l = await teamListing(team);
    expect((await request(player, l.id, { contacts: { other: "9876543210" } })).json.code).toBe("contacts_has_phone");
    expect((await request(player, l.id, { contacts: { snapchat: "x" } })).json.code).toBe("contacts_invalid_contacts");
    const t2 = await user();
    const tp = await ownTeamPage(t2.id);
    const bad = await api("/v3/lft", { token: t2.token, body: { kind: "looking_for_player", game: "bgmi", teamProfileId: tp.id, message: "Team looking for a player, evenings.", contacts: { discord: "x#1" }, languages: ["xx"] } });
    expect(bad.json.code).toBe("invalid_languages");
  });
});

describe("lft match: block and report on requests", () => {
  it("the team blocks a requester: pending requests are declined and new ones are a plain 404", async () => {
    await on();
    const team = await user(), player = await user(), stranger = await user();
    const l1 = await teamListing(team), l2 = await teamListing(team);
    const r1 = await request(player, l1.id);
    const r2 = await request(player, l2.id);
    expect((await api(`/v3/lft-applications/${r1.json.id}/block`, { token: stranger.token, body: {} })).status).toBe(404); // not a party
    expect((await api(`/v3/lft-applications/${r1.json.id}/block`, { token: team.token, body: {} })).json).toEqual({ ok: true, blocked: true });
    const inbox2 = await api(`/v3/lft/${l2.id}/applications`, { token: team.token });
    expect(inbox2.json.items.find((x: { id: string }) => x.id === r2.json.id).status).toBe("declined");
    const l3 = await teamListing(team);
    const again = await request(player, l3.id);
    expect([again.status, again.json]).toEqual([404, { error: "Not found" }]);
    // the block list carries no user id; unblock is owner-only
    const blocks = await api("/v3/me/lft-blocks", { token: team.token });
    expect(JSON.stringify(blocks.json)).not.toContain(player.id);
    const bid = blocks.json.items[0].id;
    expect((await api(`/v3/me/lft-blocks/${bid}`, { method: "DELETE", token: player.token })).status).toBe(404);
    expect((await api(`/v3/me/lft-blocks/${bid}`, { method: "DELETE", token: team.token })).status).toBe(200);
    expect((await request(player, l3.id)).status).toBe(201);
  });

  it("the player blocks the team: own pending requests are withdrawn, and the team cannot get new ones from them", async () => {
    await on();
    const team = await user(), player = await user();
    const l1 = await teamListing(team);
    const r1 = await request(player, l1.id);
    expect((await api(`/v3/lft-applications/${r1.json.id}/block`, { token: player.token, body: {} })).status).toBe(200);
    expect((await api("/v3/me/lft/applications", { token: player.token })).json.items[0].status).toBe("withdrawn");
    const l2 = await teamListing(team);
    expect((await request(player, l2.id)).status).toBe(404);
  });

  it("only the team can report a request; staff see it without user ids", async () => {
    await on();
    const team = await user(), player = await user();
    const l = await teamListing(team);
    const r = await request(player, l.id, { message: "Rude spam request text here" });
    expect((await api(`/v3/lft-applications/${r.json.id}/report`, { token: player.token, body: { reason: "spam" } })).status).toBe(404);
    expect((await api(`/v3/lft-applications/${r.json.id}/report`, { token: team.token, body: { reason: "nope" } })).json.code).toBe("invalid_reason");
    expect((await api(`/v3/lft-applications/${r.json.id}/report`, { token: team.token, body: { reason: "spam", note: "copy paste spam" } })).status).toBe(202);
    const s = await makeStaff();
    const list = await api("/admin/v1/v3/lft/request-reports", { token: (await s.login()).token });
    expect(list.status, list.text).toBe(200);
    const item = list.json.items.find((x: { message: string }) => x.message === "Rude spam request text here");
    expect(item).toMatchObject({ reason: "spam", note: "copy paste spam", reportsOnApplicant: 1 });
    expect(JSON.stringify(list.json)).not.toMatch(new RegExp(`${player.id}|${team.id}|ravi#4321`));
    expect((await api("/admin/v1/v3/lft/request-reports", { token: team.token })).status).toBe(404);
  });
});
