/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetFlagsCache } from "../../src/flags";
import { resetShadowCap } from "../../src/policy/shadow";
import { newEvent, newUser } from "../helpers";
import { callDirect as call } from "../golden/direct";

// A small smoke per authz.mode (blueprint 6.3 item 7, dev B-17): the full matrix runs once in the default mode, this proves each mode answers the
// same HTTP statuses for today's principals. Requests go straight to the app so the flag cache this file resets is the one the app reads.
vi.setConfig({ testTimeout: 60_000 });
const now = () => new Date().toISOString();

async function setMode(mode: "legacy" | "shadow" | "org" | null) {
  await env.DB.prepare("DELETE FROM flags WHERE key = 'authz.mode'").run();
  if (mode) await env.DB.prepare("INSERT INTO flags (key, value, updated_by, updated_at, note) VALUES ('authz.mode', ?, 'test', ?, '')").bind(JSON.stringify(mode), now()).run();
  resetFlagsCache();
  resetShadowCap();
}
afterEach(async () => { await setMode(null); });

async function world() {
  const o = await newUser(); const e = await newUser(); const v = await newUser(); const s = await newUser();
  const ev = await newEvent(o.token);
  await env.DB.prepare("INSERT INTO event_members (event_id, user_id, role, added_at) VALUES (?, ?, 'editor', ?), (?, ?, 'viewer', ?)").bind(ev.id, e.id, now(), ev.id, v.id, now()).run();
  return { o, e, v, s, ev };
}

for (const mode of [null, "legacy", "shadow", "org"] as const) {
  describe(`smoke: authz.mode = ${mode ?? "(no flag row)"}`, () => {
    it("owner, editor, viewer and stranger get today's statuses", async () => {
      await setMode(mode);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const w = await world();
      const path = `/events/${w.ev.id}`;
      expect((await call(path, { token: w.o.token })).status).toBe(200);
      expect((await call(path, { token: w.e.token })).status).toBe(200);
      expect((await call(path, { token: w.v.token })).status).toBe(200);
      expect((await call(path, { token: w.s.token })).status).toBe(404);
      expect((await call(path, { token: w.s.token })).json).toEqual({ error: "Event not found" });
      // viewer writes are 403, editor cannot delete, owner can reach the owner-only list
      expect((await call(path, { method: "PUT", token: w.v.token, body: {} })).status).toBe(403);
      expect((await call(path, { method: "DELETE", token: w.e.token })).status).toBe(403);
      expect((await call(`${path}/members`, { token: w.e.token })).status).toBe(403);
      expect((await call(`${path}/members`, { token: w.o.token })).status).toBe(200);
      expect((await call(`${path}/passes`, { token: w.v.token })).status).toBe(403);
      expect((await call(`${path}/roster`, { token: w.e.token })).status).toBe(200);
      // removing a member revokes access at once
      expect((await call(`${path}/members/${w.e.id}`, { method: "DELETE", token: w.o.token })).status).toBe(200);
      expect((await call(`${path}/roster`, { token: w.e.token })).status).toBe(404);
      expect((await call(path, { method: "DELETE", token: w.o.token })).status).toBe(200);
      expect((await call(path, { token: w.o.token })).status).toBe(404);
    });
  });
}

describe("smoke: org mode with a team organisation", () => {
  it("a club admin and member reach the event; a removed creator does not", async () => {
    await setMode("org");
    const creator = await newUser(); const admin = await newUser(); const member = await newUser();
    const ev = await newEvent(creator.token);
    const org = `org-${crypto.randomUUID()}`.slice(0, 40);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES (?, 'Club', 'team', 'active', ?)").bind(org, now()),
      env.DB.prepare("INSERT INTO org_members (org_id, user_id, role, added_by, added_at) VALUES (?, ?, 'admin', ?, ?), (?, ?, 'member', ?, ?)").bind(org, admin.id, admin.id, now(), org, member.id, admin.id, now()),
      env.DB.prepare("UPDATE events SET org_id = ? WHERE id = ?").bind(org, ev.id),
    ]);
    const path = `/events/${ev.id}`;
    expect((await call(`${path}/members`, { token: admin.token })).status).toBe(200); // admin acts as owner
    expect((await call(`${path}/roster`, { token: member.token })).status).toBe(200); // member acts as editor
    expect((await call(`${path}/members`, { token: member.token })).status).toBe(403);
    expect((await call(path, { token: creator.token })).status).toBe(404); // creator is not a member of the club
    // the same world in shadow: legacy is enforced, so the creator still gets in
    await setMode("shadow");
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await call(path, { token: creator.token })).status).toBe(200);
    expect((await call(path, { token: member.token })).status).toBe(404);
  });
});
