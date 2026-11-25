import { describe, expect, it, vi } from "vitest";
import { newEvent, newUser, uniq } from "../helpers";
import { REASON_CODES } from "../../src/admin/flags";
import { MODERATION_REASONS } from "../../src/v3/lib/community";
import { api, auditRows, db, makeStaff, nowSec } from "./helpers";

vi.setConfig({ testTimeout: 180_000 });

const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
const staffToken = async () => { const s = await makeStaff(); return { s, token: (await s.login()).token }; };
const hide = (token: string, kind: string, id: string, body: Record<string, unknown>) => api(`/admin/v1/content/${kind}/${id}/hide`, { token, body });
const restore = (token: string, kind: string, id: string, body: Record<string, unknown>) => api(`/admin/v1/content/${kind}/${id}/restore`, { token, body });

async function seed() {
  const owner = await newUser("Content Owner");
  const ev = await newEvent(owner.token, `Results Cup ${uniq()}`);
  const tp = `tp${uniq()}`;
  await db.prepare("INSERT INTO team_profiles (id, owner_user_id, name, slug, updated_at) VALUES (?1, ?2, 'Hub Squad', ?3, ?4)").bind(tp, owner.id, `hub-${uniq()}`.toLowerCase(), new Date().toISOString()).run();
  const slot = hex();
  await db.prepare("INSERT INTO scrim_slots (id, poster_user_id, team_profile_id, game, starts_at, region, skill_note, slots_total, contact, created_at) VALUES (?1, ?2, ?3, 'bgmi', ?4, 'india', 'tier 2 only', 4, 'SECRETCONTACT#1', ?5)").bind(slot, owner.id, tp, nowSec() + 86_400, nowSec() + 5).run();
  const lft = hex();
  await db.prepare("INSERT INTO lft_listings (id, kind, author_user_id, game, message, contact, expires_at, created_at) VALUES (?1, 'looking_for_team', ?2, 'bgmi', 'IGL looking for a squad', 'LFTCONTACT#9', ?3, ?4)").bind(lft, owner.id, nowSec() + 86_400, nowSec() + 5).run();
  await db.prepare("INSERT INTO directory_entries (event_id, listed, title, game, city, starts_on, blurb, reg_link, updated_at) VALUES (?1, 1, 'Listed Cup', 'BGMI', 'Pune', '2026-12-20', 'Open to all', 'https://example.com/REGLINK', ?2)").bind(ev.id, new Date(Date.now() + 5000).toISOString()).run();
  const orgId = `org${uniq()}`;
  await db.prepare("INSERT INTO organisations (id, name, kind, status, created_at, slug, verified_at) VALUES (?1, 'Hub College', 'team', 'active', ?2, ?3, ?4)").bind(orgId, new Date().toISOString(), `hub-college-${uniq()}`.toLowerCase(), nowSec()).run();
  const cal = hex();
  await db.prepare("INSERT INTO calendar_entries (id, org_id, title, game, city, starts_on, ends_on, registration_url, created_at, updated_at) VALUES (?1, ?2, 'Fest Cup', 'bgmi', 'Pune', '2026-12-20', '2026-12-21', 'https://example.com/fest', ?3, ?3)").bind(cal, orgId, nowSec() + 5).run();
  const rater = await newUser("Rater");
  const rating = hex();
  await db.prepare("INSERT INTO organiser_ratings (id, event_id, organiser_key, user_id, display_name, proof_kind, proof_ref, stars, on_time, fair_play, communication, review, reply, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'Riya K', 'checked_in', ?5, 2, 2, 3, 2, 'Started two hours late.', 'Sorry, the venue opened late.', ?6, ?6)").bind(rating, ev.id, `event:${ev.id}`, rater.id, `person:${uniq()}`, nowSec() + 5).run();
  await db.prepare("INSERT INTO br_results (event_id, match_no, team, placement, kills, updated_at) VALUES (?1, 1, 'Hub Squad', 1, 9, ?2)").bind(ev.id, new Date(Date.now() + 5000).toISOString()).run();
  return { owner, ev, slot, lft, cal, rating, rater };
}

describe("content hub: list", () => {
  it("every kind lists newest first with its reasons and never a contact field", async () => {
    const { token } = await staffToken();
    const w = await seed();
    const want: Record<string, string> = { scrims: w.slot, lft: w.lft, directory: w.ev.id, calendar: w.cal, ratings: w.rating, results: w.ev.id };
    for (const [kind, id] of Object.entries(want)) {
      const r = await api(`/admin/v1/content?kind=${kind}&id=${id}`, { token });
      expect(r.status, `${kind} ${r.text}`).toBe(200);
      expect(r.json.available).toBe(true);
      expect(r.json.reasons).toEqual(kind === "calendar" || kind === "ratings" ? [...MODERATION_REASONS] : [...REASON_CODES]);
      expect(r.json.items.map((x: { id: string }) => x.id), kind).toEqual([id]);
      expect(r.json.items[0]).toMatchObject({ kind, hidden: false });
      expect(r.text).not.toMatch(/SECRETCONTACT|LFTCONTACT|REGLINK|example\.com\/fest/);
    }
    const all = await api("/admin/v1/content?kind=scrims", { token });
    expect(all.json.items[0].id).toBe(w.slot);
    expect((await api("/admin/v1/content?kind=nope", { token })).status).toBe(400);
    expect((await api("/admin/v1/content?kind=lft&state=weird", { token })).status).toBe(400);
  });
});

describe("content hub: hide and restore reuse each kind's mechanism, with a reason and an audit row", () => {
  it("scrim slots and LFT listings: hidden_at, content.hidden / content.restored", async () => {
    const { s, token } = await staffToken();
    const w = await seed();
    for (const [kind, id, table, meta] of [["scrims", w.slot, "scrim_slots", "scrim"], ["lft", w.lft, "lft_listings", "lft"]] as const) {
      expect((await hide(token, kind, id, {})).status, kind).toBe(400);
      const h = await hide(token, kind, id, { reasonCode: "spam" });
      expect(h.status, h.text).toBe(200);
      expect(h.json.item.hidden).toBe(true);
      expect((await hide(token, kind, id, { reasonCode: "spam" })).json.code).toBe("already_hidden");
      const ha = await auditRows("content.hidden", id);
      expect(ha).toHaveLength(1);
      expect(ha[0]).toMatchObject({ actor_type: "staff", actor_id: s.id, reason_code: "spam" });
      expect(JSON.parse(String(ha[0]!.meta))).toEqual({ kind: meta });
      const hidden = await api(`/admin/v1/content?kind=${kind}&state=hidden`, { token });
      expect(hidden.json.items.map((x: { id: string }) => x.id)).toContain(id);
      const r = await restore(token, kind, id, { reasonCode: "other" });
      expect(r.json.item.hidden).toBe(false);
      expect(await auditRows("content.restored", id)).toHaveLength(1);
      expect((await db.prepare(`SELECT hidden_at FROM ${table} WHERE id = ?1`).bind(id).first<{ hidden_at: number | null }>())!.hidden_at).toBeNull();
      expect((await restore(token, kind, id, { reasonCode: "other" })).json.code).toBe("not_hidden");
    }
    expect((await hide(token, "scrims", hex(), { reasonCode: "spam" })).status).toBe(404);
  });

  it("calendar entries and ratings go through their services (moderation log + calendar.* / trust.* audit)", async () => {
    const { s, token } = await staffToken();
    const w = await seed();
    expect((await hide(token, "calendar", w.cal, { reasonCode: "spam" })).status).toBe(200);
    expect((await db.prepare("SELECT hidden_reason FROM calendar_entries WHERE id = ?1").bind(w.cal).first<{ hidden_reason: string }>())!.hidden_reason).toBe("spam");
    expect((await auditRows("calendar.hidden", w.cal))[0]).toMatchObject({ actor_id: s.id, reason_code: "spam" });
    expect((await restore(token, "calendar", w.cal, { reasonCode: "appeal_upheld" })).json.item.hidden).toBe(false);
    expect(await auditRows("calendar.restored", w.cal)).toHaveLength(1);
    expect((await hide(token, "calendar", w.cal, { reasonCode: "minor_exposed" })).status).toBe(400); // not on the calendar's reason list

    const rep = await hide(token, "ratings", w.rating, { reasonCode: "abuse", target: "reply" });
    expect(rep.status, rep.text).toBe(200);
    expect(rep.json.item).toMatchObject({ hidden: false, replyHidden: true });
    expect(JSON.parse(String((await auditRows("trust.hidden", w.rating))[0]!.meta))).toEqual({ target: "reply" });
    const rev = await hide(token, "ratings", w.rating, { reasonCode: "personal_info" });
    expect(rev.json.item.hidden).toBe(true);
    expect((await restore(token, "ratings", w.rating, { reasonCode: "report_unfounded" })).json.item.hidden).toBe(false);
    expect(await auditRows("trust.restored", w.rating)).toHaveLength(1);
  });

  it("directory listings and results use takedowns (takedown.hidden / takedown.restored)", async () => {
    const { s, token } = await staffToken();
    const w = await seed();
    const d = await hide(token, "directory", w.ev.id, { reasonCode: "scam" });
    expect(d.status, d.text).toBe(200);
    expect(d.json.item).toMatchObject({ hidden: true, hiddenReason: "scam" });
    const ta = (await auditRows("takedown.hidden", w.ev.id)).filter((x) => x.target_type === "directory_entry");
    expect(ta[0]).toMatchObject({ actor_id: s.id, reason_code: "scam" });
    expect((await restore(token, "directory", w.ev.id, { reasonCode: "other" })).json.item.hidden).toBe(false);

    const r = await hide(token, "results", w.ev.id, { reasonCode: "minor_exposed" });
    expect(r.status, r.text).toBe(200);
    expect(r.json.item.hidden).toBe(true);
    expect((await db.prepare("SELECT state FROM takedowns WHERE target_type = 'event' AND target_id = ?1").bind(w.ev.id).first<{ state: string }>())!.state).toBe("hidden");
    expect((await restore(token, "results", w.ev.id, { reasonCode: "other" })).json.item.hidden).toBe(false);
    expect((await auditRows("takedown.restored", w.ev.id)).filter((x) => x.target_type === "event")).toHaveLength(1);
    expect((await hide(token, "directory", "noevent1", { reasonCode: "scam" })).status).toBe(404);
  });

  it("an unknown kind is 404", async () => {
    const { token } = await staffToken();
    expect((await hide(token, "photos", "abc", { reasonCode: "spam" })).status).toBe(404);
  });
});
