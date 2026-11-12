import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { applyAll, applyUpTo, foreignKeyViolations, one, seedLegacyWorld } from "./world";

// Phase 6 and 7 schema: 0048 api_keys, 0049 plans and entitlements (+ the seed row 'free'). Applied on top of a populated database.
const T = "2026-11-20T00:00:00.000Z";

describe("0048 and 0049 on a populated database", () => {
  it("expand only; api_keys rules hold; the free plan is seeded once; nothing existing changes", async () => {
    await applyUpTo(47);
    await seedLegacyWorld();
    const users = await one("SELECT COUNT(*) FROM users");
    await applyAll();
    expect(await one("SELECT COUNT(*) FROM users")).toBe(users);
    expect(await one("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('api_keys','idx_api_keys_user','plans','entitlements')")).toBe(4);
    expect(await foreignKeyViolations()).toEqual([]);

    const uid = (await env.DB.prepare("SELECT id FROM users LIMIT 1").first<{ id: string }>())!.id;
    const ins = (id: string, label: string, hash: string, scope = "read") =>
      env.DB.prepare("INSERT INTO api_keys (id, user_id, label, key_hash, hint, scope, created_at) VALUES (?1, ?2, ?3, ?4, 'ehk_abcd', ?5, ?6)").bind(id, uid, label, hash, scope, T).run();
    await ins("k1", "one", "h1");
    await expect(ins("k2", "two", "h1")).rejects.toThrow(); // key_hash unique
    await expect(ins("k3", "", "h3")).rejects.toThrow(); // label 1..40
    await expect(ins("k4", "x".repeat(41), "h4")).rejects.toThrow();
    await expect(ins("k5", "write", "h5", "write")).rejects.toThrow(); // scope is read only
    await env.DB.prepare("DELETE FROM users WHERE id = ?1").bind(uid).run();
    expect(await one("SELECT COUNT(*) FROM api_keys")).toBe(0); // cascades with the account

    expect(await one("SELECT COUNT(*) FROM plans")).toBe(1);
    expect(await one("SELECT COUNT(*) FROM plans WHERE id = 'free' AND json_valid(limits) = 1")).toBe(1);
    expect(await one("SELECT COUNT(*) FROM entitlements")).toBe(0);
    await expect(env.DB.prepare("INSERT INTO plans (id, name, limits) VALUES ('bad', 'Bad', 'not json')").run()).rejects.toThrow();
    await expect(env.DB.prepare("INSERT INTO entitlements (subject, plan_id, since) VALUES ('anyone', 'free', ?1)").bind(T).run()).rejects.toThrow(); // subject shape
    await expect(env.DB.prepare("INSERT INTO entitlements (subject, plan_id, since) VALUES ('user:u1', 'gold', ?1)").bind(T).run()).rejects.toThrow(); // unknown plan (FK)
    await env.DB.prepare("INSERT INTO entitlements (subject, plan_id, since) VALUES ('org:o1', 'free', ?1)").bind(T).run();
  });
});
