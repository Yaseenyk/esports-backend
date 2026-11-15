import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { uniq } from "../helpers";
import { makeStaff } from "../admin/helpers";
import { runRetention } from "../../src/v3/services/retention-service";
import { addBr, addMatch, addRegistration, allV3On, api, captainToken, db, disputeWorld, flagsOn, nowSec, PNG, tournament, user, type U } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
beforeAll(allV3On);

type W = Awaited<ReturnType<typeof disputeWorld>>;
const raise = (w: W, u: U, over: Record<string, unknown> = {}) =>
  api(`/v3/tournaments/${w.slug}/disputes`, { token: u.token, body: { type: "wrong_score", summary: "Our kills in match 2 were counted for the wrong team.", againstTeam: "Beta Hawks", ...over } });
async function dispute(w: W, over: Record<string, unknown> = {}) {
  const r = await raise(w, w.a, over);
  if (r.status !== 201) throw new Error(`raise ${r.status} ${r.text}`);
  return r.json.id as string;
}
const get = (id: string, u: U) => api(`/v3/disputes/${id}`, { token: u.token });
const move = (id: string, u: U, to: string, note?: string) => api(`/v3/disputes/${id}/transition`, { token: u.token, body: { to, note } });
const resolve = (id: string, u: U, over: Record<string, unknown> = {}) => api(`/v3/disputes/${id}/resolve`, { token: u.token, body: { outcome: "no_action", note: "Reviewed the screenshots and the lobby log.", ...over } });
const upload = (id: string, u: U, bytes: Uint8Array, q = "") => api(`/v3/disputes/${id}/evidence${q}`, { token: u.token, raw: bytes as BodyInit, headers: { "content-type": "text/html" } });
async function underReview(w: W, over: Record<string, unknown> = {}) {
  const id = await dispute(w, over);
  expect((await move(id, w.owner, "under_review")).status).toBe(200);
  return id;
}

describe("captain claim", () => {
  it("a signed-in user proves captaincy with the captain link token", async () => {
    const t = await tournament({}, "live");
    await addRegistration(t.eventId, "Gamma");
    const u = await user("Cap");
    const tok = await captainToken(t.eventId, "Gamma");
    expect((await api(`/v3/tournaments/${t.slug}/captain-claim`, { body: { token: tok } })).status).toBe(401);
    const r = await api(`/v3/tournaments/${t.slug}/captain-claim`, { token: u.token, body: { token: tok } });
    expect([r.status, r.json.team]).toEqual([200, "Gamma"]);
    expect((await api(`/v3/tournaments/${t.slug}/captain-claim`, { token: u.token, body: { token: tok } })).status).toBe(200); // idempotent
    expect((await db.prepare("SELECT COUNT(*) AS n FROM v3_team_captains WHERE user_id = ?1").bind(u.id).first<{ n: number }>())!.n).toBe(1);
  });
  it("refuses a bad token, another event's token, an unregistered team, a draft tournament", async () => {
    const t = await tournament({}, "live");
    const other = await tournament({}, "live");
    await addRegistration(other.eventId, "Elsewhere");
    await addRegistration(t.eventId, "Pending Team", "pending");
    const u = await user();
    const claim = (slug: string, token: unknown) => api(`/v3/tournaments/${slug}/captain-claim`, { token: u.token, body: { token } });
    expect((await claim(t.slug, "not-a-real-token-1234567890")).json.code).toBe("bad_token");
    expect((await claim(t.slug, await captainToken(other.eventId, "Elsewhere"))).json.code).toBe("bad_token");
    expect((await claim(t.slug, await captainToken(t.eventId, "Pending Team"))).json.code).toBe("team_not_registered");
    expect((await claim(t.slug, undefined)).json.code).toBe("token_required");
    const draft = await tournament();
    expect((await claim(draft.slug, await captainToken(draft.eventId, "X"))).status).toBe(404);
    expect((await claim("no-such-tournament", "x")).status).toBe(404);
  });
  it("a revoked captain link no longer works", async () => {
    const t = await tournament({}, "live");
    await addRegistration(t.eventId, "Delta");
    const tok = await captainToken(t.eventId, "Delta");
    await db.prepare("UPDATE captain_links SET revoked_at = ?1 WHERE event_id = ?2").bind(new Date().toISOString(), t.eventId).run();
    expect((await api(`/v3/tournaments/${t.slug}/captain-claim`, { token: (await user()).token, body: { token: tok } })).json.code).toBe("bad_token");
  });
});

describe("raising", () => {
  it("a captain raises; due in 72 hours; first event is written; both teams and the organiser can read it", async () => {
    const w = await disputeWorld();
    const r = await raise(w, w.a, { matchNo: 2 });
    expect(r.status, r.text).toBe(201);
    expect(r.json).toMatchObject({ type: "wrong_score", status: "open", raisedByTeam: "Alpha Wolves", againstTeam: "Beta Hawks", matchNo: 2, overdue: false, outcome: null });
    expect(Date.parse(r.json.dueAt) - Date.parse(r.json.createdAt)).toBe(72 * 3600 * 1000);
    expect(r.json.events).toEqual([expect.objectContaining({ actorRole: "team", action: "raised", fromStatus: null, toStatus: "open" })]);
    expect(r.json.permissions).toMatchObject({ role: "raiser", canWithdraw: true, canResolve: false, transitions: ["withdrawn"] });
    for (const u of [w.a, w.b, w.owner]) expect((await get(r.json.id, u)).status).toBe(200);
    const asB = await get(r.json.id, w.b);
    expect(asB.json.permissions).toMatchObject({ role: "team", canWithdraw: false, canResolve: false, transitions: [] });
    const asOrg = await get(r.json.id, w.owner);
    expect(asOrg.json.permissions).toMatchObject({ role: "organiser", transitions: ["evidence_requested", "under_review"] });
    expect(JSON.stringify(r.json)).not.toContain(w.a.id);
  });
  it("the organiser may raise on their own behalf", async () => {
    const w = await disputeWorld();
    const r = await api(`/v3/tournaments/${w.slug}/disputes`, { token: w.owner.token, body: { type: "no_show", summary: "Beta Hawks did not appear for match 3.", againstTeam: "Beta Hawks" } });
    expect(r.status, r.text).toBe(201);
    expect(r.json.raisedByTeam).toBeNull();
    expect(r.json.events[0].actorRole).toBe("organiser");
  });
  it("only a proven captain or the organiser: a stranger gets 404; a viewer cannot", async () => {
    const w = await disputeWorld();
    const stranger = await user("Stranger");
    expect((await raise(w, stranger)).status).toBe(404);
    expect((await api(`/v3/tournaments/${w.slug}/disputes`, { token: stranger.token })).status).toBe(404);
    const viewer = await user("Viewer");
    await db.prepare("INSERT INTO event_members (event_id, user_id, role, added_at) VALUES (?1, ?2, 'viewer', ?3)").bind(w.eventId, viewer.id, new Date().toISOString()).run();
    expect((await raise(w, viewer)).status).toBe(404);
    expect((await api("/v3/tournaments/x/disputes", { token: w.a.token, body: {} })).status).toBe(404);
    expect((await api(`/v3/tournaments/${w.slug}/disputes`, { body: {} })).status).toBe(401);
  });
  it("not before registration has closed", async () => {
    const t = await tournament({}, "registration_open");
    await addRegistration(t.eventId, "Early");
    const u = await user();
    await api(`/v3/tournaments/${t.slug}/captain-claim`, { token: u.token, body: { token: await captainToken(t.eventId, "Early") } });
    const r = await api(`/v3/tournaments/${t.slug}/disputes`, { token: u.token, body: { type: "other", summary: "Something long enough to be valid." } });
    expect([r.status, r.json.code]).toEqual([409, "tournament_not_started"]);
  });
  it("validates type, summary, teams, match", async () => {
    const w = await disputeWorld();
    const mid = await addMatch(w.eventId, "Alpha Wolves", "Beta Hawks");
    const cases: [Record<string, unknown>, string][] = [
      [{ type: "x" }, "invalid_type"], [{ summary: "short" }, "summary_empty"], [{ summary: "call me on 9876543210 about the match" }, "summary_has_phone"],
      [{ summary: "x".repeat(1001) }, "summary_too_long"], [{ againstTeam: "Nobody FC" }, "invalid_againstTeam"], [{ againstTeam: "alpha wolves" }, "invalid_againstTeam"],
      [{ matchId: "nope" }, "invalid_matchId"], [{ team: "Beta Hawks" }, "invalid_team"], [{ matchNo: 0 }, "invalid_matchNo"],
    ];
    for (const [over, code] of cases) {
      const r = await raise(w, w.a, over);
      expect([r.status, r.json.code], JSON.stringify(over)).toEqual([400, code]);
    }
    expect((await raise(w, w.a, { matchId: mid, summary: "Links like https://imgur.com/x are fine in disputes as evidence." })).status).toBe(201);
  });
  it("at most 3 open disputes per raiser per tournament", async () => {
    const w = await disputeWorld();
    for (let i = 0; i < 3; i++) await dispute(w);
    const r = await raise(w, w.a);
    expect([r.status, r.json.code]).toEqual([429, "dispute_cap"]);
    expect((await raise(w, w.b, { againstTeam: "Alpha Wolves" })).status).toBe(201);
  });
});

describe("who can see what", () => {
  it("lists: organiser sees all, a captain only theirs, strangers and a third team's captain see nothing", async () => {
    const w = await disputeWorld();
    await addRegistration(w.eventId, "Third Team");
    const c = await user("CaptainC");
    await api(`/v3/tournaments/${w.slug}/captain-claim`, { token: c.token, body: { token: await captainToken(w.eventId, "Third Team") } });
    const d1 = await dispute(w);
    const d2 = (await raise(w, w.b, { againstTeam: "Third Team", summary: "Third Team used an unregistered player." })).json.id;
    const ids = async (u: U) => (await api(`/v3/tournaments/${w.slug}/disputes`, { token: u.token })).json.items.map((x: { id: string }) => x.id).sort();
    expect(await ids(w.owner)).toEqual([d1, d2].sort());
    expect(await ids(w.a)).toEqual([d1]);
    expect(await ids(w.b)).toEqual([d1, d2].sort());
    expect(await ids(c)).toEqual([d2]);
    const stranger = await user();
    expect((await api(`/v3/tournaments/${w.slug}/disputes`, { token: stranger.token })).status).toBe(404);
    expect((await get(d1, c)).status).toBe(404);
    expect((await get(d1, stranger)).status).toBe(404);
    expect((await get("00000000000000000000000000000000", stranger)).status).toBe(404);
    expect((await get("not-an-id", w.owner)).status).toBe(404);
    expect((await api(`/v3/me/disputes`, { token: w.a.token })).json.items.map((x: { id: string }) => x.id)).toEqual([d1]);
    const item = (await api(`/v3/tournaments/${w.slug}/disputes`, { token: w.owner.token })).json.items[0];
    expect(Object.keys(item).sort()).toEqual(["againstTeam", "createdAt", "dueAt", "evidenceCount", "id", "overdue", "raisedByTeam", "status", "summary", "tournament", "type"]);
  });
  it("another organiser's tournament: its organiser cannot read my dispute", async () => {
    const w = await disputeWorld();
    const id = await dispute(w);
    const other = await tournament({}, "live");
    expect((await get(id, other.owner)).status).toBe(404);
  });
  it("overdue is flagged once due_at has passed and the dispute is undecided", async () => {
    const w = await disputeWorld();
    const id = await dispute(w);
    await db.prepare("UPDATE disputes SET due_at = ?2 WHERE id = ?1").bind(id, nowSec() - 60).run();
    expect((await get(id, w.owner)).json.overdue).toBe(true);
    expect((await api(`/v3/tournaments/${w.slug}/disputes`, { token: w.owner.token })).json.items[0].overdue).toBe(true);
    await move(id, w.a, "withdrawn");
    expect((await get(id, w.owner)).json.overdue).toBe(false);
  });
});

describe("comments", () => {
  it("parties and the organiser comment; strangers cannot; phone numbers refused; closed disputes refuse", async () => {
    const w = await disputeWorld();
    const id = await dispute(w);
    const say = (u: U, note: unknown) => api(`/v3/disputes/${id}/comment`, { token: u.token, body: { note } });
    expect((await say(w.b, "We disagree: the lobby log shows our kills.")).status).toBe(201);
    expect((await say(w.owner, "Please send the full-lobby screenshot.")).status).toBe(201);
    expect((await say(await user(), "hi")).status).toBe(404);
    expect((await say(w.a, "call 9876543210")).json.code).toBe("note_has_phone");
    expect((await say(w.a, "")).json.code).toBe("note_empty");
    const ev = (await get(id, w.a)).json.events;
    expect(ev.map((e: { action: string; actorRole: string }) => `${e.actorRole}:${e.action}`)).toEqual(["team:raised", "team:comment", "organiser:comment"]);
    await move(id, w.a, "withdrawn");
    expect((await say(w.b, "too late")).json.code).toBe("dispute_final");
  });
});

describe("evidence", () => {
  it("uploads png/jpeg/webp by magic bytes (the client type is ignored) and serves them as attachments", async () => {
    const w = await disputeWorld();
    const id = await dispute(w);
    const png = PNG(300, 1);
    const up = await upload(id, w.a, png, "?caption=Lobby%20result%20screen");
    expect(up.status, up.text).toBe(201);
    expect(up.json).toMatchObject({ mimeType: "image/png", sizeBytes: 300, caption: "Lobby result screen" });
    const jpg = await upload(id, w.a, Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, ...new Uint8Array(60).fill(7)]));
    const webp = await upload(id, w.a, Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, ...new Uint8Array(60).fill(9)]));
    expect([jpg.json.mimeType, webp.json.mimeType]).toEqual(["image/jpeg", "image/webp"]);
    const dl = await api(`/v3/disputes/${id}/evidence/${up.json.id}`, { token: w.b.token }); // the other team may read it too
    expect(dl.status).toBe(200);
    expect(dl.headers.get("content-type")).toBe("image/png");
    expect(dl.headers.get("content-disposition")).toMatch(/^attachment; filename="evidence-[0-9a-f]{8}\.png"$/);
    expect(dl.headers.get("x-content-type-options")).toBe("nosniff");
    expect(dl.headers.get("cache-control")).toBe("private, no-store");
    expect(dl.bytes).toEqual(png);
    const org = await api(`/v3/disputes/${id}/evidence/${jpg.json.id}`, { token: w.owner.token });
    expect([org.status, org.headers.get("content-type")]).toEqual([200, "image/jpeg"]);
    const detail = (await get(id, w.owner)).json;
    expect(detail.evidence).toHaveLength(3);
    expect(Object.keys(detail.evidence[0]).sort()).toEqual(["caption", "createdAt", "id", "mimeType", "purgeAfter", "purged", "sizeBytes"]);
    expect(detail.events.filter((e: { action: string }) => e.action === "evidence_added")).toHaveLength(3);
  });
  it("refuses wrong content, size, empty, duplicates, the 5th file, strangers, closed disputes", async () => {
    const w = await disputeWorld();
    const id = await dispute(w);
    const svg = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    expect((await upload(id, w.a, svg)).json.code).toBe("bad_image");
    expect((await upload(id, w.a, new TextEncoder().encode("GIF89a....."))).status).toBe(415);
    expect((await upload(id, w.a, new Uint8Array(0))).json.code).toBe("empty_file");
    const big = PNG(400 * 1024 + 1, 2);
    expect((await upload(id, w.a, big)).status).toBe(413);
    expect((await upload(id, w.a, PNG(400 * 1024, 3))).status).toBe(201); // exactly 400 KB passes
    const dup = await upload(id, w.b, PNG(400 * 1024, 3));
    expect([dup.status, dup.json.code]).toEqual([409, "duplicate_evidence"]);
    for (let i = 4; i < 7; i++) expect((await upload(id, w.a, PNG(100, i))).status).toBe(201);
    const fifth = await upload(id, w.a, PNG(100, 99));
    expect([fifth.status, fifth.json.code]).toEqual([409, "evidence_cap"]);
    expect((await upload(id, await user(), PNG(100, 50))).status).toBe(404);
    expect((await api(`/v3/disputes/${id}/evidence`, { raw: PNG(10) as BodyInit })).status).toBe(401);
    expect((await get(id, w.a)).json.evidence).toHaveLength(4);
    await move(id, w.a, "withdrawn");
    expect((await upload(id, w.a, PNG(100, 60))).json.code).toBe("dispute_final");
  });
  it("only parties, the organiser (and moderators) can download; ids are scoped to the dispute", async () => {
    const w = await disputeWorld();
    const id = await dispute(w);
    const id2 = await dispute(w, { summary: "Another claim about match three scoring." });
    const ev = (await upload(id, w.a, PNG(120, 1))).json.id;
    const stranger = await user();
    expect((await api(`/v3/disputes/${id}/evidence/${ev}`, { token: stranger.token })).status).toBe(404);
    expect((await api(`/v3/disputes/${id}/evidence/${ev}`)).status).toBe(401);
    expect((await api(`/v3/disputes/${id2}/evidence/${ev}`, { token: w.a.token })).status).toBe(404); // right id, wrong dispute
    expect((await api(`/v3/disputes/${id}/evidence/${"0".repeat(32)}`, { token: w.a.token })).status).toBe(404);
    expect((await api(`/v3/disputes/${id}/evidence/bad`, { token: w.a.token })).status).toBe(404);
    expect((await upload(id, stranger, PNG(120, 2))).status).toBe(404);
  });
  it("kill.uploads stops uploads (503)", async () => {
    const w = await disputeWorld();
    const id = await dispute(w);
    await flagsOn("v3.tournaments", "v3.resume", "v3.lft", "v3.disputes", "kill.uploads");
    expect((await upload(id, w.a, PNG(100, 1))).status).toBe(503);
    await allV3On();
  });
  it("evidence bytes live apart from metadata: the list query never reads a blob", async () => {
    const w = await disputeWorld();
    const id = await dispute(w);
    const ev = (await upload(id, w.a, PNG(500, 4))).json.id;
    expect((await db.prepare("SELECT COUNT(*) AS n FROM dispute_evidence_blobs WHERE evidence_id = ?1").bind(ev).first<{ n: number }>())!.n).toBe(1);
    const cols = (await db.prepare("PRAGMA table_info(dispute_evidence)").all<{ name: string }>()).results.map((c) => c.name);
    expect(cols).not.toContain("bytes");
    expect(await db.prepare("SELECT size_bytes, sha256 FROM dispute_evidence WHERE id = ?1").bind(ev).first()).toMatchObject({ size_bytes: 500, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });
});

describe("status machine and authority", () => {
  it("organiser moves open -> evidence_requested <-> under_review; illegal moves are 409; parties cannot move", async () => {
    const w = await disputeWorld();
    const id = await dispute(w);
    expect((await move(id, w.a, "under_review")).json.code).toBe("not_allowed");
    expect((await move(id, w.b, "evidence_requested")).status).toBe(403);
    expect((await move(id, await user(), "under_review")).status).toBe(404);
    expect((await move(id, w.owner, "escalated")).json.code).toBe("bad_transition"); // open -> escalated is not a move
    expect((await move(id, w.owner, "resolved")).json.code).toBe("use_resolve");
    expect((await move(id, w.owner, "nonsense")).status).toBe(400);
    const er = await move(id, w.owner, "evidence_requested", "Please add the lobby screenshot");
    expect([er.status, er.json.status]).toEqual([200, "evidence_requested"]);
    expect((await move(id, w.owner, "evidence_requested")).json.code).toBe("bad_transition");
    expect((await move(id, w.owner, "under_review")).json.status).toBe("under_review");
    expect((await move(id, w.owner, "evidence_requested")).json.status).toBe("evidence_requested");
    const events = (await get(id, w.a)).json.events.map((e: { action: string; fromStatus: string | null; toStatus: string | null }) => `${e.action}:${e.fromStatus}>${e.toStatus}`);
    expect(events).toEqual(["raised:null>open", "status_evidence_requested:open>evidence_requested", "status_under_review:evidence_requested>under_review", "status_evidence_requested:under_review>evidence_requested"]);
  });
  it("only the raiser withdraws; the organiser and the other team cannot", async () => {
    const w = await disputeWorld();
    const id = await dispute(w);
    expect((await move(id, w.b, "withdrawn")).status).toBe(403);
    expect((await move(id, w.owner, "withdrawn")).status).toBe(403);
    const ok = await move(id, w.a, "withdrawn", "Resolved between us");
    expect([ok.status, ok.json.status]).toEqual([200, "withdrawn"]);
    expect((await move(id, w.owner, "under_review")).json.code).toBe("bad_transition");
    expect((await resolve(id, w.owner)).json.code).toBe("dispute_final");
  });
  it("two concurrent moves: a lost race is a 409 and never a half-written history", async () => {
    const w = await disputeWorld();
    const id = await dispute(w);
    const rs = await Promise.all([move(id, w.owner, "under_review"), move(id, w.owner, "evidence_requested")]);
    expect(rs.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    expect(rs.some((r) => r.status === 200)).toBe(true);
    const ev = (await get(id, w.owner)).json.events.filter((e: { action: string }) => e.action.startsWith("status_"));
    expect(ev.length).toBe(rs.filter((r) => r.status === 200).length);
  });
  it("the organiser escalates; then only a moderator decides", async () => {
    const w = await disputeWorld();
    const id = await underReview(w);
    const esc = await move(id, w.owner, "escalated", "Needs a neutral view");
    expect(esc.json.status).toBe("escalated");
    expect(esc.json.permissions).toMatchObject({ canResolve: false, transitions: [] });
    const r = await resolve(id, w.owner);
    expect([r.status, r.json.code]).toEqual([403, "not_allowed"]);
    expect((await move(id, w.owner, "under_review")).status).toBe(403);
  });
});

describe("resolving", () => {
  it("the organiser resolves from under_review with an outcome; nothing before that", async () => {
    const w = await disputeWorld();
    const id = await dispute(w);
    expect((await resolve(id, w.owner)).json.code).toBe("bad_transition");
    await move(id, w.owner, "under_review");
    const r = await resolve(id, w.owner, { outcome: "no_action", note: "The lobby log matches the organiser's sheet." });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ status: "resolved", outcome: "no_action", resolutionNote: "The lobby log matches the organiser's sheet." });
    expect(r.json.resolvedAt).toBeTruthy();
    expect(r.json.events.at(-1)).toMatchObject({ actorRole: "organiser", action: "status_resolved", fromStatus: "under_review", toStatus: "resolved" });
    expect((await resolve(id, w.owner)).json.code).toBe("dispute_final");
  });
  it("nobody resolves a dispute they raised or are named in", async () => {
    const w = await disputeWorld();
    const id = await underReview(w);
    for (const u of [w.a, w.b]) {
      const r = await resolve(id, u);
      expect([r.status, r.json.code]).toEqual([403, "conflict_of_interest"]);
    }
    expect((await resolve(id, await user())).status).toBe(404);
    // an organiser who also captains one of the teams cannot decide it either
    await db.prepare("INSERT INTO v3_team_captains (event_id, team_key, team_name, user_id) VALUES (?1, 'beta hawks', 'Beta Hawks', ?2)").bind(w.eventId, w.owner.id).run();
    const r = await resolve(id, w.owner);
    expect([r.status, r.json.code]).toEqual([403, "conflict_of_interest"]);
    expect((await move(id, w.owner, "evidence_requested")).status).toBe(403);
  });
  it("a dispute the organiser raised cannot be decided or moved by the organiser; a moderator does it", async () => {
    const w = await disputeWorld();
    const r = await api(`/v3/tournaments/${w.slug}/disputes`, { token: w.owner.token, body: { type: "no_show", summary: "Beta Hawks missed match 3 without notice.", againstTeam: "Beta Hawks" } });
    const id = r.json.id;
    expect(r.json.permissions).toMatchObject({ role: "organiser", transitions: ["withdrawn"], canResolve: false });
    expect((await move(id, w.owner, "under_review")).status).toBe(403);
    const staff = await makeStaff();
    const token = (await staff.login()).token;
    expect((await api(`/admin/v1/v3/disputes/${id}/transition`, { token, body: { to: "under_review" } })).json.status).toBe("under_review");
    const done = await api(`/admin/v1/v3/disputes/${id}/resolve`, { token, body: { status: "rejected", outcome: "rejected", note: "No evidence of a no-show was provided." } });
    expect([done.status, done.json.status, done.json.events.at(-1).actorRole]).toEqual([200, "rejected", "moderator"]);
  });
  it("validates outcome, status pairing, note", async () => {
    const w = await disputeWorld();
    const id = await underReview(w);
    const cases: [Record<string, unknown>, string][] = [
      [{ outcome: "won" }, "invalid_outcome"], [{ status: "rejected", outcome: "upheld" }, "invalid_outcome"], [{ status: "resolved", outcome: "rejected" }, "invalid_outcome"],
      [{ status: "maybe" }, "invalid_status"], [{ note: "short" }, "note_empty"], [{ note: "call 9876543210 for details" }, "note_has_phone"],
      [{ outcome: "no_action", corrections: [{ matchId: "x" }] }, "invalid_corrections"], [{ outcome: "upheld", corrections: "no" }, "invalid_corrections"],
    ];
    for (const [over, code] of cases) {
      const r = await resolve(id, w.owner, over);
      expect([r.status, r.json.code], JSON.stringify(over)).toEqual([400, code]);
    }
    expect((await get(id, w.owner)).json.status).toBe("under_review");
    expect((await resolve(id, w.owner, { status: "rejected", outcome: "rejected" })).json.status).toBe("rejected");
  });
  it("a resolved dispute that corrects a result writes a NEW correction row, never touches the legacy rows, and the public read shows it as corrected", async () => {
    const w = await disputeWorld();
    const mid = await addMatch(w.eventId, "Alpha Wolves", "Beta Hawks", { score_a: 5, score_b: 7, winner: "b" });
    await addBr(w.eventId, 2, "Alpha Wolves", 2, 5);
    const id = await underReview(w, { matchId: mid, matchNo: 2 });
    const corrections = [{ matchId: mid, scoreA: 9, scoreB: 7, winner: "a" }, { matchNo: 2, team: "Alpha Wolves", placement: 1, kills: 6 }];
    expect((await resolve(id, w.owner, { outcome: "no_action", corrections })).json.code).toBe("invalid_corrections");
    expect((await resolve(id, w.owner, { outcome: "upheld", corrections: [{ matchId: "ghost", scoreA: 1, scoreB: 1, winner: "a" }] })).json.code).toBe("correction_target_missing");
    expect((await resolve(id, w.owner, { outcome: "upheld", corrections: [{ matchNo: 9, team: "Alpha Wolves", placement: 1, kills: 1 }] })).json.code).toBe("correction_target_missing");
    expect((await resolve(id, w.owner, { outcome: "upheld", corrections: [{ matchId: mid, scoreA: -1, scoreB: 1, winner: "a" }] })).status).toBe(400);
    expect((await get(id, w.owner)).json.corrections).toEqual([]);
    const r = await resolve(id, w.owner, { outcome: "upheld", note: "Screenshots show the real score was 9 to 7.", corrections });
    expect(r.status, r.text).toBe(200);
    expect(r.json.corrections).toEqual([
      { matchRef: `match:${mid}`, oldValue: { scoreA: 5, scoreB: 7, winner: "b" }, newValue: { scoreA: 9, scoreB: 7, winner: "a" } },
      { matchRef: "br:2:Alpha Wolves", oldValue: { placement: 2, kills: 5 }, newValue: { placement: 1, kills: 6 } },
    ]);
    expect(await db.prepare("SELECT score_a, score_b, winner FROM matches WHERE id = ?1").bind(mid).first()).toEqual({ score_a: 5, score_b: 7, winner: "b" });
    expect(await db.prepare("SELECT placement, kills FROM br_results WHERE event_id = ?1").bind(w.eventId).first()).toEqual({ placement: 2, kills: 5 });
    expect((await db.prepare("SELECT COUNT(*) AS n FROM v3_result_corrections WHERE dispute_id = ?1").bind(id).first<{ n: number }>())!.n).toBe(2);
    // the public page: both teams must be public to be named
    await db.prepare("INSERT INTO team_profiles (id, owner_user_id, name, slug, published, updated_at) VALUES ('tpx1', ?1, 'Alpha Wolves', 'alpha-w-pub', 1, ?2)").bind(w.a.id, new Date().toISOString()).run();
    await db.prepare("INSERT INTO team_profile_events (profile_id, event_id, team_name) VALUES ('tpx1', ?1, 'Alpha Wolves')").bind(w.eventId).run();
    const pub = await api(`/public/tournaments/${w.slug}`);
    expect(pub.json.results.matches[0]).toMatchObject({ scoreA: 9, scoreB: 7, winner: "a", corrected: true, original: { scoreA: 5, scoreB: 7, winner: "b" } });
    expect(pub.json.results.battleRoyale[0]).toMatchObject({ team: "Alpha Wolves", placement: 1, kills: 6, corrected: true, original: { placement: 2, kills: 5 } });
  });
});

describe("history is append-only", () => {
  it("the database refuses to change or delete the meaning of an event (only actor and a [deleted] note may change)", async () => {
    const w = await disputeWorld();
    const id = await dispute(w);
    await api(`/v3/disputes/${id}/comment`, { token: w.a.token, body: { note: "A comment that must stay as written." } });
    const upd = (set: string) => db.prepare(`UPDATE dispute_events SET ${set} WHERE dispute_id = ?1 AND action = 'comment'`).bind(id).run();
    for (const set of ["note = 'rewritten'", "action = 'raised'", "to_status = 'resolved'", "created_at = 1", "actor_role = 'moderator'", "dispute_id = 'x'"]) await expect(upd(set), set).rejects.toThrow(/append-only/);
    await expect(upd("note = '[deleted]'")).resolves.toBeDefined();
    await expect(upd("actor_user_id = NULL")).resolves.toBeDefined();
  });
});

describe("evidence retention", () => {
  it("bytes are purged 90 days after the final state; the row stays with purged_at; the download answers 410", async () => {
    const w = await disputeWorld();
    const id = await underReview(w);
    const ev = (await upload(id, w.a, PNG(250, 1))).json.id;
    const ev2 = (await upload(id, w.b, PNG(250, 2))).json.id;
    const resolvedAt = nowSec();
    await resolve(id, w.owner);
    const row = await db.prepare("SELECT purge_after FROM dispute_evidence WHERE id = ?1").bind(ev).first<{ purge_after: number }>();
    expect(Math.abs(row!.purge_after - (resolvedAt + 90 * 86_400))).toBeLessThan(5);
    expect((await api(`/v3/disputes/${id}/evidence/${ev}`, { token: w.a.token })).status).toBe(200); // still there after resolution
    const early = await runRetention(env.DB, { daily: true, now: resolvedAt + 89 * 86_400 });
    expect(early.purged).toBe(0);
    expect((await api(`/v3/disputes/${id}/evidence/${ev}`, { token: w.a.token })).status).toBe(200);
    const late = await runRetention(env.DB, { daily: true, now: resolvedAt + 91 * 86_400 });
    expect(late.purged).toBeGreaterThanOrEqual(2);
    const gone = await api(`/v3/disputes/${id}/evidence/${ev}`, { token: w.a.token });
    expect([gone.status, gone.json.code]).toEqual([410, "evidence_purged"]);
    expect((await api(`/v3/disputes/${id}/evidence/${ev2}`, { token: w.b.token })).status).toBe(410);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM dispute_evidence_blobs WHERE evidence_id IN (?1, ?2)").bind(ev, ev2).first<{ n: number }>())!.n).toBe(0);
    expect(await db.prepare("SELECT purged_at IS NOT NULL AS p FROM dispute_evidence WHERE id = ?1").bind(ev).first()).toEqual({ p: 1 });
    const detail = (await get(id, w.owner)).json;
    expect(detail.evidence.map((e: { purged: boolean }) => e.purged)).toEqual([true, true]);
    expect(detail.status).toBe("resolved"); // the dispute and its events stay
    expect(detail.events.length).toBeGreaterThanOrEqual(4);
  });
  it("withdrawn and rejected disputes also start the 90 day clock; undecided ones never purge", async () => {
    const w = await disputeWorld();
    const open = await dispute(w);
    const withdrawn = await dispute(w, { summary: "A claim the team later withdrew entirely." });
    const evOpen = (await upload(open, w.a, PNG(100, 11))).json.id;
    const evW = (await upload(withdrawn, w.a, PNG(100, 12))).json.id;
    await move(withdrawn, w.a, "withdrawn");
    expect((await db.prepare("SELECT purge_after FROM dispute_evidence WHERE id = ?1").bind(evOpen).first<{ purge_after: number | null }>())!.purge_after).toBeNull();
    expect((await db.prepare("SELECT purge_after FROM dispute_evidence WHERE id = ?1").bind(evW).first<{ purge_after: number | null }>())!.purge_after).toBeGreaterThan(nowSec() + 89 * 86_400);
    await runRetention(env.DB, { daily: true, now: nowSec() + 365 * 86_400 });
    expect((await api(`/v3/disputes/${open}/evidence/${evOpen}`, { token: w.a.token })).status).toBe(200);
    expect((await api(`/v3/disputes/${withdrawn}/evidence/${evW}`, { token: w.a.token })).status).toBe(410);
  });
});

describe("moderators (staff token)", () => {
  it("only staff tokens reach the routes; the queue lists escalated first; a moderator reads, comments, downloads and resolves", async () => {
    const w = await disputeWorld();
    const d1 = await dispute(w);
    const d2 = await underReview(w, { summary: "A second claim that will be escalated." });
    await move(d2, w.owner, "escalated");
    const ev = (await upload(d1, w.a, PNG(90, 5))).json.id;
    const staff = await makeStaff();
    const token = (await staff.login()).token;
    for (const t of [undefined, w.owner.token, w.a.token]) {
      expect((await api("/admin/v1/v3/disputes", { token: t })).status).toBe(404);
      expect((await api(`/admin/v1/v3/disputes/${d1}`, { token: t })).status).toBe(404);
    }
    const q = await api("/admin/v1/v3/disputes", { token });
    expect(q.status, q.text).toBe(200);
    const mine = q.json.items.filter((x: { id: string }) => [d1, d2].includes(x.id)).map((x: { id: string }) => x.id);
    expect(mine).toEqual([d2, d1]); // escalated first
    expect((await api("/admin/v1/v3/disputes?status=bogus", { token })).status).toBe(400);
    expect((await api("/admin/v1/v3/disputes?status=escalated", { token })).json.items.every((x: { status: string }) => x.status === "escalated")).toBe(true);
    const det = await api(`/admin/v1/v3/disputes/${d1}`, { token });
    expect(det.json.permissions).toMatchObject({ role: "moderator", canComment: true, canUploadEvidence: false });
    expect((await api(`/admin/v1/v3/disputes/${d1}/evidence/${ev}`, { token })).bytes).toEqual(PNG(90, 5));
    const c = await api(`/admin/v1/v3/disputes/${d1}/comment`, { token, body: { note: "Moderator note: please add the lobby screenshot." } });
    expect([c.status, c.json.events.at(-1).actorRole]).toEqual([201, "moderator"]);
    const done = await api(`/admin/v1/v3/disputes/${d2}/resolve`, { token, body: { outcome: "upheld", note: "Escalated dispute decided after review." } });
    expect([done.status, done.json.status]).toEqual([200, "resolved"]);
    expect((await api("/admin/v1/v3/disputes/not-an-id", { token })).status).toBe(404);
  });
});
