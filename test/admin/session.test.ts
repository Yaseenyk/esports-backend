import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { hotp, stepOf } from "../../src/admin/totp";
import { STAFF_CHAIN_SECONDS, STEP_UP_SECONDS, signStaffJwt } from "../../src/admin/session";
import { newUser } from "../helpers";
import { api, auditRows, db, enableConsole, forge, makeStaff, nowSec } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
const NF = { error: "Not found" };

describe("enrolment, login, renew, step-up", () => {
  it("enrol -> first code activates -> staff token with the documented shape; a second enrol is 404", async () => {
    const s = await makeStaff();
    const before = await db.prepare("SELECT totp_enabled_at, totp_secret_enc FROM platform_staff WHERE user_id = ?1").bind(s.id).first<{ totp_enabled_at: string | null; totp_secret_enc: string }>();
    expect(before!.totp_enabled_at).toBeNull();
    expect(before!.totp_secret_enc.startsWith("v1.")).toBe(true); // sealed, never the raw seed
    const r = await s.login();
    expect(Object.keys(r).sort()).toEqual(["chainEndsAt", "expiresAt", "staff", "stepUpUntil", "token"]);
    expect(r.staff).toEqual({ id: s.id, role: "admin" });
    expect(Date.parse(r.expiresAt) - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000);
    expect(Date.parse(r.chainEndsAt) - Date.now()).toBeLessThanOrEqual(STAFF_CHAIN_SECONDS * 1000);
    const after = await db.prepare("SELECT totp_enabled_at, totp_last_step FROM platform_staff WHERE user_id = ?1").bind(s.id).first<{ totp_enabled_at: string | null; totp_last_step: number }>();
    expect(after!.totp_enabled_at).not.toBeNull();
    expect(after!.totp_last_step).toBeGreaterThan(0);
    expect((await api("/admin/v1/session/enroll", { token: s.userToken, body: {} })).status).toBe(404);
    expect((await auditRows("admin.session", s.id)).map((x) => x.reason_code)).toEqual(["enroll", "login"]);
  });

  it("login before enrolling is 409, not a 404 (the staff member needs to know)", async () => {
    await enableConsole();
    const u = await newUser("NoSeed");
    await db.prepare("INSERT INTO platform_staff (user_id, role, added_by, added_at) VALUES (?1, 'admin', 'test', ?2)").bind(u.id, new Date().toISOString()).run();
    const r = await api("/admin/v1/session", { token: u.token, body: { code: "123456" } });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("totp_not_enrolled");
  });

  it("replay: the same code twice is refused (login, and step-up with the login code)", async () => {
    const s = await makeStaff();
    const code = await s.code();
    expect((await api("/admin/v1/session", { token: s.userToken, body: { code } })).status).toBe(200);
    const again = await api("/admin/v1/session", { token: s.userToken, body: { code } });
    expect(again.status).toBe(401);
    expect(again.json.code).toBe("invalid_code");
    const t = await s.login();
    const su = await api("/admin/v1/session/step-up", { token: t.token, body: { code } });
    expect(su.status).toBe(401);
  });

  it("an older step than the last accepted one is refused too", async () => {
    const s = await makeStaff();
    const cur = stepOf(Date.now());
    expect((await api("/admin/v1/session", { token: s.userToken, body: { code: await hotp(s.seed, cur + 1) } })).status).toBe(200);
    expect((await api("/admin/v1/session", { token: s.userToken, body: { code: await hotp(s.seed, cur) } })).status).toBe(401);
  });

  it("renew needs no code and keeps su and the chain start; step-up gives a fresh su", async () => {
    const s = await makeStaff();
    await s.login(); // activates the authenticator
    const old = await forge(s.id, { su: nowSec() - 1000, cs: nowSec() - 3600, iat: nowSec() - 60 });
    const renewed = await api("/admin/v1/session/renew", { token: old, body: {} });
    expect(renewed.status).toBe(200);
    expect(Date.parse(renewed.json.stepUpUntil)).toBeLessThan(Date.now()); // su was not refreshed by renew
    const up = await api("/admin/v1/session/step-up", { token: renewed.json.token, body: { code: await s.code() } });
    expect(up.status).toBe(200);
    expect(Date.parse(up.json.stepUpUntil)).toBeGreaterThan(Date.now());
    expect(Date.parse(up.json.chainEndsAt)).toBe(Date.parse(renewed.json.chainEndsAt)); // the chain start did not move
    expect(Date.parse(up.json.stepUpUntil) - Date.now()).toBeLessThanOrEqual(STEP_UP_SECONDS * 1000);
  });

  it("renew is refused once the chain is 4 hours old (401 session_expired), and a token never outlives the chain", async () => {
    const s = await makeStaff();
    await s.login();
    const t = await forge(s.id, { cs: nowSec() - STAFF_CHAIN_SECONDS - 5 });
    const r = await api("/admin/v1/session/renew", { token: t, body: {} });
    expect(r.status).toBe(401);
    expect(r.json.code).toBe("session_expired");
    const near = await api("/admin/v1/session/renew", { token: await forge(s.id, { cs: nowSec() - STAFF_CHAIN_SECONDS + 100 }), body: {} });
    expect(near.status).toBe(200);
    expect(Date.parse(near.json.expiresAt) - Date.now()).toBeLessThanOrEqual(101_000);
  });
});

describe("lockout: 5 failures per 15 minutes per user id", () => {
  it("a staff member with wrong codes is 401 five times, then 429 even for the right code", async () => {
    const s = await makeStaff();
    for (let i = 0; i < 5; i++) expect((await api("/admin/v1/session", { token: s.userToken, body: { code: "000000" } })).status, `try ${i}`).toBe(401);
    const locked = await api("/admin/v1/session", { token: s.userToken, body: { code: await s.code() } });
    expect(locked.status).toBe(429);
    expect(locked.json.code).toBe("locked");
  });

  it("a non-staff user hits the same wall (404 five times, then 429), so the limiter is not an oracle", async () => {
    await enableConsole();
    const u = await newUser("Nope");
    for (let i = 0; i < 5; i++) {
      const r = await api("/admin/v1/session", { token: u.token, body: { code: "123456" } });
      expect(r.status).toBe(404);
      expect(r.json).toEqual(NF);
    }
    expect((await api("/admin/v1/session", { token: u.token, body: { code: "123456" } })).status).toBe(429);
  });

  it("step-up failures count in the same bucket", async () => {
    const s = await makeStaff();
    const t = (await s.login()).token;
    for (let i = 0; i < 5; i++) expect((await api("/admin/v1/session/step-up", { token: t, body: { code: "000000" } })).status).toBe(401);
    expect((await api("/admin/v1/session/step-up", { token: t, body: { code: await s.code() } })).status).toBe(429);
  });
});

describe("audience separation, both ways", () => {
  it("a staff token is no user token: every user route refuses it", async () => {
    const s = await makeStaff();
    const t = (await s.login()).token;
    for (const p of ["/me", "/events", "/brand", "/profiles"]) {
      expect((await api(p, { token: t })).status, p).toBe(401);
    }
    expect((await api("/events", { token: t, body: { name: "x" } })).status).toBe(401);
  });

  it("a user token is no staff token: staff routes refuse it with 404", async () => {
    const s = await makeStaff();
    await s.login();
    for (const [m, p] of [["GET", "/admin/v1/usage"], ["GET", "/admin/v1/flags"], ["GET", "/admin/v1/lookup?id=x"], ["POST", "/admin/v1/session/renew"]] as const) {
      const r = await api(p, { method: m, token: s.userToken, body: m === "POST" ? {} : undefined });
      expect(r.status, p).toBe(404);
      expect(r.json).toEqual(NF);
    }
  });

  it("tokens built from the wrong pieces are all refused: wrong secret, user secret, no aud, wrong aud, expired, none algorithm", async () => {
    const s = await makeStaff();
    await s.login();
    const t = nowSec();
    const good = { sub: s.id, iat: t, exp: t + 600, su: t, cs: t };
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const bad: string[] = [
      await signStaffJwt("some-other-secret-some-other-secret", { ...good, aud: "staff" }),
      await signStaffJwt(env.JWT_SECRET, { ...good, aud: "staff" }), // the USER secret
      await signStaffJwt(env.STAFF_JWT_SECRET!, { ...good, aud: "user" } as never),
      await signStaffJwt(env.STAFF_JWT_SECRET!, { ...good } as never), // no aud
      await forge(s.id, { exp: t - 5, iat: t - 600 }), // expired
      `${b64({ alg: "none", typ: "JWT" })}.${b64({ ...good, aud: "staff" })}.`,
      "garbage",
    ];
    for (const token of bad) {
      const r = await api("/admin/v1/usage", { token });
      expect(r.status, token.slice(0, 20)).toBe(404);
      expect(r.json).toEqual(NF);
    }
    expect((await api("/admin/v1/usage", { token: await forge(s.id) })).status).toBe(200);
  });
});

describe("staff state is read on every request", () => {
  it("token_valid_after signs staff out everywhere", async () => {
    const s = await makeStaff();
    const t = (await s.login()).token;
    expect((await api("/admin/v1/usage", { token: t })).status).toBe(200);
    await db.prepare("UPDATE platform_staff SET token_valid_after = ?1 WHERE user_id = ?2").bind(nowSec() + 1, s.id).run();
    expect((await api("/admin/v1/usage", { token: t })).status).toBe(404);
    await db.prepare("UPDATE platform_staff SET token_valid_after = 0 WHERE user_id = ?1").bind(s.id).run();
    expect((await api("/admin/v1/usage", { token: t })).status).toBe(200);
  });

  it("flag admin.enabled=false, a suspended account and a removed staff row all give 404 at once", async () => {
    const s = await makeStaff();
    const t = (await s.login()).token;
    await enableConsole(false);
    expect((await api("/admin/v1/usage", { token: t })).status).toBe(404);
    expect((await api("/admin/v1/session", { token: s.userToken, body: { code: await s.code() } })).status).toBe(404);
    await enableConsole(true);
    expect((await api("/admin/v1/usage", { token: t })).status).toBe(200);
    await db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1").bind(s.id).run();
    expect((await api("/admin/v1/usage", { token: t })).status).toBe(404);
    await db.prepare("UPDATE users SET status = 'active' WHERE id = ?1").bind(s.id).run();
    await db.prepare("UPDATE platform_staff SET removed_at = ?2 WHERE user_id = ?1").bind(s.id, new Date().toISOString()).run();
    expect((await api("/admin/v1/usage", { token: t })).status).toBe(404);
    expect((await api("/admin/v1/session", { token: s.userToken, body: { code: await s.code() } })).status).toBe(404);
  });

  it("the gate fails closed when a secret is missing", () => {
    const src = import.meta.glob("../../src/admin/session.ts", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
    expect(Object.values(src)[0]).toContain("!c.env.STAFF_JWT_SECRET || !c.env.TOTP_KEK");
  });
});

describe("the door is not an oracle", () => {
  it("anonymous, ordinary user and unknown paths get the identical 404 body", async () => {
    await enableConsole();
    const u = await newUser("Plain");
    const a = await api("/admin/v1/session", { body: { code: "123456" } });
    const b = await api("/admin/v1/session", { token: u.token, body: { code: "123456" } });
    const c = await api("/admin/v1/lookup?id=x");
    const d = await api("/admin/v1/no-such-thing");
    expect([a.status, b.status, c.status, d.status]).toEqual([404, 404, 404, 404]);
    expect(a.text).toBe(b.text);
    expect(b.text).toBe(c.text);
    expect(c.text).toBe(d.text);
  });
});
