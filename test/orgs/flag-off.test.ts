import app from "../../src/index";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call, newUser, teamOff, teamOn, verified } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
afterEach(teamOff);

// Every org route, with the method it is registered under. /me/context, /me/export and /me/deletion-preview are NOT here: they always work.
const GATED: [string, string][] = [
  ["POST", "/me/invitations/accept"],
  ["GET", "/orgs/convert/preview"],
  ["POST", "/orgs/convert"],
  ["GET", "/orgs/x1"],
  ["GET", "/orgs/x1/members"],
  ["PUT", "/orgs/x1/members/x2"],
  ["DELETE", "/orgs/x1/members/x2"],
  ["POST", "/orgs/x1/invitations"],
  ["GET", "/orgs/x1/invitations"],
  ["DELETE", "/orgs/x1/invitations/x2"],
  ["GET", "/orgs/x1/events"],
  ["GET", "/orgs/x1/audit"],
  ["GET", "/orgs/x1/analytics"],
];

describe("flag orgs.team off (the default)", () => {
  it("the gated list covers every org route the router registers", () => {
    const registered = app.routes.filter((r) => /^\/(orgs|me\/invitations)/.test(r.path) && r.method !== "ALL").map((r) => `${r.method} ${r.path.replace(/:[A-Za-z]+/g, "x")}`);
    const listed = GATED.map(([m, p]) => `${m} ${p.replace(/\/x\d/g, "/x")}`);
    expect([...new Set(registered)].sort()).toEqual([...new Set(listed)].sort());
  });

  it("every org route answers byte for byte like an unknown route, for anonymous and signed-in callers", async () => {
    const u = await verified();
    for (const [method, path] of GATED) {
      for (const token of [undefined, u.token, "garbage"]) {
        const probe = await call(path, { method, token, body: method === "GET" || method === "DELETE" ? undefined : {} });
        const unknown = await call(`/definitely-not-a-route${path}`, { method, token, body: method === "GET" || method === "DELETE" ? undefined : {} });
        expect(probe.status, `${method} ${path}`).toBe(404);
        expect(probe.text, `${method} ${path}`).toBe(unknown.text);
        expect(probe.headers.get("content-type")).toBe(unknown.headers.get("content-type"));
      }
    }
  });

  it("/me/context, /me/export and /me/deletion-preview work for a signed-in user and still need a token", async () => {
    const u = await newUser("Ctx User");
    for (const [method, path] of [["GET", "/me/context"], ["POST", "/me/export"], ["GET", "/me/deletion-preview"]] as const) {
      expect((await call(path, { method })).status, `${path} anon`).toBe(401);
      expect((await call(path, { method, token: "garbage" })).status, `${path} garbage`).toBe(401);
      expect((await call(path, { method, token: u.token })).status, `${path} user`).toBe(200);
    }
    const ctx = (await call("/me/context", { token: u.token })).json;
    expect(Object.keys(ctx).sort()).toEqual(["features", "orgs", "staff", "user"]);
    expect(ctx.features).toEqual({ teamOrgs: false });
    expect(ctx.staff).toBeNull();
    expect(ctx.user).toEqual({ id: u.id, email: u.email, name: "Ctx User", emailVerified: false, verifyRequired: false });
    expect(ctx.orgs).toHaveLength(1);
    expect(ctx.orgs[0]).toMatchObject({ id: `org-${u.id}`, kind: "personal", role: "admin", status: "active" });
    expect(ctx.orgs[0].caps).toEqual(["org.read", "org.people.manage", "org.events.create", "org.audit.read"]);
  });

  it("flag on: the same routes now exist (members of nothing get 404 from the route itself, not from the gate)", async () => {
    await teamOn();
    const u = await verified();
    const r = await call("/orgs/not-mine", { token: u.token });
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "Not found" });
    expect((await call("/orgs/convert/preview", { token: u.token })).status).toBe(200);
    expect((await call("/me/context", { token: u.token })).json.features).toEqual({ teamOrgs: true });
    // anonymous callers are asked to sign in once the flag is on
    expect((await call("/orgs/not-mine")).status).toBe(401);
  });

  it("with the flag off, adding a guest by email still works exactly as before (instant add, 404 for an unknown address)", async () => {
    const o = await verified();
    const g = await newUser("Guest");
    const ev = (await call("/events", { token: o.token, body: { name: "Cup" } })).json;
    const ok = await call(`/events/${ev.id}/members`, { token: o.token, body: { email: g.email, role: "viewer" } });
    expect(ok.status).toBe(201);
    expect(ok.json).toMatchObject({ userId: g.id, role: "viewer" });
    const unknown = await call(`/events/${ev.id}/members`, { token: o.token, body: { email: "nobody-here@example.com", role: "viewer" } });
    expect(unknown.status).toBe(404);
  });
});
