const enc = new TextEncoder();

export function b64url(input: ArrayBuffer | Uint8Array): string {
  const u = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = "";
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("bad base64url");
  const b = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 24 random bytes, base64url (32 chars). */
export function randomToken(bytes = 24): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(text: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

/** Constant-time string comparison (length is not secret here). */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

function hmacKey(secret: string, usages: ("sign" | "verify")[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, usages);
}

// ---------- passwords ----------
async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return b64url(bits);
}

export function iterationsFrom(env: { PBKDF2_ITERATIONS?: string }): number {
  const n = Number.parseInt(env.PBKDF2_ITERATIONS ?? "", 10);
  // Workers' WebCrypto rejects PBKDF2 above 100000 iterations.
  return Number.isFinite(n) && n >= 1 ? Math.min(n, 100000) : 100000;
}

export async function hashPassword(password: string, iterations: number) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: await pbkdf2(password, salt, iterations), salt: b64url(salt), iterations };
}

export async function verifyPassword(password: string, hash: string, salt: string, iterations: number) {
  const got = await pbkdf2(password, fromB64url(salt), iterations);
  return timingSafeEqual(got, hash);
}

// ---------- JWT (HS256) ----------
const JWT_HEADER = b64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
export const JWT_TTL_SECONDS = 7 * 24 * 3600;

/** Short non-reversible fingerprint of the current password hash+salt; changes whenever the password changes. */
export async function pwFingerprint(u: { pw_hash: string; pw_salt: string }): Promise<string> {
  return (await sha256(`pv1|${u.pw_salt}|${u.pw_hash}`)).slice(0, 16);
}

export async function signJwt(sub: string, secret: string, pv: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS;
  const data = `${JWT_HEADER}.${b64url(enc.encode(JSON.stringify({ sub, exp, pv })))}`;
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(data));
  return `${data}.${b64url(sig)}`;
}

export async function verifyJwt(token: string, secret: string): Promise<{ sub: string; pv: string } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  try {
    if (h !== JWT_HEADER) return null; // pins alg=HS256, rejects "none"
    // subtle.verify compares in constant time
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret, ["verify"]), fromB64url(s), enc.encode(`${h}.${p}`));
    if (!ok) return null;
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(p))) as { sub?: unknown; exp?: unknown; pv?: unknown };
    if (typeof claims.sub !== "string" || typeof claims.exp !== "number") return null;
    if (claims.exp <= Math.floor(Date.now() / 1000)) return null;
    if (typeof claims.pv !== "string") return null; // tokens from before password fingerprints are refused: sign in again
    return { sub: claims.sub, pv: claims.pv };
  } catch {
    return null;
  }
}

// ---------- pass signing ----------
export function importPassKey(signingSecret: string): Promise<CryptoKey> {
  return hmacKey(signingSecret, ["sign"]);
}

export async function passSig(key: CryptoKey, eventKey: string, personId: string, role: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", key, enc.encode(`${eventKey}|${personId}|${role}`));
  return b64url(mac).slice(0, 16);
}

export const passCode = (eventKey: string, personId: string, sig: string) => `EH1.${eventKey}.${personId}.${sig}`;

// ---------- purpose-split keys (S10) ----------
/** Key for hashes and derived tokens that are not sessions (unsubscribe tokens, rate-limit and reporter hashes). Falls back to JWT_SECRET until HASH_KEY is set. */
export const hashKey = (env: { HASH_KEY?: string; JWT_SECRET: string }): string => env.HASH_KEY || env.JWT_SECRET;

/** 32-char token derived from a secret, a purpose label and an id: HMAC-SHA256, base64url, truncated. */
export async function deriveToken(secret: string, label: string, id: string): Promise<string> {
  const mac = await crypto.subtle.sign("HMAC", await hmacKey(secret, ["sign"]), enc.encode(`${label}|${id}`));
  return b64url(mac).slice(0, 32);
}
