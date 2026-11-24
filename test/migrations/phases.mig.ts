import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it } from "vitest";
import { applyAll, applyUpTo, foreignKeyViolations, one, seedLegacyWorld, snapshot } from "./world";

// 0056 (phases 3-5: profiles, scrims, directory) on top of a populated production-like database (0001 to 0055 plus a legacy world).
const NEW = ["scrim_blocks", "scrim_reports", "scrim_requests", "scrim_slots", "v3_player_hidden_items", "v3_profile_moderation", "v3_profile_reports", "v3_team_hidden_items", "v3_team_pages", "v3_tournament_directory"];

describe("0056 on a populated database", () => {
  it("is purely additive: no existing row, column or table changes; exactly ten tables appear; foreign keys stay clean", async () => {
    await applyUpTo(56);
    await seedLegacyWorld();
    const before = await snapshot();
    const tablesBefore = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name);
    const colsBefore = JSON.stringify((await env.DB.prepare("SELECT m.name AS t, p.name AS c, p.type AS ty, p.\"notnull\" AS nn FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE '_cf_%' AND m.name NOT LIKE 'sqlite_%' AND m.name != 'd1_migrations' ORDER BY m.name, p.cid").all()).results);
    await applyAll();
    expect(await snapshot()).toEqual(before);
    const added = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((r) => r.name).filter((n) => !tablesBefore.includes(n)).sort();
    expect(added).toEqual([...NEW, "scrim_slot_assignments", "scrim_waitlist", "scrim_notifications", "scrim_schedules", "scrim_schedule_days"].sort()); // + the 0057 scrim manager tables
    const colsAfter = (await env.DB.prepare("SELECT m.name AS t, p.name AS c, p.type AS ty, p.\"notnull\" AS nn FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name NOT LIKE '_cf_%' AND m.name NOT LIKE 'sqlite_%' AND m.name != 'd1_migrations' ORDER BY m.name, p.cid").all<{ t: string }>()).results.filter((r) => !NEW.includes(r.t) && !r.t.startsWith("scrim_"));
    expect(JSON.stringify(colsAfter)).toBe(colsBefore);
    expect(await foreignKeyViolations()).toEqual([]);
    // no money, date of birth, id document, phone, email or IP column in the new tables
    for (const t of [...NEW, "scrim_slot_assignments", "scrim_waitlist", "scrim_notifications", "scrim_schedules", "scrim_schedule_days"]) {
      const cols = (await env.DB.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()).results.map((c) => c.name);
      for (const c of cols) expect(c, `${t}.${c}`).not.toMatch(/fee|prize|price|amount|wallet|payout|money|dob|birth|aadhaar|pan_|passport|phone|email|ip_/i);
    }
  });

  it("is idempotent: applying the file again changes nothing", async () => {
    await applyAll();
    const schema = async () => JSON.stringify((await env.DB.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()).results);
    const s1 = await schema();
    for (const name of ["0056", "0057"]) {
      const m = (env.TEST_MIGRATIONS as D1Migration[]).find((x) => x.name.startsWith(name))!;
      for (const q of m.queries) await env.DB.prepare(q).run();
    }
    expect(await schema()).toBe(s1);
    expect(await one("SELECT COUNT(*) FROM sqlite_master WHERE name = 'tournaments_city_idx'")).toBe(1);
  });
});
