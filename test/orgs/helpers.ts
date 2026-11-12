import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { resetFlagsCache, type FlagKey } from "../../src/flags";
import { callDirect } from "../golden/direct";
import { newEvent, newUser } from "../helpers";

export const call = callDirect;
export const db = env.DB;
export const now = () => new Date().toISOString();

/** Sets (or, with undefined, removes) a flag row and forgets the isolate's 10 second cache so the app sees it at once. */
export async function setFlag(key: FlagKey, value: unknown): Promise<void> {
  await env.DB.prepare("DELETE FROM flags WHERE key = ?1").bind(key).run();
  if (value !== undefined) await env.DB.prepare("INSERT INTO flags (key, value, updated_by, updated_at, note) VALUES (?1, ?2, 'test', ?3, '')").bind(key, JSON.stringify(value), now()).run();
  resetFlagsCache();
}

export const teamOn = () => setFlag("orgs.team", true);
export const teamOff = () => setFlag("orgs.team", undefined);

export async function verified(name = "Tester") {
  const u = await newUser(name);
  await env.DB.prepare("UPDATE users SET email_verified_at = ?1 WHERE id = ?2").bind(now(), u.id).run();
  return u;
}

/** A user who has converted their personal organisation into a club (flag orgs.team must be on). */
export async function club(name = "Club Admin", clubName = "Pune Esports Club") {
  const u = await verified(name);
  const r = await call("/orgs/convert", { token: u.token, body: { name: clubName } });
  expect(r.status, r.text).toBe(200);
  return { ...u, orgId: r.json.id as string };
}

/** Invites `email` into the org with `role`, returns the clear token. */
export async function invite(orgId: string, token: string, email: string, role: "admin" | "member" = "member"): Promise<{ id: string; token: string }> {
  const r = await call(`/orgs/${orgId}/invitations`, { token, body: { email, role } });
  expect(r.status, r.text).toBe(201);
  return { id: r.json.id, token: r.json.token };
}

/** A verified user who has joined the club through an invitation. */
export async function joined(org: { orgId: string; token: string }, role: "admin" | "member" = "member", name = "Helper") {
  const u = await verified(name);
  const inv = await invite(org.orgId, org.token, u.email, role);
  const r = await call("/me/invitations/accept", { token: u.token, body: { token: inv.token } });
  expect(r.status, r.text).toBe(200);
  return u;
}

export { newEvent, newUser };

export const one = async <T = number>(sql: string, ...binds: unknown[]): Promise<T> => {
  const r = await env.DB.prepare(sql).bind(...binds).first<Record<string, T>>();
  return Object.values(r!)[0] as T;
};
