/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetFlagsCache } from "../../src/flags";
import { HttpError, type Ctx } from "../../src/http";
import { ACCESS_SQL, resolveEvent } from "../../src/policy/access";
import { resetShadowCap, MAX_WRITES_PER_HOUR } from "../../src/policy/shadow";
import { ownerEvent, accessibleEvent } from "../../src/auth";
import { newEvent, newUser } from "../helpers";

// The query exactly as it was before src/policy existed.
const OLD_SQL =
  "SELECT e.*, CASE WHEN e.owner_id = ?1 THEN 'owner' ELSE m.role END AS my_role FROM events e LEFT JOIN event_members m ON m.event_id = e.id AND m.user_id = ?1 WHERE e.id = ?2 AND (e.owner_id = ?1 OR m.user_id = ?1)";

const db = env.DB;
const now = () => new Date().toISOString();

async function setMode(mode: "legacy" | "shadow" | "org" | null) {
  await db.prepare("DELETE FROM flags WHERE key = 'authz.mode'").run();
  if (mode) await db.prepare("INSERT INTO flags (key, value, updated_by, updated_at, note) VALUES ('authz.mode', ?, 'test', ?, '')").bind(JSON.stringify(mode), now()).run();
  resetFlagsCache();
}

interface Probe { c: Ctx; sql: string[]; pending: Promise<unknown>[] }
/** A minimal context: a counting wrapper around the real D1 binding, one signed-in user and a waitUntil that collects promises. */
function probe(userId: string, method = "GET", routePath = "/events/:id/roster", failOrgSql = false): Probe {
  const sql: string[] = [];
  const pending: Promise<unknown>[] = [];
  const wrapped = {
    prepare(q: string) {
      sql.push(q);
      if (failOrgSql && q.includes("organisations")) throw new Error("no such table: organisations");
      return db.prepare(q);
    },
  } as unknown as D1Database;
  const c = {
    env: { DB: wrapped },
    get: (k: string) => (k === "userId" ? userId : undefined),
    req: { method, routePath },
    executionCtx: { waitUntil: (p: Promise<unknown>) => void pending.push(p) },
  } as unknown as Ctx;
  return { c, sql, pending };
}

async function team(adminId: string, memberId?: string) {
  const id = `org-${crypto.randomUUID()}`.slice(0, 40);
  await db.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES (?, 'Club', 'team', 'active', ?)").bind(id, now()).run();
  await db.prepare("INSERT INTO org_members (org_id, user_id, role, added_by, added_at) VALUES (?, ?, 'admin', ?, ?)").bind(id, adminId, adminId, now()).run();
  if (memberId) await db.prepare("INSERT INTO org_members (org_id, user_id, role, added_by, added_at) VALUES (?, ?, 'member', ?, ?)").bind(id, memberId, adminId, now()).run();
  return id;
}
const rehome = (evId: string, orgId: string | null) => db.prepare("UPDATE events SET org_id = ? WHERE id = ?").bind(orgId, evId).run();
const status = async (p: Promise<unknown>) => { try { await p; return 200; } catch (e) { return e instanceof HttpError ? e.status : 500; } };

beforeEach(async () => {
  await db.prepare("CREATE TABLE IF NOT EXISTS metrics_daily (day TEXT NOT NULL, name TEXT NOT NULL CHECK (length(name) <= 24), d1 TEXT NOT NULL DEFAULT '' CHECK (length(d1) <= 20), n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, name, d1)) WITHOUT ROWID").run();
  await db.prepare("DELETE FROM metrics_daily WHERE name = 'authz_mismatch'").run();
  resetShadowCap();
});
afterEach(async () => {
  await setMode(null);
  vi.restoreAllMocks();
});

describe("legacy mode (the default) is today's behaviour", () => {
  it("answers exactly what the old query answered, for owner, editor, viewer and stranger", async () => {
    const o = await newUser(); const e = await newUser(); const v = await newUser(); const s = await newUser();
    const ev = await newEvent(o.token);
    await db.prepare("INSERT INTO event_members (event_id, user_id, role, added_at) VALUES (?, ?, 'editor', ?), (?, ?, 'viewer', ?)").bind(ev.id, e.id, now(), ev.id, v.id, now()).run();
    for (const [u, want] of [[o, "owner"], [e, "editor"], [v, "viewer"], [s, null]] as const) {
      const old = await db.prepare(OLD_SQL).bind(u.id, ev.id).first<Record<string, unknown>>();
      const p = probe(u.id);
      if (want === null) {
        expect(old).toBeNull();
        expect(await status(resolveEvent(p.c, ev.id))).toBe(404);
      } else {
        expect(await resolveEvent(p.c, ev.id)).toEqual(old);
        expect(old!.my_role).toBe(want);
      }
    }
  });

  it("an org-only member is a 404 in legacy mode, even when the event has an organisation", async () => {
    const o = await newUser(); const m = await newUser();
    const ev = await newEvent(o.token);
    await rehome(ev.id, await team(o.id, m.id));
    expect(await status(resolveEvent(probe(m.id).c, ev.id))).toBe(404);
  });

  it("a missing, unreadable or invalid flag is legacy", async () => {
    const o = await newUser();
    const ev = await newEvent(o.token);
    await db.prepare("INSERT INTO flags (key, value, updated_by, updated_at) VALUES ('authz.mode', '\"banana\"', 't', ?)").bind(now()).run();
    resetFlagsCache();
    const p = probe(o.id);
    expect((await resolveEvent(p.c, ev.id)).my_role).toBe("owner");
    expect(p.sql).not.toContain(ACCESS_SQL);
  });

  it("costs one query once the flag cache is warm, and touches no organisation table", async () => {
    const o = await newUser();
    const ev = await newEvent(o.token);
    await resolveEvent(probe(o.id).c, ev.id); // warms the per-isolate flag cache (keyed by db object: use the same probe db below)
    const p = probe(o.id);
    await resolveEvent(p.c, ev.id);
    // the probe wraps a new object, so its own cache is cold: at most the flag read plus the access query, never more
    expect(p.sql.length).toBeLessThanOrEqual(2);
    expect(p.sql.filter((q) => /organisations|org_members/.test(q))).toEqual([]);
  });
});

describe("shadow mode never changes the result and costs no extra query", () => {
  it("enforces legacy and adds exactly zero queries over legacy mode (same single access query, no mismatch)", async () => {
    const o = await newUser();
    const ev = await newEvent(o.token);
    const dbKey = probe(o.id);
    // one shared wrapped db so the flag cache is warm for both measurements
    const run = async (mode: "legacy" | "shadow") => {
      await setMode(mode);
      await resolveEvent(dbKey.c, ev.id); // warm
      dbKey.sql.length = 0;
      const row = await resolveEvent(dbKey.c, ev.id);
      return { n: dbKey.sql.length, row };
    };
    const legacy = await run("legacy");
    const shadow = await run("shadow");
    expect(legacy.n).toBe(1);
    expect(shadow.n).toBe(1);
    expect(shadow.row.my_role).toBe("owner");
    expect(dbKey.pending.length).toBe(0); // nothing written when there is no mismatch
    expect(Object.keys(shadow.row)).not.toContain("is_creator");
    expect(Object.keys(shadow.row)).not.toContain("guest_role");
  });

  it("a removed club member who created the event: legacy owner is enforced, the mismatch is logged and counted", async () => {
    await setMode("shadow");
    const creator = await newUser(); const admin = await newUser();
    const ev = await newEvent(creator.token);
    await rehome(ev.id, await team(admin.id)); // creator is not a member of the team organisation
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = probe(creator.id, "GET", "/events/:id/roster");
    const row = await resolveEvent(p.c, ev.id);
    await Promise.all(p.pending);
    expect(row.my_role).toBe("owner"); // result unchanged
    expect(warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(warn.mock.calls[0]![0] as string);
    expect(line).toMatchObject({ authz_mismatch: true, legacy: "owner", org: null, route: "GET roster", user: creator.id, event: ev.id });
    expect(JSON.stringify(line)).not.toMatch(/@/); // ids only, no email
    const n = await db.prepare("SELECT SUM(n) AS n FROM metrics_daily WHERE name = 'authz_mismatch' AND d1 = 'GET roster'").first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("an org member with no legacy access is a 404 in shadow, and counted", async () => {
    await setMode("shadow");
    const o = await newUser(); const m = await newUser();
    const ev = await newEvent(o.token);
    await rehome(ev.id, await team(o.id, m.id));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = probe(m.id, "PUT", "/events/:id");
    expect(await status(resolveEvent(p.c, ev.id))).toBe(404);
    await Promise.all(p.pending);
    const n = await db.prepare("SELECT SUM(n) AS n FROM metrics_daily WHERE name = 'authz_mismatch'").first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("caps counter writes at 20 per isolate-hour so a systematic bug cannot flood D1", async () => {
    await setMode("shadow");
    const creator = await newUser(); const admin = await newUser();
    const ev = await newEvent(creator.token);
    await rehome(ev.id, await team(admin.id));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (let i = 0; i < MAX_WRITES_PER_HOUR + 10; i++) {
      const p = probe(creator.id);
      await resolveEvent(p.c, ev.id);
      await Promise.all(p.pending);
    }
    expect(warn).toHaveBeenCalledTimes(MAX_WRITES_PER_HOUR + 10); // every line is logged
    const n = await db.prepare("SELECT SUM(n) AS n FROM metrics_daily WHERE name = 'authz_mismatch'").first<{ n: number }>();
    expect(n!.n).toBe(MAX_WRITES_PER_HOUR); // but only 20 writes
  });

  it("falls back to the legacy answer when the organisation tables cannot be read", async () => {
    await setMode("shadow");
    const o = await newUser();
    const ev = await newEvent(o.token);
    const p = probe(o.id, "GET", "/events/:id", true);
    expect((await resolveEvent(p.c, ev.id)).my_role).toBe("owner");
  });

  it("a missing metrics table does not break the request", async () => {
    await setMode("shadow");
    await db.prepare("DROP TABLE metrics_daily").run();
    const creator = await newUser(); const admin = await newUser();
    const ev = await newEvent(creator.token);
    await rehome(ev.id, await team(admin.id));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const p = probe(creator.id);
    expect((await resolveEvent(p.c, ev.id)).my_role).toBe("owner");
    await Promise.all(p.pending);
  });
});

describe("org mode", () => {
  it("org admin acts as owner, org member as editor, stranger and other-organisation members get 404", async () => {
    await setMode("org");
    const creator = await newUser(); const admin = await newUser(); const member = await newUser(); const other = await newUser(); const stranger = await newUser();
    const ev = await newEvent(creator.token);
    await rehome(ev.id, await team(admin.id, member.id));
    await team(other.id); // another organisation
    expect((await resolveEvent(probe(admin.id).c, ev.id)).my_role).toBe("owner");
    expect((await resolveEvent(probe(member.id).c, ev.id)).my_role).toBe("editor");
    expect(await status(resolveEvent(probe(other.id).c, ev.id))).toBe(404);
    expect(await status(resolveEvent(probe(stranger.id).c, ev.id))).toBe(404);
    // a removed club member who created the event loses access on the very next request
    expect(await status(resolveEvent(probe(creator.id).c, ev.id))).toBe(404);
  });

  it("an event with org_id NULL is never a 404 for its creator (a dangling org_id is covered by the pure tests: the foreign key forbids it in D1)", async () => {
    await setMode("org");
    const o = await newUser();
    const ev = await newEvent(o.token);
    expect((await resolveEvent(probe(o.id).c, ev.id)).my_role).toBe("owner");
  });

  it("the highest source wins: a viewer grant never lowers an org role; a guest editor plus org admin is owner", async () => {
    await setMode("org");
    const creator = await newUser(); const member = await newUser(); const admin = await newUser();
    const ev = await newEvent(creator.token);
    await rehome(ev.id, await team(admin.id, member.id));
    await db.prepare("INSERT INTO event_members (event_id, user_id, role, added_at) VALUES (?, ?, 'viewer', ?), (?, ?, 'editor', ?)").bind(ev.id, member.id, now(), ev.id, admin.id, now()).run();
    expect((await resolveEvent(probe(member.id).c, ev.id)).my_role).toBe("editor");
    expect((await resolveEvent(probe(admin.id).c, ev.id)).my_role).toBe("owner");
  });

  it("the wrappers keep the viewer method gate and the owner-only gate", async () => {
    await setMode("org");
    const creator = await newUser(); const admin = await newUser(); const member = await newUser(); const viewer = await newUser();
    const ev = await newEvent(creator.token);
    await rehome(ev.id, await team(admin.id, member.id));
    await db.prepare("INSERT INTO event_members (event_id, user_id, role, added_at) VALUES (?, ?, 'viewer', ?)").bind(ev.id, viewer.id, now()).run();
    expect(await status(accessibleEvent(probe(viewer.id, "PUT").c, ev.id))).toBe(403);
    expect(await status(accessibleEvent(probe(viewer.id, "GET").c, ev.id))).toBe(200);
    expect(await status(ownerEvent(probe(member.id, "DELETE").c, ev.id))).toBe(403);
    expect(await status(ownerEvent(probe(admin.id, "DELETE").c, ev.id))).toBe(200);
  });

  it("never writes: no organisation, membership or event row changes on any read", async () => {
    await setMode("org");
    const o = await newUser();
    const ev = await newEvent(o.token);
    // create now fills org_id (dual-write); an event from an old Worker has none, and a read must not fill it
    await db.prepare("UPDATE events SET org_id = NULL WHERE id = ?").bind(ev.id).run();
    const p = probe(o.id);
    await resolveEvent(p.c, ev.id);
    expect(p.sql.filter((q) => /^\s*(INSERT|UPDATE|DELETE)/i.test(q))).toEqual([]);
    const row = await db.prepare("SELECT org_id FROM events WHERE id = ?").bind(ev.id).first<{ org_id: string | null }>();
    expect(row!.org_id).toBeNull(); // not healed on read (blueprint A-17)
  });
});
