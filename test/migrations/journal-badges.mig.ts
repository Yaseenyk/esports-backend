import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it } from "vitest";
import { applyUpTo, foreignKeyViolations, seedLegacyWorld, snapshot } from "./world";

// 0091 (match journal and badges): two new tables and one index on top of a populated database. Additive and idempotent.
describe("0091 journal and badges", () => {
  it("adds exactly two tables, changes no existing row or table, re-running it changes nothing, and the database refuses bad rows", async () => {
    await applyUpTo(91);
    await seedLegacyWorld();
    const before = await snapshot();
    const tablesBefore = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name);
    await applyUpTo(92);
    expect(await snapshot()).toEqual(before);
    const added = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name).filter((n) => !tablesBefore.includes(n));
    expect(added.sort()).toEqual(["v3_badge_state", "v3_journal_entries"]);
    expect(await foreignKeyViolations()).toEqual([]);
    const schema = async () => JSON.stringify((await env.DB.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).results);
    const s1 = await schema();
    const m = (env.TEST_MIGRATIONS as D1Migration[]).find((x) => x.name.startsWith("0091"))!;
    for (const q of m.queries) await env.DB.prepare(q).run();
    expect(await schema()).toBe(s1);
    for (const t of ["v3_journal_entries", "v3_badge_state"]) {
      const cols = (await env.DB.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()).results.map((c) => c.name);
      for (const c of cols) expect(c, `${t}.${c}`).not.toMatch(/dob|birth|aadhaar|aadhar|phone|email|^ip|price|fee|amount|prize|wallet/i);
    }
    const uid = (await env.DB.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>())!.id;
    const j = (over: Record<string, unknown>) => {
      const r = { id: crypto.randomUUID(), user_id: uid, played_on: "2026-11-20", game: "bgmi", kills: 3, ...over };
      const k = Object.keys(r);
      return env.DB.prepare(`INSERT INTO v3_journal_entries (${k.join(", ")}) VALUES (${k.map((_, i) => `?${i + 1}`).join(", ")})`).bind(...Object.values(r)).run();
    };
    await j({});
    for (const bad of [{ played_on: "20-11-2026" }, { game: "chess" }, { kills: 201 }, { kills: null }, { placement: 0 }, { damage: 100001 }, { notes: "n".repeat(501) }, { user_id: "no-such-user" }]) {
      await expect(j(bad), JSON.stringify(bad)).rejects.toThrow();
    }
    await env.DB.prepare("INSERT INTO v3_badge_state (user_id, badge_id, hidden) VALUES (?1, 'first_win', 1)").bind(uid).run();
    await expect(env.DB.prepare("INSERT INTO v3_badge_state (user_id, badge_id, hidden) VALUES (?1, 'first_scrim', 2)").bind(uid).run()).rejects.toThrow();
  });
});
