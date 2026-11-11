import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import {
  AUDIT_ACTIONS, AUDIT_ACTION_NAMES, AUDIT_INSERT_SQL, AUDIT_RETENTION_DAYS, audit, auditBinds, auditDropped, auditStmt, auditStmts, purgeAudit, sanitizeMeta,
  type AuditAction,
} from "../src/audit";
import { resetFlagsCache } from "../src/flags";

vi.setConfig({ testTimeout: 120_000 });

const db = env.DB;
const rows = async (where = "1=1", ...b: unknown[]) => (await db.prepare(`SELECT * FROM audit_log WHERE ${where}`).bind(...b).all<Record<string, unknown>>()).results;
const uid = () => `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

describe("registry", () => {
  it("every action fits the column check and the closed list has the blueprint 7.2 actions", () => {
    for (const a of AUDIT_ACTION_NAMES) expect(a.length).toBeLessThanOrEqual(40);
    for (const a of ["org.converted", "member.role_changed", "link.created", "live.published", "checkins.reset", "roster.replaced", "matches.deleted", "admin.flag_set", "event.deleted"]) {
      expect(a in AUDIT_ACTIONS, a).toBe(true);
    }
  });

  it("source scan: every audit( / auditStmt( / auditStmts( call in src/ names a registered action literal, and the INSERT text exists once", () => {
    const files = import.meta.glob("../src/**/*.ts", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
    expect(Object.keys(files).length).toBeGreaterThan(10);
    const bad = scanAuditCalls(files);
    expect(bad).toEqual([]);
    const own = files["../src/audit.ts"] ?? "";
    // The statement text exists twice on purpose: the exported constant (for tests) and the literal at the one prepare() call (the injection guard demands a literal there). They must never drift apart.
    expect(own.match(/INSERT INTO audit_log/g)?.length).toBe(2);
    const inPrepare = own.match(/\.prepare\("(INSERT INTO audit_log[^"]*)"\)/)?.[1];
    expect(inPrepare).toBe(AUDIT_INSERT_SQL);
    for (const [f, text] of Object.entries(files)) if (!f.endsWith("/audit.ts")) expect(/INSERT INTO audit_log|UPDATE audit_log/i.test(text) ? f : "").toBe(""); // immutable by route
  });

  it("the scanner itself catches an unregistered literal", () => {
    expect(scanAuditCalls({ "x.ts": 'await audit(db, { action: "nope.nope", actorType: "user" });' })).toEqual(["x.ts: nope.nope"]);
    expect(scanAuditCalls({ "x.ts": 'auditStmt(db, { action: "event.deleted", actorType: "user" })' })).toEqual([]);
  });
});

function scanAuditCalls(files: Record<string, string>): string[] {
  const bad: string[] = [];
  for (const [f, text] of Object.entries(files)) {
    if (f.endsWith("/audit.ts")) continue;
    for (const m of text.matchAll(/\baudit(?:Stmts?)?\(/g)) {
      const lit = /action:\s*["']([^"']+)["']/.exec(text.slice(m.index!, m.index! + 400));
      if (lit && !(lit[1]! in AUDIT_ACTIONS)) bad.push(`${f}: ${lit[1]}`);
    }
  }
  return bad;
}

describe("meta sanitiser", () => {
  const HOSTILE: unknown[] = [
    { email: "a@b.com", name: "Alice Smith", team: "Alpha Wolves", token: "tok_abc", ip: "1.2.3.4", filename: "photo.png" },
    { count: "5; DROP TABLE audit_log" },
    { __proto__: { polluted: true }, constructor: { x: 1 } },
    "a string", 42, null, undefined, ["count", 3], true,
    Object.assign(Object.create({ count: 3 }), {}), // inherited keys only
    { get count(): number { throw new Error("boom"); } },
  ];

  it("hostile meta gives {} for an action that allows nothing and for one that allows keys", () => {
    for (const h of HOSTILE) {
      expect(sanitizeMeta("event.deleted", h), String(HOSTILE.indexOf(h))).toBe("{}");
      expect(sanitizeMeta("roster.replaced", h), String(HOSTILE.indexOf(h))).toBe("{}");
      expect(sanitizeMeta("link.created", h), String(HOSTILE.indexOf(h))).toBe("{}");
    }
  });

  it("keeps allow-listed keys with the right shape and drops the rest, counting the drops", () => {
    const before = auditDropped();
    expect(sanitizeMeta("roster.replaced", { count: 12, email: "a@b.com" })).toBe('{"count":12}');
    expect(sanitizeMeta("roster.replaced", { count: -1 })).toBe("{}");
    expect(sanitizeMeta("roster.replaced", { count: 1.5 })).toBe("{}");
    expect(sanitizeMeta("link.created", { kind: "gate" })).toBe('{"kind":"gate"}');
    expect(sanitizeMeta("link.created", { kind: "Alpha Wolves" })).toBe("{}");
    expect(sanitizeMeta("admin.flag_set", { flag: "kill.tracking", value: true })).toBe('{"flag":"kill.tracking","value":true}');
    expect(sanitizeMeta("admin.flag_set", { flag: "a b@c.com", value: "yes" })).toBe("{}");
    expect(auditDropped()).toBeGreaterThan(before);
  });

  it("free text, emails and names in ids are refused", () => {
    const b = auditBinds({ action: "member.added", actorType: "user", actorId: "yk@example.com", targetId: "Alice Smith", orgId: "org x", targetType: "Member!", reasonCode: "Because I said so", meta: { role: "admin", note: "x" } });
    expect(b[2]).toBe("");
    expect(b[3]).toBeNull();
    expect(b[6]).toBe("");
    expect(b[7]).toBe("");
    expect(b[8]).toBe("");
    expect(b[9]).toBe('{"role":"admin"}');
  });

  it("an unregistered action throws (a programming error, never silently stored)", () => {
    expect(() => auditBinds({ action: "made.up" as AuditAction, actorType: "user" })).toThrow();
  });
});

describe("audit rows in D1", () => {
  it("auditStmt commits with its mutation in one batch: exactly one row, 2 rows written (row plus idx_audit_org)", async () => {
    const org = `org-${uid()}`;
    const res = await db.batch([
      db.prepare("SELECT 1"),
      auditStmt(db, { action: "org.converted", actorType: "user", actorId: "u-1", orgId: org, targetType: "org", targetId: org, meta: { email: "x@y.z" } }),
    ]);
    const r = await rows("org_id = ?", org);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ action: "org.converted", actor_type: "user", actor_id: "u-1", meta: "{}", reason_code: "" });
    const written = res[1]!.meta.rows_written;
    expect(written).toBe(2); // blueprint 7.1 and dev B-1 (INTEGER PRIMARY KEY, one index)
  });

  it("a failed mutation in the same batch leaves no audit row", async () => {
    const org = `org-${uid()}`;
    await expect(db.batch([
      db.prepare("INSERT INTO audit_log (id, at, actor_type, action) VALUES (NULL, 'x', 'bogus', 'x')"), // violates the CHECK: the whole batch rolls back
      auditStmt(db, { action: "event.deleted", actorType: "user", orgId: org }),
    ])).rejects.toThrow();
    expect(await rows("org_id = ?", org)).toHaveLength(0);
  });

  it("audit.off makes the helper a no-op", async () => {
    const org = `org-${uid()}`;
    await db.prepare("INSERT OR REPLACE INTO flags (key, value, updated_by, updated_at) VALUES ('audit.off', 'true', 't', 't')").run();
    resetFlagsCache(db);
    try {
      await audit(db, { action: "event.deleted", actorType: "user", orgId: org });
      expect(await rows("org_id = ?", org)).toHaveLength(0);
      expect(auditStmts(db, { action: "event.deleted", actorType: "user", orgId: org }, true)).toEqual([]);
    } finally {
      await db.prepare("DELETE FROM flags WHERE key = 'audit.off'").run();
      resetFlagsCache(db);
    }
    await audit(db, { action: "event.deleted", actorType: "user", orgId: org });
    expect(await rows("org_id = ?", org)).toHaveLength(1);
  });

  it("the statement is the one constant INSERT", () => {
    expect(AUDIT_INSERT_SQL).toMatch(/^INSERT INTO audit_log \(at, actor_type, actor_id, org_id, event_id, action, target_type, target_id, reason_code, meta\) VALUES \(\?1/);
  });
});

describe("purge (400 days, 03:00 slot)", () => {
  /** A D1 stand-in that counts the statements it is asked to prepare. */
  function spy() {
    const sql: string[] = [];
    const wrapped = { prepare(s: string) { sql.push(s); return db.prepare(s); } } as unknown as D1Database;
    return { wrapped, sql };
  }
  const old = (n: number, at: string, org: string) =>
    db.batch(Array.from({ length: n }, () => db.prepare(AUDIT_INSERT_SQL).bind(at, "system", "", org, null, "event.deleted", "", "", "", "{}")));

  it("a quiet day costs one oldest-row read and no delete", async () => {
    await db.prepare("DELETE FROM audit_log").run();
    await old(3, new Date().toISOString(), "org-fresh");
    const s = spy();
    expect(await purgeAudit(s.wrapped, Date.now())).toBe(0);
    expect(s.sql).toHaveLength(1);
    expect(s.sql[0]).toMatch(/^SELECT at FROM audit_log ORDER BY id LIMIT 1/);
    expect(await rows()).toHaveLength(3);
  });

  it("deletes rows older than the cutoff in chunks of 500, at most four chunks a call, and keeps newer rows", async () => {
    await db.prepare("DELETE FROM audit_log").run();
    const now = Date.parse("2026-12-01T03:00:00Z");
    const stale = new Date(now - (AUDIT_RETENTION_DAYS + 1) * 86_400_000).toISOString();
    const fresh = new Date(now - 10 * 86_400_000).toISOString();
    await old(60, stale, "org-old");
    await old(5, fresh, "org-new");
    expect(await purgeAudit(db, now)).toBe(60);
    expect(await rows("org_id = 'org-old'")).toHaveLength(0);
    expect(await rows("org_id = 'org-new'")).toHaveLength(5);
    expect(await purgeAudit(db, now)).toBe(0); // nothing due: guard stops it
  });

  it("the daily housekeeping hook calls the purge", async () => {
    const { dailyHousekeeping } = await import("../src/features/housekeeping");
    await db.prepare("DELETE FROM audit_log").run();
    const now = Date.parse("2026-12-01T03:00:00Z");
    await old(2, new Date(now - 500 * 86_400_000).toISOString(), "org-hk");
    await dailyHousekeeping(env, now);
    expect(await rows("org_id = 'org-hk'")).toHaveLength(0);
  });
});
