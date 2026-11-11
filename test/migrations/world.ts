/// <reference types="vite/client" />
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import invariantsSql from "./invariants.sql?raw";

/** Helpers for the migration project (vitest.migrations.config.ts). No migration is applied for you: call `applyUpTo` / `applyAll`. */

export const db = (): D1Database => env.DB;

const num = (m: D1Migration) => Number(/^(\d+)/.exec(m.name)?.[1] ?? "0");

/** Every file of migrations/ with a number below `n` (so applyUpTo(35) is "0001 to 0034", the production state before this phase). */
export async function applyUpTo(n: number): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.filter((m) => num(m) < n));
}

/** Every file of migrations/ (already applied files are skipped by the runner). The gated data steps in migrations-deferred/ are NOT included. */
export async function applyAll(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
}

/** The statements of the gated backfill (migrations-deferred/0042_*). Run them with `runStatements`, never with applyD1Migrations (that would record it as applied and skip the second run). */
export function backfillStatements(): string[] {
  const m = (env as unknown as { TEST_DEFERRED: D1Migration[] }).TEST_DEFERRED.find((x) => x.name.startsWith("0042"));
  if (!m) throw new Error("migrations-deferred/0042 backfill not found");
  return m.queries;
}

/** Runs each statement; returns the `changes` of each (0 means it touched nothing). */
export async function runStatements(statements: string[]): Promise<number[]> {
  const out: number[] = [];
  for (const q of statements) out.push((await env.DB.prepare(q).run()).meta.changes ?? 0);
  return out;
}

/** The first five invariants of test/migrations/invariants.sql (the file the runbook uses), as { sql, n }. PRAGMA lines are handled by foreignKeyViolations. */
export async function invariants(): Promise<number[]> {
  const stmts = invariantsSql
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.toUpperCase().startsWith("SELECT"));
  const out: number[] = [];
  for (const s of stmts) out.push((await env.DB.prepare(s).first<{ "COUNT(*)": number }>())!["COUNT(*)"]);
  return out;
}

export async function foreignKeyViolations(): Promise<unknown[]> {
  return (await env.DB.prepare("PRAGMA foreign_key_check").all()).results;
}

export async function one<T = number>(sql: string, ...binds: unknown[]): Promise<T> {
  const r = await env.DB.prepare(sql).bind(...binds).first<Record<string, T>>();
  return Object.values(r!)[0] as T;
}

const T0 = "2026-01-01T00:00:00.000Z";

export const ids = {
  alice: "u-alice", bob: "u-bob", carol: "u-carol", dave: "u-dave", longname: "u-long",
  teamOrg: "org-3f6c1a52-7f0e-4c1c-9a57-0a1b2c3d4e5f",
};

const user = (id: string, name: string) =>
  env.DB.prepare("INSERT INTO users (id, email, name, pw_hash, pw_salt, pw_iter, created_at) VALUES (?1, ?2, ?3, 'h', 's', 1000, ?4)").bind(id, `${id}@example.com`, name, T0);

const event = (id: string, owner: string, slug: string) =>
  env.DB.prepare("INSERT INTO events (id, owner_id, slug, name, signing_secret, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'sec', ?5, ?5)").bind(id, owner, slug, `Event ${id}`, T0);

/** The production world as of 0034 (what an old Worker wrote): users, events owned, guests. Needs the schema up to 0034 only. */
export async function seedLegacyWorld(): Promise<void> {
  await env.DB.batch([
    user(ids.alice, "Alice O'Neil"), // an apostrophe: the personal organisation name is built by string concatenation
    user(ids.bob, "Bob"),
    user(ids.carol, "Carol"),
    user(ids.dave, "Dave (never made an event)"),
    user(ids.longname, "L".repeat(80)), // the longest a name can be after substr(...,60) plus the suffix must stay inside CHECK (80)
    event("e1", ids.alice, "cup-1"),
    event("e2", ids.alice, "cup-2"),
    event("e3", ids.bob, "cup-1"),
    event("e4", ids.bob, "cup-2"),
    event("e5", ids.carol, "cup-1"),
    env.DB.prepare("INSERT INTO event_members (event_id, user_id, role, added_at) VALUES ('e4', ?1, 'editor', ?2)").bind(ids.carol, T0),
    env.DB.prepare("INSERT INTO event_members (event_id, user_id, role, added_at) VALUES ('e5', ?1, 'viewer', ?2)").bind(ids.dave, T0),
    env.DB.prepare("INSERT INTO teams (event_id, id, name) VALUES ('e1', 't1', 'Team One')"),
  ]);
}

/** A team organisation (needs 0036 to 0038): alice admin, bob member, plus one event homed in it. */
export async function seedTeamOrg(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES (?1, 'Club One', 'team', 'active', ?2)").bind(ids.teamOrg, T0),
    env.DB.prepare("INSERT INTO org_members (org_id, user_id, role, added_by, added_at) VALUES (?1, ?2, 'admin', ?2, ?3)").bind(ids.teamOrg, ids.alice, T0),
    env.DB.prepare("INSERT INTO org_members (org_id, user_id, role, added_by, added_at) VALUES (?1, ?2, 'member', ?3, ?4)").bind(ids.teamOrg, ids.bob, ids.alice, T0),
    env.DB.prepare("INSERT INTO events (id, owner_id, slug, name, signing_secret, created_at, updated_at, org_id, created_by) VALUES ('e6', ?1, 'club-cup', 'Club cup', 'sec', ?2, ?2, ?3, ?1)").bind(ids.alice, T0, ids.teamOrg),
  ]);
}

/** A snapshot of everything the backfill can change, for "twice changes nothing" assertions. */
export async function snapshot() {
  const orgs = (await env.DB.prepare("SELECT id, name, kind, status, created_at FROM organisations ORDER BY id").all()).results;
  const members = (await env.DB.prepare("SELECT org_id, user_id, role, added_by, added_at FROM org_members ORDER BY org_id, user_id").all()).results;
  const evs = (await env.DB.prepare("SELECT id, owner_id, org_id, created_by FROM events ORDER BY id").all()).results;
  return { orgs, members, evs };
}
