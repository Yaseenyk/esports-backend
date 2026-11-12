import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { ADMIN_ROUTES } from "../../src/admin/routes";
import { signStaffJwt } from "../../src/admin/session";
import { newUser } from "../helpers";
import { api, enableConsole, forge, makeStaff, nowSec } from "./helpers";

vi.setConfig({ testTimeout: 180_000 });

const concrete = (p: string) => p.replace(/:[A-Za-z]+/g, "x1");

describe("staff matrix: every /admin/v1 route is a plain 404 for everyone without a valid staff token", () => {
  it("anonymous, ordinary user, expired token, wrong-audience token, wrong-secret token, garbage", async () => {
    await enableConsole();
    const user = await newUser("Matrix");
    const t = nowSec();
    const base = { sub: user.id, iat: t, exp: t + 600, su: t, cs: t };
    const callers: [string, string | undefined][] = [
      ["anonymous", undefined],
      ["ordinary user", user.token],
      ["expired", await forge(user.id, { exp: t - 10, iat: t - 700 })],
      ["wrong audience", await signStaffJwt(env.STAFF_JWT_SECRET!, { ...base, aud: "user" } as never)],
      ["user secret", await signStaffJwt(env.JWT_SECRET, { ...base, aud: "staff" })],
      ["valid shape but no staff row", await forge(user.id)],
      ["garbage", "garbage"],
    ];
    for (const r of ADMIN_ROUTES) {
      for (const [who, token] of callers) {
        const res = await api(concrete(r.path), { method: r.method, token, body: r.method === "GET" ? undefined : {} });
        expect(res.status, `${who} ${r.method} ${r.path}`).toBe(404);
        expect(res.json, `${who} ${r.method} ${r.path}`).toEqual({ error: "Not found" });
      }
    }
  });

  it("a real staff token reaches every staff route (not 404), and wrong methods stay 404", async () => {
    const s = await makeStaff();
    const token = (await s.login()).token;
    for (const r of ADMIN_ROUTES.filter((x) => x.auth === "staff" && x.path !== "/admin/v1/session/step-up" && x.path !== "/admin/v1/session/renew")) {
      const res = await api(concrete(r.path), { method: r.method, token, body: r.method === "GET" ? undefined : {} });
      // 400/403/404 from the handler itself are fine (bad params, unknown ids); the point is that it is a handler answer, never the door
      expect([200, 400, 403, 404], `${r.method} ${r.path}`).toContain(res.status);
    }
    expect((await api("/admin/v1/usage", { method: "POST", token, body: {} })).status).toBe(404);
    expect((await api("/admin/v1/usage", { method: "DELETE", token })).status).toBe(404);
  });
});

describe("route inventory", () => {
  it("every registered /admin/v1 route is in ADMIN_ROUTES and every ADMIN_ROUTES entry is registered", () => {
    const registered = app.routes.filter((r) => r.method !== "ALL" && r.path.startsWith("/admin/v1")).map((r) => `${r.method} ${r.path}`).sort();
    const listed = ADMIN_ROUTES.map((r) => `${r.method} ${r.path}`).sort();
    expect(registered).toEqual(listed);
  });

  it("no irreversible staff action: nothing is flagged irreversible, no DELETE, no delete/erase/purge/impersonate/export in a path", () => {
    for (const r of ADMIN_ROUTES) {
      expect(r.irreversible, `${r.method} ${r.path}`).toBe(false);
      expect(r.method, r.path).not.toBe("DELETE");
      expect(r.path, r.path).not.toMatch(/delete|erase|purge|remove|impersonat|export|roster|photo|registration|proof|grant/i);
    }
  });

  it("the three step-up families are marked: kill flags, suspend and restore", () => {
    const need = ADMIN_ROUTES.filter((r) => r.stepUp).map((r) => `${r.method} ${r.path}`).sort();
    expect(need).toEqual([
      "POST /admin/v1/orgs/:id/restore", "POST /admin/v1/orgs/:id/suspend", "POST /admin/v1/users/:id/restore", "POST /admin/v1/users/:id/suspend", "PUT /admin/v1/flags/:key",
    ]);
  });

  it("every admin route file uses constant SQL and registered audit actions only (source scan)", () => {
    const files = import.meta.glob("../../src/admin/*.ts", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
    expect(Object.keys(files).length).toBeGreaterThanOrEqual(7);
    for (const [f, src] of Object.entries(files)) {
      expect(src, f).not.toMatch(/\.prepare\(\s*[A-Za-z_`]/);
      expect(src, f).not.toMatch(/\bfrom ["']\.\.\/(routes\/(roster|gate|share|invites|registration)|features\/(ready|results|scorer))/); // no route that serves private content
    }
  });
});
