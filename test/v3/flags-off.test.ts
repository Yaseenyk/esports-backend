import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../../src/index";
import { FLAG_DEFAULTS } from "../../src/flags";
import { api, flagsOn, user } from "./helpers";

const V3_TABLES = ["tournaments", "player_profiles", "player_games", "lft_listings", "lft_applications", "lft_reports", "disputes", "dispute_events", "dispute_evidence", "dispute_evidence_blobs", "v3_result_corrections", "v3_team_captains", "discord_guilds", "discord_outbox", "v3_registration_discord", "discord_link_codes", "v3_discord_settings"];

/** An env whose DB records every statement it is asked to prepare. */
function spyEnv() {
  const sql: string[] = [];
  const DB = new Proxy(env.DB, {
    get(t, p) {
      if (p === "prepare") return (s: string) => { sql.push(s); return t.prepare(s); };
      if (p === "batch") return (stmts: unknown[]) => t.batch(stmts as D1PreparedStatement[]);
      const v = (t as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { env: { ...env, DB } as typeof env, sql };
}

const v3Routes = () => [...new Map(app.routes.filter((r) => r.method !== "ALL" && /^\/(v3\/|public\/(tournaments|players|lft))/.test(r.path)).map((r) => [`${r.method} ${r.path}`, r])).values()];

describe("v3 flags default OFF and a v3 route then answers 404 before any v3 table is touched", () => {
  it("the five flags exist, default false", () => {
    for (const k of ["v3.tournaments", "v3.resume", "v3.lft", "v3.disputes", "v3.discord"] as const) expect(FLAG_DEFAULTS[k], k).toBe(false);
  });

  it("there are v3 routes to test", () => expect(v3Routes().length).toBeGreaterThanOrEqual(35));

  it("every v3 route answers the router's own 404 (anonymous and signed in) and never prepares SQL against a v3 table", async () => {
    await flagsOn();
    const u = await user("Flagless");
    const unknown = await api("/v3/definitely-not-a-route");
    expect(unknown.status).toBe(404);
    for (const r of v3Routes()) {
      const path = r.path.replace(/:[A-Za-z]+/g, "x1");
      for (const token of [undefined, u.token]) {
        const spy = spyEnv();
        const res = await api(path, { method: r.method, token, body: r.method === "GET" || r.method === "DELETE" ? undefined : {}, env: spy.env });
        expect(res.status, `${r.method} ${path}`).toBe(404);
        expect(res.json, `${r.method} ${path}`).toEqual(unknown.json);
        for (const s of spy.sql) for (const t of V3_TABLES) expect(s, `${r.method} ${path} touched ${t}`).not.toMatch(new RegExp(`\\b${t}\\b`));
      }
    }
  });

  it("one feature on does not open the others", async () => {
    await flagsOn("v3.lft");
    const u = await user("OnlyLft");
    expect((await api("/public/lft")).status).toBe(200);
    expect((await api("/public/tournaments")).status).toBe(404);
    expect((await api("/public/players/abc")).status).toBe(404);
    expect((await api("/v3/me/profile", { token: u.token })).status).toBe(404);
    expect((await api("/v3/me/disputes", { token: u.token })).status).toBe(404);
    expect((await api("/v3/me/status", { token: u.token })).status).toBe(200); // shared account facts open with any of resume, lft, disputes
    await flagsOn();
  });

  it("with flags off the worker still works without the v3 tables: account deletion and the cron retention are safe", async () => {
    await flagsOn();
    const r = await api("/");
    expect(r.json).toEqual({ ok: true, name: "esports-api" });
  });
});
