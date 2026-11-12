import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { FLAG_DEFAULTS, resetFlagsCache } from "../../src/flags";
import { KILL_KEYS, killGate, type KillKey } from "../../src/admin/kill";
import { SETTABLE_FLAGS } from "../../src/admin/flags";
import type { AppBindings } from "../../src/types";
import { api, auditRows, db, forge, makeStaff, nowSec } from "./helpers";

vi.setConfig({ testTimeout: 180_000 });

// A stand-in for a public write route: the later sweep will put exactly these two lines into the real route files.
const t = new Hono<AppBindings>();
t.post("/w/:k", async (c) => (await killGate(c, c.req.param("k") as KillKey)) ?? c.json({ ok: true }));
t.get("/r/:k", async (c) => (await killGate(c, c.req.param("k") as KillKey)) ?? c.json({ ok: true }));
t.get("/rr/:k", async (c) => (await killGate(c, c.req.param("k") as KillKey, { read: true })) ?? c.json({ ok: true }));
const write = (k: string) => t.request(`/w/${k}`, { method: "POST" }, env);

async function put(token: string, key: string, body: unknown) {
  return api(`/admin/v1/flags/${key}`, { method: "PUT", token, body });
}

describe("GET /admin/v1/flags", () => {
  it("lists every known flag with its effective value, default and rules", async () => {
    const s = await makeStaff();
    const r = await api("/admin/v1/flags", { token: (await s.login()).token });
    expect(r.status).toBe(200);
    expect(r.json.flags.map((f: { key: string }) => f.key).sort()).toEqual(Object.keys(FLAG_DEFAULTS).sort());
    for (const f of r.json.flags) {
      expect(Object.keys(f).sort()).toEqual(["default", "key", "reasonCode", "settable", "stepUp", "updatedAt", "updatedBy", "value"]);
      expect(f.settable).toBe((SETTABLE_FLAGS as readonly string[]).includes(f.key));
      expect(f.stepUp).toBe((KILL_KEYS as readonly string[]).includes(f.key));
    }
  });
});

describe("every kill key: step-up, 503 on the next write, recovery, audit", () => {
  for (const key of KILL_KEYS) {
    it(key, async () => {
      const s = await makeStaff();
      const fresh = (await s.login()).token;
      const stale = await forge(s.id, { su: nowSec() - 3600, cs: nowSec() - 3600 });
      expect((await write(key)).status).toBe(200); // before: carries on

      // needs a step-up code and a reason
      const noStep = await put(stale, key, { value: true, reasonCode: "security" });
      expect(noStep.status).toBe(403);
      expect(noStep.json.code).toBe("step_up_required");
      expect((await write(key)).status).toBe(200);
      expect((await put(fresh, key, { value: true })).status).toBe(400);
      expect((await put(fresh, key, { value: "yes", reasonCode: "security" })).status).toBe(400);
      expect((await put(fresh, key, { value: true, reasonCode: "made-up" })).status).toBe(400);
      expect((await write(key)).status).toBe(200);

      // on: the very next write request is 503 (no cache wait), reads stay up
      const on = await put(fresh, key, { value: true, reasonCode: "security" });
      expect(on.status).toBe(200);
      expect(on.json).toEqual({ ok: true, key, value: true, changed: true });
      const res = await write(key);
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "This feature is temporarily switched off", code: "temporarily_disabled", retryAfter: 300 });
      expect(res.headers.get("retry-after")).toBe("300");
      expect((await t.request(`/r/${key}`, {}, env)).status).toBe(200);

      // a second identical PUT changes nothing and audits nothing
      expect((await put(fresh, key, { value: true, reasonCode: "security" })).json.changed).toBe(false);

      // off: recovers on the next request
      expect((await put(fresh, key, { value: false, reasonCode: "other" })).status).toBe(200);
      expect((await write(key)).status).toBe(200);

      const rows = await auditRows("admin.flag_set", key);
      expect(rows.length).toBe(2);
      expect(rows.map((x) => x.reason_code)).toEqual(["security", "other"]);
      expect(rows.every((x) => x.actor_type === "staff" && x.actor_id === s.id)).toBe(true);
      expect(JSON.parse(rows[0]!.meta as string)).toEqual({ flag: key, value: true });
      const stored = await db.prepare("SELECT value, updated_by FROM flags WHERE key = ?1").bind(key).first<{ value: string; updated_by: string }>();
      expect(stored).toEqual({ value: "false", updated_by: s.id });
    });
  }
});

describe("kill.public_writes is the master valve; reads use the cache only when asked", () => {
  it("stops every key that guards a public write route, not mail or tracking", async () => {
    const s = await makeStaff();
    const tok = (await s.login()).token;
    expect((await put(tok, "kill.public_writes", { value: true, reasonCode: "other" })).status).toBe(200);
    for (const k of ["kill.public_forms", "kill.directory", "kill.team_pages", "kill.uploads", "kill.public_writes"]) expect((await write(k)).status, k).toBe(503);
    for (const k of ["kill.mail", "kill.tracking"]) expect((await write(k)).status, k).toBe(200);
    expect((await put(tok, "kill.public_writes", { value: false, reasonCode: "other" })).status).toBe(200);
    expect((await write("kill.uploads")).status).toBe(200);
  });

  it("{ read: true } blocks a GET (10 s cache: the staff route clears this isolate's cache, so it bites at once here)", async () => {
    const s = await makeStaff();
    const tok = (await s.login()).token;
    resetFlagsCache(db);
    expect((await t.request("/rr/kill.directory", {}, env)).status).toBe(200);
    await put(tok, "kill.directory", { value: true, reasonCode: "abuse" });
    expect((await t.request("/rr/kill.directory", {}, env)).status).toBe(503);
    expect((await t.request("/r/kill.directory", {}, env)).status).toBe(200); // plain read route without the option
    await put(tok, "kill.directory", { value: false, reasonCode: "other" });
    expect((await t.request("/rr/kill.directory", {}, env)).status).toBe(200);
  });

  it("an unreadable or garbage flag row means not killed", async () => {
    await db.prepare("INSERT INTO flags (key, value, updated_by, updated_at, note) VALUES ('kill.mail', 'not json', 'x', 'x', '') ON CONFLICT (key) DO UPDATE SET value = 'not json'").run();
    expect((await write("kill.mail")).status).toBe(200);
    await db.prepare("UPDATE flags SET value = 'false' WHERE key = 'kill.mail'").run();
  });
});

describe("what staff may and may not set", () => {
  it("shed.tracking and takedown.enforce need no step-up; authz.mode, orgs.team, audit.off, admin.enabled and unknown keys are 404", async () => {
    const s = await makeStaff();
    const stale = await forge(s.id, { su: nowSec() - 3600, cs: nowSec() - 60 });
    await s.login();
    for (const k of ["shed.tracking", "takedown.enforce"]) {
      expect((await put(stale, k, { value: true, reasonCode: "other" })).status, k).toBe(200);
      expect((await put(stale, k, { value: false, reasonCode: "other" })).status, k).toBe(200);
    }
    for (const k of ["authz.mode", "orgs.team", "audit.off", "admin.enabled", "nope"]) {
      expect((await put(stale, k, { value: true, reasonCode: "other" })).status, k).toBe(404);
    }
    const mode = await db.prepare("SELECT value FROM flags WHERE key = 'authz.mode'").first();
    expect(mode).toBeNull();
  });
});
