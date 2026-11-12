import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMailerForTests, type Mail } from "../src/mailer";
import { setSignupMailForTests } from "../src/routes/verify";
import { resetFlagsCache } from "../src/flags";
import { call, uniq } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

let sent: Mail[] = [];
beforeEach(() => {
  setSignupMailForTests(true);
  sent = [];
  setMailerForTests({ async send(m) { sent.push(m); } });
});
afterEach(async () => {
  setSignupMailForTests(false);
  setMailerForTests(null);
  await setRequired(false);
});

const tokenFrom = (m: Mail) => /\?t=([A-Za-z0-9_-]+)/.exec(m.text)![1]!;
async function setRequired(on: boolean) {
  await env.DB.prepare("INSERT INTO flags (key, value, updated_by, updated_at) VALUES ('auth.verify_required', ?1, 'test', ?2) ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(on ? "true" : "false", new Date().toISOString()).run();
  resetFlagsCache(env.DB);
}
/** Sign-up emails the link in the background, so wait for it (unless this test makes mail fail). */
async function signUp(expectMail = true) {
  const before = sent.length;
  const email = `v${uniq()}@example.com`;
  const r = await call("/auth/register", { body: { email, password: "correct horse", name: "Vera" } });
  expect(r.status).toBe(201);
  if (expectMail) await vi.waitFor(() => expect(sent.length).toBe(before + 1));
  return { email, token: r.json.token as string, id: r.json.user.id as string };
}
const ctxUser = async (token: string) => (await call("/me/context", { token })).json.user as { emailVerified: boolean; verifyRequired: boolean };
const mkEvent = (token: string) => call("/events", { token, body: { name: "Gate Cup", game: "BGMI" } });

describe("sign-up sends the confirmation email by itself", () => {
  it("emails a link to the new address and the link confirms it", async () => {
    const u = await signUp();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(u.email);
    expect((await ctxUser(u.token)).emailVerified).toBe(false);
    expect((await call("/me/email/verify", { token: u.token, body: { token: tokenFrom(sent[0]!) } })).status).toBe(200);
    expect((await ctxUser(u.token)).emailVerified).toBe(true);
  });

  it("a mail problem never stops the sign-up", async () => {
    setMailerForTests({ async send() { throw new Error("down"); } });
    const u = await signUp(false);
    expect((await call("/me", { token: u.token })).status).toBe(200);
  });
});

describe("flag auth.verify_required", () => {
  it("off (the default): nobody is blocked and the account is not marked", async () => {
    const u = await signUp();
    expect((await ctxUser(u.token)).verifyRequired).toBe(false);
    expect((await mkEvent(u.token)).status).toBe(201);
  });

  it("on: a new password account cannot create or duplicate events until the email is confirmed", async () => {
    const old = await signUp(); // made while the flag was off: never blocked
    const oldEvent = await mkEvent(old.token);
    expect(oldEvent.status).toBe(201);

    await setRequired(true);
    const u = await signUp();
    sent.length = 0;
    expect((await ctxUser(u.token)).verifyRequired).toBe(true);
    const blocked = await mkEvent(u.token);
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe("email_unverified");
    // reading and other account actions still work
    expect((await call("/events", { token: u.token })).status).toBe(200);
    expect((await call("/me", { token: u.token })).status).toBe(200);

    // an older account stays free
    expect((await mkEvent(old.token)).status).toBe(201);
    expect((await ctxUser(old.token)).verifyRequired).toBe(false);

    // after confirming, creating works and the screen condition clears
    expect((await call("/me/email/verify/start", { token: u.token, method: "POST" })).status).toBe(200);
    expect((await call("/me/email/verify", { token: u.token, body: { token: tokenFrom(sent[sent.length - 1]!) } })).status).toBe(200);
    expect((await ctxUser(u.token)).verifyRequired).toBe(false);
    expect((await mkEvent(u.token)).status).toBe(201);
  });

  it("duplicating an event is held back too", async () => {
    const u = await signUp();
    const ev = await mkEvent(u.token);
    expect(ev.status).toBe(201);
    await env.DB.prepare("UPDATE users SET verify_required = 1 WHERE id = ?").bind(u.id).run();
    const r = await call(`/events/${ev.json.id}/duplicate`, { token: u.token, body: { name: "Copy", include: {} } });
    expect(r.status).toBe(403);
    expect(r.json.code).toBe("email_unverified");
  });
});

describe("change my email before it is confirmed", () => {
  it("replaces the address, sends a fresh link to it, and the old link stops working", async () => {
    const u = await signUp();
    const firstLink = tokenFrom(sent[0]!);
    const next = `n${uniq()}@Example.com`;
    const r = await call("/me/email/change", { token: u.token, body: { email: next } });
    expect(r.status).toBe(200);
    expect(r.json.email).toBe(next.toLowerCase());
    expect(sent).toHaveLength(2);
    expect(sent[1]!.to).toBe(next.toLowerCase());
    expect((await call("/me/email/verify", { token: u.token, body: { token: firstLink } })).status).toBe(400); // replaced by the new link
    expect((await call("/me/email/verify", { token: u.token, body: { token: tokenFrom(sent[1]!) } })).status).toBe(200);
    expect((await call("/me", { token: u.token })).json.email).toBe(next.toLowerCase());
  });

  it("refuses an address that is not valid, one that is taken, and any change once confirmed", async () => {
    const a = await signUp();
    const b = await signUp();
    expect((await call("/me/email/change", { token: a.token, body: { email: "nope" } })).status).toBe(400);
    const taken = await call("/me/email/change", { token: a.token, body: { email: b.email } });
    expect(taken.status).toBe(409);
    expect(taken.json.code).toBe("email_taken");
    await call("/me/email/verify", { token: a.token, body: { token: tokenFrom(sent[0]!) } });
    const done = await call("/me/email/change", { token: a.token, body: { email: `z${uniq()}@example.com` } });
    expect(done.status).toBe(409);
    expect(done.json.code).toBe("already_verified");
  });

  it("needs a signed-in user", async () => {
    expect((await call("/me/email/change", { body: { email: "a@example.com" } })).status).toBe(401);
  });
});
