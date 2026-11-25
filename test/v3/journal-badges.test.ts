import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { uniq } from "../helpers";
import { sha256 } from "../../src/crypto";
import { BADGES, BADGE_IDS, earnedBadges, NO_FACTS, publicBadges, RECORDED_BADGES } from "../../src/v3/lib/badges";
import { checkJournalEntry, isCalendarDay, JOURNAL, latestDay } from "../../src/v3/lib/journal";
import { recordBadgesDaily } from "../../src/v3/services/badge-service";
import { addBr, addMatch, addRegistration, api, captainToken, db, flagsOn, nowSec, ownTeamPage, prodLikeOn, tournament, user, type U } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
beforeAll(() => prodLikeOn("v3.profiles", "v3.journal", "v3.achievements"));

const entry = (over: Record<string, unknown> = {}) => ({ playedOn: "2026-11-20", game: "bgmi", mode: "Squad", map: "Erangel", placement: 3, kills: 6, damage: 840, notes: "Rotated late, third zone", ...over });
const add = (u: U, body: Record<string, unknown>) => api("/v3/me/journal", { token: u.token, body });
const list = (u: U) => api("/v3/me/journal", { token: u.token });

// ------------------------------------------------------------------ pure rules
describe("lib/journal: the rules", () => {
  it("accepts only real past calendar days", () => {
    expect(isCalendarDay("2026-02-28")).toBe(true);
    for (const bad of ["2026-02-30", "2026-13-01", "26-11-20", "2026-11-20T00:00", 20261120, null]) expect(isCalendarDay(bad), String(bad)).toBe(false);
    const now = Date.UTC(2026, 10, 25, 12);
    expect(latestDay(now)).toBe("2026-11-26");
    expect(() => checkJournalEntry(entry({ playedOn: "2026-11-28" }), now)).toThrow(/future/);
    expect(() => checkJournalEntry(entry({ playedOn: "2014-12-31" }), now)).toThrow();
    expect(checkJournalEntry(entry({ playedOn: "2026-11-26" }), now).playedOn).toBe("2026-11-26");
  });

  it("caps every field, keeps text plain, and an edit merges with the stored entry (null clears)", () => {
    const now = Date.UTC(2026, 10, 25);
    for (const [k, v] of [["kills", -1], ["kills", 201], ["kills", 2.5], ["kills", "7"], ["placement", 0], ["placement", 101], ["damage", 100_001], ["game", "chess"], ["mode", "x".repeat(41)], ["map", "y".repeat(41)], ["notes", "n".repeat(501)], ["notes", "<script>"]] as const) {
      expect(() => checkJournalEntry(entry({ [k]: v }), now), `${k}=${String(v)}`).toThrow();
    }
    expect(() => checkJournalEntry({ playedOn: "2026-11-20", game: "bgmi" }, now)).toThrow(/kills/);
    const prev = checkJournalEntry(entry(), now);
    expect(checkJournalEntry({ kills: 9, notes: null }, now, prev)).toEqual({ ...prev, kills: 9, notes: null });
    expect(JOURNAL.MAX_ENTRIES).toBe(2000);
  });
});

describe("lib/badges: one list, plain rules", () => {
  it("every badge has a unique id, a title and a rule sentence; the list is the one the spec names", () => {
    expect(new Set(BADGE_IDS).size).toBe(BADGES.length);
    expect(BADGE_IDS).toEqual(["first_tournament", "first_result", "first_win", "verified_5", "verified_10", "verified_25", "first_scrim", "first_event", "player_card"]);
    for (const b of BADGES) {
      expect(b.title.length).toBeGreaterThan(3);
      expect(b.rule).toMatch(/^[A-Z].*\.$/);
    }
    expect(earnedBadges(NO_FACTS)).toEqual([]);
  });

  it("each rule fires exactly at its threshold", () => {
    expect(earnedBadges({ ...NO_FACTS, tournaments: 1 })).toEqual(["first_tournament"]);
    expect(earnedBadges({ ...NO_FACTS, verifiedResults: 4 })).toEqual(["first_result"]);
    expect(earnedBadges({ ...NO_FACTS, verifiedResults: 5 })).toEqual(["first_result", "verified_5"]);
    expect(earnedBadges({ ...NO_FACTS, verifiedResults: 9 })).toEqual(["first_result", "verified_5"]);
    expect(earnedBadges({ ...NO_FACTS, verifiedResults: 10 })).toEqual(["first_result", "verified_5", "verified_10"]);
    expect(earnedBadges({ ...NO_FACTS, verifiedResults: 25 })).toEqual(["first_result", "verified_5", "verified_10", "verified_25"]);
    expect(earnedBadges({ ...NO_FACTS, wins: 1 })).toEqual(["first_win"]);
    expect(earnedBadges({ ...NO_FACTS, scrimPlayed: true })).toEqual(["first_scrim"]);
    expect(earnedBadges({ ...NO_FACTS, eventOrganised: true })).toEqual(["first_event"]);
    expect(earnedBadges({ ...NO_FACTS, cardCreated: true })).toEqual(["player_card"]);
  });

  it("only scrim badges can come from the server's record; a record of anything else (or junk) earns nothing", () => {
    expect(RECORDED_BADGES).toEqual(["first_scrim"]);
    expect(earnedBadges(NO_FACTS, ["first_scrim"])).toEqual(["first_scrim"]);
    expect(earnedBadges(NO_FACTS, ["first_win", "verified_25", "nonsense"])).toEqual([]);
  });

  it("public list: hidden badges and a hidden section give nothing; unearned badges are never listed", () => {
    expect(publicBadges(["first_tournament", "first_win"], ["first_win"], false)).toEqual([{ id: "first_tournament", title: "First tournament" }]);
    expect(publicBadges(["first_tournament"], [], true)).toEqual([]);
    expect(publicBadges([], [], false)).toEqual([]);
  });
});

// ------------------------------------------------------------------ journal routes
describe("journal: owner only, private, capped", () => {
  it("needs sign-in; the owner creates, lists, edits and deletes their own entries", async () => {
    expect((await api("/v3/me/journal")).status).toBe(401);
    expect((await api("/v3/me/journal", { body: entry() })).status).toBe(401);
    const me = await user("Journal Owner");
    const c = await add(me, entry());
    expect(c.status, c.text).toBe(201);
    expect(Object.keys(c.json.item).sort()).toEqual(["createdAt", "damage", "game", "id", "kills", "map", "mode", "notes", "placement", "playedOn", "updatedAt"]);
    expect(c.json.item).toMatchObject({ playedOn: "2026-11-20", game: "bgmi", kills: 6, placement: 3, notes: "Rotated late, third zone" });
    expect(c.text).not.toContain(me.id);
    await add(me, entry({ playedOn: "2026-11-22", kills: 2, placement: null, damage: null, mode: null, map: null, notes: null }));
    const l = await list(me);
    expect(l.status).toBe(200);
    expect(l.json).toMatchObject({ count: 2, cap: 2000, selfLogged: true });
    expect(l.json.items.map((x: { playedOn: string }) => x.playedOn)).toEqual(["2026-11-22", "2026-11-20"]);
    const id = c.json.item.id as string;
    const e = await api(`/v3/me/journal/${id}`, { method: "PUT", token: me.token, body: { kills: 11, notes: null } });
    expect(e.status, e.text).toBe(200);
    expect(e.json.item).toMatchObject({ kills: 11, notes: null, map: "Erangel" });
    expect((await api(`/v3/me/journal/${id}`, { method: "DELETE", token: me.token })).status).toBe(200);
    expect((await list(me)).json.count).toBe(1);
  });

  it("another account cannot read, edit or delete my entry: the same 404 as an unknown or malformed id", async () => {
    const me = await user("Owner J");
    const other = await user("Stranger J");
    const id = (await add(me, entry({ notes: `secret-${uniq()}` }))).json.item.id as string;
    expect((await list(other)).json.items).toEqual([]);
    const miss = await api(`/v3/me/journal/${"0".repeat(32)}`, { method: "PUT", token: other.token, body: { kills: 1 } });
    expect(miss.status).toBe(404);
    for (const [method, path, body] of [["PUT", `/v3/me/journal/${id}`, { kills: 0 }], ["DELETE", `/v3/me/journal/${id}`, undefined], ["PUT", "/v3/me/journal/not-an-id", { kills: 0 }], ["DELETE", "/v3/me/journal/../x", undefined]] as const) {
      const r = await api(path, { method, token: other.token, body });
      expect(r.status, `${method} ${path}`).toBe(404);
      if (r.json) expect(r.json, `${method} ${path}`).toEqual(miss.json);
    }
    // clearing deletes only the caller's own rows
    expect((await api("/v3/me/journal/clear", { token: other.token, body: { confirm: true } })).json).toEqual({ ok: true, deleted: 0 });
    expect((await list(me)).json.items[0]).toMatchObject({ id, kills: 6 });
    // the stored row is untouched
    expect(await db.prepare("SELECT kills FROM v3_journal_entries WHERE id = ?1").bind(id).first()).toEqual({ kills: 6 });
  });

  it("validates input (400 with a code), caps the body size, and needs the 18+ confirmation to write", async () => {
    const me = await user("Validator");
    for (const [body, code] of [[entry({ playedOn: "2026-02-30" }), "invalid_playedOn"], [entry({ game: "ludo" }), "invalid_game"], [entry({ kills: 500 }), "invalid_kills"], [entry({ notes: "<b>hi</b>" }), "invalid_notes"], [entry({ placement: 0 }), "invalid_placement"]] as const) {
      const r = await add(me, body);
      expect([r.status, r.json.code], JSON.stringify(body)).toEqual([400, code]);
    }
    const big = await add(me, entry({ notes: "a".repeat(3000) }));
    expect(big.status).toBe(413);
    const minor = await user("Unconfirmed", false);
    const r = await add(minor, entry());
    expect([r.status, r.json.code]).toEqual([403, "adult_required"]);
    expect((await list(minor)).status).toBe(200); // reading (and deleting) stays possible
  });

  it("refuses the entry after the cap (409 journal_full) and rate limits writes per account (429)", async () => {
    const me = await user("Heavy Logger");
    await db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?2)
         INSERT INTO v3_journal_entries (id, user_id, played_on, game, kills) SELECT lower(hex(randomblob(16))), ?1, '2026-01-01', 'bgmi', 1 FROM n`,
      )
      .bind(me.id, JOURNAL.MAX_ENTRIES - 1)
      .run();
    expect((await add(me, entry())).status).toBe(201);
    const full = await add(me, entry());
    expect([full.status, full.json.code]).toEqual([409, "journal_full"]);
    expect((await list(me)).json.count).toBe(JOURNAL.MAX_ENTRIES);
    // writes: 120 an hour per account (the bucket is pre-filled the way the limiter keys it)
    const w = await user("Rate Limited");
    const key = await sha256(`${env.JWT_SECRET}|v3-journal-write|subject|${w.id}`);
    const ws = Math.floor(nowSec() / 3600) * 3600;
    await db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 120)").bind(key, ws).run();
    expect((await add(w, entry())).status).toBe(429);
  });

  it("clear needs confirm: true", async () => {
    const me = await user("Clearer");
    await add(me, entry());
    expect((await api("/v3/me/journal/clear", { token: me.token, body: {} })).json.code).toBe("confirm_required");
    expect((await api("/v3/me/journal/clear", { token: me.token, body: { confirm: true } })).json).toEqual({ ok: true, deleted: 1 });
  });
});

// ------------------------------------------------------------------ badges
async function captainWithResults() {
  const me = await user("Badge Captain");
  expect((await api("/v3/me/resume-consent", { token: me.token, body: { consent: true } })).status).toBe(200);
  const slug = `b-${uniq()}`.toLowerCase();
  expect((await api("/v3/me/profile", { method: "PUT", token: me.token, body: { slug, handle: "Badge Hunter", bio: "IGL from Pune", visibility: "public" } })).status).toBe(200);
  const t = await tournament({}, "live");
  await addRegistration(t.eventId, "Alpha Wolves");
  await addRegistration(t.eventId, "Beta Hawks");
  await addBr(t.eventId, 1, "Alpha Wolves", 1, 12);
  await addBr(t.eventId, 2, "Alpha Wolves", 4, 3);
  await addMatch(t.eventId, "Alpha Wolves", "Beta Hawks", { winner: "b", score_a: 9, score_b: 13 });
  expect((await api(`/v3/tournaments/${t.slug}/captain-claim`, { token: me.token, body: { token: await captainToken(t.eventId, "Alpha Wolves") } })).status).toBe(200);
  return { me, slug, t };
}
const pub = async (slug: string) => {
  const r = await api(`/public/profiles/players/${slug}`);
  expect(r.status, r.text).toBe(200);
  return r.json;
};
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("badges: earned from recorded actions only, show/hide, never from the journal", () => {
  it("a captain with verified results earns first_tournament, first_result and first_win; the public page lists them", async () => {
    const { me, slug } = await captainWithResults();
    const mine = await api("/v3/me/badges", { token: me.token });
    expect(mine.status, mine.text).toBe(200);
    expect(mine.json.items).toHaveLength(BADGES.length);
    const earned = mine.json.items.filter((b: { earned: boolean }) => b.earned).map((b: { id: string }) => b.id);
    expect(earned).toEqual(["first_tournament", "first_result", "first_win"]);
    expect(mine.json.items.find((b: { id: string }) => b.id === "verified_5")).toMatchObject({ earned: false, rule: "Have 5 verified results." });
    const p = await pub(slug);
    expect(p.badges).toEqual([{ id: "first_tournament", title: "First tournament" }, { id: "first_result", title: "First verified result" }, { id: "first_win", title: "First win" }]);
  });

  it("journal entries never earn a badge and never appear on the public page or change the verified stats", async () => {
    const { me, slug } = await captainWithResults();
    const before = await pub(slug);
    const mark = `JNOTE${uniq()}`;
    for (let i = 0; i < 30; i++) expect((await add(me, entry({ placement: 1, kills: 40, notes: `${mark} ${i}` }))).status).toBe(201);
    const after = await pub(slug);
    expect(after.stats).toEqual(before.stats);
    expect(after.badges).toEqual(before.badges);
    expect(JSON.stringify(after)).not.toContain(mark);
    expect(ids(after.badges)).not.toContain("verified_25");
    const card = await api("/v3/me/player-page/card-link", { token: me.token, body: {} });
    const tok = /k=([A-Za-z0-9_-]{22})/.exec(card.json.page.cardPath)![1]!;
    expect((await api(`/public/profiles/cards/${tok}`)).text).not.toContain(mark);
  });

  it("a hidden badge stays off public JSON; the section switch hides all; unknown badge ids are refused", async () => {
    const { me, slug } = await captainWithResults();
    const h = await api("/v3/me/badges/hidden", { method: "PUT", token: me.token, body: { badge: "first_win", hidden: true } });
    expect(h.status, h.text).toBe(200);
    expect(h.json.items.find((b: { id: string }) => b.id === "first_win")).toMatchObject({ earned: true, hidden: true });
    const p = await pub(slug);
    expect(ids(p.badges)).toEqual(["first_tournament", "first_result"]);
    expect(JSON.stringify(p)).not.toMatch(/first_win|First win/);
    expect((await api("/v3/me/player-page/details", { method: "PUT", token: me.token, body: { hiddenFields: ["badges"] } })).status).toBe(200);
    expect((await pub(slug)).badges).toEqual([]);
    expect((await api("/v3/me/badges", { token: me.token })).json.sectionHidden).toBe(true);
    for (const body of [{ badge: "admin", hidden: true }, { badge: "first_win", hidden: "yes" }, { badge: ["first_win"], hidden: true }]) {
      expect((await api("/v3/me/badges/hidden", { method: "PUT", token: me.token, body })).status, JSON.stringify(body)).toBe(400);
    }
  });

  it("player_card after a card link; first_event for the organiser of a published tournament", async () => {
    const { me, slug, t } = await captainWithResults();
    expect(ids((await pub(slug)).badges)).not.toContain("player_card");
    expect((await api("/v3/me/player-page/card-link", { token: me.token, body: {} })).status).toBe(200);
    expect(ids((await pub(slug)).badges)).toContain("player_card");
    const org = await api("/v3/me/badges", { token: t.owner.token });
    expect(org.json.items.filter((b: { earned: boolean }) => b.earned).map((b: { id: string }) => b.id)).toEqual(["first_event"]);
    // a draft tournament earns nothing
    const draft = await tournament();
    expect((await api("/v3/me/badges", { token: draft.owner.token })).json.items.some((b: { earned: boolean }) => b.earned)).toBe(false);
  });

  it("first_scrim: a confirmed scrim whose start has passed; the daily record keeps it after the scrim rows are deleted", async () => {
    await flagsOn("v3.tournaments", "v3.resume", "v3.lft", "v3.disputes", "v3.profiles", "v3.scrims", "v3.achievements");
    const host = await user("Scrim Host");
    const guest = await user("Scrim Guest");
    const loner = await user("Scrim Loner");
    const ht = await ownTeamPage(host.id, "Host Squad");
    const gt = await ownTeamPage(guest.id, "Guest Squad");
    const lt = await ownTeamPage(loner.id, "Lone Squad");
    const past = nowSec() - 3600;
    const slot = `s${uniq()}`;
    const lone = `s${uniq()}`;
    await db.prepare("INSERT INTO scrim_slots (id, poster_user_id, team_profile_id, game, starts_at, region, slots_total, slots_filled, contact, status) VALUES (?1, ?2, ?3, 'bgmi', ?4, 'india', 4, 1, 'host#1', 'open')").bind(slot, host.id, ht.id, past).run();
    await db.prepare("INSERT INTO scrim_requests (id, slot_id, requester_user_id, team_profile_id, contact, status) VALUES (?1, ?2, ?3, ?4, 'guest#1', 'accepted')").bind(`q${uniq()}`, slot, guest.id, gt.id).run();
    // a slot nobody joined does not count for its poster
    await db.prepare("INSERT INTO scrim_slots (id, poster_user_id, team_profile_id, game, starts_at, region, slots_total, slots_filled, contact, status) VALUES (?1, ?2, ?3, 'bgmi', ?4, 'india', 4, 0, 'lone#1', 'open')").bind(lone, loner.id, lt.id, past).run();
    const earnedOf = async (u: U) => (await api("/v3/me/badges", { token: u.token })).json.items.filter((b: { earned: boolean }) => b.earned).map((b: { id: string }) => b.id);
    expect(await earnedOf(host)).toEqual(["first_scrim"]);
    expect(await earnedOf(guest)).toEqual(["first_scrim"]);
    expect(await earnedOf(loner)).toEqual([]);
    expect(await recordBadgesDaily(db, nowSec())).toBeGreaterThanOrEqual(2);
    await db.prepare("DELETE FROM scrim_slots WHERE id IN (?1, ?2)").bind(slot, lone).run();
    expect(await earnedOf(host)).toEqual(["first_scrim"]);
    expect(await earnedOf(guest)).toEqual(["first_scrim"]);
    expect(await earnedOf(loner)).toEqual([]);
    const rec = await db.prepare("SELECT recorded_at IS NOT NULL AS r, hidden FROM v3_badge_state WHERE user_id = ?1 AND badge_id = 'first_scrim'").bind(guest.id).first();
    expect(rec).toEqual({ r: 1, hidden: 0 });
    // with the flag off the cron records nothing and touches no badge table
    await flagsOn("v3.tournaments", "v3.resume", "v3.lft", "v3.disputes");
    expect(await recordBadgesDaily(db, nowSec())).toBe(0);
    await prodLikeOn("v3.profiles", "v3.journal", "v3.achievements");
  });

  it("flag off: public pages carry badges: [] and the badge and journal routes are the plain 404", async () => {
    const { me, slug } = await captainWithResults();
    await prodLikeOn("v3.profiles");
    expect((await pub(slug)).badges).toEqual([]);
    const unknown = await api("/v3/definitely-not-a-route", { token: me.token });
    for (const [method, path] of [["GET", "/v3/me/badges"], ["PUT", "/v3/me/badges/hidden"], ["GET", "/v3/me/journal"], ["POST", "/v3/me/journal"], ["POST", "/v3/me/journal/clear"]] as const) {
      const r = await api(path, { method, token: me.token, body: method === "GET" ? undefined : {} });
      expect([r.status, r.json], `${method} ${path}`).toEqual([404, unknown.json]);
    }
    await prodLikeOn("v3.profiles", "v3.journal", "v3.achievements");
  });
});
