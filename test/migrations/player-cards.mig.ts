import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it } from "vitest";
import { applyUpTo, foreignKeyViolations, seedLegacyWorld, snapshot } from "./world";

// 0081 (player cards): one new table and one index on top of a populated database. Additive and idempotent.
describe("0081 player cards", () => {
  it("adds exactly one table, changes no existing row or table, re-running it changes nothing, and the database refuses bad rows", async () => {
    await applyUpTo(81);
    await seedLegacyWorld();
    const before = await snapshot();
    const tablesBefore = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name);
    await applyUpTo(82); // only 0081 (later files add their own tables)
    expect(await snapshot()).toEqual(before);
    const added = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name).filter((n) => !tablesBefore.includes(n));
    expect(added).toEqual(["v3_player_page_details"]);
    expect(await foreignKeyViolations()).toEqual([]);
    const schema = async () => JSON.stringify((await env.DB.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).results);
    const s1 = await schema();
    const m = (env.TEST_MIGRATIONS as D1Migration[]).find((x) => x.name.startsWith("0081"))!;
    for (const q of m.queries) await env.DB.prepare(q).run();
    expect(await schema()).toBe(s1);
    const cols = (await env.DB.prepare("SELECT name FROM pragma_table_info('v3_player_page_details')").all<{ name: string }>()).results.map((c) => c.name);
    for (const c of cols) expect(c).not.toMatch(/dob|birth|aadhaar|aadhar|phone|email|^ip|price|fee|amount|prize|wallet/i);

    const uid = (await env.DB.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>())!.id;
    const ins = (over: Record<string, unknown>) => {
      const r = { user_id: uid, ...over };
      const k = Object.keys(r);
      return env.DB.prepare(`INSERT OR REPLACE INTO v3_player_page_details (${k.join(", ")}) VALUES (${k.map((_, i) => `?${i + 1}`).join(", ")})`).bind(...Object.values(r)).run();
    };
    await ins({ team_name: "Alpha", card_token_hash: "h".repeat(43) });
    await expect(ins({ team_name: "x".repeat(61) })).rejects.toThrow();
    await expect(ins({ card_token_hash: "short" })).rejects.toThrow();
    await expect(ins({ links: "x".repeat(2001) })).rejects.toThrow();
    await expect(ins({ user_id: "no-such-user" })).rejects.toThrow();
  });
});
