import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMailerForTests, type Mail } from "../src/mailer";
import { sha256 } from "../src/crypto";
import { call, freshIp, newUser, uniq } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

let sent: Mail[] = [];
beforeEach(() => {
  sent = [];
  setMailerForTests({ async send(m) { sent.push(m); } });
});
afterEach(() => setMailerForTests(null));

const tokenFrom = (m: Mail) => /\?t=([A-Za-z0-9_-]+)/.exec(m.text)![1]!;
const forgot = (email: string, ip?: string) => call("/auth/forgot", { body: { email }, ip });
const reset = (token: string, password: string) => call("/auth/reset", { body: { token, password } });

async function request(email: string) {
  const r = await forgot(email);
  expect(r.status).toBe(200);
  return tokenFrom(sent[sent.length - 1]!);
}

describe("password reset", () => {
  it("happy path: link emailed, reset works, new password logs in, old does not", async () => {
    const u = await newUser();
    const r = await forgot(u.email);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(u.email);
    expect(sent[0]!.subject).toBe("Reset your Esports Hub password");
    expect(sent[0]!.text).toContain("https://esports.streamerosai.com/reset-password/?t=");
    expect(sent[0]!.text).toContain("30 minutes");
    expect(sent[0]!.html).toContain("ignore this email, your password is unchanged");
    const token = tokenFrom(sent[0]!);

    const done = await reset(token, "brand new pass");
    expect(done.status).toBe(200);
    expect(done.json).toEqual({ ok: true }); // no session token
    expect((await call("/auth/login", { body: { email: u.email, password: "brand new pass" } })).status).toBe(200);
    expect((await call("/auth/login", { body: { email: u.email, password: "correct horse" } })).status).toBe(401);
  });

  it("the token is stored only as its SHA-256 hash", async () => {
    const u = await newUser();
    const token = await request(u.email);
    const rows = await env.DB.prepare("SELECT token_hash, expires_at, created_at FROM password_resets WHERE user_id = ?").bind(u.id).all<{ token_hash: string; expires_at: string; created_at: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.token_hash).toBe(await sha256(token));
    expect(rows.results[0]!.token_hash).not.toBe(token);
    const dump = JSON.stringify((await env.DB.prepare("SELECT * FROM password_resets").all()).results);
    expect(dump).not.toContain(token);
    const ttl = Date.parse(rows.results[0]!.expires_at) - Date.parse(rows.results[0]!.created_at);
    expect(Math.abs(ttl - 30 * 60_000)).toBeLessThanOrEqual(1000); // two Date.now() reads can differ by a few milliseconds
  });

  it("an unknown email gets the identical 200 and nothing is sent", async () => {
    const known = await newUser();
    const a = await forgot(known.email);
    sent = [];
    const b = await forgot(`${uniq()}@example.com`);
    expect(b.status).toBe(a.status);
    expect(b.json).toEqual(a.json);
    expect(b.text).toBe(a.text);
    expect(sent).toHaveLength(0);
  });

  it("the email is normalised like login (case and fullwidth forms)", async () => {
    const u = await newUser();
    const fullwidth = u.email.toUpperCase().replace(/[A-Z0-9]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));
    expect((await forgot(fullwidth)).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(u.email);
  });

  it("malformed requests are 400", async () => {
    expect((await call("/auth/forgot", { raw: "{nope", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect((await call("/auth/forgot", { body: {} })).status).toBe(400);
    expect((await forgot("not-an-email")).status).toBe(400);
    expect((await call("/auth/forgot", { body: { email: 5 } })).status).toBe(400);
    expect((await call("/auth/reset", { raw: "{nope", headers: { "content-type": "application/json" } })).status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  it("rate limit per email: the 6th request in an hour is 429, even from other addresses", async () => {
    const email = `${uniq()}@example.com`;
    for (let i = 0; i < 5; i++) expect((await forgot(email)).status).toBe(200);
    const r = await forgot(email);
    expect(r.status).toBe(429);
    expect(r.json.error).toBeTruthy();
  });

  it("rate limit per IP: the 21st request from one address is 429", async () => {
    const ip = freshIp();
    for (let i = 0; i < 20; i++) expect((await forgot(`${uniq()}@example.com`, ip)).status).toBe(200);
    expect((await forgot(`${uniq()}@example.com`, ip)).status).toBe(429);
  });

  it("an expired token is refused with the generic error", async () => {
    const u = await newUser();
    const token = await request(u.email);
    await env.DB.prepare("UPDATE password_resets SET expires_at = ? WHERE user_id = ?").bind(new Date(Date.now() - 1000).toISOString(), u.id).run();
    const r = await reset(token, "brand new pass");
    expect(r.status).toBe(400);
    expect(r.json).toEqual({ error: "invalid_or_expired" });
    expect((await call("/auth/login", { body: { email: u.email, password: "correct horse" } })).status).toBe(200);
  });

  it("a token works once; unknown and malformed tokens get the same generic error", async () => {
    const u = await newUser();
    const token = await request(u.email);
    expect((await reset(token, "brand new pass")).status).toBe(200);
    const again = await reset(token, "another pass 1");
    expect(again.status).toBe(400);
    expect(again.json).toEqual({ error: "invalid_or_expired" });
    expect((await reset("A".repeat(43), "another pass 1")).json).toEqual({ error: "invalid_or_expired" });
    expect((await reset("short", "another pass 1")).json).toEqual({ error: "invalid_or_expired" });
    expect((await call("/auth/reset", { body: { token: 5, password: "another pass 1" } })).json).toEqual({ error: "invalid_or_expired" });
  });

  it("a weak password is refused with the password rule and the token stays usable", async () => {
    const u = await newUser();
    const token = await request(u.email);
    const r = await reset(token, "short");
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("password must be 8-200 characters");
    expect((await reset(token, "long enough pass")).status).toBe(200);
  });

  it("a JWT issued before the reset is rejected afterwards", async () => {
    const u = await newUser();
    expect((await call("/me", { token: u.token })).status).toBe(200);
    const token = await request(u.email);
    expect((await reset(token, "brand new pass")).status).toBe(200);
    expect((await call("/me", { token: u.token })).status).toBe(401);
    const login = await call("/auth/login", { body: { email: u.email, password: "brand new pass" } });
    expect((await call("/me", { token: login.json.token })).status).toBe(200);
  });

  it("a successful reset invalidates the user's other reset tokens", async () => {
    const u = await newUser();
    const first = await request(u.email);
    // plant a second still-valid token directly (a second /forgot would invalidate the first)
    const second = `planted${uniq()}`.padEnd(30, "x");
    const now = new Date();
    await env.DB.prepare("INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)")
      .bind(crypto.randomUUID(), u.id, await sha256(second), now.toISOString(), new Date(now.getTime() + 60_000).toISOString()).run();
    expect((await reset(first, "brand new pass")).status).toBe(200);
    expect((await reset(second, "other new pass")).json).toEqual({ error: "invalid_or_expired" });
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?").bind(u.id).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("a second forgot invalidates the first token", async () => {
    const u = await newUser();
    const first = await request(u.email);
    const second = await request(u.email);
    expect(second).not.toBe(first);
    expect((await reset(first, "brand new pass")).json).toEqual({ error: "invalid_or_expired" });
    expect((await reset(second, "brand new pass")).status).toBe(200);
  });

  it("without RESEND_API_KEY the response is still 200 and nothing crashes", async () => {
    setMailerForTests(null);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const u = await newUser();
    const r = await forgot(u.email);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain(u.email);
    warn.mockRestore();
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = ?").bind(u.id).first<{ n: number }>();
    expect(n!.n).toBe(1);
  });

  it("a mail provider failure does not change the response or leak", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setMailerForTests({ async send() { throw new Error("boom secret-detail"); } });
    const u = await newUser();
    const r = await forgot(u.email);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(r.text).not.toContain("boom");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret-detail");
    warn.mockRestore();
  });
});
