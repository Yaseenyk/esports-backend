/**
 * Offline pair comparison (blueprint 16.3 steps 5 to 8). For every (user, event) pair, for every route class, the legacy decision must equal the org decision.
 * Run it on a fresh, sanitised export of the production database. Nothing is sent anywhere, the export is opened read only (a .sql dump is loaded into memory).
 *
 *   node --experimental-strip-types scripts/pair-compare.ts <export.sql | export.sqlite>   [--sample 5000] [--no-backfill] [--json]
 *   node --experimental-strip-types scripts/pair-compare.ts --selftest
 *
 * What it prints, in this order:
 *   1. PREDICTED BACKFILL: users and events the backfill would touch and the rows it would write against the 100,000 daily cap (30 percent rule, dev-review-r2 3.3).
 *   2. If the export has no organisations yet, the new schema (0035 to 0039) and the backfill (migrations-deferred/0042) are applied to the IN-MEMORY copy,
 *      so the comparison is of the state the cut-over will produce. --no-backfill compares the export exactly as it is (use it for the re-run of step 8).
 *   3. The six invariants (0 expected).
 *   4. The comparison. Exit code 0 only if there are 0 mismatches and every invariant is 0.
 *
 * Decision rules are the table of blueprint 5.2, written here independently of src/policy (the oracle). When src/policy/decide.ts exists, run both
 * (test/policy covers the in-repo fixture world; this script covers the real data).
 *   legacy: creator is owner, else the guest role, else 404.
 *   org:    org_id NULL: the legacy rule. Else the higher of org role (admin=owner, member=editor) and guest role. The creator branch is ignored when org_id is set.
 *           Nothing applies: 404.
 * Route classes: read (GET), write (any other method), owner_read (GET, owner only, for example the members list), owner_write (owner only, for example delete).
 * The access query is the real SQL of 5.2, run for every pair where it can return a row, plus a random sample of the unrelated pairs (must return none).
 */
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Role = "owner" | "editor" | "viewer" | null;
type Decision = "200" | "403" | "404";
interface AccessRow { is_creator: number; org_id: string | null; org_kind?: string | null; org_role: string | null; guest_role: string | null }

export const ROUTE_CLASSES = ["read", "write", "owner_read", "owner_write"] as const;
type RouteClass = (typeof ROUTE_CLASSES)[number];

const RANK: Record<string, number> = { viewer: 1, editor: 2, owner: 3 };
const best = (a: Role, b: Role): Role => ((RANK[a ?? ""] ?? 0) >= (RANK[b ?? ""] ?? 0) ? a : b);

export function legacyRole(r: AccessRow): Role {
  if (r.is_creator) return "owner";
  return (r.guest_role as Role) ?? null;
}

export function orgRole(r: AccessRow): Role {
  if (r.org_id === null) return legacyRole(r);
  const fromOrg: Role = r.org_role === "admin" ? "owner" : r.org_role === "member" ? "editor" : null;
  return best(fromOrg, (r.guest_role as Role) ?? null);
}

export function decide(role: Role, cls: RouteClass): Decision {
  if (role === null) return "404";
  const write = cls === "write" || cls === "owner_write";
  if (role === "viewer" && write) return "403"; // accessibleEvent: a viewer may only GET
  if ((cls === "owner_read" || cls === "owner_write") && role !== "owner") return "403"; // ownerEvent
  return "200";
}

const ACCESS_SQL =
  "SELECT e.org_id AS org_id, o.kind AS org_kind, om.role AS org_role, em.role AS guest_role, CASE WHEN e.owner_id = :u THEN 1 ELSE 0 END AS is_creator " +
  "FROM events e LEFT JOIN organisations o ON o.id = e.org_id " +
  "LEFT JOIN org_members om ON om.org_id = e.org_id AND om.user_id = :u " +
  "LEFT JOIN event_members em ON em.event_id = e.id AND em.user_id = :u " +
  "WHERE e.id = :e AND (e.owner_id = :u OR om.user_id IS NOT NULL OR em.user_id IS NOT NULL)";

const INVARIANTS: [string, string][] = [
  ["1 user without personal org admin membership", "SELECT COUNT(*) AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = 'org-' || u.id AND m.user_id = u.id AND m.role = 'admin')"],
  ["2 event without org_id", "SELECT COUNT(*) AS n FROM events WHERE org_id IS NULL"],
  ["3 personal-org event whose creator is not a member", "SELECT COUNT(*) AS n FROM events e WHERE e.org_id = 'org-' || e.owner_id AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = e.org_id AND m.user_id = e.owner_id)"],
  ["4 orphan personal organisation", "SELECT COUNT(*) AS n FROM organisations o WHERE o.kind = 'personal' AND NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = o.id)"],
  ["5 event pointing at a missing organisation", "SELECT COUNT(*) AS n FROM events e WHERE e.org_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM organisations o WHERE o.id = e.org_id)"],
];

const migrationsDir = fileURLToPath(new URL("../migrations/", import.meta.url));
const deferredDir = fileURLToPath(new URL("../migrations-deferred/", import.meta.url));
const num = (n: string) => Number(/^(\d+)/.exec(n)?.[1] ?? "-1");

function count(db: DatabaseSync, sql: string, ...p: (string | number)[]): number {
  const r = db.prepare(sql).get(...p) as { n: number } | undefined;
  return r ? Number(r.n) : 0;
}
const hasTable = (db: DatabaseSync, t: string) => count(db, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?", t) > 0;

export function openExport(path: string): DatabaseSync {
  if (/\.sql$/i.test(path)) {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec(readFileSync(path, "utf8"));
    return db;
  }
  // A SQLite file is opened read only and copied into memory (tables, rows and indexes), so the in-memory migration never touches the file.
  const src = new DatabaseSync(path, { readOnly: true });
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  const objs = src.prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END").all() as { type: string; name: string; sql: string }[];
  for (const o of objs) if (o.type === "table") db.exec(o.sql);
  for (const o of objs) {
    if (o.type !== "table") continue;
    const cols = (src.prepare(`SELECT name FROM pragma_table_info('${o.name.replace(/'/g, "''")}')`).all() as { name: string }[]).map((c) => `"${c.name}"`);
    if (!cols.length) continue;
    const ins = db.prepare(`INSERT INTO "${o.name}" (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    for (const row of src.prepare(`SELECT ${cols.join(",")} FROM "${o.name}"`).all()) ins.run(...(Object.values(row) as never[]));
  }
  for (const o of objs) if (o.type !== "table") db.exec(o.sql);
  src.close();
  return db;
}

export interface Prediction { users: number; events: number; orgsToCreate: number; membersToCreate: number; eventsToFill: number; rows: number; pctOfCap: number }

/** Rows the backfill would write, counting an index entry as one row (dev-review-r2 3.3: about 3 per user plus 3 per event). Needs the organisations tables only if they exist. */
export function predictBackfill(db: DatabaseSync): Prediction {
  const users = count(db, "SELECT COUNT(*) AS n FROM users");
  const events = count(db, "SELECT COUNT(*) AS n FROM events");
  const withOrgs = hasTable(db, "organisations") && hasTable(db, "org_members");
  const orgsToCreate = withOrgs ? count(db, "SELECT COUNT(*) AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM organisations o WHERE o.id = 'org-' || u.id)") : users;
  const membersToCreate = withOrgs ? count(db, "SELECT COUNT(*) AS n FROM users u WHERE NOT EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = 'org-' || u.id AND m.user_id = u.id)") : users;
  const hasCol = count(db, "SELECT COUNT(*) AS n FROM pragma_table_info('events') WHERE name = 'org_id'") > 0;
  const eventsToFill = hasCol ? count(db, "SELECT COUNT(*) AS n FROM events WHERE org_id IS NULL") : events;
  const rows = orgsToCreate * 1 + membersToCreate * 2 + eventsToFill * 3;
  return { users, events, orgsToCreate, membersToCreate, eventsToFill, rows, pctOfCap: Math.round((rows / 100_000) * 1000) / 10 };
}

/** Applies 0035 to 0039 and the gated backfill to an in-memory copy (never to a file opened read only). */
export function migrateInMemory(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql") && num(f) >= 35 && num(f) < 42).sort()) {
    const name = /^\d+_(.+)\.sql$/.exec(f)?.[1] ?? f;
    if (name === "events_org_id" && count(db, "SELECT COUNT(*) AS n FROM pragma_table_info('events') WHERE name = 'org_id'") > 0) continue;
    if (name === "events_created_by" && count(db, "SELECT COUNT(*) AS n FROM pragma_table_info('events') WHERE name = 'created_by'") > 0) continue;
    db.exec(readFileSync(migrationsDir + f, "utf8"));
  }
  const bf = readdirSync(deferredDir).find((f) => f.startsWith("0042"));
  if (!bf) throw new Error("migrations-deferred/0042 not found");
  db.exec(readFileSync(deferredDir + bf, "utf8"));
}

export interface Mismatch { user: string; event: string; cls: RouteClass; legacy: Decision; org: Decision; reason: string }
export interface CompareResult { pairsTotal: number; pairsRelated: number; pairsSampledUnrelated: number; decisions: number; mismatches: Mismatch[]; teamDivergences: number; unrelatedLeaks: string[]; byReason: Record<string, number> }

function why(r: AccessRow, l: Role, o: Role): string {
  if (r.is_creator && r.org_id !== null && o === null) return "creator is not a member of the event's organisation";
  if (r.org_id === null) return "org_id NULL but decisions differ (bug)";
  if (l === null && o !== null) return "org member without legacy access";
  if (l !== null && o === null) return "legacy access, no org access";
  return `role differs (legacy ${l}, org ${o})`;
}

export function compare(db: DatabaseSync, sample = 5000): CompareResult {
  const users = (db.prepare("SELECT id FROM users ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  const events = (db.prepare("SELECT id FROM events ORDER BY id").all() as { id: string }[]).map((r) => r.id);
  const access = db.prepare(ACCESS_SQL);
  const related = db
    .prepare(
      "SELECT e.id AS event_id, e.owner_id AS user_id FROM events e UNION SELECT event_id, user_id FROM event_members UNION SELECT e.id, m.user_id FROM events e JOIN org_members m ON m.org_id = e.org_id",
    )
    .all() as { event_id: string; user_id: string }[];
  const relSet = new Set(related.map((p) => `${p.user_id}\u0000${p.event_id}`));
  const out: CompareResult = { pairsTotal: users.length * events.length, pairsRelated: related.length, pairsSampledUnrelated: 0, decisions: 0, mismatches: [], teamDivergences: 0, unrelatedLeaks: [], byReason: {} };

  for (const p of related) {
    const row = access.get({ u: p.user_id, e: p.event_id }) as AccessRow | undefined;
    const base: AccessRow = row ?? { is_creator: 0, org_id: null, org_role: null, guest_role: null };
    const l = row ? legacyRole(base) : null;
    const o = row ? orgRole(base) : null;
    for (const cls of ROUTE_CLASSES) {
      out.decisions++;
      const dl = decide(l, cls), dorg = decide(o, cls);
      if (dl !== dorg && base.org_kind === "team") out.teamDivergences++; // intended: a team organisation grants what legacy cannot (Phase 2a); not a cut-over defect
      else if (dl !== dorg) {
        const reason = why(base, l, o);
        out.mismatches.push({ user: p.user_id, event: p.event_id, cls, legacy: dl, org: dorg, reason });
        out.byReason[reason] = (out.byReason[reason] ?? 0) + 1;
      }
    }
  }

  // Unrelated pairs: the access query must return nothing (both modes answer 404). A deterministic sample, because U x E can be tens of millions.
  let seed = 123456789;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff);
  if (users.length && events.length) {
    for (let i = 0; i < sample; i++) {
      const u = users[Math.floor(rnd() * users.length)]!, e = events[Math.floor(rnd() * events.length)]!;
      if (relSet.has(`${u}\u0000${e}`)) continue;
      out.pairsSampledUnrelated++;
      if (access.get({ u, e })) out.unrelatedLeaks.push(`${u} / ${e}`);
    }
  }
  return out;
}

function report(db: DatabaseSync, opts: { sample: number; backfill: boolean; json: boolean }): number {
  const pred = predictBackfill(db);
  const lines: string[] = [];
  const say = (s: string) => lines.push(s);
  say("PREDICTED BACKFILL (printed first, nothing has been changed)");
  say(`  users ${pred.users}, events ${pred.events}`);
  say(`  organisations to create ${pred.orgsToCreate} (1 row each), memberships to create ${pred.membersToCreate} (2 rows each), events to fill ${pred.eventsToFill} (3 rows each)`);
  say(`  predicted rows written ${pred.rows} = ${pred.pctOfCap}% of the 100,000 daily cap ${pred.pctOfCap > 30 ? "  ** OVER 30%: split the backfill over two days **" : "(under the 30% rule)"}`);
  say("  run just after 00:00 UTC on a day with no event. The one-off index build (0039) costs about one more row per event and is already behind you.");

  const hasOrgCols = hasTable(db, "organisations") && count(db, "SELECT COUNT(*) AS n FROM pragma_table_info('events') WHERE name = 'org_id'") > 0;
  const empty = hasOrgCols ? count(db, "SELECT COUNT(*) AS n FROM organisations") === 0 : true;
  if (opts.backfill && empty) {
    migrateInMemory(db);
    say("  (the export has no organisations: 0035 to 0039 and the backfill were applied to the in-memory copy, so what follows is the state the cut-over will produce)");
  } else {
    say(opts.backfill ? "  (the export already has organisations: compared as it is)" : "  (--no-backfill: compared as it is)");
  }

  if (!hasTable(db, "org_members") || !hasTable(db, "organisations")) {
    console.log(lines.join("\n"));
    console.error("The export has no organisations tables and --no-backfill was given: nothing to compare. Drop --no-backfill, or apply 0035 to 0039 first.");
    return 2;
  }
  say("\nINVARIANTS (all must be 0)");
  let bad = 0;
  for (const [label, sql] of INVARIANTS) {
    const n = count(db, sql);
    bad += n;
    say(`  ${n === 0 ? "ok  " : "FAIL"} ${label}: ${n}`);
  }

  const cmp = compare(db, opts.sample);
  say("\nCOMPARISON legacy vs org");
  say(`  users x events = ${cmp.pairsTotal} pairs. Pairs where the access query can return a row: ${cmp.pairsRelated} (each checked on ${ROUTE_CLASSES.length} route classes = ${cmp.decisions} decisions).`);
  say(`  All other pairs are 404 in both modes by the WHERE clause; ${cmp.pairsSampledUnrelated} of them were run through the real SQL as a check, leaks: ${cmp.unrelatedLeaks.length}.`);
  say(`  MISMATCHES: ${cmp.mismatches.length}`);
  const teams = count(db, "SELECT COUNT(*) AS n FROM organisations WHERE kind = 'team'");
  if (teams) say(`  NOTE: ${teams} team organisation(s) exist (expected 0 before Phase 2a). ${cmp.teamDivergences} decisions in their events differ from legacy by design and are not counted as mismatches.`);
  for (const [k, v] of Object.entries(cmp.byReason)) say(`    ${v} x ${k}`);
  for (const m of cmp.mismatches.slice(0, 20)) say(`    user ${m.user} event ${m.event} ${m.cls}: legacy ${m.legacy}, org ${m.org} (${m.reason})`);
  const ok = cmp.mismatches.length === 0 && cmp.unrelatedLeaks.length === 0 && bad === 0;
  say(`\nRESULT: ${ok ? "PASS (0 mismatches, invariants 0)" : "FAIL"}`);
  if (opts.json) console.log(JSON.stringify({ prediction: pred, invariantViolations: bad, comparison: cmp, ok }));
  else console.log(lines.join("\n"));
  return ok ? 0 : 1;
}

/** Builds a small world with every kind of pair, on all repo migrations, then proves the script both passes and fails when it should. */
function selftest(): number {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) db.exec(readFileSync(migrationsDir + f, "utf8"));
  const U = (id: string, name: string) => db.prepare("INSERT INTO users (id, email, name, pw_hash, pw_salt, pw_iter, created_at) VALUES (?, ?, ?, 'h', 's', 1, '2026-01-01T00:00:00Z')").run(id, `${id}@x.y`, name);
  const E = (id: string, owner: string, slug: string) => db.prepare("INSERT INTO events (id, owner_id, slug, name, signing_secret, created_at, updated_at) VALUES (?, ?, ?, 'n', 's', 'now', 'now')").run(id, owner, slug);
  for (const [id, n] of [["a", "Ann"], ["b", "Bo O'Hara"], ["c", "Cy"], ["d", "Di"]]) U(id!, n!);
  E("e1", "a", "s1"); E("e2", "a", "s2"); E("e3", "b", "s1"); E("e4", "b", "s2");
  db.prepare("INSERT INTO event_members (event_id, user_id, role, added_at) VALUES ('e4', 'c', 'editor', 'now'), ('e3', 'd', 'viewer', 'now')").run();
  // a legacy world, pre-backfill
  const pre = predictBackfill(db);
  if (pre.users !== 4 || pre.eventsToFill !== 4 || pre.rows !== 4 + 8 + 12) { console.log("selftest FAIL: prediction", pre); return 1; }
  migrateInMemory(db);
  // a team organisation: a admin, b member, event e5 homed in it (creator a)
  db.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES ('org-team1', 'Club', 'team', 'active', 'now')").run();
  db.prepare("INSERT INTO org_members (org_id, user_id, role, added_by, added_at) VALUES ('org-team1', 'a', 'admin', 'a', 'now'), ('org-team1', 'b', 'member', 'a', 'now')").run();
  db.prepare("INSERT INTO events (id, owner_id, slug, name, signing_secret, created_at, updated_at, org_id, created_by) VALUES ('e5', 'a', 's5', 'n', 's', 'now', 'now', 'org-team1', 'a')").run();
  const good = compare(db, 200);
  if (good.teamDivergences === 0) { console.log("selftest FAIL: team organisation divergence not recognised"); return 1; }
  if (good.mismatches.length !== 0 || good.unrelatedLeaks.length !== 0) { console.log("selftest FAIL: clean world mismatched", good.mismatches); return 1; }
  // inject the bug the comparison exists to catch: a creator who is no longer a member of the organisation of their event
  db.prepare("DELETE FROM org_members WHERE org_id = 'org-a' AND user_id = 'a'").run();
  const bad = compare(db, 200);
  if (bad.mismatches.length === 0 || !bad.mismatches.some((m) => m.event === "e1" && m.reason.startsWith("creator"))) { console.log("selftest FAIL: injected mismatch not found"); return 1; }
  console.log(`selftest ok: clean world 0 mismatches over ${good.decisions} decisions; injected fault found (${bad.mismatches.length} decisions differ, first: ${bad.mismatches[0]!.reason})`);
  return 0;
}

const argv = process.argv.slice(2);
if (process.argv[1]?.endsWith("pair-compare.ts")) {
  if (argv.includes("--selftest")) process.exit(selftest());
  const si = argv.indexOf("--sample");
  const file = argv.find((a, i) => !a.startsWith("--") && !(si >= 0 && i === si + 1));
  if (!file) {
    console.error("usage: node --experimental-strip-types scripts/pair-compare.ts <export.sql|export.sqlite> [--sample N] [--no-backfill] [--json] | --selftest");
    process.exit(2);
  }
  process.exit(report(openExport(file), { sample: si >= 0 ? Number(argv[si + 1]) : 5000, backfill: !argv.includes("--no-backfill"), json: argv.includes("--json") }));
}
