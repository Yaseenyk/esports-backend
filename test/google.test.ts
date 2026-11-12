import { env } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setGoogleKeysForTests } from "../src/routes/google";
import { b64url } from "../src/crypto";
import { call, uniq } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

const CLIENT = env.GOOGLE_CLIENT_ID!;
const enc = new TextEncoder();
let priv: CryptoKey;
let otherPriv: CryptoKey;

async function sign(claims: Record<string, unknown>, o: { key?: CryptoKey; kid?: string; alg?: string } = {}): Promise<string> {
  const h = b64url(enc.encode(JSON.stringify({ alg: o.alg ?? "RS256", kid: o.kid ?? "k1", typ: "JWT" })));
  const p = b64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", o.key ?? priv, enc.encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}
const now = () => Math.floor(Date.now() / 1000);
const claims = (email: string, over: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com", aud: CLIENT, sub: `g-${uniq()}`, email, email_verified: true, name: "Gee Tester", iat: now(), exp: now() + 3600, ...over,
});
const login = (credential: string, extra: Record<string, unknown> = {}) => call("/auth/google", { method: "POST", body: { credential, ...extra } });
const mail = () => `g${uniq()}@example.com`;

beforeAll(async () => {
  const mk = () => crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]) as Promise<CryptoKeyPair>;
  const a = await mk();
  const b = await mk();
  priv = a.privateKey;
  otherPriv = b.privateKey;
  const jwk = (await crypto.subtle.exportKey("jwk", a.publicKey)) as { n: string; e: string; kty: string };
  setGoogleKeysForTests([{ kid: "k1", kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256" }]);
});
afterAll(() => setGoogleKeysForTests(null));

describe("sign in with Google", () => {
  it("creates an account (with its personal organisation, verified email) only when 18+ is confirmed", async () => {
    const e = mail();
    const tok = await sign(claims(e));
    const refused = await login(tok);
    expect(refused.status).toBe(400);
    expect((refused.json as { code?: string }).code).toBe("adult_required");
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(e).first()).toBeNull();

    const ok = await login(tok, { adult: true });
    expect(ok.status).toBe(201);
    const b = ok.json as { token: string; user: { email: string; name: string }; created: boolean };
    expect(b.created).toBe(true);
    expect(b.user.email).toBe(e);
    expect(b.user.name).toBe("Gee Tester");
    const row = await env.DB.prepare("SELECT id, email_verified_at AS v FROM users WHERE email = ?").bind(e).first<{ id: string; v: string | null }>();
    expect(row!.v).toBeTruthy();
    expect(await env.DB.prepare("SELECT role FROM org_members WHERE user_id = ?").bind(row!.id).first()).toEqual({ role: "admin" });
    expect((await call("/me", { token: b.token })).status).toBe(200);
  });

  it("signs an existing, verified account in without asking for 18+ again", async () => {
    const e = mail();
    await login(await sign(claims(e)), { adult: true });
    const again = await login(await sign(claims(e)));
    expect(again.status).toBe(200);
    expect((again.json as { created?: boolean }).created).toBeUndefined();
  });

  it("an address nobody verified: Google proves it, and the earlier password and tokens stop working", async () => {
    const e = mail();
    const reg = await call("/auth/register", { method: "POST", body: { email: e, name: "Squatter", password: "squatter-pass-1" } });
    expect(reg.status).toBe(201);
    const squatterToken = (reg.json as { token: string }).token;
    const res = await login(await sign(claims(e)));
    expect(res.status).toBe(200);
    const b = res.json as { token: string; passwordReset?: boolean };
    expect(b.passwordReset).toBe(true);
    expect((await call("/me", { token: b.token })).status).toBe(200);
    expect((await call("/me", { token: squatterToken })).status).toBe(401);
    expect((await call("/auth/login", { method: "POST", body: { email: e, password: "squatter-pass-1" } })).status).toBe(401);
  });

  it("rejects tokens that are forged, for another app, expired, unverified, or the wrong shape", async () => {
    const e = mail();
    const bad = [
      await sign(claims(e), { key: otherPriv }), // signed with a key Google never published
      await sign(claims(e, { aud: "someone-else.apps.googleusercontent.com" })),
      await sign(claims(e, { iss: "https://evil.example" })),
      await sign(claims(e, { exp: now() - 3600 })),
      await sign(claims(e, { email_verified: false })),
      await sign(claims(e), { kid: "unknown" }),
      await sign(claims(e), { alg: "HS256" }),
      "not.a.jwt",
      "",
    ];
    for (const t of bad) {
      const r = await login(t, { adult: true });
      expect([400, 401]).toContain(r.status);
    }
    expect(await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(e).first()).toBeNull();
    expect((await call("/auth/google", { method: "POST", body: {} })).status).toBe(400);
  });

  it("is one account per mailbox: upper case and the same address from Google match an email sign-up", async () => {
    const e = mail();
    await call("/auth/register", { method: "POST", body: { email: e, name: "Pw User", password: "password-one-1" } });
    await env.DB.prepare("UPDATE users SET email_verified_at = ? WHERE email = ?").bind(new Date().toISOString(), e).run();
    const res = await login(await sign(claims(e.toUpperCase())));
    expect(res.status).toBe(200);
    expect(Number((await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE email = ?").bind(e).first<{ n: number }>())!.n)).toBe(1);
    // the password still works for a verified account that signed in with Google
    expect((await call("/auth/login", { method: "POST", body: { email: e, password: "password-one-1" } })).status).toBe(200);
  });
});
