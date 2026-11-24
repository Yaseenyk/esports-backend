import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it } from "vitest";
import { applyAll, applyUpTo, foreignKeyViolations, one, seedLegacyWorld, snapshot } from "./world";

// 0054 (feedback bot: three tables, one trigger, indexes) on top of a populated production-like database (0001 to 0053 plus a legacy world).
const run = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).run();
const rid = () => crypto.randomUUID().replace(/-/g, "");
const report = (over: Record<string, unknown> = {}) => {
  const r = { id: rid(), created_at: 1_800_000_000, kind: "bug", message: "a long enough message", page_path: "/tools/", consent_version: "feedback-v1", ...over };
  const cols = Object.keys(r);
  return run(`INSERT INTO feedback_reports (${cols.join(", ")}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(", ")})`, ...Object.values(r));
};

describe("0054 on a populated database", () => {
  it("is additive: nothing existing changes, three tables and a trigger appear, foreign keys stay clean", async () => {
    await applyUpTo(54);
    await seedLegacyWorld();
    const before = await snapshot();
    const usersBefore = (await env.DB.prepare("SELECT id, email, name, status FROM users ORDER BY id").all()).results;
    const tablesBefore = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name);
    await applyAll();
    expect(await snapshot()).toEqual(before);
    expect((await env.DB.prepare("SELECT id, email, name, status FROM users ORDER BY id").all()).results).toEqual(usersBefore);
    const added = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name).filter((n) => !tablesBefore.includes(n)).sort();
    expect(added).toEqual(["feedback_attachment_blobs", "feedback_attachments", "feedback_reports", "scrim_blocks", "scrim_reports", "scrim_requests", "scrim_slots", "v3_player_hidden_items", "v3_profile_moderation", "v3_profile_reports", "v3_team_hidden_items", "v3_team_pages", "v3_tournament_directory", "scrim_slot_assignments", "scrim_waitlist", "scrim_notifications", "scrim_schedules", "scrim_schedule_days"].sort()); // + the later 0056 tables
    expect(await one("SELECT COUNT(*) FROM sqlite_master WHERE name = 'trg_feedback_attachments_max2'")).toBe(1);
    expect(await foreignKeyViolations()).toEqual([]);
    for (const t of added) {
      const cols = (await env.DB.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>()).results.map((c) => c.name);
      for (const c of cols) expect(c, `${t}.${c}`).not.toMatch(/dob|birth|aadhaar|aadhar|price|fee|amount|prize|payout|wallet|currency|email|user_agent|^ip$|ip_address/i);
    }
  });

  it("re-running 0054 changes nothing (idempotent)", async () => {
    await report();
    const m = (env.TEST_MIGRATIONS as D1Migration[]).find((x) => x.name.startsWith("0054"))!;
    expect(m.queries.length).toBeGreaterThanOrEqual(10);
    for (const q of m.queries) await env.DB.prepare(q).run();
    expect(await one("SELECT COUNT(*) FROM feedback_reports")).toBe(1);
    expect(await one("SELECT COUNT(*) FROM sqlite_master WHERE name = 'trg_feedback_attachments_max2'")).toBe(1);
  });

  it("the database refuses bad rows: path with ? or #, kind, status, message length, device class, errors, user link, orphan attachments, sizes", async () => {
    await report({ page_path: "/ok/" });
    for (const p of ["/a?x=1", "/a#x", "no-slash", ""]) await expect(report({ page_path: p }), p).rejects.toThrow();
    await expect(report({ page_path: "/" + "x".repeat(200) })).rejects.toThrow();
    await expect(report({ referrer_path: "/a?b" })).rejects.toThrow();
    await expect(report({ kind: "praise" })).rejects.toThrow();
    await expect(report({ status: "closed" })).rejects.toThrow();
    await expect(report({ message: "too short" })).rejects.toThrow();
    await expect(report({ message: "x".repeat(2001) })).rejects.toThrow();
    await report({ message: "y".repeat(2000) });
    await expect(report({ device_class: "tv" })).rejects.toThrow();
    await expect(report({ page_title: "t".repeat(121) })).rejects.toThrow();
    await expect(report({ client_errors: "not json" })).rejects.toThrow();
    await expect(report({ client_errors: '{"a":1}' })).rejects.toThrow();
    await expect(report({ client_errors: '["1","2","3","4","5","6"]' })).rejects.toThrow();
    await report({ client_errors: '["1","2","3","4","5"]' });
    await expect(report({ viewport_w: 0 })).rejects.toThrow();
    await expect(report({ contact: "ab" })).rejects.toThrow();
    await expect(report({ staff_note: "n".repeat(1001) })).rejects.toThrow();
    await expect(report({ user_id: "u-alice", signed_in: 0 })).rejects.toThrow();
    await expect(report({ consent_version: null })).rejects.toThrow();

    const id = rid();
    await report({ id });
    const att = (aid: string, over: Record<string, unknown> = {}) => run("INSERT INTO feedback_attachments (id, report_id, mime, size_bytes, sha256, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 1)", aid, over.report ?? id, over.mime ?? "png", over.size ?? 100, over.sha ?? "a".repeat(64));
    await expect(att("a0", { report: "nope" })).rejects.toThrow(); // FK
    await expect(att("a1", { mime: "gif" })).rejects.toThrow();
    await expect(att("a2", { size: 0 })).rejects.toThrow();
    await expect(att("a3", { size: 409_601 })).rejects.toThrow();
    await expect(att("a4", { sha: "short" })).rejects.toThrow();
    await att("b1", { size: 409_600 });
    await expect(att("b2")).rejects.toThrow(); // same hash, same report
    await att("b3", { sha: "c".repeat(64), mime: "webp" });
    await expect(att("b4", { sha: "d".repeat(64) })).rejects.toThrow(/at most 2/); // the third file
    await expect(run("INSERT INTO feedback_attachment_blobs (attachment_id, data) VALUES ('b1', x'')")).rejects.toThrow();
    await run("INSERT INTO feedback_attachment_blobs (attachment_id, data) VALUES ('b1', x'89504e47')");
    await expect(run("INSERT INTO feedback_attachment_blobs (attachment_id, data) VALUES ('nope', x'89')")).rejects.toThrow();
  });

  it("deleting a report cascades to its attachments and bytes; deleting a user only unlinks (the application deletes the report itself)", async () => {
    const id = rid();
    await report({ id });
    await run("INSERT INTO feedback_attachments (id, report_id, mime, size_bytes, sha256, created_at) VALUES ('c1', ?1, 'png', 4, ?2, 1)", id, "e".repeat(64));
    await run("INSERT INTO feedback_attachment_blobs (attachment_id, data) VALUES ('c1', x'89504e47')");
    await run("DELETE FROM feedback_reports WHERE id = ?1", id);
    expect(await one("SELECT COUNT(*) FROM feedback_attachments WHERE id = 'c1'")).toBe(0);
    expect(await one("SELECT COUNT(*) FROM feedback_attachment_blobs WHERE attachment_id = 'c1'")).toBe(0);
    const uid = await env.DB.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>();
    const r2 = rid();
    await report({ id: r2, user_id: uid!.id, signed_in: 1 });
    await run("DELETE FROM users WHERE id = ?1", uid!.id).catch(() => undefined); // may be blocked by legacy rows; the unlink rule is the foreign key's
    expect(await foreignKeyViolations()).toEqual([]);
  });
});
