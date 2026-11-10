import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, freshIp, newUser, uniq } from "./helpers";

const b64u = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function forgeJwt(payload: object, secret: string) {
  const data = `${b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }))}.${b64u(JSON.stringify(payload))}`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
  let bin = "";
  for (const b of sig) bin += String.fromCharCode(b);
  return `${data}.${b64u(bin)}`;
}

describe("health", () => {
  it("GET / is ok", async () => {
    const r = await call("/");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, name: "esports-api" });
  });
  it("unknown route is a JSON 404", async () => {
    const r = await call("/nope");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: "Not found" });
  });
});

describe("auth", () => {
  it("registers, logs in and reads /me; email is lower-cased", async () => {
    const email = `Mixed.${uniq()}@Example.COM`;
    const reg = await call("/auth/register", { body: { email, password: "supersecret", name: "Yas" } });
    expect(reg.status).toBe(201);
    expect(reg.json.user.email).toBe(email.toLowerCase());
    expect(reg.json.token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);

    const login = await call("/auth/login", { body: { email: email.toUpperCase(), password: "supersecret" } });
    expect(login.status).toBe(200);
    const me = await call("/me", { token: login.json.token });
    expect(me.status).toBe(200);
    expect(me.json.email).toBe(email.toLowerCase());
    expect(me.json.name).toBe("Yas");
  });

  it("stores a salted PBKDF2 hash, never the password", async () => {
    const u = await newUser();
    const row = await env.DB.prepare("SELECT pw_hash, pw_salt, pw_iter FROM users WHERE id = ?").bind(u.id).first<{ pw_hash: string; pw_salt: string; pw_iter: number }>();
    expect(row!.pw_hash).not.toContain("correct horse");
    expect(row!.pw_salt.length).toBeGreaterThanOrEqual(21); // 16 bytes base64url
    expect(row!.pw_iter).toBe(1000);
    const u2 = await newUser();
    const row2 = await env.DB.prepare("SELECT pw_hash, pw_salt FROM users WHERE id = ?").bind(u2.id).first<{ pw_hash: string; pw_salt: string }>();
    expect(row2!.pw_salt).not.toBe(row!.pw_salt);
    expect(row2!.pw_hash).not.toBe(row!.pw_hash);
  });

  it("rejects a wrong password, unknown email, short password, bad email, duplicates", async () => {
    const u = await newUser();
    expect((await call("/auth/login", { body: { email: u.email, password: "wrong password" } })).status).toBe(401);
    expect((await call("/auth/login", { body: { email: "nobody@example.com", password: "whatever123" } })).status).toBe(401);
    expect((await call("/auth/register", { body: { email: `${uniq()}@x.com`, password: "short", name: "A" } })).status).toBe(400);
    expect((await call("/auth/register", { body: { email: "not-an-email", password: "longenough", name: "A" } })).status).toBe(400);
    const dup = await call("/auth/register", { body: { email: u.email.toUpperCase(), password: "longenough", name: "A" } });
    expect(dup.status).toBe(409);
  });

  it("requires a bearer token on /me", async () => {
    expect((await call("/me")).status).toBe(401);
    expect((await call("/me", { token: "garbage" })).status).toBe(401);
  });

  it("rejects a tampered JWT (payload swapped, signature kept)", async () => {
    const a = await newUser();
    const b = await newUser();
    const [h, , s] = a.token.split(".");
    const forgedPayload = b64u(JSON.stringify({ sub: b.id, exp: Math.floor(Date.now() / 1000) + 9999 }));
    const r = await call("/me", { token: `${h}.${forgedPayload}.${s}` });
    expect(r.status).toBe(401);
    // last signature char flipped
    const flipped = a.token.slice(0, -1) + (a.token.endsWith("A") ? "B" : "A");
    expect((await call("/me", { token: flipped })).status).toBe(401);
  });

  it("rejects alg=none, wrong-secret and expired tokens; accepts a correctly forged one only with the real secret", async () => {
    const u = await newUser();
    const none = `${b64u(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64u(JSON.stringify({ sub: u.id, exp: 9999999999 }))}.`;
    expect((await call("/me", { token: none })).status).toBe(401);
    expect((await call("/me", { token: await forgeJwt({ sub: u.id, exp: 9999999999 }, "some-other-secret-value") })).status).toBe(401);
    expect((await call("/me", { token: await forgeJwt({ sub: u.id, exp: 1000 }, env.JWT_SECRET) })).status).toBe(401);
    expect((await call("/me", { token: await forgeJwt({ sub: u.id, exp: Math.floor(Date.now() / 1000) + 60 }, env.JWT_SECRET) })).status).toBe(200);
  });

  it("issues tokens that expire in 7 days with claims {sub, exp}", async () => {
    const u = await newUser();
    const claims = JSON.parse(atob(u.token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
    expect(Object.keys(claims).sort()).toEqual(["exp", "sub"]);
    expect(claims.sub).toBe(u.id);
    const left = claims.exp - Math.floor(Date.now() / 1000);
    expect(left).toBeGreaterThan(7 * 86400 - 60);
    expect(left).toBeLessThanOrEqual(7 * 86400);
  });

  it("rate limits login attempts per IP (10 per 15 minutes)", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      const r = await call("/auth/login", { ip, body: { email: "ghost@example.com", password: "nope nope nope" } });
      expect(r.status).toBe(401);
    }
    const blocked = await call("/auth/login", { ip, body: { email: "ghost@example.com", password: "nope nope nope" } });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error).toBeTruthy();
    // a different IP is unaffected
    expect((await call("/auth/login", { body: { email: "ghost@example.com", password: "nope nope nope" } })).status).toBe(401);
    // only a hash of the IP is stored
    const keys = await env.DB.prepare("SELECT key FROM rate_limits").all<{ key: string }>();
    expect(keys.results.some((k) => k.key.includes(ip))).toBe(false);
  });
});
