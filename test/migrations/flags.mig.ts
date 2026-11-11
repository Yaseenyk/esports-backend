import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { FLAG_CACHE_MS, FLAG_DEFAULTS, getAuthzMode, getFlag, getFlagFresh, getFlags, parseFlagValue, resetFlagsCache } from "../../src/flags";
import { applyAll, applyUpTo } from "./world";

const put = (key: string, value: string) =>
  env.DB.prepare("INSERT INTO flags (key, value, updated_by, updated_at) VALUES (?1, ?2, 'test', 'now') ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, value).run();

describe("flags", () => {
  it("answers the safe defaults when the table does not exist yet, and never throws", async () => {
    await applyUpTo(35); // schema of production today: no flags table
    expect(await getFlags(env.DB, 1)).toEqual(FLAG_DEFAULTS);
    expect(await getAuthzMode(env.DB)).toBe("legacy");
    expect(await getFlagFresh(env.DB, "kill.mail")).toBe(false);
    expect(FLAG_DEFAULTS["authz.mode"]).toBe("legacy");
    expect(Object.entries(FLAG_DEFAULTS).filter(([k, v]) => k !== "authz.mode" && v !== false)).toEqual([]); // everything else is off
  });

  it("reads stored values, ignores invalid ones, caches for 10 s, and a fresh read sees a change at once", async () => {
    await applyAll();
    resetFlagsCache();
    expect(await getFlags(env.DB, 1_000)).toEqual(FLAG_DEFAULTS); // empty table: defaults
    resetFlagsCache();
    await put("authz.mode", '"shadow"');
    await put("orgs.team", "true");
    await put("kill.mail", '"yes"'); // wrong type: ignored
    await put("authz.mode.typo", "true"); // unknown key: ignored
    const f = await getFlags(env.DB, 2_000);
    expect(f["authz.mode"]).toBe("shadow");
    expect(f["orgs.team"]).toBe(true);
    expect(f["kill.mail"]).toBe(false);

    await put("authz.mode", '"org"');
    expect(await getFlag(env.DB, "authz.mode", 2_000 + FLAG_CACHE_MS - 1)).toBe("shadow"); // still cached
    expect(await getFlag(env.DB, "authz.mode", 2_000 + FLAG_CACHE_MS)).toBe("org"); // expired
    await put("authz.mode", '"legacy"');
    expect(await getFlagFresh(env.DB, "authz.mode")).toBe("legacy"); // fresh read: no cache

    await put("authz.mode", '"admin"'); // not a mode
    expect(await getFlagFresh(env.DB, "authz.mode")).toBe("legacy");
    await put("authz.mode", "not json");
    expect(await getFlagFresh(env.DB, "authz.mode")).toBe("legacy");
    resetFlagsCache();
    expect((await getFlags(env.DB, 99_000))["authz.mode"]).toBe("legacy");
  });

  it("validates values per key", () => {
    expect(parseFlagValue("authz.mode", '"org"')).toBe("org");
    expect(parseFlagValue("authz.mode", "true")).toBeUndefined();
    expect(parseFlagValue("kill.uploads", "true")).toBe(true);
    expect(parseFlagValue("kill.uploads", "1")).toBeUndefined();
  });
});
