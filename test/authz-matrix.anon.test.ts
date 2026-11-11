/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { call } from "./helpers";
import { ACCOUNT, D, GATE, PUBLIC, ROUTES, world } from "./golden/rows";

// Anonymous sweep: route inventory plus anon, garbage-token, gate-key and malformed-header on every route. (split from authz-matrix.test.ts; rows live in test/golden/rows.ts)
// One row per route in src/routes. `owner` = owner-only. `viewerBlocked` = a GET a view-only member still may not do (403); other GETs give a viewer 200.
// Feature modules add their rows in test/features/<id>.routes.ts (see test/features/README.md).
vi.setConfig({ testTimeout: 120_000 });
describe("route inventory", () => {
  it("every registered route is covered by this matrix or explicitly public", () => {
    const covered = new Set<string>([
      ...ROUTES.map((r) => `${r.method} ${r.path({ ev: ":id", pid: ":personId", kid: ":keyId", iid: ":inviteId", sid: ":sid", rid: ":rid", uid: ":userId", mid: ":mid" }).replace(`/${D}`, "/:x")}`),
    ]);
    // normalise the matrix paths to the registered pattern shapes by only comparing method + segment count + literal prefix
    const shape = (m: string, p: string) => `${m} ${p.split("/").map((s) => (s.startsWith(":") ? ":" : s)).join("/")}`;
    const matrixShapes = new Set<string>([
      ...[...covered].map((k) => { const [m, p] = k.split(" "); return shape(m!, p!.replace(/\/nope/g, "/:x")); }),
      ...ACCOUNT.map((r) => shape(r.method, r.path)),
      ...GATE.map((r) => shape(r.method, r.path.replace("/ALP-002", "/:personId"))),
      ...[...PUBLIC].map((k) => { const [m, p] = k.split(" "); return shape(m!, p!); }),
    ]);
    const missing: string[] = [];
    for (const r of app.routes) {
      if (r.method === "ALL") continue;
      const k = shape(r.method, r.path);
      if (!matrixShapes.has(k)) missing.push(`${r.method} ${r.path}`);
    }
    expect(missing).toEqual([]);
  });

  it("every routeRules key of a feature module is a registered route", async () => {
    const mods = import.meta.glob("../src/features/*.ts", { eager: true }) as Record<string, { routeRules?: Record<string, unknown> }>;
    const registered = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
    for (const [file, m] of Object.entries(mods)) {
      for (const key of Object.keys(m.routeRules ?? {})) expect(registered.has(key), `${file}: ${key}`).toBe(true);
    }
  });

  it("every non-public route refuses an anonymous caller with 401 (even for ids that do not exist)", async () => {
    for (const r of app.routes) {
      if (r.method === "ALL" || PUBLIC.has(`${r.method} ${r.path}`)) continue;
      const path = r.path.replace(/:[A-Za-z]+/g, "x1");
      const res = await call(path, { method: r.method, body: r.method === "GET" ? undefined : {} });
      expect(res.status, `${r.method} ${path}`).toBe(401);
    }
  });
});

describe("authorization matrix", () => {
  it("unauthenticated, garbage tokens and gate keys on user routes are all 401", async () => {
    const w = await world();
    const all = [...ROUTES.map((r) => ({ method: r.method, path: r.path(w.ctx), body: r.body })), ...ACCOUNT];
    for (const r of all) {
      const send = (extra: object) => call(r.path, { method: r.method, body: r.body ?? (r.method === "GET" ? undefined : {}), ...extra });
      expect((await send({})).status, `anon ${r.method} ${r.path}`).toBe(401);
      expect((await send({ token: "garbage" })).status, `garbage ${r.method} ${r.path}`).toBe(401);
      expect((await send({ gate: w.key.key })).status, `gate key ${r.method} ${r.path}`).toBe(401);
      expect((await send({ headers: { authorization: `Basic ${w.o.token}` } })).status, `basic ${r.method} ${r.path}`).toBe(401);
    }
  });
});
