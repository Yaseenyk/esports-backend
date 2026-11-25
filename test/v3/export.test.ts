import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { uniq } from "../helpers";
import { resetFlagsCache } from "../../src/flags";
import { V3_PERSONAL_TABLES, V3_TABLE_NAMES } from "../../src/v3/lib/personal-tables";
import { buildV3Export, loadV3Export } from "../../src/v3/services/export-service";
import { allV3On, api, db, disputeWorld, flagsOn, nowSec, PNG, user } from "./helpers";
import { seedPhases } from "./phase-seed";

vi.setConfig({ testTimeout: 120_000 });
beforeAll(allV3On);
afterEach(async () => {
  await db.prepare("DELETE FROM flags WHERE key = 'feedback.enabled'").run();
  await allV3On();
});

const exportOf = (token: string) => api("/me/export", { method: "POST", token });
/** Every key name anywhere in a JSON value. */
const keysOf = (v: unknown, out: string[] = []): string[] => {
  if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysOf(x, out);
    }
  }
  return out;
};
const FORBIDDEN_KEY = /ip_?hash|token|hash|sha|blob|^data$|^bytes$|attach|password|salt|secret|discordUserId|raisedBy|uploadedBy|staff/i;

/** One row of personal data in every v3 table, like test/v3/deletion.test.ts. `me` is a captain; `other` is the other team captain. */
async function seed() {
  await flagsOn("v3.tournaments", "v3.resume", "v3.lft", "v3.disputes", "v3.profiles", "v3.scrims", "v3.directory", "v3.journal", "v3.achievements", "takedown.enforce");
  const mark = `XMARK${uniq()}`;
  const rid = `rbm${uniq()}`;
  const gid = `guild${uniq()}`;
  const w = await disputeWorld();
  const me = w.a;
  const other = w.b;
  await api("/v3/me/resume-consent", { token: me.token, body: { consent: true } });
  const slug = `exp-${uniq()}`.toLowerCase();
  await api("/v3/me/profile", { method: "PUT", token: me.token, body: { slug, handle: `${mark}handle`, bio: `${mark} bio`, visibility: "public" } });
  await api("/v3/me/games/bgmi", { method: "PUT", token: me.token, body: { inGameName: `${mark}ign`, roles: ["igl"] } });
  const mine = (await api("/v3/lft", { token: me.token, body: { kind: "looking_for_team", game: "bgmi", message: `${mark} looking for a squad tonight please`, contact: `${mark}#1` } })).json.id;
  const theirs = (await api("/v3/lft", { token: other.token, body: { kind: "looking_for_team", game: "bgmi", message: "OTHERLISTING looking for a squad tonight", contact: "other#1" } })).json.id;
  await api(`/v3/lft/${mine}/applications`, { token: other.token, body: { contact: "other#1", message: "OTHERAPPLICATION I would join" } });
  await api(`/v3/lft/${theirs}/applications`, { token: me.token, body: { contact: `${mark}#2`, message: `${mark} applying` } });
  await api(`/v3/lft/${theirs}/report`, { token: me.token, body: { reason: "spam", note: "x" } });
  const mineD = (await api(`/v3/tournaments/${w.slug}/disputes`, { token: me.token, body: { type: "other", summary: `${mark} summary of my claim`, againstTeam: "Beta Hawks" } })).json.id;
  await api(`/v3/disputes/${mineD}/comment`, { token: me.token, body: { note: `${mark} my comment` } });
  await api(`/v3/disputes/${mineD}/evidence?caption=${mark}%20caption`, { token: me.token, raw: PNG(150, 1) as BodyInit });
  const theirD = (await api(`/v3/tournaments/${w.slug}/disputes`, { token: other.token, body: { type: "no_show", summary: "OTHERDISPUTE they never showed up for match one.", againstTeam: "Alpha Wolves" } })).json.id;
  await api(`/v3/disputes/${theirD}/evidence?caption=OTHERCAPTION`, { token: other.token, raw: PNG(150, 3) as BodyInit });
  await db.prepare("INSERT INTO disputes (id, tournament_id, type, status, summary, resolution_note, resolved_by_user_id, resolved_at, due_at, created_at, updated_at) VALUES (?5, ?1, 'other', 'resolved', 'closed one', ?2, ?3, ?4, ?4, ?4, ?4)").bind(w.id, `${mark} decision`, me.id, nowSec(), rid).run();
  await db.prepare("INSERT INTO v3_result_corrections (id, dispute_id, event_id, match_ref, old_value, new_value, applied_by, created_at) VALUES (?4, ?5, ?1, 'match:x', '{}', '{}', ?2, ?3)").bind(w.eventId, me.id, nowSec(), `c${uniq()}`, rid).run();
  await db.prepare("INSERT INTO discord_guilds (guild_id, installed_by_user_id, permissions_ok, installed_at) VALUES (?3, ?1, 1, ?2)").bind(me.id, nowSec(), gid).run();
  await db.prepare("INSERT INTO discord_outbox (id, kind, guild_id, payload, idempotency_key) VALUES (?1, 'create_team_channel', ?2, '{}', ?1)").bind(`job${uniq()}`, gid).run();
  // match rooms (0070): a room I created as organiser and a reveal I made as captain; neither is exported (organiser data and the organiser's audit log)
  const roomId = `room${uniq()}`;
  await db.prepare("INSERT INTO v3_match_rooms (id, event_id, label, starts_at, reveal_at, secret_enc, created_by) VALUES (?1, ?2, 'Lobby', ?3, ?3, 'v1.x.y', ?4)").bind(roomId, w.eventId, nowSec(), me.id).run();
  await db.prepare("INSERT INTO v3_room_views (id, room_id, event_id, user_id, team_name, secret_version, viewed_at) VALUES (?1, ?2, ?3, ?4, 'Alpha Wolves', 1, ?5)").bind(`view${uniq()}`, roomId, w.eventId, me.id, nowSec()).run();
  const discordId = `DISCORDID${uniq()}`;
  await db.prepare("UPDATE users SET discord_user_id = ?1 WHERE id = ?2").bind(discordId, me.id).run();
  await db.prepare("INSERT INTO flags (key, value, updated_by, updated_at, note) VALUES ('feedback.enabled', 'true', 'test', ?1, '') ON CONFLICT (key) DO UPDATE SET value = 'true'").bind(new Date().toISOString()).run();
  resetFlagsCache();
  const fb = (m: string) => ({ kind: "bug", message: `${m} the page broke when I pressed save`, page: { path: "/tools/" }, client: { viewport: { w: 400, h: 800 } }, consent: true, consentVersion: "feedback-v1", website: "", includeAccount: true, contact: `${m}@example.com` });
  const fbMine = await api("/feedback", { token: me.token, body: fb(mark) });
  expect(fbMine.status, fbMine.text).toBe(201);
  await api(`/feedback/${fbMine.json.id}/attachments`, { raw: PNG(150, 77) as BodyInit, headers: { "content-type": "image/png", "x-attach-token": fbMine.json.attachToken } });
  const fbOther = await api("/feedback", { token: other.token, body: fb("OTHERFB") });
  expect(fbOther.status).toBe(201);
  const ph = await seedPhases({ w, me, other, mark, slug });
  return { mark, rid, gid, w, me, other, slug, mine, mineD, fbMine, discordId, ph };
}

describe("POST /me/export, v3 section", () => {
  it("one row in every v3 table: every section is filled, only with the user's own data, and the deletion and export table lists agree", async () => {
    const s = await seed();
    for (const t of V3_TABLE_NAMES) expect((await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n, `${t} has a row`).toBeGreaterThan(0);
    const r = await exportOf(s.me.token);
    expect(r.status, r.text).toBe(200);
    const j = r.json;
    expect(j.exportVersion).toBe(2);
    expect(j.v3Truncated).toBeUndefined();
    expect(Object.keys(j.v3).sort()).toEqual(["disputes", "feedback", "journal", "lft", "profiles", "ratings", "resume", "scrims"]);
    // builder C (0091): the private journal is exported in full, labelled self-logged; badge choices are listed
    expect(j.v3.journal).toMatchObject({ selfLogged: true, entryCount: 1, entries: [{ playedOn: "2026-11-20", game: "bgmi", kills: 7, placement: 2, notes: `${s.mark} journal note` }] });
    expect(j.v3.profiles.badgeSettings).toEqual([{ badge: "first_win", hidden: true, recordedAt: null, updatedAt: expect.any(String) }]);
    // phases 3-5: my team page settings and hidden entries; my scrim slots, the requests I SENT and the blocks I made (not who blocked me)
    expect(Object.keys(j.v3.profiles).sort()).toEqual(["badgeSettings", "hiddenOnPlayerPage", "hiddenOnTeamPages", "playerPageDetails", "teamPageSettings"]);
    expect(j.v3.profiles.playerPageDetails).toEqual({ teamName: `${s.mark} Wolves`, links: [], achievements: [{ title: `${s.mark} cup winner`, year: 2026 }], hiddenFields: ["languages"], cardLinkCreatedAt: expect.any(String), updatedAt: expect.any(String) });
    expect(r.text).not.toContain("/p/?k=");
    expect(j.v3.profiles.teamPageSettings).toEqual([{ teamPage: s.ph.myTeam.slug, name: s.ph.myTeam.name, visibility: "public", publicSince: expect.any(String) }]);
    expect(j.v3.profiles.hiddenOnPlayerPage).toEqual([{ item: s.ph.itemKey, createdAt: expect.any(String) }]);
    expect(j.v3.profiles.hiddenOnTeamPages).toEqual([{ teamPage: s.ph.myTeam.slug, item: s.ph.itemKey, createdAt: expect.any(String) }]);
    expect(Object.keys(j.v3.scrims).sort()).toEqual(["blocksMade", "notices", "schedules", "sentRequestCount", "sentRequests", "slotCount", "slots", "waitlist"]);
    expect(j.v3.scrims.slots).toEqual(expect.arrayContaining([expect.objectContaining({ id: s.ph.mySlot, contact: `${s.mark}c`, requestsReceived: 1 })]));
    expect(j.v3.scrims.waitlist).toEqual([expect.objectContaining({ status: "offered" })]);
    expect(j.v3.scrims.notices).toEqual([expect.objectContaining({ kind: "waitlist_offer", read: false })]);
    expect(j.v3.scrims.schedules).toEqual([expect.objectContaining({ timeOfDayIst: "23:59", daysAhead: 3, contact: `${s.mark}s` })]);
    expect(j.v3.scrims.sentRequests).toEqual(expect.arrayContaining([expect.objectContaining({ slotId: s.ph.theirSlot, status: "accepted", contact: `${s.mark}r` })]));
    expect(j.v3.scrims.blocksMade).toEqual([{ team: "Beta Hawks Page", createdAt: expect.any(String) }]);

    // resume
    expect(Object.keys(j.v3.resume).sort()).toEqual(["adultConfirmedAt", "discordLinked", "games", "profile", "resumeConsentAt"]);
    expect(Object.keys(j.v3.resume.profile).sort()).toEqual(["bio", "city", "createdAt", "handle", "languages", "slug", "state", "visibility"]);
    expect(j.v3.resume.profile).toMatchObject({ slug: s.slug, handle: `${s.mark}handle`, visibility: "public" });
    expect(Object.keys(j.v3.resume.games[0]).sort()).toEqual(["game", "inGameName", "rankCode", "rankOrdinal", "roles"]);
    expect(j.v3.resume.games[0]).toMatchObject({ game: "bgmi", inGameName: `${s.mark}ign`, roles: ["igl"] });
    expect(j.v3.resume.discordLinked).toBe(true);
    expect(j.v3.resume.adultConfirmedAt).toEqual(expect.any(String));
    expect(j.v3.resume.resumeConsentAt).toEqual(expect.any(String));
    // lft: my listing with a COUNT of applications received, my sent application, never the received one
    expect(Object.keys(j.v3.lft).sort()).toEqual(["applicationsReceivedTotal", "listingCount", "listings", "sentApplicationCount", "sentApplications"]);
    expect(Object.keys(j.v3.lft.listings[0]).sort()).toEqual(["applicationsReceived", "city", "createdAt", "expiresAt", "game", "id", "kind", "message", "onlineOk", "roles", "state", "status"]);
    expect(j.v3.lft.listings.map((l: { id: string }) => l.id)).toEqual([s.mine]);
    expect(j.v3.lft.listings[0].applicationsReceived).toBe(1);
    expect(j.v3.lft.applicationsReceivedTotal).toBe(1);
    expect(Object.keys(j.v3.lft.sentApplications[0]).sort()).toEqual(["createdAt", "listingId", "message", "respondedAt", "status"]);
    expect(j.v3.lft.sentApplications).toHaveLength(1);
    expect(j.v3.lft.sentApplications[0].message).toContain(s.mark);
    // disputes: raised ones with evidence METADATA, captain claims without the token
    expect(Object.keys(j.v3.disputes).sort()).toEqual(["captainClaims", "evidenceOnOtherDisputes", "raised", "raisedCount"]);
    expect(Object.keys(j.v3.disputes.raised[0]).sort()).toEqual(["createdAt", "evidence", "id", "outcome", "resolutionNote", "resolvedAt", "status", "summary", "tournament", "type"]);
    const mineD = j.v3.disputes.raised.find((d: { id: string }) => d.id === s.mineD);
    expect(mineD).toMatchObject({ tournament: s.w.slug, type: "other", status: "open" });
    expect(Object.keys(mineD.evidence[0]).sort()).toEqual(["createdAt", "mime", "purged", "sizeBytes"]);
    expect(mineD.evidence).toHaveLength(1);
    expect(j.v3.disputes.raised.map((d: { id: string }) => d.id)).not.toContain(s.rid); // resolved BY me (as staff) but not raised by me
    expect(Object.keys(j.v3.disputes.captainClaims[0]).sort()).toEqual(["createdAt", "eventId", "teamName"]);
    expect(j.v3.disputes.captainClaims[0]).toMatchObject({ eventId: s.w.eventId, teamName: "Alpha Wolves" });
    // feedback
    expect(Object.keys(j.v3.feedback).sort()).toEqual(["reportCount", "reports"]);
    expect(Object.keys(j.v3.feedback.reports[0]).sort()).toEqual(["clientErrors", "contact", "createdAt", "id", "kind", "message", "pagePath", "status"]);
    expect(j.v3.feedback.reports).toHaveLength(1);
    expect(j.v3.feedback.reports[0]).toMatchObject({ id: s.fbMine.json.id, contact: `${s.mark}@example.com`, pagePath: "/tools/" });

    // every table the shared list says is exported shows up in the output; every other table is marked "none" with a reason
    const present: Record<string, (v3: any) => unknown> = {
      player_profiles: (v) => v.resume.profile, player_games: (v) => v.resume.games.length,
      lft_listings: (v) => v.lft.listings.length, lft_applications: (v) => v.lft.sentApplications.length,
      disputes: (v) => v.disputes.raised.length, dispute_evidence: (v) => v.disputes.raised.find((d: { id: string }) => d.id === s.mineD).evidence.length,
      v3_team_captains: (v) => v.disputes.captainClaims.length, feedback_reports: (v) => v.feedback.reports.length,
      feedback_attachments: () => "screenshots are not listed for feedback, only the report; the attachment bytes and tokens are never exported",
      v3_team_pages: (v) => v.profiles.teamPageSettings.length, v3_player_hidden_items: (v) => v.profiles.hiddenOnPlayerPage.length,
      v3_team_hidden_items: (v) => v.profiles.hiddenOnTeamPages.length, v3_player_page_details: (v) => v.profiles.playerPageDetails, scrim_slots: (v) => v.scrims.slots.length,
      scrim_requests: (v) => v.scrims.sentRequests.length, scrim_blocks: (v) => v.scrims.blocksMade.length,
      v3_journal_entries: (v) => v.journal.entries.length, v3_badge_state: (v) => v.profiles.badgeSettings.length,
      scrim_waitlist: (v) => v.scrims.waitlist.length, scrim_notifications: (v) => v.scrims.notices.length, scrim_schedules: (v) => v.scrims.schedules.length,
    };
    for (const [t, c] of Object.entries(V3_PERSONAL_TABLES)) {
      if (c.export === "none") expect(c.why, `${t} needs a reason it is not exported`).toBeTruthy();
      else {
        expect(present[t], `${t} is exported but this test has no check for it`).toBeDefined();
        expect(present[t]!(j.v3), t).toBeTruthy();
      }
    }
    for (const t of Object.keys(present)) expect(V3_PERSONAL_TABLES[t], `${t} is checked here but missing from lib/personal-tables.ts`).toBeDefined();

    // nobody else's data, no secrets, no bytes
    for (const needle of ["OTHERSLOT", "OTHERREQUEST", "otherslot#1", "otherreq#1", "OTHERLISTING", "OTHERAPPLICATION", "OTHERDISPUTE", "OTHERCAPTION", "OTHERFB", s.other.id, s.other.email, s.discordId, s.fbMine.json.attachToken, "other#1", s.gid, `${s.mark} caption`, `${s.mark} my comment`]) {
      expect(r.text, needle).not.toContain(needle);
    }
    for (const k of keysOf(j)) expect(k, `key ${k}`).not.toMatch(FORBIDDEN_KEY);
    expect(r.text).not.toMatch(/ip_?hash|attach_token|"data":|base64/i);
    expect(r.text).not.toContain("spam"); // the report I filed on someone else's listing concerns that person and is not exported

    // the other user gets theirs, not mine
    const o = await exportOf(s.other.token);
    expect(o.status).toBe(200);
    expect(o.text).toContain("OTHERDISPUTE");
    expect(o.text).toContain("OTHERFB");
    expect(o.json.v3.lft.listings[0].applicationsReceived).toBe(1);
    expect(o.json.v3.lft.sentApplications[0].message).toContain("OTHERAPPLICATION");
    for (const needle of [s.mark, s.me.id, s.me.email, s.slug, s.discordId]) expect(o.text, needle).not.toContain(needle);
  });

  it("the export always works whatever the flags say, with feedback off too", async () => {
    const s = await seed();
    await flagsOn();
    await db.prepare("DELETE FROM flags WHERE key = 'feedback.enabled'").run();
    resetFlagsCache();
    const r = await exportOf(s.me.token);
    expect(r.status, r.text).toBe(200);
    expect(r.json.v3.resume.profile.slug).toBe(s.slug);
    expect(r.json.v3.lft.listings).toHaveLength(1);
    expect(r.json.v3.disputes.raised.length).toBeGreaterThan(0);
    expect(r.json.v3.feedback.reports).toHaveLength(1);
  });

  it("a user with no v3 activity gets empty sections", async () => {
    const u = await user("Nothing Yet", false);
    const r = await exportOf(u.token);
    expect(r.status).toBe(200);
    expect(r.json.v3).toEqual({
      resume: { adultConfirmedAt: null, resumeConsentAt: null, discordLinked: false, profile: null, games: [] },
      lft: { listingCount: 0, listings: [], applicationsReceivedTotal: 0, sentApplicationCount: 0, sentApplications: [] },
      disputes: { raisedCount: 0, raised: [], evidenceOnOtherDisputes: [], captainClaims: [] },
      feedback: { reportCount: 0, reports: [] },
      profiles: { teamPageSettings: [], hiddenOnPlayerPage: [], hiddenOnTeamPages: [], playerPageDetails: null, badgeSettings: [] },
      journal: { selfLogged: true, entryCount: 0, entries: [] },
      scrims: { slotCount: 0, slots: [], sentRequestCount: 0, sentRequests: [], blocksMade: [], schedules: [], waitlist: [], notices: [] },
      ratings: { writtenCount: 0, written: [], receivedCount: 0, received: [] },
    });
  });

  it("tables that are not migrated give empty sections, never an error, and no query touches a missing table", async () => {
    const u = await user("Partial");
    await db.prepare("INSERT INTO player_games (user_id, game, in_game_name, roles) VALUES (?1, 'bgmi', 'OnlyGames', '[]')").bind(u.id).run();
    // A database view where only `visible` tables exist: the sqlite_master probe answers with that list; any other query on a hidden table throws.
    const fake = (visible: string[]) =>
      ({
        prepare(sql: string) {
          if (sql.includes("sqlite_master")) return { first: async () => (visible.includes("feedback_reports") ? { x: 1 } : null), bind: () => ({ all: async () => ({ results: visible.map((name) => ({ name })) }) }) };
          const hidden = V3_TABLE_NAMES.filter((t) => !visible.includes(t)).find((t) => new RegExp(`\\b(FROM|JOIN)\\s+${t}\\b`).test(sql));
          if (hidden) throw new Error(`queried missing table ${hidden}`);
          return db.prepare(sql);
        },
      }) as unknown as D1Database;
    const none = buildV3Export(await loadV3Export(fake([]), u.id));
    expect(none.resume.games).toEqual([]);
    expect(none.disputes.raised).toEqual([]);
    const some = buildV3Export(await loadV3Export(fake(["player_games"]), u.id));
    expect(some.resume.games).toMatchObject([{ game: "bgmi", inGameName: "OnlyGames" }]);
    expect(some.lft.listings).toEqual([]);
    // a database that answers nothing at all (even the users columns) still yields empty sections
    const bare = { prepare: () => ({ bind() { return this; }, all: async () => ({ results: [] }), first: async () => null }) } as unknown as D1Database;
    const e = buildV3Export(await loadV3Export(bare, "nobody"));
    expect(e.resume.profile).toBeNull();
    expect(e.feedback.reportCount).toBe(0);
  });

  it("large v3 data shrinks the biggest optional parts to counts, sets v3Truncated and never fails the download", async () => {
    const w = await disputeWorld();
    const u = w.a;
    const msg = "F".repeat(1990);
    const note = "N".repeat(3000);
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 200; i++) {
      stmts.push(db.prepare("INSERT INTO feedback_reports (id, created_at, kind, message, page_path, signed_in, user_id, consent_version) VALUES (?1, ?2, 'bug', ?3, '/x/', 1, ?4, 'feedback-v1')").bind(`bigfb${i}-${uniq()}`, nowSec() + i, msg, u.id));
      stmts.push(db.prepare("INSERT INTO disputes (id, tournament_id, type, status, summary, resolution_note, raised_by_user_id, due_at, created_at, updated_at) VALUES (?1, ?2, 'other', 'open', ?3, ?4, ?5, ?6, ?6, ?6)").bind(`bigd${i}-${uniq()}`, w.id, "S".repeat(900), note, u.id, nowSec() + i));
    }
    await db.batch(stmts);
    const r = await exportOf(u.token);
    expect(r.status).toBe(200);
    expect(r.text.length).toBeLessThan(1_000_000);
    expect(r.json.v3Truncated).toBe(true);
    expect(r.json.v3.feedback.reportCount).toBe(200);
    expect(r.json.v3.feedback.reports).toEqual([]); // the largest optional part goes first
    expect(r.json.v3.disputes.raisedCount).toBe(200);
    expect(r.json.account.id).toBe(u.id);
  });
});
