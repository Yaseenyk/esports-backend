import { audit } from "../audit";
import { randomToken } from "../crypto";
import { HttpError, ID_RE, nowIso, rateLimitSoft, readJson, str, type Ctx } from "../http";
import { hashToken } from "../links";
import { API_KEYS_MAX, can, subjectOf } from "../plans";

/**
 * /me/api-keys (Phase 6). User token only. Scope is fixed to 'read'. The key is returned ONCE by POST and stored only as SHA-256 (links.ts pattern).
 * Max 5 active keys per user (also enforced inside the INSERT, so two parallel creates cannot reach 6). Revoking keeps the row (revoked_at).
 */
const KEY_SHAPE = /^ehk_[A-Za-z0-9_-]{32}$/;
export const isKeyShape = (k: string): boolean => KEY_SHAPE.test(k);

interface KeyRow { id: string; label: string; hint: string; scope: string; created_at: string; last_used_at: string | null }
const out = (r: KeyRow) => ({ id: r.id, label: r.label, hint: r.hint, scope: r.scope, createdAt: r.created_at, lastUsedAt: r.last_used_at });

export async function listKeys(c: Ctx): Promise<Response> {
  const rows = await c.env.DB.prepare("SELECT id, label, hint, scope, created_at, last_used_at FROM api_keys WHERE user_id = ?1 AND revoked_at IS NULL ORDER BY created_at, id LIMIT 10").bind(c.get("userId")).all<KeyRow>();
  c.header("cache-control", "private, no-store");
  return c.json({ keys: rows.results.map(out), max: API_KEYS_MAX });
}

export async function createKey(c: Ctx): Promise<Response> {
  const uid = c.get("userId");
  if (!can(subjectOf("user", uid), "api_keys")) throw new HttpError(403, "Not part of your plan");
  rateLimitSoft(c, "apikey.write", 20, 3600);
  const label = str((await readJson(c, 2_000)).label, "label", 1, 40);
  const key = `ehk_${randomToken(24)}`;
  const id = crypto.randomUUID();
  const at = nowIso();
  const r = await c.env.DB.prepare(
    "INSERT INTO api_keys (id, user_id, label, key_hash, hint, scope, created_at) SELECT ?1, ?2, ?3, ?4, ?5, 'read', ?6 WHERE (SELECT COUNT(*) FROM api_keys WHERE user_id = ?2 AND revoked_at IS NULL) < ?7",
  ).bind(id, uid, label, await hashToken(key), key.slice(0, 8), at, API_KEYS_MAX).run();
  if (!(r.meta.changes ?? 0)) throw new HttpError(409, `You can have ${API_KEYS_MAX} active keys. Revoke one first.`, { code: "api_key_limit" });
  await audit(c.env.DB, { action: "apikey.created", actorType: "user", actorId: uid, targetType: "api_key", targetId: id });
  c.header("cache-control", "no-store");
  return c.json({ id, label, hint: key.slice(0, 8), scope: "read", createdAt: at, lastUsedAt: null, key, note: "Copy this key now. It is shown only once." }, 201);
}

export async function revokeKey(c: Ctx): Promise<Response> {
  const uid = c.get("userId");
  const id = c.req.param("id")!;
  if (!ID_RE.test(id)) throw new HttpError(404, "Not found");
  const r = await c.env.DB.prepare("UPDATE api_keys SET revoked_at = ?1 WHERE id = ?2 AND user_id = ?3 AND revoked_at IS NULL").bind(nowIso(), id, uid).run();
  if (!(r.meta.changes ?? 0)) throw new HttpError(404, "Not found");
  await audit(c.env.DB, { action: "apikey.revoked", actorType: "user", actorId: uid, targetType: "api_key", targetId: id });
  return c.json({ ok: true });
}
