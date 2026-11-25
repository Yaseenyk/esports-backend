import { describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { purgeExpiredPlans } from "../../src/v3/services/planner-service";
import { checkPicks, checkPlainLabel, checkSlots, slotCounts, validTimeZone } from "../../src/v3/lib/planner";
import { api, db, flagsOn, nowSec } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
const on = () => flagsOn(...(["v3.planner"] as never[]));
const hour = 3600;
const slotsFrom = (n: number, start = Math.ceil(nowSec() / hour) * hour + hour) => Array.from({ length: n }, (_, i) => start + i * hour);
const key = () => `k${crypto.randomUUID().replace(/-/g, "")}`; // 33 base64url characters
async function plan(over: Record<string, unknown> = {}) {
  const r = await api("/public/planner", { body: { game: "bgmi", title: "Saturday scrims", slots: slotsFrom(6), ...over } });
  if (r.status !== 201) throw new Error(`create ${r.status} ${r.text}`);
  return r.json as { token: string; captainKey: string; expiresAt: string };
}
const open = (token: unknown) => api("/public/planner/open", { body: { token } });

describe("planner: pure rules", () => {
  it("validates time zones, slots, picks and labels", () => {
    expect(validTimeZone("Asia/Kolkata")).toBe(true);
    expect(validTimeZone("Mars/Base")).toBe(false);
    expect(validTimeZone("x".repeat(41))).toBe(false);
    const now = 1_800_000_000;
    expect(checkSlots([now + 3600], 60, now).ok).toBe(true);
    expect(checkSlots([], 60, now)).toEqual({ ok: false, code: "slots_missing" });
    expect(checkSlots([now + 60], 60, now)).toEqual({ ok: false, code: "slots_not_aligned" });
    expect(checkSlots([now + 7200, now + 3600], 60, now)).toEqual({ ok: false, code: "slots_order" });
    expect(checkSlots([now + 3600, now + 3600 + 16 * 86_400], 60, now)).toEqual({ ok: false, code: "slots_span" });
    expect(checkSlots([now + 61 * 86_400], 60, now)).toEqual({ ok: false, code: "slots_range" });
    expect(checkSlots(Array.from({ length: 337 }, (_, i) => now + i * 1800), 30, now)).toEqual({ ok: false, code: "slots_too_many" });
    expect(checkPicks([2, 0, 2], 3)).toEqual([0, 2]);
    expect(checkPicks([3], 3)).toBeNull();
    expect(checkPicks(["1"], 3)).toBeNull();
    expect(checkPlainLabel("Ravi", 24, true)).toEqual({ ok: true, text: "Ravi" });
    for (const bad of ["<b>x</b>", "see discord.gg/abc", "9876543210", "insta: rohan_igl"]) expect(checkPlainLabel(bad, 60, true).ok, bad).toBe(false);
    expect(slotCounts(3, [[0, 1], [1], [5]])).toEqual([1, 2, 0]);
  });
});

describe("planner: flag off", () => {
  it("every planner route answers the unknown-route 404 and touches no planner table", async () => {
    await flagsOn();
    const unknown = await api("/v3/definitely-not-a-route");
    const routes = [...new Map(app.routes.filter((r) => r.method !== "ALL" && r.path.startsWith("/public/planner")).map((r) => [`${r.method} ${r.path}`, r])).values()];
    expect(routes.length).toBe(5);
    for (const r of routes) {
      const res = await api(r.path, { method: r.method, body: {} });
      expect(res.status, r.path).toBe(404);
      expect(res.json).toEqual(unknown.json);
    }
  });
});

describe("planner: create, open, vote", () => {
  it("creates a plan with an unguessable token; only hashes are stored", async () => {
    await on();
    const p = await plan();
    expect(p.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(p.captainKey).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(p.token).not.toBe(p.captainKey);
    expect(Math.round((Date.parse(p.expiresAt) - Date.now()) / 86_400_000)).toBe(30);
    const raw = await db.prepare("SELECT * FROM squad_plans ORDER BY created_at DESC LIMIT 20").all<Record<string, unknown>>();
    const text = JSON.stringify(raw.results);
    expect(text).not.toContain(p.token);
    expect(text).not.toContain(p.captainKey);
    const r = await open(p.token);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(r.json).sort()).toEqual(["counts", "createdAt", "expiresAt", "game", "people", "slotMinutes", "slots", "title", "tz"]);
    expect(r.json).toMatchObject({ game: "bgmi", title: "Saturday scrims", tz: "Asia/Kolkata", slotMinutes: 60, people: [], counts: [0, 0, 0, 0, 0, 0] });
  });

  it("validates the create body", async () => {
    await on();
    const cases: [Record<string, unknown>, string][] = [
      [{ game: "chess" }, "invalid_game"], [{ tz: "Nowhere/City" }, "invalid_tz"], [{ slotMinutes: 45 }, "invalid_slotMinutes"],
      [{ slots: [] }, "slots_missing"], [{ title: "join discord.gg/xyz" }, "invalid_title"], [{ slots: [nowSec() + 61] }, "slots_not_aligned"],
    ];
    for (const [over, code] of cases) {
      const r = await api("/public/planner", { body: { game: "bgmi", slots: slotsFrom(2), ...over } });
      expect([r.status, r.json.code], code).toEqual([400, code]);
    }
    expect((await api("/public/planner", { raw: "x".repeat(9_000), headers: { "content-type": "application/json" } })).status).toBe(413);
  });

  it("a wrong, malformed or deleted token is the same 404 as nothing (no oracle)", async () => {
    await on();
    const p = await plan();
    const fake = `${p.token.slice(0, 31)}${p.token[31] === "A" ? "B" : "A"}`;
    const answers = await Promise.all([open(fake), open("short"), open(123), open(undefined), open(p.token.toLowerCase() === p.token ? `${p.token.slice(1)}Z` : p.token.toLowerCase())]);
    for (const a of answers) expect([a.status, a.json]).toEqual([404, { error: "Not found" }]);
  });

  it("teammates vote with a name and an edit key, edit their own answers, and counts add up", async () => {
    await on();
    const p = await plan();
    const k1 = key(), k2 = key();
    let r = await api("/public/planner/vote", { body: { token: p.token, editKey: k1, name: "Ravi", picks: [0, 1, 2] } });
    expect(r.status, r.text).toBe(200);
    r = await api("/public/planner/vote", { body: { token: p.token, editKey: k2, name: "Asha", picks: [1, 2] } });
    expect(r.json.counts).toEqual([1, 2, 2, 0, 0, 0]);
    // the same key edits its own row, never a second one
    r = await api("/public/planner/vote", { body: { token: p.token, editKey: k1, name: "Ravi K", picks: [5] } });
    expect(r.json.people.map((x: { name: string }) => x.name)).toEqual(["Ravi K", "Asha"]);
    expect(r.json.counts).toEqual([0, 1, 1, 0, 0, 1]);
    // the response never carries a key or its hash
    expect(JSON.stringify(r.json)).not.toMatch(new RegExp(`${k1}|${k2}|edit_key|captain|token`));
    // unvote: only your own key removes your row
    expect((await api("/public/planner/unvote", { body: { token: p.token, editKey: key() } })).status).toBe(404);
    r = await api("/public/planner/unvote", { body: { token: p.token, editKey: k2 } });
    expect(r.json.people).toHaveLength(1);
  });

  it("rejects bad votes: name, picks outside the plan, a missing key", async () => {
    await on();
    const p = await plan();
    const cases: [Record<string, unknown>, string][] = [
      [{ name: "" }, "invalid_name"], [{ name: "x".repeat(25) }, "invalid_name"], [{ name: "call 9876543210" }, "invalid_name"],
      [{ picks: [6] }, "invalid_picks"], [{ picks: "0" }, "invalid_picks"], [{ editKey: "short" }, "invalid_editKey"],
    ];
    for (const [over, code] of cases) {
      const r = await api("/public/planner/vote", { body: { token: p.token, editKey: key(), name: "Ok", picks: [0], ...over } });
      expect([r.status, r.json.code], code).toEqual([400, code]);
    }
    // a vote on another plan's token never lands on this one
    expect((await api("/public/planner/vote", { body: { token: "A".repeat(32), editKey: key(), name: "X", picks: [] } })).status).toBe(404);
  });

  it("caps a plan at 20 people", async () => {
    await on();
    const p = await plan();
    for (let i = 0; i < 20; i++) expect((await api("/public/planner/vote", { body: { token: p.token, editKey: key(), name: `P${i}`, picks: [0] } })).status).toBe(200);
    const r = await api("/public/planner/vote", { body: { token: p.token, editKey: key(), name: "Late", picks: [0] } });
    expect([r.status, r.json.code]).toEqual([409, "plan_full"]);
  });

  it("only the captain key deletes the plan; afterwards the link is a 404", async () => {
    await on();
    const p = await plan();
    const other = await plan();
    expect((await api("/public/planner/delete", { body: { token: p.token, captainKey: other.captainKey } })).status).toBe(404);
    expect((await api("/public/planner/delete", { body: { token: p.token, captainKey: "short" } })).status).toBe(404);
    expect((await open(p.token)).status).toBe(200);
    expect((await api("/public/planner/delete", { body: { token: p.token, captainKey: p.captainKey } })).json).toEqual({ ok: true, deleted: true });
    expect((await open(p.token)).status).toBe(404);
    expect((await open(other.token)).status).toBe(200);
  });

  it("an expired plan is a 404 and the daily purge deletes it and its votes", async () => {
    await on();
    const p = await plan();
    await api("/public/planner/vote", { body: { token: p.token, editKey: key(), name: "A", picks: [0] } });
    const old = await plan({ title: "Old one" });
    await api("/public/planner/vote", { body: { token: old.token, editKey: key(), name: "B", picks: [0] } });
    await db.prepare("UPDATE squad_plans SET expires_at = ?1 WHERE title = 'Old one'").bind(nowSec() - 10).run();
    expect((await open(old.token)).status).toBe(404);
    expect(await purgeExpiredPlans(db)).toBeGreaterThanOrEqual(1);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM squad_plans WHERE title = 'Old one'").first<{ n: number }>())!.n).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM squad_plan_votes v WHERE NOT EXISTS (SELECT 1 FROM squad_plans p WHERE p.id = v.plan_id)").first<{ n: number }>())!.n).toBe(0);
    expect((await open(p.token)).status).toBe(200);
  });

  it("rate limits plan creation per address and honours kill.public_writes (delete still works)", async () => {
    await on();
    const ip = "10.250.1.1";
    let last = 0;
    for (let i = 0; i < 11; i++) last = (await api("/public/planner", { ip, body: { game: "bgmi", slots: slotsFrom(1) } })).status;
    expect(last).toBe(429);
    const p = await plan();
    await flagsOn(...(["v3.planner", "kill.public_writes"] as never[]));
    expect((await api("/public/planner", { body: { game: "bgmi", slots: slotsFrom(1) } })).status).toBe(503);
    expect((await api("/public/planner/vote", { body: { token: p.token, editKey: key(), name: "A", picks: [] } })).status).toBe(503);
    expect((await api("/public/planner/delete", { body: { token: p.token, captainKey: p.captainKey } })).status).toBe(200);
  });
});
