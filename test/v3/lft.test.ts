import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { uniq } from "../helpers";
import { makeStaff } from "../admin/helpers";
import { runRetention } from "../../src/v3/services/retention-service";
import { allV3On, api, db, flagsOn, nowSec, user, type U } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
beforeAll(allV3On);

const cityTag = () => `City${uniq()}`.slice(0, 40);
const body = (over: Record<string, unknown> = {}) => ({
  kind: "looking_for_team", game: "bgmi", roles: ["igl"], rankMin: 10, rankMax: 20, state: "Maharashtra", city: "Pune", onlineOk: true,
  message: "IGL looking for a serious BGMI squad, evenings IST, diamond and above.", contact: "raviigl#1234", ...over,
});
const post = (u: U, over: Record<string, unknown> = {}) => api("/v3/lft", { token: u.token, body: body(over) });
async function listing(u?: U, over: Record<string, unknown> = {}) {
  const a = u ?? (await user("Poster"));
  const r = await post(a, over);
  if (r.status !== 201) throw new Error(`create ${r.status} ${r.text}`);
  return { a, id: r.json.id as string };
}
async function teamPage(owner: U) {
  const id = `tp${uniq()}`;
  await db.prepare("INSERT INTO team_profiles (id, owner_user_id, name, slug, published, updated_at) VALUES (?1, ?2, 'Wolves', ?3, 0, ?4)").bind(id, owner.id, `tm-${uniq()}`, new Date().toISOString()).run();
  return id;
}

describe("creating listings", () => {
  it("creates a looking_for_team listing with a 14 day default expiry", async () => {
    const u = await user();
    const r = await post(u);
    expect(r.status, r.text).toBe(201);
    expect(r.json).toMatchObject({ kind: "looking_for_team", game: "bgmi", roles: ["igl"], rankMin: 10, rankMax: 20, status: "open", hidden: false, applications: 0, contact: "raviigl#1234", teamProfileId: null });
    const days = (Date.parse(r.json.expiresAt) - Date.parse(r.json.createdAt)) / 86_400_000;
    expect(Math.round(days)).toBe(14);
  });
  it("expiry: custom up to 30 days, nothing above", async () => {
    const u = await user();
    const r = await post(u, { expiresInDays: 30 });
    expect(Math.round((Date.parse(r.json.expiresAt) - Date.parse(r.json.createdAt)) / 86_400_000)).toBe(30);
    expect((await post(u, { expiresInDays: 31 })).json.code).toBe("invalid_expiresInDays");
    expect((await post(u, { expiresInDays: 0 })).json.code).toBe("invalid_expiresInDays");
  });
  it("needs sign-in and 18+", async () => {
    expect((await api("/v3/lft", { body: body() })).status).toBe(401);
    const minor = await user("NoAdult", false);
    const r = await post(minor);
    expect([r.status, r.json.code]).toEqual([403, "adult_required"]);
    await api("/v3/me/adult-confirmation", { token: minor.token, body: { adult: true } });
    expect((await post(minor)).status).toBe(201);
  });
  it("rejects links and phone numbers in the message and the contact, and bad input", async () => {
    const u = await user();
    const cases: [Record<string, unknown>, string][] = [
      [{ message: "Looking for team, join my server https://discord.gg/abcd" }, "message_has_link"],
      [{ message: "Looking for team, my site is example.com ok" }, "message_has_link"],
      [{ message: "Looking for team, call me on 9876543210 now" }, "message_has_phone"],
      [{ message: "Looking for team, whatsapp +91 98765 43210" }, "message_has_phone"],
      [{ message: "a".repeat(601) }, "message_too_long"], [{ message: "short" }, "message_empty"], [{ message: "<b>looking for team please</b>" }, "message_has_markup"],
      [{ contact: "https://x.co/me" }, "contact_bad_contact"], [{ contact: "9876543210" }, "contact_has_phone"], [{ contact: "x" }, "contact_bad_contact"],
      [{ game: "chess" }, "invalid_game"], [{ kind: "x" }, "invalid_kind"], [{ roles: ["wizard"] }, "invalid_roles"], [{ rankMin: 30, rankMax: 10 }, "invalid_rank_range"],
      [{ rankMin: 101 }, "invalid_rankMin"], [{ onlineOk: "yes" }, "invalid_onlineOk"], [{ city: "<x>" }, "invalid_city"],
    ];
    for (const [over, code] of cases) {
      const r = await post(await user("Fresh"), over); // a fresh user per case: creating is rate limited to 5 per hour
      expect([r.status, r.json.code], JSON.stringify(over).slice(0, 60)).toEqual([400, code]);
    }
    expect((await post(u, { message: "a".repeat(600) })).status).toBe(201);
  });
  it("at most 3 open listings per user; closing frees a slot", async () => {
    const u = await user();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await listing(u)).id);
    const r = await post(u);
    expect([r.status, r.json.code]).toEqual([409, "listing_cap"]);
    expect((await api(`/v3/lft/${ids[0]}/close`, { token: u.token, body: { status: "filled" } })).json.status).toBe("filled");
    expect((await post(u)).status).toBe(201);
    expect((await api("/v3/me/lft", { token: u.token })).json.items).toHaveLength(4);
  });
  it("looking_for_player must name a team page the author owns", async () => {
    const owner = await user("TeamOwner");
    const other = await user("Other");
    const tp = await teamPage(owner);
    const noTeam = await post(owner, { kind: "looking_for_player" });
    expect([noTeam.status, noTeam.json.code]).toEqual([400, "team_required"]);
    const notMine = await post(other, { kind: "looking_for_player", teamProfileId: tp });
    expect([notMine.status, notMine.json.code]).toEqual([403, "not_team_owner"]);
    const ghost = await post(owner, { kind: "looking_for_player", teamProfileId: "no-such-team" });
    expect(ghost.json.code).toBe("not_team_owner");
    const ok = await post(owner, { kind: "looking_for_player", teamProfileId: tp, roles: ["sniper"] });
    expect([ok.status, ok.json.teamProfileId]).toEqual([201, tp]);
    const bad = await post(owner, { kind: "looking_for_team", teamProfileId: tp });
    expect([bad.status, bad.json.code]).toEqual([400, "team_not_allowed"]);
  });
  it("per-user rate limit on creating (5 per hour)", async () => {
    const u = await user();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await api("/v3/lft", { token: u.token, body: {} })).status);
    expect(codes).toEqual([400, 400, 400, 400, 400, 429]);
  });
});

describe("public board", () => {
  it("lists only open, non-hidden, non-expired listings, with no author data", async () => {
    const city = cityTag();
    const open = await listing(undefined, { city });
    const closed = await listing(undefined, { city });
    await api(`/v3/lft/${closed.id}/close`, { token: closed.a.token, body: {} });
    const hidden = await listing(undefined, { city });
    await db.prepare("UPDATE lft_listings SET hidden_at = ?2 WHERE id = ?1").bind(hidden.id, nowSec()).run();
    const expired = await listing(undefined, { city });
    await db.prepare("UPDATE lft_listings SET expires_at = ?2 WHERE id = ?1").bind(expired.id, nowSec() - 5).run();
    const removed = await listing(undefined, { city });
    await db.prepare("UPDATE lft_listings SET status = 'removed' WHERE id = ?1").bind(removed.id).run();

    const r = await api(`/public/lft?city=${city}`);
    expect(r.status).toBe(200);
    expect(r.json.items.map((x: { id: string }) => x.id)).toEqual([open.id]);
    expect(Object.keys(r.json.items[0]).sort()).toEqual(["city", "createdAt", "expiresAt", "game", "id", "kind", "lastBumpedAt", "message", "onlineOk", "rankMax", "rankMin", "roles", "state", "teamName"]);
    for (const secret of [open.a.id, open.a.email, "raviigl", "contact"]) expect(r.text).not.toContain(secret);
    expect(r.json.nextCursor).toBeNull();
    const tag = r.headers.get("etag")!;
    expect((await api(`/public/lft?city=${city}`, { headers: { "if-none-match": tag } })).status).toBe(304);
    expect((await api(`/public/lft/${open.id}`)).json.id).toBe(open.id);
    for (const g of [closed, hidden, expired, removed]) expect((await api(`/public/lft/${g.id}`)).status, g.id).toBe(404);
    expect((await api("/public/lft/not-an-id")).status).toBe(404);
  });
  it("filters: game, kind, role, rank overlap, state, city, online", async () => {
    const city = cityTag();
    const a = await listing(undefined, { city, game: "bgmi", roles: ["igl"], rankMin: 10, rankMax: 20, onlineOk: true });
    const b = await listing(undefined, { city, game: "valorant", roles: ["duelist", "flex"], rankMin: 30, rankMax: 40, onlineOk: false, state: "Goa" });
    const c = await listing(undefined, { city, game: "bgmi", roles: ["sniper"], rankMin: undefined, rankMax: undefined });
    const q = async (qs: string) => (await api(`/public/lft?city=${city}&${qs}`)).json.items.map((x: { id: string }) => x.id).sort();
    const ids = (...x: { id: string }[]) => x.map((y) => y.id).sort();
    expect(await q("game=bgmi")).toEqual(ids(a, c));
    expect(await q("game=valorant")).toEqual(ids(b));
    expect(await q("role=igl")).toEqual(ids(a));
    expect(await q("role=flex")).toEqual(ids(b));
    expect(await q("rank_min=15&rank_max=18")).toEqual(ids(a, c)); // overlaps a; c has no range = any
    expect(await q("rank_min=35")).toEqual(ids(b, c));
    expect(await q("rank_max=5")).toEqual(ids(c));
    expect(await q("state=goa")).toEqual(ids(b));
    expect(await q("online=1")).toEqual(ids(a, c));
    expect(await q("kind=looking_for_player")).toEqual([]);
    for (const bad of ["game=chess", "kind=x", "role=wizard", "rank_min=-1", "rank_min=x", "rank_min=20&rank_max=10", "limit=0", "limit=x", "cursor=zzz", "state=%3Cb%3E"]) expect((await api(`/public/lft?${bad}`)).status, bad).toBe(400);
  });
  it("paginates by cursor on last_bumped_at, newest first, with a stable tiebreak", async () => {
    const city = cityTag();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await listing(undefined, { city })).id);
    // bump times: ids[0] oldest ... ids[3] newest; ids[4] ties with ids[3]
    const base = nowSec() - 1000;
    for (let i = 0; i < 4; i++) await db.prepare("UPDATE lft_listings SET last_bumped_at = ?2 WHERE id = ?1").bind(ids[i], base + i * 10).run();
    await db.prepare("UPDATE lft_listings SET last_bumped_at = ?2 WHERE id = ?1").bind(ids[4], base + 30).run();
    const seen: string[] = [];
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      const r = await api(`/public/lft?city=${city}&limit=2${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...r.json.items.map((x: { id: string }) => x.id));
      if (!r.json.nextCursor) break;
      cursor = r.json.nextCursor;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect(seen.slice(2)).toEqual([ids[2], ids[1], ids[0]]);
    expect(new Set(seen.slice(0, 2))).toEqual(new Set([ids[3], ids[4]]));
    expect((await api(`/public/lft?city=${city}&limit=500`)).json.items).toHaveLength(5);
  });
});

describe("bump and close", () => {
  it("bump at most once per 24 hours, author only, open only", async () => {
    const { a, id } = await listing();
    const first = await api(`/v3/lft/${id}/bump`, { token: a.token, body: {} });
    expect(first.status, first.text).toBe(429); // created just now: last bump was a moment ago
    expect(first.json.code).toBe("bump_too_soon");
    expect(first.json.retryAfter).toBeGreaterThan(80_000);
    await db.prepare("UPDATE lft_listings SET last_bumped_at = ?2 WHERE id = ?1").bind(id, nowSec() - 86_401).run();
    const ok = await api(`/v3/lft/${id}/bump`, { token: a.token, body: {} });
    expect(ok.status).toBe(200);
    expect((await api(`/v3/lft/${id}/bump`, { token: a.token, body: {} })).status).toBe(429);
    const stranger = await user("Stranger");
    expect((await api(`/v3/lft/${id}/bump`, { token: stranger.token, body: {} })).status).toBe(404);
    await api(`/v3/lft/${id}/close`, { token: a.token, body: {} });
    await db.prepare("UPDATE lft_listings SET last_bumped_at = ?2 WHERE id = ?1").bind(id, nowSec() - 90_000).run();
    expect((await api(`/v3/lft/${id}/bump`, { token: a.token, body: {} })).status).toBe(429);
  });
  it("close: author only, open only, status closed or filled", async () => {
    const { a, id } = await listing();
    const stranger = await user();
    expect((await api(`/v3/lft/${id}/close`, { token: stranger.token, body: {} })).status).toBe(404);
    expect((await api(`/v3/lft/${id}/close`, { token: a.token, body: { status: "removed" } })).status).toBe(400);
    expect((await api(`/v3/lft/${id}/close`, { token: a.token, body: {} })).json.status).toBe("closed");
    expect((await api(`/v3/lft/${id}/close`, { token: a.token, body: {} })).json.code).toBe("not_open");
  });
});

describe("applications and contact reveal", () => {
  it("one per person; own listing refused; needs 18+; contact required; text rules", async () => {
    const { a, id } = await listing();
    const me = await user("Applicant");
    const apply = (u: U, b: Record<string, unknown>) => api(`/v3/lft/${id}/applications`, { token: u.token, body: b });
    expect([(await apply(a, { contact: "x#1234" })).status, (await apply(a, { contact: "x#1234" })).json.code]).toEqual([403, "own_listing"]);
    const minor = await user("Minor", false);
    expect((await apply(minor, { contact: "minor#1" })).json.code).toBe("adult_required");
    expect((await apply(me, { message: "hello" })).json.code).toBe("contact_bad_contact");
    expect((await apply(me, { contact: "me#1234", message: "see example.com" })).json.code).toBe("message_has_link");
    expect((await apply(me, { contact: "me#1234", message: "call 9876543210" })).json.code).toBe("message_has_phone");
    expect((await apply(me, { contact: "me#1234", message: "a".repeat(401) })).json.code).toBe("message_too_long");
    const ok = await apply(me, { contact: "me#1234", message: "I am an IGL too" });
    expect([ok.status, ok.json.status]).toEqual([201, "sent"]);
    expect((await apply(me, { contact: "me#1234" })).json.code).toBe("already_applied");
    expect((await api("/v3/lft/00000000000000000000000000000000/applications", { token: me.token, body: { contact: "me#1234" } })).status).toBe(404);
  });
  it("contact is revealed to the other side only after accept", async () => {
    const { a, id } = await listing();
    const me = await user("Applicant");
    const ap = await api(`/v3/lft/${id}/applications`, { token: me.token, body: { contact: "applicant#99", message: "Rank 17 IGL" } });
    const aid = ap.json.id;
    const authorView = async () => (await api(`/v3/lft/${id}/applications`, { token: a.token })).json.items[0];
    const myView = async () => (await api("/v3/me/lft/applications", { token: me.token })).json.items.find((x: { id: string }) => x.id === aid);
    expect(await authorView()).toMatchObject({ status: "sent", contact: null, message: "Rank 17 IGL", profileSlug: null });
    expect(await myView()).toMatchObject({ status: "sent", contact: null, listingStatus: "open" });
    expect(JSON.stringify(await authorView())).not.toContain("applicant#99");
    expect(JSON.stringify(await myView())).not.toContain("raviigl");
    const stranger = await user("Stranger");
    expect((await api(`/v3/lft/${id}/applications`, { token: stranger.token })).status).toBe(404);
    expect((await api(`/v3/lft-applications/${aid}/respond`, { token: stranger.token, body: { decision: "accept" } })).status).toBe(404);
    expect((await api(`/v3/lft-applications/${aid}/respond`, { token: me.token, body: { decision: "accept" } })).status).toBe(404); // the applicant cannot accept their own
    expect((await api(`/v3/lft-applications/${aid}/respond`, { token: a.token, body: { decision: "maybe" } })).status).toBe(400);
    const acc = await api(`/v3/lft-applications/${aid}/respond`, { token: a.token, body: { decision: "accept" } });
    expect([acc.status, acc.json.status, acc.json.contact]).toEqual([200, "accepted", "applicant#99"]);
    expect(await myView()).toMatchObject({ status: "accepted", contact: "raviigl#1234" });
    expect((await api(`/v3/lft-applications/${aid}/respond`, { token: a.token, body: { decision: "decline" } })).json.code).toBe("already_answered");
    expect((await api(`/v3/lft-applications/${aid}/withdraw`, { token: me.token, body: {} })).json.code).toBe("already_answered");
  });
  it("decline keeps contacts hidden; withdraw only while sent, only by the applicant", async () => {
    const { a, id } = await listing();
    const x = await user("X");
    const y = await user("Y");
    const ax = (await api(`/v3/lft/${id}/applications`, { token: x.token, body: { contact: "x#1111" } })).json.id;
    const ay = (await api(`/v3/lft/${id}/applications`, { token: y.token, body: { contact: "y#2222" } })).json.id;
    const dec = await api(`/v3/lft-applications/${ax}/respond`, { token: a.token, body: { decision: "decline" } });
    expect([dec.json.status, dec.json.contact]).toEqual(["declined", null]);
    expect((await api(`/v3/me/lft/applications`, { token: x.token })).json.items[0].contact).toBeNull();
    expect((await api(`/v3/lft-applications/${ay}/withdraw`, { token: x.token, body: {} })).status).toBe(404);
    const w = await api(`/v3/lft-applications/${ay}/withdraw`, { token: y.token, body: {} });
    expect([w.status, w.json.status]).toEqual([200, "withdrawn"]);
    expect((await api(`/v3/lft-applications/${ay}/respond`, { token: a.token, body: { decision: "accept" } })).json.code).toBe("already_answered");
  });
  it("applying to a closed, hidden or expired listing is a 404", async () => {
    const me = await user("Applicant");
    const closed = await listing();
    await api(`/v3/lft/${closed.id}/close`, { token: closed.a.token, body: {} });
    const hidden = await listing();
    await db.prepare("UPDATE lft_listings SET hidden_at = 1 WHERE id = ?1").bind(hidden.id).run();
    for (const l of [closed, hidden]) expect((await api(`/v3/lft/${l.id}/applications`, { token: me.token, body: { contact: "me#1" } })).status).toBe(404);
  });
  it("a public resume of the applicant is linked, a private one is not", async () => {
    const { a, id } = await listing();
    const me = await user("Applicant");
    await api("/v3/me/resume-consent", { token: me.token, body: { consent: true } });
    const slug = `app-${uniq()}`.toLowerCase();
    await api("/v3/me/profile", { method: "PUT", token: me.token, body: { slug, handle: "Appl", visibility: "public" } });
    await api(`/v3/lft/${id}/applications`, { token: me.token, body: { contact: "me#1234" } });
    expect((await api(`/v3/lft/${id}/applications`, { token: a.token })).json.items[0].profileSlug).toBe(slug);
    await api("/v3/me/resume-consent", { method: "DELETE", token: me.token });
    expect((await api(`/v3/lft/${id}/applications`, { token: a.token })).json.items[0].profileSlug).toBeNull();
  });
});

describe("reports and auto-hide", () => {
  const report = (u: U, id: string, reason = "spam") => api(`/v3/lft/${id}/report`, { token: u.token, body: { reason, note: "looks wrong" } });
  it("records reports but does not hide while takedown.enforce is off", async () => {
    const { id } = await listing();
    for (let i = 0; i < 4; i++) expect((await report(await user(`R${i}`), id)).status).toBe(202);
    expect((await api(`/public/lft/${id}`)).status).toBe(200);
    expect((await db.prepare("SELECT report_count, hidden_at FROM lft_listings WHERE id = ?1").bind(id).first())).toEqual({ report_count: 4, hidden_at: null });
  });
  it("3 distinct reporters hide it (takedown.enforce on); the same reporter counts once; the answer never says", async () => {
    await flagsOn("v3.tournaments", "v3.resume", "v3.lft", "v3.disputes", "takedown.enforce");
    const { a, id } = await listing();
    const r1 = await user("R1");
    const first = await report(r1, id);
    const again = await report(r1, id, "scam");
    expect([first.json, again.json]).toEqual([{ ok: true }, { ok: true }]);
    expect((await report(await user("R2"), id)).json).toEqual({ ok: true });
    expect((await api(`/public/lft/${id}`)).status).toBe(200); // 2 distinct reporters so far
    const third = await report(await user("R3"), id);
    expect(third.json).toEqual({ ok: true });
    expect((await api(`/public/lft/${id}`)).status).toBe(404);
    expect((await api("/public/lft?limit=50")).json.items.map((x: { id: string }) => x.id)).not.toContain(id);
    expect((await api("/v3/me/lft", { token: a.token })).json.items.find((x: { id: string }) => x.id === id)).toMatchObject({ hidden: true, reportCount: 3 });
    await allV3On();
  });
  it("own listing, bad reason, unknown or closed listing, signed out", async () => {
    const { a, id } = await listing();
    expect((await report(a, id)).json.code).toBe("own_listing");
    const u = await user();
    expect((await report(u, id, "nonsense")).json.code).toBe("invalid_reason");
    expect((await report(u, "00000000000000000000000000000000")).status).toBe(404);
    await api(`/v3/lft/${id}/close`, { token: a.token, body: {} });
    expect((await report(u, id)).status).toBe(404);
    expect((await api(`/v3/lft/${id}/report`, { body: { reason: "spam" } })).status).toBe(401);
  });
  it("moderators list hidden listings and restore or remove them (staff token only)", async () => {
    await flagsOn("v3.tournaments", "v3.resume", "v3.lft", "v3.disputes", "takedown.enforce");
    const staff = await makeStaff();
    const token = (await staff.login()).token;
    const l1 = await listing();
    const l2 = await listing();
    for (const id of [l1.id, l2.id]) for (let i = 0; i < 3; i++) await report(await user(`Rp${i}`), id);
    const anon = await api("/admin/v1/v3/lft/hidden");
    const asUser = await api("/admin/v1/v3/lft/hidden", { token: l1.a.token });
    expect([anon.status, asUser.status]).toEqual([404, 404]);
    const list = await api("/admin/v1/v3/lft/hidden", { token });
    expect(list.status, list.text).toBe(200);
    const mine = list.json.items.filter((x: { id: string }) => [l1.id, l2.id].includes(x.id));
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ reportCount: 3 });
    const restore = await api(`/admin/v1/v3/lft/${l1.id}/decide`, { token, body: { decision: "restore" } });
    expect([restore.status, restore.json]).toEqual([200, { ok: true, decision: "restore" }]);
    expect((await api(`/public/lft/${l1.id}`)).status).toBe(200);
    expect((await api(`/admin/v1/v3/lft/${l1.id}/decide`, { token, body: { decision: "restore" } })).json.code).toBe("not_hidden");
    // after a restore the old reporters are cleared: one new report does not re-hide it
    await report(await user("Late"), l1.id);
    expect((await api(`/public/lft/${l1.id}`)).status).toBe(200);
    const rem = await api(`/admin/v1/v3/lft/${l2.id}/decide`, { token, body: { decision: "remove" } });
    expect(rem.status).toBe(200);
    expect((await db.prepare("SELECT status FROM lft_listings WHERE id = ?1").bind(l2.id).first())).toEqual({ status: "removed" });
    expect((await api(`/admin/v1/v3/lft/${l2.id}/decide`, { token, body: { decision: "nope" } })).status).toBe(400);
    await allV3On();
  });
  it("report rate limit: 20 per hour per user", async () => {
    const { id } = await listing();
    const u = await user("Spammer");
    const codes: number[] = [];
    for (let i = 0; i < 21; i++) codes.push((await report(u, id)).status);
    expect(codes.slice(0, 20).every((c) => c === 202)).toBe(true);
    expect(codes[20]).toBe(429);
  });
});

describe("kill switches", () => {
  it("kill.public_writes stops writes (503) but not reads; kill.directory stops the public list", async () => {
    const { a, id } = await listing();
    await flagsOn("v3.lft", "kill.public_writes");
    expect([(await post(a)).status, (await api(`/v3/lft/${id}/bump`, { token: a.token, body: {} })).status]).toEqual([503, 503]);
    expect((await api(`/public/lft/${id}`)).status).toBe(200);
    expect((await api("/v3/me/lft", { token: a.token })).status).toBe(200);
    await flagsOn("v3.lft", "kill.directory");
    expect((await api("/public/lft")).status).toBe(503);
    await allV3On();
  });
});

describe("scheduled expiry and deletion", () => {
  it("expires open listings, then deletes them (with applications and reports) 30 days after expiry", async () => {
    const { a, id } = await listing();
    const me = await user("Applicant");
    await api(`/v3/lft/${id}/applications`, { token: me.token, body: { contact: "me#1234" } });
    await db.prepare("INSERT INTO lft_reports (id, listing_id, reporter, reason_code, created_at) VALUES ('rep1', ?1, 'hash', 'spam', ?2)").bind(id, nowSec()).run();
    const fresh = await listing();
    const T = nowSec();
    await db.prepare("UPDATE lft_listings SET expires_at = ?2 WHERE id = ?1").bind(id, T - 10).run();

    const tick = await runRetention(env.DB, { daily: false, now: T });
    expect(tick).toMatchObject({ skipped: false, deleted: 0 });
    expect(tick.expired).toBeGreaterThanOrEqual(1);
    expect(await db.prepare("SELECT status FROM lft_listings WHERE id = ?1").bind(id).first()).toEqual({ status: "expired" });
    expect(await db.prepare("SELECT status FROM lft_listings WHERE id = ?1").bind(fresh.id).first()).toEqual({ status: "open" });
    expect((await api(`/public/lft/${id}`)).status).toBe(404);

    const day29 = await runRetention(env.DB, { daily: true, now: T - 10 + 29 * 86_400 });
    expect(day29.deleted).toBe(0);
    expect(await db.prepare("SELECT 1 AS x FROM lft_listings WHERE id = ?1").bind(id).first()).not.toBeNull();
    const day31 = await runRetention(env.DB, { daily: true, now: T - 10 + 31 * 86_400 });
    expect(day31.deleted).toBeGreaterThanOrEqual(1);
    expect(await db.prepare("SELECT 1 AS x FROM lft_listings WHERE id = ?1").bind(id).first()).toBeNull();
    expect((await db.prepare("SELECT COUNT(*) AS n FROM lft_applications WHERE listing_id = ?1").bind(id).first<{ n: number }>())!.n).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM lft_reports WHERE listing_id = ?1").bind(id).first<{ n: number }>())!.n).toBe(0);
    expect(a.id).toBeTruthy();
  });
  it("the real cron handler runs the expiry (and survives)", async () => {
    const { id } = await listing();
    await db.prepare("UPDATE lft_listings SET expires_at = ?2 WHERE id = ?1").bind(id, nowSec() - 1).run();
    const { scheduled } = await import("../../src/features/reminders-cron");
    const pending: Promise<unknown>[] = [];
    await scheduled({ scheduledTime: Date.now() } as ScheduledController, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext);
    await Promise.all(pending);
    expect(await db.prepare("SELECT status FROM lft_listings WHERE id = ?1").bind(id).first()).toEqual({ status: "expired" });
  });
});
