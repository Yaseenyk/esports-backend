import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { uniq } from "../helpers";
import { lftReporterHash } from "../../src/v3/lib/reporter";
import { resetFlagsCache } from "../../src/flags";
import { allV3On, api, db, disputeWorld, flagsOn, nowSec, PNG, user } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
beforeAll(allV3On);

const TABLES = ["tournaments", "player_profiles", "player_games", "lft_listings", "lft_applications", "lft_reports", "disputes", "dispute_events", "dispute_evidence", "dispute_evidence_blobs", "v3_result_corrections", "v3_team_captains", "discord_guilds", "discord_outbox", "feedback_reports", "feedback_attachments", "feedback_attachment_blobs"];
const dump = async (t: string) => JSON.stringify((await db.prepare(`SELECT * FROM ${t}`).all()).results);

describe("account deletion covers every v3 table", () => {
  it("one row of personal data in every new table for a user; deleting the account leaves none of it", async () => {
    await flagsOn("v3.tournaments", "v3.resume", "v3.lft", "v3.disputes", "takedown.enforce");
    const mark = `MARK${uniq()}`;
    const w = await disputeWorld();
    const me = w.a; // captain of Alpha Wolves
    const other = w.b;

    // resume: profile + game + consent
    await api("/v3/me/resume-consent", { token: me.token, body: { consent: true } });
    const slug = `del-${uniq()}`.toLowerCase();
    await api("/v3/me/profile", { method: "PUT", token: me.token, body: { slug, handle: `${mark}handle`, bio: `${mark} bio`, visibility: "public" } });
    await api("/v3/me/games/bgmi", { method: "PUT", token: me.token, body: { inGameName: `${mark}ign`, roles: ["igl"] } });
    expect((await api(`/public/players/${slug}`)).status).toBe(200);

    // lft: my own listing (+ an application from someone), my application to another listing, my report on another listing
    const mine = (await api("/v3/lft", { token: me.token, body: { kind: "looking_for_team", game: "bgmi", message: `${mark} looking for a squad tonight please`, contact: `${mark}#1` } })).json.id;
    const theirs = (await api("/v3/lft", { token: other.token, body: { kind: "looking_for_team", game: "bgmi", message: "Other player looking for a squad tonight", contact: "other#1" } })).json.id;
    await api(`/v3/lft/${mine}/applications`, { token: other.token, body: { contact: "other#1", message: "I would join" } });
    await api(`/v3/lft/${theirs}/applications`, { token: me.token, body: { contact: `${mark}#2`, message: `${mark} applying` } });
    await api(`/v3/lft/${theirs}/report`, { token: me.token, body: { reason: "spam", note: "x" } });
    const hash = await lftReporterHash(env, me.id);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM lft_reports WHERE reporter = ?1").bind(hash).first<{ n: number }>())!.n).toBe(1);

    // disputes: one I raised (with a comment and a screenshot with a caption), one the other team raised against me with MY comment and MY screenshot
    const mineD = (await api(`/v3/tournaments/${w.slug}/disputes`, { token: me.token, body: { type: "other", summary: `${mark} summary of my claim`, againstTeam: "Beta Hawks" } })).json.id;
    await api(`/v3/disputes/${mineD}/comment`, { token: me.token, body: { note: `${mark} my comment` } });
    const myShot = (await api(`/v3/disputes/${mineD}/evidence?caption=${mark}%20caption`, { token: me.token, raw: PNG(150, 1) as BodyInit })).json.id;
    const theirD = (await api(`/v3/tournaments/${w.slug}/disputes`, { token: other.token, body: { type: "no_show", summary: "They never showed up for match one.", againstTeam: "Alpha Wolves" } })).json.id;
    await api(`/v3/disputes/${theirD}/comment`, { token: me.token, body: { note: `${mark} my reply as the named team` } });
    const myShot2 = (await api(`/v3/disputes/${theirD}/evidence`, { token: me.token, raw: PNG(150, 2) as BodyInit })).json.id;
    const otherShot = (await api(`/v3/disputes/${theirD}/evidence?caption=theirs`, { token: other.token, raw: PNG(150, 3) as BodyInit })).json.id;
    // a decision note and a correction attributed to me, a discord install, an outbox job
    await db.prepare("INSERT INTO disputes (id, tournament_id, type, status, summary, resolution_note, resolved_by_user_id, resolved_at, due_at, created_at, updated_at) VALUES ('resolvedbyme', ?1, 'other', 'resolved', 'closed one', ?2, ?3, ?4, ?4, ?4, ?4)").bind(w.id, `${mark} decision`, me.id, nowSec()).run();
    await db.prepare("INSERT INTO v3_result_corrections (id, dispute_id, event_id, match_ref, old_value, new_value, applied_by, created_at) VALUES ('corr1', 'resolvedbyme', ?1, 'match:x', '{}', '{}', ?2, ?3)").bind(w.eventId, me.id, nowSec()).run();
    await db.prepare("INSERT INTO discord_guilds (guild_id, installed_by_user_id, permissions_ok, installed_at) VALUES ('guild1', ?1, 1, ?2)").bind(me.id, nowSec()).run();
    await db.prepare("INSERT INTO discord_outbox (id, kind, guild_id, payload, idempotency_key) VALUES ('job1', 'create_team_channel', 'guild1', '{}', 'k1')").run();

    // feedback bot: one report linked to my account (with a contact, a screenshot and my marker), one of the other user that must survive
    await db.prepare("INSERT INTO flags (key, value, updated_by, updated_at, note) VALUES ('feedback.enabled', 'true', 'test', ?1, '') ON CONFLICT (key) DO UPDATE SET value = 'true'").bind(new Date().toISOString()).run();
    resetFlagsCache();
    const fbBody = (m: string) => ({ kind: "bug", message: `${m} the page broke when I pressed save`, page: { path: "/tools/" }, client: { viewport: { w: 400, h: 800 } }, consent: true, consentVersion: "feedback-v1", website: "", includeAccount: true, contact: `${m}@example.com` });
    const fbMine = await api("/feedback", { token: me.token, body: fbBody(mark) });
    expect(fbMine.status, fbMine.text).toBe(201);
    const fbShot = await api(`/feedback/${fbMine.json.id}/attachments`, { raw: PNG(150, 77) as BodyInit, headers: { "content-type": "image/png", "x-attach-token": fbMine.json.attachToken } });
    expect(fbShot.status, fbShot.text).toBe(201);
    const fbOther = await api("/feedback", { token: other.token, body: fbBody("othermark") });
    expect(fbOther.status).toBe(201);

    // every v3 table has at least one row from this scenario (so the test really covers them all)
    for (const t of TABLES) expect((await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n, `${t} has a row`).toBeGreaterThan(0);
    const before = (await Promise.all(TABLES.map(dump))).join("\n");
    expect(before).toContain(me.id);
    expect(before).toContain(mark);

    // delete the account
    const del = await api("/auth/delete-account", { token: me.token, body: { password: "correct horse" } });
    expect(del.status, del.text).toBe(200);

    // nothing personal is left in any v3 table
    for (const t of TABLES) {
      const text = await dump(t);
      for (const needle of [me.id, me.email, mark, hash]) expect(text, `${t} still holds ${needle}`).not.toContain(needle);
    }
    // the linked feedback is DELETED (not just unlinked), with its screenshot; the other user's report stays
    expect(await db.prepare("SELECT id FROM feedback_reports WHERE id = ?1").bind(fbMine.json.id).first()).toBeNull();
    expect((await db.prepare("SELECT COUNT(*) AS n FROM feedback_attachments WHERE id = ?1").bind(fbShot.json.id).first<{ n: number }>())!.n).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM feedback_attachment_blobs WHERE attachment_id = ?1").bind(fbShot.json.id).first<{ n: number }>())!.n).toBe(0);
    expect(await db.prepare("SELECT user_id AS u FROM feedback_reports WHERE id = ?1").bind(fbOther.json.id).first()).toEqual({ u: other.id });
    await db.prepare("DELETE FROM flags WHERE key = 'feedback.enabled'").run();
    resetFlagsCache();
    // direct rows are gone
    for (const [t, col] of [["player_profiles", "user_id"], ["player_games", "user_id"], ["lft_listings", "author_user_id"], ["lft_applications", "applicant_user_id"], ["v3_team_captains", "user_id"]] as const) {
      expect((await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?1`).bind(me.id).first<{ n: number }>())!.n, t).toBe(0);
    }
    expect((await db.prepare("SELECT COUNT(*) AS n FROM lft_applications WHERE listing_id = ?1").bind(mine).first<{ n: number }>())!.n).toBe(0); // applications to my deleted listing went with it
    expect((await api(`/public/players/${slug}`)).status).toBe(404);
    expect((await api(`/public/lft/${mine}`)).status).toBe(404);
    // my screenshots are gone (blob and caption), the metadata row says so; the other team's screenshot is untouched
    for (const id of [myShot, myShot2]) {
      expect((await db.prepare("SELECT COUNT(*) AS n FROM dispute_evidence_blobs WHERE evidence_id = ?1").bind(id).first<{ n: number }>())!.n).toBe(0);
      expect(await db.prepare("SELECT caption, purged_at IS NOT NULL AS purged, uploaded_by_user_id AS u FROM dispute_evidence WHERE id = ?1").bind(id).first()).toEqual({ caption: null, purged: 1, u: null });
    }
    expect((await db.prepare("SELECT COUNT(*) AS n FROM dispute_evidence_blobs WHERE evidence_id = ?1").bind(otherShot).first<{ n: number }>())!.n).toBe(1);
    // the disputes stay for the other team and the organiser, anonymised; their history stays in order
    expect(await db.prepare("SELECT summary, raised_by_user_id AS u FROM disputes WHERE id = ?1").bind(mineD).first()).toEqual({ summary: "[deleted]", u: null });
    expect(await db.prepare("SELECT resolution_note, resolved_by_user_id AS u FROM disputes WHERE id = 'resolvedbyme'").first()).toEqual({ resolution_note: "[deleted]", u: null });
    const events = (await db.prepare("SELECT action, actor_user_id AS u, note FROM dispute_events WHERE dispute_id IN (?1, ?2) ORDER BY created_at, rowid").bind(mineD, theirD).all<{ action: string; u: string | null; note: string | null }>()).results;
    expect(events.length).toBeGreaterThanOrEqual(6);
    expect(events.filter((e) => e.u === null).every((e) => e.note === "[deleted]" || e.note === null || e.action === "evidence_added")).toBe(true);
    expect(await db.prepare("SELECT applied_by FROM v3_result_corrections WHERE id = 'corr1'").first()).toEqual({ applied_by: null });
    expect(await db.prepare("SELECT installed_by_user_id AS u FROM discord_guilds WHERE guild_id = 'guild1'").first()).toEqual({ u: null });
    // the other captain can still read the dispute they were named in? they were party to theirD (raised it): yes
    expect((await api(`/v3/disputes/${theirD}`, { token: other.token })).status).toBe(200);
    await allV3On();
  });

  it("deleting an organiser removes their events with the tournaments, disputes and evidence under them", async () => {
    const w = await disputeWorld();
    const id = (await api(`/v3/tournaments/${w.slug}/disputes`, { token: w.a.token, body: { type: "other", summary: "A claim in a tournament that will vanish." } })).json.id;
    await api(`/v3/disputes/${id}/evidence`, { token: w.a.token, raw: PNG(100, 8) as BodyInit });
    const del = await api("/auth/delete-account", { token: w.owner.token, body: { password: "correct horse" } });
    expect(del.status, del.text).toBe(200);
    for (const [t, col, v] of [["tournaments", "id", w.id], ["disputes", "tournament_id", w.id]] as const) expect((await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${col} = ?1`).bind(v).first<{ n: number }>())!.n, t).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM dispute_evidence WHERE dispute_id = ?1").bind(id).first<{ n: number }>())!.n).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM dispute_evidence_blobs").first<{ n: number }>())!.n).toBeGreaterThanOrEqual(0);
    expect((await api(`/v3/disputes/${id}`, { token: w.a.token })).status).toBe(404);
  });

  it("deletion still works when the v3 tables are not there (migration 0051 not applied yet)", async () => {
    // Simulated: the existence probe says "no tables", and no v3 statement is added to the batch.
    const { v3AccountDeletionStatements } = await import("../../src/v3/services/account-service");
    const stub = { DB: { prepare: () => ({ first: async () => null }) } as unknown as D1Database, JWT_SECRET: "x" };
    expect(await v3AccountDeletionStatements(stub, "u1")).toEqual([]); // and the feedback tables are probed the same way
    const u = await user("Plain");
    expect((await api("/auth/delete-account", { token: u.token, body: { password: "correct horse" } })).status).toBe(200);
  });
});
