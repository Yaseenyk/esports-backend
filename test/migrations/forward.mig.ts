import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { applyAll, applyUpTo, backfillStatements, foreignKeyViolations, ids, invariants, one, runStatements, seedLegacyWorld, seedTeamOrg, snapshot } from "./world";

// Exit criterion 2 of Phase 0B: apply 0001 to 0034, seed a world that includes a team organisation, apply the new files,
// the invariants return 0, the backfill applied twice changes nothing.

describe("0B migrations on a seeded world", () => {
  it("expands the schema without touching data, then backfills idempotently", async () => {
    await applyUpTo(35);
    await seedLegacyWorld();
    expect(await one("SELECT COUNT(*) FROM users")).toBe(5);
    expect(await one("SELECT COUNT(*) FROM events")).toBe(5);

    // expand: 0035 to 0039 (and anything else the ledger adds below 0042, such as audit and metrics)
    await applyAll();
    for (const t of ["flags", "organisations", "org_members"]) expect(await one(`SELECT COUNT(*) FROM ${t}`)).toBe(0);
    const cols = (await env.DB.prepare("SELECT name FROM pragma_table_info('events')").all<{ name: string }>()).results.map((r) => r.name);
    expect(cols).toContain("org_id");
    expect(cols).toContain("created_by");
    expect(await one("SELECT COUNT(*) FROM pragma_index_list('events') WHERE name = 'idx_events_org'")).toBe(1);
    expect(await one("SELECT COUNT(*) FROM events WHERE org_id IS NULL")).toBe(5); // nothing was filled by the schema step

    // an old Worker keeps working against the new schema: its INSERT names no new column, and the row has org_id NULL
    await env.DB.prepare("INSERT INTO events (id, owner_id, slug, name, signing_secret, created_at, updated_at) VALUES ('e7', ?1, 'late', 'Late', 'sec', 'now', 'now')").bind(ids.bob).run();
    await seedTeamOrg();

    // the gate bites before the backfill: users without organisation, events without org_id
    const before = await invariants();
    expect(before[0]).toBe(5); // inv1: all five users lack a personal organisation (the team org does not count)
    expect(before[1]).toBe(6); // inv2: e1..e5 and e7
    expect(before.slice(2)).toEqual([0, 0, 0]);

    // backfill, first run
    const first = await runStatements(backfillStatements());
    expect(first[0]).toBe(5); // organisations
    expect(first[1]).toBe(5); // memberships
    expect(first.slice(2).reduce((a, b) => a + b, 0)).toBe(6); // events: e1..e5 and e7, not e6
    expect(await invariants()).toEqual([0, 0, 0, 0, 0]);

    const world = await snapshot();
    const e = Object.fromEntries(world.evs.map((r: any) => [r.id, r]));
    expect(e.e1.org_id).toBe(`org-${ids.alice}`);
    expect(e.e1.created_by).toBe(ids.alice);
    expect(e.e4.org_id).toBe(`org-${ids.bob}`); // a guest does not move the event
    expect(e.e6.org_id).toBe(ids.teamOrg); // the team organisation event is not rewritten
    expect(e.e6.created_by).toBe(ids.alice);
    const org = world.orgs.find((o: any) => o.id === `org-${ids.alice}`) as any;
    expect(org.name).toBe("Alice O'Neil's workspace");
    expect(org.kind).toBe("personal");
    const long = world.orgs.find((o: any) => o.id === `org-${ids.longname}`) as any;
    expect(long.name.length).toBe(72); // 60 + 12, inside CHECK 80
    expect(world.members.filter((m: any) => m.org_id === ids.teamOrg)).toHaveLength(2);
    expect(world.orgs).toHaveLength(6); // five personal plus the team

    // backfill, second run: no statement changes a row and the world is byte-identical
    const second = await runStatements(backfillStatements());
    expect(second.every((n) => n === 0)).toBe(true);
    expect(await snapshot()).toEqual(world);
    expect(await invariants()).toEqual([0, 0, 0, 0, 0]);

    // the sixth invariant
    expect(await foreignKeyViolations()).toEqual([]);

    // the foreign keys protect the foreign-key target and column (blueprint 16.1 rule 6)
    await expect(env.DB.prepare("DROP TABLE organisations").run()).rejects.toThrow();
    await expect(env.DB.prepare("ALTER TABLE events DROP COLUMN org_id").run()).rejects.toThrow();
  });

  it("chunks the events update (more than one chunk, one run)", async () => {
    // self-contained whether or not the storage of the test above survived
    await applyAll();
    if ((await one("SELECT COUNT(*) FROM users")) === 0) await seedLegacyWorld();
    const base = await one("SELECT COUNT(*) FROM events WHERE org_id IS NULL");
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 2300; i++) {
      stmts.push(env.DB.prepare("INSERT INTO events (id, owner_id, slug, name, signing_secret, created_at, updated_at) VALUES (?1, ?2, ?3, 'bulk', 's', 'now', 'now')").bind(`bulk-${i}`, ids.carol, `bulk-${i}`));
      if (stmts.length === 100) { await env.DB.batch(stmts.splice(0)); }
    }
    if (stmts.length) await env.DB.batch(stmts);
    expect(await one("SELECT COUNT(*) FROM events WHERE org_id IS NULL")).toBe(base + 2300);
    const run = await runStatements(backfillStatements());
    const chunks = run.slice(2);
    expect(chunks[0]).toBe(1000);
    expect(chunks[1]).toBe(1000);
    expect(chunks[2]).toBe(300);
    expect(chunks.slice(3).every((n) => n === 0)).toBe(true);
    expect(await invariants()).toEqual([0, 0, 0, 0, 0]);
  });
});
