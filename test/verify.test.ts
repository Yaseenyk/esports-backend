import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMailerForTests, reserveMail, type Mail } from "../src/mailer";
import { sha256 } from "../src/crypto";
import { dayOf } from "../src/features/reminders";
import { call, newEvent, newUser } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

let sent: Mail[] = [];
beforeEach(() => {
  sent = [];
  setMailerForTests({ async send(m) { sent.push(m); } });
});
afterEach(() => setMailerForTests(null));

const tokenFrom = (m: Mail) => /\?t=([A-Za-z0-9_-]+)/.exec(m.text)![1]!;
const start = (token: string) => call("/me/email/verify/start", { token, method: "POST" });
const confirm = (token: string, t: string) => call("/me/email/verify", { token, body: { token: t } });
const verifiedAt = async (id: string) => (await env.DB.prepare("SELECT email_verified_at AS v FROM users WHERE id = ?").bind(id).first<{ v: string | null }>())!.v;
const setSent = (n: number) => env.DB.prepare("INSERT INTO mail_budget (day, sent) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET sent = excluded.sent").bind(dayOf(), n).run();

async function begin() {
  const u = await newUser();
  expect((await start(u.token)).status).toBe(200);
  return { u, t: tokenFrom(sent[sent.length - 1]!) };
}

describe("email verification (S6)", () => {
  it("new accounts start unverified and are not blocked (grandfathering: nothing requires verification yet)", async () => {
    const u = await newUser();
    expect(await verifiedAt(u.id)).toBeNull();
    expect((await call("/me", { token: u.token })).status).toBe(200);
    await newEvent(u.token);
  });

  it("happy path: mail sent, token stored only as a hash with a 30 minute expiry, confirm marks the account", async () => {
    const { u, t } = await begin();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(u.email);
    expect(sent[0]!.text).toContain("https://esports.streamerosai.com/verify-email/?t=");
    expect(sent[0]!.text.toLowerCase()).toContain("spam");
    const rows = await env.DB.prepare("SELECT token_hash, expires_at FROM email_tokens WHERE user_id = ?").bind(u.id).all<{ token_hash: string; expires_at: string }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.token_hash).toBe(await sha256(t));
    expect(JSON.stringify((await env.DB.prepare("SELECT * FROM email_tokens").all()).results)).not.toContain(t);
    const ttl = Date.parse(rows.results[0]!.expires_at) - Date.now();
    expect(ttl).toBeGreaterThan(29 * 60_000);
    expect(ttl).toBeLessThanOrEqual(30 * 60_000);
    const done = await confirm(u.token, t);
    expect(done.status).toBe(200);
    expect(done.json).toEqual({ ok: true });
    expect(await verifiedAt(u.id)).not.toBeNull();
  });

  it("a token works once", async () => {
    const { u, t } = await begin();
    expect((await confirm(u.token, t)).status).toBe(200);
    const again = await confirm(u.token, t);
    expect(again.status).toBe(400);
    expect(again.json.error).toBe("invalid_or_expired");
  });

  it("an expired token is refused with the same answer", async () => {
    const { u, t } = await begin();
    await env.DB.prepare("UPDATE email_tokens SET expires_at = ? WHERE user_id = ?").bind(new Date(Date.now() - 1000).toISOString(), u.id).run();
    const r = await confirm(u.token, t);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_or_expired");
    expect(await verifiedAt(u.id)).toBeNull();
  });

  it("another user's token is refused identically and is not used up", async () => {
    const { u, t } = await begin();
    const other = await newUser();
    const r = await confirm(other.token, t);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("invalid_or_expired");
    expect(await verifiedAt(other.id)).toBeNull();
    expect((await confirm(u.token, t)).status).toBe(200); // the owner can still use it
    expect((await confirm(u.token, "x".repeat(40))).json.error).toBe("invalid_or_expired"); // unknown token: same words
    expect((await confirm(u.token, "short")).json.error).toBe("invalid_or_expired");
  });

  it("asking again invalidates the earlier link", async () => {
    const { u, t } = await begin();
    expect((await start(u.token)).status).toBe(200);
    const t2 = tokenFrom(sent[1]!);
    expect(t2).not.toBe(t);
    expect((await confirm(u.token, t)).status).toBe(400);
    expect((await confirm(u.token, t2)).status).toBe(200);
  });

  it("an already verified account gets the same 200 and no mail", async () => {
    const { u, t } = await begin();
    await confirm(u.token, t);
    sent = [];
    const r = await start(u.token);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true });
    expect(sent).toHaveLength(0);
  });

  it("needs a signed-in user", async () => {
    expect((await call("/me/email/verify/start", { method: "POST" })).status).toBe(401);
    expect((await call("/me/email/verify", { body: { token: "x".repeat(40) } })).status).toBe(401);
  });

  it("is rate limited per user", async () => {
    const u = await newUser();
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await start(u.token)).status;
    expect(last).toBe(429);
  });

  it("budget exhausted: 429, nothing sent, nothing stored", async () => {
    const u = await newUser();
    await setSent(90);
    const r = await start(u.token);
    expect(r.status).toBe(429);
    expect(r.json.code).toBe("mail_budget_exhausted");
    expect(sent).toHaveLength(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = ?").bind(u.id).first<{ n: number }>())!.n).toBe(0);
    await setSent(0);
  });

  it("10-of-90 reserve: reminders stop at 80, verification may use the last 10", async () => {
    await setSent(80);
    expect(await reserveMail(env, dayOf(), "reminder")).toBe(false);
    const u = await newUser();
    expect((await start(u.token)).status).toBe(200);
    expect(sent).toHaveLength(1);
    await setSent(89);
    expect(await reserveMail(env, dayOf(), "auth")).toBe(true); // the 90th
    expect(await reserveMail(env, dayOf(), "auth")).toBe(false);
    await setSent(0);
  });

  it("a failed send gives the budget back and leaks nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setMailerForTests({ async send() { throw new Error("boom secret-detail"); } });
    await setSent(5);
    const u = await newUser();
    expect((await start(u.token)).status).toBe(200);
    expect((await env.DB.prepare("SELECT sent FROM mail_budget WHERE day = ?").bind(dayOf()).first<{ sent: number }>())!.sent).toBe(5);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-detail|@example\.com/);
    warn.mockRestore();
    await setSent(0);
  });

  it("deleting the account removes its tokens (cascade)", async () => {
    const { u } = await begin();
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(u.id).run();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM email_tokens WHERE user_id = ?").bind(u.id).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("account status (S6)", () => {
  it("only the three states are allowed", async () => {
    const u = await newUser();
    for (const st of ["suspended", "pending_deletion", "active"]) await env.DB.prepare("UPDATE users SET status = ? WHERE id = ?").bind(st, u.id).run();
    await expect(env.DB.prepare("UPDATE users SET status = 'banned' WHERE id = ?").bind(u.id).run()).rejects.toThrow();
  });

  it("a suspended user gets 401 everywhere except GET /me, which explains with 403", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    await env.DB.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").bind(u.id).run();
    const me = await call("/me", { token: u.token });
    expect(me.status).toBe(403);
    expect(me.json.code).toBe("account_suspended");
    expect((await call("/events", { token: u.token })).status).toBe(401);
    expect((await call(`/events/${ev.id}`, { token: u.token })).status).toBe(401);
    expect((await call("/events", { token: u.token, body: { name: "x", game: "g", organiser: "o", date: "2026-12-01", venue: "v", emergency: "e", rules: "r", settings: {} } })).status).toBe(401);
    expect((await call("/auth/change-password", { token: u.token, body: { current: "correct horse", next: "another pass 1" } })).status).toBe(401);
    expect((await start(u.token)).status).toBe(401);
    // restored: everything works again
    await env.DB.prepare("UPDATE users SET status = 'active' WHERE id = ?").bind(u.id).run();
    expect((await call("/me", { token: u.token })).status).toBe(200);
    expect((await call(`/events/${ev.id}`, { token: u.token })).status).toBe(200);
  });

  it("pending_deletion answers the same, with its own code on /me", async () => {
    const u = await newUser();
    await env.DB.prepare("UPDATE users SET status = 'pending_deletion' WHERE id = ?").bind(u.id).run();
    const me = await call("/me", { token: u.token });
    expect(me.status).toBe(403);
    expect(me.json.code).toBe("deletion_pending");
    expect((await call("/events", { token: u.token })).status).toBe(401);
  });
});
