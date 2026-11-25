import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it } from "vitest";
import { applyAll, applyUpTo, foreignKeyViolations, seedLegacyWorld, snapshot } from "./world";

// 0070 (organiser match rooms): two new tables on top of a populated database. Additive and idempotent.
describe("0070 match rooms", () => {
  it("adds exactly two tables, changes no existing row or table, and re-running it changes nothing", async () => {
    await applyUpTo(70);
    await seedLegacyWorld();
    const before = await snapshot();
    const tablesBefore = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name);
    await applyAll();
    expect(await snapshot()).toEqual(before);
    const added = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name).filter((n) => !tablesBefore.includes(n)).sort();
    expect(added.filter((n) => !/^(calendar_entr|organiser_rating)/.test(n))).toEqual(["v3_match_rooms", "v3_player_page_details", "v3_room_views"]); // 0080 (community) is checked in community.mig.ts; 0081 (player cards) in player-cards.mig.ts
    expect(await foreignKeyViolations()).toEqual([]);
    const schema = async () => JSON.stringify((await env.DB.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).results);
    const s1 = await schema();
    const m = (env.TEST_MIGRATIONS as D1Migration[]).find((x) => x.name.startsWith("0070"))!;
    for (const q of m.queries) await env.DB.prepare(q).run();
    expect(await schema()).toBe(s1);
    for (const t of added) {
      const cols = (await env.DB.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()).results.map((c) => c.name);
      for (const c of cols) expect(c, `${t}.${c}`).not.toMatch(/password|room_id_plain|dob|birth|aadhaar|phone|email|ip_/i);
    }
  });
});
