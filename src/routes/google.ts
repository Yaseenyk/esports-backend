import { Hono } from "hono";
import type { AppBindings } from "../types";
import { fromB64url, hashPassword, iterationsFrom, pwFingerprint, randomToken, signJwt } from "../crypto";
import { HttpError, nowIso, rateLimit, readJson } from "../http";
import { personalOrgId } from "../ownership";

/**
 * Sign in with Google (free: Google Identity Services issues an ID token, this Worker checks it; no client secret is used).
 * Off (404) until GOOGLE_CLIENT_ID is set. The token is verified here: RS256 signature against Google's public keys, issuer, audience, expiry,
 * and a verified email. New accounts need the 18+ confirmation, same as the email sign-up.
 */
export const google = new Hono<AppBindings>();

const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];
const SKEW_S = 60;

interface Jwk { kid: string; kty: string; n: string; e: string; alg?: string }
let jwksCache: { keys: Jwk[]; until: number } | null = null;
let jwksForTests: Jwk[] | null = null;
/** Tests supply their own key set so nothing touches the network. */
export function setGoogleKeysForTests(keys: Jwk[] | null): void { jwksForTests = keys; jwksCache = null; }

async function googleKeys(force = false): Promise<Jwk[]> {
  if (jwksForTests) return jwksForTests;
  if (!force && jwksCache && jwksCache.until > Date.now()) return jwksCache.keys;
  const r = await fetch(JWKS_URL);
  if (!r.ok) throw new HttpError(500, "Google sign-in is unavailable right now. Try again, or use your email and password");
  const body = (await r.json()) as { keys?: Jwk[] };
  jwksCache = { keys: body.keys ?? [], until: Date.now() + 60 * 60_000 };
  return jwksCache.keys;
}

export interface GoogleClaims { sub: string; email: string; name?: string; email_verified?: boolean | string }

/** Returns the claims of a valid Google ID token for this client, or throws a 401. Exported for tests. */
export async function verifyGoogleToken(credential: string, clientId: string): Promise<GoogleClaims> {
  const bad = () => new HttpError(401, "Google sign-in could not be checked. Try again");
  const parts = credential.split(".");
  if (parts.length !== 3 || credential.length > 4096) throw bad();
  let header: { alg?: string; kid?: string }, claims: Record<string, unknown>;
  try {
    const dec = new TextDecoder();
    header = JSON.parse(dec.decode(fromB64url(parts[0]!)));
    claims = JSON.parse(dec.decode(fromB64url(parts[1]!)));
  } catch { throw bad(); }
  if (header.alg !== "RS256" || !header.kid) throw bad();
  let jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await googleKeys(true)).find((k) => k.kid === header.kid); // keys rotate: look once more
  if (!jwk) throw bad();
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, fromB64url(parts[2]!), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw bad();
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.iss !== "string" || !ISSUERS.includes(claims.iss)) throw bad();
  if (claims.aud !== clientId) throw bad();
  if (typeof claims.exp !== "number" || claims.exp + SKEW_S < now) throw bad();
  if (typeof claims.iat === "number" && claims.iat - SKEW_S > now) throw bad();
  if (typeof claims.sub !== "string" || typeof claims.email !== "string") throw bad();
  if (claims.email_verified !== true && claims.email_verified !== "true") throw new HttpError(401, "Your Google email address is not verified, so it cannot be used to sign in");
  return claims as unknown as GoogleClaims;
}

interface Row { id: string; email: string; name: string; pw_hash: string; pw_salt: string; pw_iter: number; created_at: string; email_verified_at: string | null }
const publicUser = (u: Row) => ({ id: u.id, email: u.email, name: u.name, createdAt: u.created_at });

google.post("/auth/google", async (c) => {
  const clientId = c.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new HttpError(404, "Not found");
  await rateLimit(c, "auth", 10, 15 * 60);
  const body = await readJson(c);
  if (typeof body.credential !== "string" || !body.credential) throw new HttpError(400, "credential is required");
  const g = await verifyGoogleToken(body.credential, clientId);
  const email = g.email.normalize("NFKC").trim().toLowerCase();
  const now = nowIso();
  c.header("cache-control", "no-store");

  const u = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<Row>();
  if (u) {
    if (u.email_verified_at) return c.json({ token: await signJwt(u.id, c.env.JWT_SECRET, await pwFingerprint(u)), user: publicUser(u) });
    // The address was never proven by the person who first used it. Google has now proven it for this person, so the password someone
    // else may have set is thrown away (and every token made with it stops working). They can set a new one with "Forgot password".
    const h = await hashPassword(randomToken(32), iterationsFrom(c.env));
    await c.env.DB.prepare("UPDATE users SET pw_hash = ?1, pw_salt = ?2, pw_iter = ?3, email_verified_at = ?4 WHERE id = ?5").bind(h.hash, h.salt, h.iterations, now, u.id).run();
    const next: Row = { ...u, pw_hash: h.hash, pw_salt: h.salt, pw_iter: h.iterations, email_verified_at: now };
    return c.json({ token: await signJwt(u.id, c.env.JWT_SECRET, await pwFingerprint(next)), user: publicUser(next), passwordReset: true });
  }

  if (body.adult !== true) throw new HttpError(400, "Confirm that you are 18 or older to create an account", { code: "adult_required" });
  const name = (typeof g.name === "string" && g.name.trim() ? g.name.trim() : email.split("@")[0]!).slice(0, 80);
  const h = await hashPassword(randomToken(32), iterationsFrom(c.env));
  const user: Row = { id: crypto.randomUUID(), email, name, pw_hash: h.hash, pw_salt: h.salt, pw_iter: h.iterations, created_at: now, email_verified_at: now };
  const orgId = personalOrgId(user.id);
  try {
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO users (id, email, name, pw_hash, pw_salt, pw_iter, created_at, email_verified_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(user.id, user.email, user.name, user.pw_hash, user.pw_salt, user.pw_iter, user.created_at, now),
      c.env.DB.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES (?1, ?2, 'personal', 'active', ?3)").bind(orgId, `${user.name.slice(0, 60)}'s workspace`, now),
      c.env.DB.prepare("INSERT INTO org_members (org_id, user_id, role, added_by, added_at) VALUES (?1, ?2, 'admin', ?2, ?3)").bind(orgId, user.id, now),
    ]);
  } catch {
    throw new HttpError(409, "An account with this email already exists. Try again");
  }
  return c.json({ token: await signJwt(user.id, c.env.JWT_SECRET, await pwFingerprint(user)), user: publicUser(user), created: true }, 201);
});
