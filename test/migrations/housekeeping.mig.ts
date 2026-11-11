import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { scheduled } from "../../src/features/reminders-cron";
import { checkInvariants, purgeExpired, purgeOrphanOrgs, runHousekeeping } from "../../src/features/housekeeping";
import { applyAll, backfillStatements, ids, one, runStatements, seedLegacyWorld } from "./world";

const NOW = Date.UTC(2026, 10, 20, 3, 0, 0);
const iso = (ms: number) => new Date(ms).toISOString();

describe("housekeeping", () => {
  it("skips cleanly before the tables exist and never throws", async () => {
    // nothing applied at all: every query fails, every step is a skip
    const r = await runHousekeeping(env.DB, NOW);
    expect(Object.values(r.invariants.counts).every((n) => n === null)).toBe(true);
    expect(r.purgedOrphanOrgs).toBeNull();
    expect(r.expired).toEqual({ email_tokens: null, password_resets: null, invitations: null });
  });

  it("daily run: invariants, orphan purge, expiry, and the cron hook", async () => {
    await applyAll();
    await seedLegacyWorld();
    await runStatements(backfillStatements());
    expect((await checkInvariants(env.DB)).ok).toBe(true);

    // a deleted user leaves an orphan personal organisation (invariant 4); one orphan still holds an event (must not be deleted)
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(ids.dave).run();
    expect(await one("SELECT COUNT(*) FROM organisations WHERE id = ?", `org-${ids.dave}`)).toBe(1);
    expect((await checkInvariants(env.DB)).counts.inv4).toBe(1);
    await env.DB.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES ('org-ghost', 'Ghost', 'personal', 'active', 'now')").run();
    await env.DB.prepare("INSERT INTO events (id, owner_id, slug, name, signing_secret, created_at, updated_at, org_id) VALUES ('eg', ?1, 'g', 'g', 's', 'now', 'now', 'org-ghost')").bind(ids.alice).run();
    expect(await purgeOrphanOrgs(env.DB)).toBe(1); // dave's, not the ghost that has an event
    expect(await one("SELECT COUNT(*) FROM organisations WHERE id = 'org-ghost'")).toBe(1);
    expect((await checkInvariants(env.DB)).counts.inv4).toBe(1); // the ghost is still reported
    await env.DB.prepare("DELETE FROM events WHERE id = 'eg'").run();
    await env.DB.prepare("DELETE FROM organisations WHERE id = 'org-ghost'").run();

    // a violation is logged and counted, best effort (the metrics table does not exist yet in this ledger, which must not matter)
    await env.DB.prepare("UPDATE events SET org_id = NULL WHERE id = 'e1'").run();
    const bad = await runHousekeeping(env.DB, NOW);
    expect(bad.invariants.ok).toBe(false);
    expect(bad.invariants.counts.inv2).toBe(1);
    await env.DB.prepare("UPDATE events SET org_id = ?1 WHERE id = 'e1'").bind(`org-${ids.alice}`).run();

    // expiry
    const old = iso(NOW - 3 * 86_400_000);
    const fresh = iso(NOW + 3_600_000);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO email_tokens (id, user_id, token_hash, purpose, expires_at, used_at) VALUES ('t-old', ?1, 'h1', 'verify', ?2, NULL)").bind(ids.alice, old),
      env.DB.prepare("INSERT INTO email_tokens (id, user_id, token_hash, purpose, expires_at, used_at) VALUES ('t-new', ?1, 'h2', 'verify', ?2, NULL)").bind(ids.alice, fresh),
      env.DB.prepare("INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at, used_at) VALUES ('p-old', ?1, 'h3', 'x', ?2, NULL)").bind(ids.alice, old),
      env.DB.prepare("INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at, used_at) VALUES ('p-new', ?1, 'h4', 'x', ?2, NULL)").bind(ids.alice, fresh),
    ]);
    // invitations arrive in Phase 2a; the housekeeping must already handle them (DDL copied from blueprint 15.4)
    await env.DB.prepare(
      "CREATE TABLE invitations (id TEXT PRIMARY KEY, org_id TEXT REFERENCES organisations(id) ON DELETE CASCADE, event_id TEXT REFERENCES events(id) ON DELETE CASCADE, role TEXT NOT NULL, email TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, invited_by TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, accepted_at TEXT, revoked_at TEXT)",
    ).run();
    const inv = (id: string, exp: string, acc: string | null, rev: string | null) =>
      env.DB.prepare("INSERT INTO invitations (id, org_id, role, email, token_hash, invited_by, created_at, expires_at, accepted_at, revoked_at) VALUES (?1, ?2, 'member', 'a@b.c', ?3, 'x', 'x', ?4, ?5, ?6)").bind(id, `org-${ids.alice}`, `th-${id}`, exp, acc, rev);
    await env.DB.batch([
      inv("i-open", fresh, null, null),
      inv("i-expired-recent", iso(NOW - 2 * 86_400_000), null, null), // expired 2 days ago: kept (14-day rule)
      inv("i-expired-old", iso(NOW - 20 * 86_400_000), null, null),
      inv("i-accepted", fresh, iso(NOW), null),
      inv("i-revoked", fresh, null, iso(NOW)),
    ]);
    const x = await purgeExpired(env.DB, NOW);
    expect(x).toEqual({ email_tokens: 1, password_resets: 1, invitations: 3 });
    expect((await env.DB.prepare("SELECT id FROM email_tokens").all()).results.map((r: any) => r.id)).toEqual(["t-new"]);
    expect((await env.DB.prepare("SELECT id FROM password_resets").all()).results.map((r: any) => r.id)).toEqual(["p-new"]);
    expect((await env.DB.prepare("SELECT id FROM invitations ORDER BY id").all()).results.map((r: any) => r.id)).toEqual(["i-expired-recent", "i-open"]);

    // the cron hook: a 03:00 UTC tick runs it, a 04:00 tick does not
    await env.DB.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES ('org-orphan2', 'O', 'personal', 'active', 'now')").run();
    const run = async (ms: number) => {
      const pending: Promise<unknown>[] = [];
      await scheduled({ scheduledTime: ms, cron: "*/15 * * * *", noRetry() {} } as unknown as ScheduledController, env, { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException() {} } as unknown as ExecutionContext);
      await Promise.all(pending);
    };
    await run(Date.UTC(2026, 10, 20, 4, 0, 0));
    expect(await one("SELECT COUNT(*) FROM organisations WHERE id = 'org-orphan2'")).toBe(1);
    await run(NOW);
    expect(await one("SELECT COUNT(*) FROM organisations WHERE id = 'org-orphan2'")).toBe(0);
  });
});
