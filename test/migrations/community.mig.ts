import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it } from "vitest";
import { applyAll, applyUpTo, foreignKeyViolations, one, seedLegacyWorld, snapshot } from "./world";

// 0080 (community: calendar + organiser trust) on a populated database: purely additive, idempotent, and the database itself refuses bad rows.
const run = (sql: string, ...b: unknown[]) => env.DB.prepare(sql).bind(...b).run();
const NEW = ["calendar_entries", "calendar_entry_actions", "organiser_rating_actions", "organiser_rating_reports", "organiser_ratings"];

describe("0080 community tables", () => {
  it("is additive (no legacy row or column changes) and every statement can run twice", async () => {
    await applyUpTo(80);
    await seedLegacyWorld();
    const before = await snapshot();
    const tablesBefore = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name);
    await applyAll();
    expect(await snapshot()).toEqual(before);
    const added = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name).filter((n) => !tablesBefore.includes(n)).sort();
    for (const t of NEW) expect(added, t).toContain(t);
    const m = (env.TEST_MIGRATIONS as D1Migration[]).find((x) => x.name.startsWith("0080"))!;
    for (const q of m.queries) {
      expect(q.trim(), "only CREATE ... IF NOT EXISTS").toMatch(/^CREATE (TABLE|UNIQUE INDEX|INDEX|TRIGGER) IF NOT EXISTS /);
      await env.DB.prepare(q).run(); // second run changes nothing
    }
    for (const t of NEW) {
      const cols = (await env.DB.prepare(`PRAGMA table_info(${t})`).all<{ name: string }>()).results.map((c) => c.name);
      for (const c of cols) expect(c, `${t}.${c}`).not.toMatch(/dob|birth|aadhaar|aadhar|price|fee|amount|prize|payout|wallet|currency|email/i);
    }
    expect(await foreignKeyViolations()).toEqual([]);
  });

  it("refuses query strings, bad dates, duplicate ratings and orphans", async () => {
    await run("INSERT INTO users (id, email, name, pw_hash, pw_salt, pw_iter, created_at) VALUES ('cu1', 'cu1@example.com', 'C1', 'x', 'x', 1, 'x')");
    await run("INSERT INTO organisations (id, name, kind, status, created_at) VALUES ('co1', 'College', 'team', 'active', 'x')");
    const cal = (id: string, url: string | null, s = "2026-12-01", e = "2026-12-02") =>
      run("INSERT INTO calendar_entries (id, org_id, title, game, city, starts_on, ends_on, registration_url, created_at, updated_at) VALUES (?1, 'co1', 'Fest Cup', 'bgmi', 'Pune', ?2, ?3, ?4, 1, 1)", id, s, e, url);
    await cal("c1", "https://forms.example.org/r");
    await expect(cal("c2", "https://forms.example.org/r?t=secret")).rejects.toThrow();
    await expect(cal("c3", "https://forms.example.org/r#frag")).rejects.toThrow();
    await expect(cal("c4", "http://forms.example.org/r")).rejects.toThrow();
    await expect(cal("c5", "https://forms.example.org/r", "2026-12-05", "2026-12-01")).rejects.toThrow();
    await expect(cal("c6", "https://forms.example.org/r", "01-12-2026", "02-12-2026")).rejects.toThrow();
    await expect(cal("c7", null)).rejects.toThrow(); // a listed entry needs a link
    await expect(run("INSERT INTO calendar_entries (id, org_id, title, game, city, starts_on, ends_on, registration_url, created_at, updated_at) VALUES ('c8', 'no-org', 'Fest Cup', 'bgmi', 'Pune', '2026-12-01', '2026-12-01', 'https://x.example.org/', 1, 1)")).rejects.toThrow();

    await run("INSERT INTO events (id, owner_id, slug, name, signing_secret, created_at, updated_at) VALUES ('ce1', 'cu1', 'ce1', 'Cup', 's', 'x', 'x')");
    const rate = (id: string, user: string, ref: string, stars = 4) =>
      run("INSERT INTO organiser_ratings (id, event_id, organiser_key, user_id, display_name, proof_kind, proof_ref, stars, on_time, fair_play, communication, created_at, updated_at) VALUES (?1, 'ce1', 'user:cu1', ?2, 'Riya', 'checked_in', ?3, ?4, 3, 3, 3, 1, 1)", id, user, ref, stars);
    await run("INSERT INTO users (id, email, name, pw_hash, pw_salt, pw_iter, created_at) VALUES ('cu2', 'cu2@example.com', 'C2', 'x', 'x', 1, 'x')");
    await rate("r1", "cu2", "person:P1");
    await expect(rate("r2", "cu2", "person:P2")).rejects.toThrow(); // one per player per event
    await expect(rate("r3", "cu1", "person:P1")).rejects.toThrow(); // one per pass per event
    await expect(rate("r4", "cu1", "person:P9", 6)).rejects.toThrow(); // stars 1-5
    await run("INSERT INTO organiser_rating_actions (id, rating_id, target, action, reason_code, staff_user_id, created_at) VALUES ('a1', 'r1', 'review', 'hidden', 'abuse', 'cu1', 1)");
    await expect(run("UPDATE organiser_rating_actions SET note = 'changed' WHERE id = 'a1'")).rejects.toThrow(); // append-only
    await run("DELETE FROM users WHERE id = 'cu2'");
    expect(await one("SELECT COUNT(*) FROM organiser_ratings WHERE id = 'r1'")).toBe(0); // goes with the account
    expect(await one("SELECT COUNT(*) FROM organiser_rating_actions WHERE id = 'a1'")).toBe(0);
    expect(await foreignKeyViolations()).toEqual([]);
  });
});
