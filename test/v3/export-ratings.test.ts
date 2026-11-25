import { describe, expect, it, vi } from "vitest";
import { newEvent, newUser, uniq } from "../helpers";
import { buildV3Export } from "../../src/v3/services/export-service";
import { api, db, nowSec } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

const hex = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
const exportOf = (token: string) => api("/me/export", { method: "POST", token });

async function rating(o: { eventId: string; key: string; userId: string; name: string; review: string; reply?: string; hidden?: boolean; replyHidden?: boolean }) {
  const id = hex();
  await db.prepare("INSERT INTO organiser_ratings (id, event_id, organiser_key, user_id, display_name, proof_kind, proof_ref, stars, on_time, fair_play, communication, review, reply, reply_at, hidden_at, reply_hidden_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'checked_in', ?6, 4, 4, 5, 3, ?7, ?8, ?9, ?10, ?11, ?12, ?12)")
    .bind(id, o.eventId, o.key, o.userId, o.name, `person:PROOF${uniq()}`, o.review, o.reply ?? null, o.reply ? nowSec() : null, o.hidden ? nowSec() : null, o.replyHidden ? nowSec() : null, nowSec()).run();
  return id;
}

describe("POST /me/export: organiser ratings", () => {
  it("an organisation admin gets the organisation's own visible reviews and replies (rater's chosen name only); a rater gets the reviews they wrote", async () => {
    const organiser = await newUser("Organiser");
    const helper = await newUser("Helper");
    const orgId = `org${uniq()}`;
    await db.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES (?1, 'Export College', 'team', 'active', ?2)").bind(orgId, new Date().toISOString()).run();
    await db.prepare("INSERT INTO org_members (org_id, user_id, role, added_at) VALUES (?1, ?2, 'admin', ?3), (?1, ?4, 'member', ?3)").bind(orgId, organiser.id, new Date().toISOString(), helper.id).run();
    const ev = await newEvent(organiser.token, "Export Cup");
    await db.prepare("UPDATE events SET org_id = ?1 WHERE id = ?2").bind(orgId, ev.id).run();
    const rater = await newUser("Rater");
    const rater2 = await newUser("Rater Two");
    const key = `org:${orgId}`;
    const visible = await rating({ eventId: ev.id, key, userId: rater.id, name: "Riya K", review: "VISIBLEREVIEW great admin", reply: "ORGREPLY thank you" });
    const hidden = await rating({ eventId: ev.id, key, userId: rater2.id, name: "Abuser X", review: "HIDDENREVIEW abusive text", hidden: true });
    // another organisation's review, by the same rater: never in the organiser's export
    const other = await newUser("Other Org");
    const otherEv = await newEvent(other.token, "Other Cup");
    const elsewhere = await rating({ eventId: otherEv.id, key: `event:${otherEv.id}`, userId: rater.id, name: "Riya K", review: "ELSEWHERE review of someone else", reply: "HIDDENREPLY", replyHidden: true });

    const o = await exportOf(organiser.token);
    expect(o.status, o.text).toBe(200);
    const recv = o.json.v3.ratings;
    expect(recv.receivedCount).toBe(1);
    expect(recv.received).toEqual([expect.objectContaining({ id: visible, orgId, organisation: "Export College", eventId: ev.id, reviewerDisplayName: "Riya K", stars: 4, review: "VISIBLEREVIEW great admin", reply: "ORGREPLY thank you", replyHiddenByModerators: false })]);
    expect(Object.keys(recv.received[0]).sort()).toEqual(["communication", "createdAt", "event", "eventId", "fair", "id", "onTime", "orgId", "organisation", "reply", "replyAt", "replyHiddenByModerators", "review", "reviewerDisplayName", "stars"]);
    for (const needle of ["HIDDENREVIEW", "ELSEWHERE", rater.id, rater.email, rater2.id, rater2.email, "PROOF", hidden]) expect(o.text, needle).not.toContain(needle);
    expect(recv.writtenCount).toBe(0);
    expect(o.json.notIncluded.join(" ")).toMatch(/moderators hid/);

    // a plain member of the organisation does not get the organisation's reviews
    const h = await exportOf(helper.token);
    expect(h.json.v3.ratings.receivedCount).toBe(0);

    // the rater gets both reviews they wrote, the organiser's reply when it is not hidden, never the proof reference or who replied
    const r = await exportOf(rater.token);
    const mine = r.json.v3.ratings.written;
    expect(mine.map((x: { id: string }) => x.id).sort()).toEqual([visible, elsewhere].sort());
    expect(mine.find((x: { id: string }) => x.id === visible)).toMatchObject({ review: "VISIBLEREVIEW great admin", organiserReply: "ORGREPLY thank you", hiddenByModerators: false });
    expect(mine.find((x: { id: string }) => x.id === elsewhere)).toMatchObject({ organiserReply: null, replyHiddenByModerators: true });
    expect(r.text).not.toContain("HIDDENREPLY");
    expect(r.text).not.toContain("PROOF");
    expect(r.text).not.toContain("HIDDENREVIEW");
    expect(r.text).not.toContain(organiser.email);
    // rater2 still sees their own (hidden) review: it is their own data
    const r2 = await exportOf(rater2.token);
    expect(r2.json.v3.ratings.written).toEqual([expect.objectContaining({ id: hidden, review: "HIDDENREVIEW abusive text", hiddenByModerators: true })]);
  });

  it("received ratings shrink to a count at truncation level 2; written ones stay", () => {
    const row = { id: "r", org_id: "o", org_name: "O", event_id: "e", event_name: "E", display_name: "N", stars: 4, on_time: 4, fair_play: 4, communication: 4, review: "x", reply: null, reply_at: null, reply_hidden: 0, created_at: 1 };
    const base = { account: null, profile: null, games: [], listings: [], sent: [], disputes: [], evidence: [], captains: [], feedback: [], ratingsReceived: [row] };
    expect(buildV3Export(base, 1).ratings.received).toHaveLength(1);
    expect(buildV3Export(base, 2).ratings).toMatchObject({ receivedCount: 1, received: [] });
  });
});
