import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { getAuthzMode, resetFlagsCache } from "../../src/flags";
import { applyAll, applyUpTo, backfillStatements, foreignKeyViolations, ids, invariants, one, runStatements, seedLegacyWorld, seedTeamOrg, snapshot } from "./world";

// The rollback drill of blueprint 16.4 (the part that is pure SQL). On staging the same statements are run by hand (runbook-cutover.md, section 6).

describe("rollback drill (16.4)", () => {
  it("flag back to legacy, empty the new tables, keep the columns, backfill again gives the same world", async () => {
    await applyUpTo(35);
    await seedLegacyWorld();
    await applyAll();
    await seedTeamOrg();
    await runStatements(backfillStatements());
    const full = await snapshot();
    expect(await invariants()).toEqual([0, 0, 0, 0, 0]);

    // the flag: shadow, then org, then rolled back to legacy (a row of 'legacy', and a deleted row, both mean legacy)
    resetFlagsCache();
    await env.DB.prepare("INSERT INTO flags (key, value, updated_by, updated_at) VALUES ('authz.mode', '\"org\"', 'drill', 'now')").run();
    expect(await getAuthzMode(env.DB)).toBe("org");
    await env.DB.prepare("UPDATE flags SET value = '\"legacy\"' WHERE key = 'authz.mode'").run();
    resetFlagsCache();
    expect(await getAuthzMode(env.DB)).toBe("legacy");

    // the SQL rollback, exactly as in the runbook
    await env.DB.prepare("UPDATE events SET org_id = NULL").run();
    await env.DB.prepare("DELETE FROM org_members").run();
    await env.DB.prepare("DELETE FROM organisations").run();
    expect(await one("SELECT COUNT(*) FROM organisations")).toBe(0);
    expect(await one("SELECT COUNT(*) FROM org_members")).toBe(0);
    expect(await one("SELECT COUNT(*) FROM events WHERE org_id IS NOT NULL")).toBe(0);
    expect(await one("SELECT COUNT(*) FROM events")).toBe(6); // no event lost
    // the empty tables, the column and the index stay
    expect(await one("SELECT COUNT(*) FROM pragma_table_info('events') WHERE name IN ('org_id','created_by')")).toBe(2);
    expect(await one("SELECT COUNT(*) FROM pragma_index_list('events') WHERE name = 'idx_events_org'")).toBe(1);
    expect(await foreignKeyViolations()).toEqual([]);

    // old code is unaffected: legacy access reads only owner_id and event_members, which the rollback never touched
    const reach = (u: string) => one("SELECT COUNT(*) FROM events e LEFT JOIN event_members m ON m.event_id = e.id AND m.user_id = ?1 WHERE e.owner_id = ?1 OR m.user_id = ?1", u);
    expect(await reach(ids.carol)).toBe(2); // owns e5, edits e4
    expect(await reach(ids.alice)).toBe(3); // e1, e2, e6 (creator rows survive; the team organisation is gone, the creator is the owner again)

    // "backfill is safe to run again": the same personal world returns; the former team event is homed in its creator's personal organisation
    // (the team organisation existed only in this rehearsal and was deleted by the rollback, as the runbook says for the pre-PONR state)
    await runStatements(backfillStatements());
    expect(await invariants()).toEqual([0, 0, 0, 0, 0]);
    const again = await snapshot();
    const strip = (w: typeof full) => ({ ...w, orgs: w.orgs.filter((o: any) => o.kind === "personal"), members: w.members.filter((m: any) => m.org_id !== ids.teamOrg), evs: w.evs.filter((e: any) => e.id !== "e6") });
    expect(strip(again)).toEqual(strip(full));
    expect(again.evs.find((e: any) => e.id === "e6")).toMatchObject({ org_id: `org-${ids.alice}` });
  });
});
