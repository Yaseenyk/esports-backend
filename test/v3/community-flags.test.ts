import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import app from "../../src/index";
import { FLAG_DEFAULTS } from "../../src/flags";
import { COMMUNITY_ADMIN_ROUTES } from "../../src/v3/routes/community-admin";
import { makeStaff } from "../admin/helpers";
import { api, communityOn, user } from "./community-helpers";

const TABLES = ["calendar_entries", "calendar_entry_actions", "organiser_ratings", "organiser_rating_reports", "organiser_rating_actions"];

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

const COMMUNITY = /^\/(public\/community|public\/calendar|v3\/me\/calendar|v3\/orgs\/:orgId\/calendar|v3\/calendar|public\/tournaments\/:slug\/trust|v3\/tournaments\/:slug\/trust|v3\/me\/trust|v3\/trust)/;
const routes = () => [...new Map(app.routes.filter((r) => r.method !== "ALL" && COMMUNITY.test(r.path)).map((r) => [`${r.method} ${r.path}`, r])).values()];

describe("community flags default OFF; every community route then answers the unknown-route 404 and touches no community table", () => {
  it("the two flags exist and default false", () => {
    expect(FLAG_DEFAULTS["v3.calendar"]).toBe(false);
    expect(FLAG_DEFAULTS["v3.trust"]).toBe(false);
  });

  it("finds every community route", () => expect(routes().length).toBe(13));

  it("anonymous and signed in: 404 identical to an unknown route, and no SQL names a community table", async () => {
    await communityOn("v3.tournaments", "v3.disputes"); // other v3 features on must not open these
    const u = await user("FlagOff");
    const unknown = await api("/v3/definitely-not-a-route");
    for (const r of routes()) {
      const path = r.path.replace(/:[A-Za-z]+/g, "x1");
      for (const token of [undefined, u.token]) {
        const spy = spyEnv();
        const res = await api(path, { method: r.method, token, body: r.method === "GET" || r.method === "DELETE" ? undefined : {}, env: spy.env });
        expect(res.status, `${r.method} ${path}`).toBe(404);
        expect(res.json, `${r.method} ${path}`).toEqual(unknown.json);
        for (const s of spy.sql) for (const t of TABLES) expect(s, `${r.method} ${path} touched ${t}`).not.toMatch(new RegExp(`\\b${t}\\b`));
      }
    }
  });

  it("staff routes answer 404 with the flags off, even to staff", async () => {
    await communityOn("admin.enabled");
    const staff = await makeStaff();
    const token = (await staff.login()).token;
    for (const r of COMMUNITY_ADMIN_ROUTES) {
      const res = await api(r.path.replace(/:[A-Za-z]+/g, "x1"), { method: r.method, token, body: r.method === "POST" ? { reason: "spam" } : undefined });
      expect(res.status, `${r.method} ${r.path}`).toBe(404);
    }
  });

  it("the shared account facts (18+) open with either community flag, so a player can confirm 18+ for the trust form", async () => {
    await communityOn("v3.trust");
    const u = await user("Facts", false);
    expect((await api("/v3/me/status", { token: u.token })).status).toBe(200);
    await communityOn();
    expect((await api("/v3/me/status", { token: u.token })).status).toBe(404);
  });
});
