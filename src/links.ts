// S7: link tokens (pass share links, team invites, registration forms) are never stored in clear.
// A token is random (24 bytes, as before). The database keeps
//   token_hash = base64url(SHA-256(token))   -> lookup through a unique index (the token is 192 random bits, so no salt or HMAC is needed)
//   token_enc  = v1.<iv>.<AES-GCM(LINK_KEY, token)>  -> lets the organiser see the same link again
// and `token` itself is the placeholder `x-<row id>` for every new row. Legacy rows keep their clear token until
// the backfill fills the two new columns (phase A) and the deferred phase B script overwrites it.
import { b64url, fromB64url, randomToken } from "./crypto";

export type LinkKind = "share" | "invite" | "regform";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Constant-time string comparison (does not leak where two same-length strings differ). */
export function constantTimeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function hashToken(token: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(token)));
}

/** What goes into the legacy `token` column of a new row: never the real token. */
export const placeholder = (rowId: string): string => `x-${rowId}`;

const keys = new Map<string, Promise<CryptoKey>>();
function aesKey(linkKey: string | undefined): Promise<CryptoKey> {
  if (!linkKey || linkKey.length < 16) throw new Error("LINK_KEY is not configured");
  let k = keys.get(linkKey);
  if (!k) {
    k = crypto.subtle.digest("SHA-256", enc.encode(`link-enc-v1|${linkKey}`)).then((raw) => crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]));
    keys.set(linkKey, k);
  }
  return k;
}

/** AES-GCM; the kind and row id are authenticated data, so a ciphertext cannot be moved to another row. */
export async function encryptToken(env: { LINK_KEY?: string }, kind: LinkKind, rowId: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`${kind}|${rowId}`) }, await aesKey(env.LINK_KEY), enc.encode(token));
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

export async function decryptToken(env: { LINK_KEY?: string }, kind: LinkKind, rowId: string, blob: string): Promise<string | null> {
  try {
    const [v, iv, ct] = blob.split(".");
    if (v !== "v1" || !iv || !ct) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv), additionalData: enc.encode(`${kind}|${rowId}`) }, await aesKey(env.LINK_KEY), fromB64url(ct));
    return dec.decode(pt);
  } catch {
    return null;
  }
}

export interface NewLink {
  token: string;
  /** Values for the three columns of the new row. */
  cols: { token: string; token_hash: string; token_enc: string };
}

/** A fresh random token plus the column values to store. rowId is the id of the row it will live in (events.id for registration forms). */
export async function newLink(env: { LINK_KEY?: string }, kind: LinkKind, rowId: string): Promise<NewLink> {
  const token = randomToken();
  return { token, cols: { token: placeholder(rowId), token_hash: await hashToken(token), token_enc: await encryptToken(env, kind, rowId, token) } };
}

/** The link as the organiser should see it: decrypted copy, or the legacy clear token before the row is backfilled. "" if it cannot be recovered. */
export async function revealToken(env: { LINK_KEY?: string }, kind: LinkKind, rowId: string, row: { token: string; token_enc: string | null }): Promise<string> {
  if (row.token_enc) return (await decryptToken(env, kind, rowId, row.token_enc)) ?? "";
  return row.token === placeholder(rowId) ? "" : row.token;
}

/** Defence in depth after an indexed lookup: the stored hash (or legacy clear token) must equal what was presented. */
export async function verifyPresented(token: string, row: { token_hash: string | null; token: string }): Promise<boolean> {
  if (row.token_hash) return constantTimeEqual(row.token_hash, await hashToken(token));
  return constantTimeEqual(row.token, token);
}
