import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { resetFlagsCache } from "../../src/flags";
import { sha256 } from "../../src/crypto";
import { deviceFromUa, hashIp, normalisePath, redactSecrets, sanitiseClientError, cleanMessage, looksLikeNoise, validContact } from "../../src/v3/lib/feedback";
import { runRetention } from "../../src/v3/services/retention-service";
import { auditRows, enableConsole, makeStaff } from "../admin/helpers";
import { api, db, nowSec, PNG, user } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

const FLAGS = ["feedback.enabled", "kill.feedback", "kill.public_writes", "kill.uploads"];
async function flags(...on: string[]) {
  await db.prepare(`DELETE FROM flags WHERE key IN (${FLAGS.map(() => "?").join(",")})`).bind(...FLAGS).run();
  for (const k of on) await db.prepare("INSERT INTO flags (key, value, updated_by, updated_at, note) VALUES (?1, 'true', 'test', ?2, '')").bind(k, new Date().toISOString()).run();
  resetFlagsCache();
}
const on = () => flags("feedback.enabled");

const good = (over: Record<string, unknown> = {}) => ({
  kind: "bug", message: "The brackets page does not load on my phone at all", page: { path: "/tools/brackets/", title: "Brackets" },
  client: { viewport: { w: 390, h: 844 }, locale: "en-IN", buildId: "b1", errors: ["TypeError: x is undefined"] }, consent: true, consentVersion: "feedback-v1", website: "", ...over,
});
const post = (body: unknown, o: { ip?: string; token?: string; headers?: Record<string, string> } = {}) => api("/feedback", { body, ip: o.ip, token: o.token, headers: o.headers });
const JPEG = (n = 200, seed = 1) => { const b = PNG(n, seed); b.set([0xff, 0xd8, 0xff, 0xe0]); b.fill(seed, 4, 8); return b; };
const WEBP = (n = 200, seed = 1) => { const b = PNG(n, seed); b.set([0x52, 0x49, 0x46, 0x46]); b.set([0x57, 0x45, 0x42, 0x50], 8); return b; };
const upload = (id: string, token: string | undefined, bytes: Uint8Array, type = "image/png", ip?: string) =>
  api(`/feedback/${id}/attachments`, { raw: bytes as BodyInit, ip, headers: { "content-type": type, ...(token ? { "x-attach-token": token } : {}) } });
const row = (id: string) => db.prepare("SELECT * FROM feedback_reports WHERE id = ?1").bind(id).first<Record<string, any>>();
const created = async (over: Record<string, unknown> = {}, o: { ip?: string; token?: string; headers?: Record<string, string> } = {}) => {
  const r = await post(good(over), o);
  expect(r.status, r.text).toBe(201);
  return r.json as { id: string; attachToken: string; attachExpiresIn: number };
};

beforeEach(on);
afterEach(() => flags());

describe("flags off: 404 before any feedback table is touched", () => {
  it("defaults are off and every route answers the unknown-route 404 without preparing SQL on a feedback table", async () => {
    await flags();
    const unknown = await api("/feedback-nope");
    expect(unknown.status).toBe(404);
    const sql: string[] = [];
    const DB = new Proxy(env.DB, {
      get(t, p) {
        if (p === "prepare") return (s: string) => { sql.push(s); return t.prepare(s); };
        if (p === "batch") return (x: unknown[]) => t.batch(x as D1PreparedStatement[]);
        const v = (t as unknown as Record<string | symbol, unknown>)[p];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    const spy = { ...env, DB } as typeof env;
    const routes = [["GET", "/feedback/status"], ["POST", "/feedback"], ["POST", "/feedback/abc/attachments"], ["DELETE", "/feedback/abc"]] as const;
    for (const [method, path] of routes) {
      const res = await api(path, { method, body: method === "POST" && path === "/feedback" ? good() : undefined, headers: { "x-attach-token": "x" }, env: spy });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.json).toEqual(unknown.json);
    }
    for (const s of sql) expect(s).not.toMatch(/feedback_/);
    expect(sql.length).toBeGreaterThan(0); // only the flags table was read
  });
});

describe("GET /feedback/status and the kill switch", () => {
  it("answers the fixed contract; kill.feedback hides it", async () => {
    const r = await api("/feedback/status");
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ enabled: true, consentVersion: "feedback-v1", maxAttachments: 2, maxAttachmentBytes: 409600 });
    await flags("feedback.enabled", "kill.feedback");
    expect((await api("/feedback/status")).status).toBe(404);
    expect((await post(good())).status).toBe(503);
    await flags("feedback.enabled", "kill.public_writes");
    expect((await post(good())).status).toBe(503);
  });
  it("withdrawing still works while kill.feedback is on", async () => {
    const c = await created();
    await flags("feedback.enabled", "kill.feedback");
    expect((await api(`/feedback/${c.id}`, { method: "DELETE", headers: { "x-attach-token": c.attachToken } })).status).toBe(204);
  });
  it("CORS: X-Attach-Token is an allowed header on the preflight", async () => {
    const res = await app.fetch(new Request("https://api.test/feedback", { method: "OPTIONS", headers: { origin: "http://localhost:3000" } }), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("X-Attach-Token");
    expect(res.headers.get("access-control-allow-methods")).toContain("DELETE");
  });
});

describe("POST /feedback validation matrix", () => {
  const cases: [string, unknown, number, string, string?][] = [
    ["not json", "nope", 400, "invalid"],
    ["bad kind", good({ kind: "praise" }), 400, "invalid", "kind"],
    ["no kind", { ...good(), kind: undefined }, 400, "invalid", "kind"],
    ["message not text", good({ message: 5 }), 400, "invalid", "message"],
    ["message too short", good({ message: "too short" }), 400, "too_short", "message"],
    ["message short after trim", good({ message: "   abc    " }), 400, "too_short", "message"],
    ["message too long", good({ message: "word ".repeat(500) }), 400, "invalid", "message"],
    ["repeated characters", good({ message: "aaaaaaaaaaaaaaaaaaaa" }), 400, "invalid", "message"],
    ["two characters", good({ message: "abababababababab" }), 400, "invalid", "message"],
    ["symbols only", good({ message: "!!!! ???? #### $$$$ %%%%" }), 400, "invalid", "message"],
    ["no page", good({ page: undefined }), 400, "invalid", "page"],
    ["path not absolute", good({ page: { path: "tools/x" } }), 400, "invalid", "page.path"],
    ["path is a url", good({ page: { path: "https://evil.example/x?y=1" } }), 400, "invalid", "page.path"],
    ["title not text", good({ page: { path: "/a/", title: 4 } }), 400, "invalid", "page.title"],
    ["no client", good({ client: undefined }), 400, "invalid", "client"],
    ["viewport zero", good({ client: { viewport: { w: 0, h: 10 } } }), 400, "invalid", "client.viewport"],
    ["viewport huge", good({ client: { viewport: { w: 10, h: 99999 } } }), 400, "invalid", "client.viewport"],
    ["viewport text", good({ client: { viewport: { w: "10", h: 10 } } }), 400, "invalid", "client.viewport"],
    ["errors not a list", good({ client: { viewport: { w: 10, h: 10 }, errors: "x" } }), 400, "invalid", "client.errors"],
    ["bad contact", good({ contact: "call me maybe" }), 400, "invalid", "contact"],
    ["includeAccount text", good({ includeAccount: "yes" }), 400, "invalid", "includeAccount"],
    ["no consent", good({ consent: undefined }), 400, "invalid", "consent"],
    ["consent false", good({ consent: false }), 400, "invalid", "consent"],
    ["consent string", good({ consent: "true" }), 400, "invalid", "consent"],
    ["old consent version", good({ consentVersion: "feedback-v0" }), 400, "invalid", "consentVersion"],
  ];
  for (const [name, body, status, code, field] of cases) {
    it(name, async () => {
      const before = (await db.prepare("SELECT COUNT(*) AS n FROM feedback_reports").first<{ n: number }>())!.n;
      const r = await api("/feedback", { body: body === "nope" ? undefined : body, raw: body === "nope" ? ("not json" as BodyInit) : undefined, headers: body === "nope" ? { "content-type": "application/json" } : undefined });
      expect(r.status, r.text).toBe(status);
      expect(r.json.code).toBe(code);
      expect(typeof r.json.error).toBe("string");
      if (field) expect(r.json.field).toBe(field);
      expect((await db.prepare("SELECT COUNT(*) AS n FROM feedback_reports").first<{ n: number }>())!.n).toBe(before);
    });
  }
  it("a valid report is 201 with an id and a 20 minute token; the token is stored hashed only", async () => {
    const c = await created({ contact: "player@example.com" });
    expect(c.id).toMatch(/^[0-9a-f]{32}$/);
    expect(c.attachExpiresIn).toBe(1200);
    expect(c.attachToken.length).toBeGreaterThanOrEqual(30);
    const r = await row(c.id);
    expect(r!.attach_token_hash).toBe(await sha256(c.attachToken));
    expect(JSON.stringify(r)).not.toContain(c.attachToken);
    expect(r!.attach_expires_at - r!.created_at).toBe(1200);
    expect(r).toMatchObject({ kind: "bug", page_path: "/tools/brackets/", page_title: "Brackets", viewport_w: 390, viewport_h: 844, locale: "en-IN", build_id: "b1", contact: "player@example.com", status: "new", user_id: null, signed_in: 0, consent_version: "feedback-v1" });
  });
  it("a body over 16 KB is 413", async () => {
    const r = await post(good({ message: "x ".repeat(9000) }));
    expect(r.status).toBe(413);
    expect(r.json.code).toBe("payload_too_large");
  });
  it("optional parts are optional; a bad locale and build id are dropped, contact kinds are accepted", async () => {
    for (const contact of ["a@b.co", "player_1", "@player.one", "name#1234"]) await created({ contact });
    const c = await created({ client: { viewport: { w: 1, h: 1 }, locale: "not a locale!!", buildId: "bad id with spaces" }, contact: "", page: { path: "/x/" } });
    expect(await row(c.id)).toMatchObject({ locale: null, build_id: null, contact: null, client_errors: null, page_title: null });
  });
  it("control characters are stripped and the text is stored as text", async () => {
    const c = await created({ message: "line one\u0000\u0007 is broken\r\n\r\n\r\n\r\nline <b>two</b>‮ here" });
    expect((await row(c.id))!.message).toBe("line one is broken\n\nline <b>two</b> here");
  });
});

describe("honeypot", () => {
  it("a filled website is accepted and dropped with a normal-looking 201", async () => {
    const before = (await db.prepare("SELECT COUNT(*) AS n FROM feedback_reports").first<{ n: number }>())!.n;
    const ip = "10.77.0.1";
    for (const website of ["http://spam.example", "x", 1, true]) {
      const r = await post(good({ website }), { ip });
      expect(r.status).toBe(201);
      expect(Object.keys(r.json).sort()).toEqual(["attachExpiresIn", "attachToken", "id"]);
      expect(r.json.id).toMatch(/^[0-9a-f]{32}$/);
      expect(await row(r.json.id)).toBeNull();
      expect((await upload(r.json.id, r.json.attachToken, PNG())).status).toBe(401);
    }
    expect((await db.prepare("SELECT COUNT(*) AS n FROM feedback_reports").first<{ n: number }>())!.n).toBe(before);
    // it does not even count against the address (6 honeypot posts, then a real one still passes)
    for (let i = 0; i < 6; i++) await post(good({ website: "x" }), { ip });
    expect((await post(good(), { ip })).status).toBe(201);
  });
  it("a honeypot hit is accepted even when the rest of the body is invalid (bots learn nothing)", async () => {
    expect((await post({ website: "x" })).status).toBe(201);
  });
});

describe("page path: query and hash never stored", () => {
  it("/join/?t=SECRET is stored as /join/ and SECRET appears in no column and no log line", async () => {
    const logs: string[] = [];
    const spies = (["log", "warn", "error", "info"] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(" ")); }));
    try {
      const c = await created({ page: { path: "/join/?t=SECRET#frag-SECRET", title: "Join" }, message: "My link was https://x.example/join/?t=SECRET and token=SECRETVALUE failed" });
      const dump = JSON.stringify(await row(c.id));
      expect(dump).not.toContain("SECRET");
      expect((await row(c.id))!.page_path).toBe("/join/");
      const bad = await post(good({ page: { path: "no-slash?t=SECRET" } }));
      expect(bad.status).toBe(400);
      expect(bad.text).not.toContain("SECRET");
    } finally { spies.forEach((s) => s.mockRestore()); }
    expect(logs.join("\n")).not.toContain("SECRET");
  });
  it("the database itself refuses a ? or # in page_path, a relative path, an empty path and a long one", async () => {
    const ins = (p: string) => db.prepare("INSERT INTO feedback_reports (id, created_at, kind, message, page_path, consent_version) VALUES (?1, 1, 'bug', 'a long enough message', ?2, 'feedback-v1')").bind(crypto.randomUUID().replace(/-/g, ""), p).run();
    await ins("/ok/");
    for (const p of ["/a?b", "/a#b", "a/b", "", "/" + "x".repeat(200)]) await expect(ins(p), p).rejects.toThrow();
  });
  it("normalisePath: strips, collapses ids and tokens, keeps real slugs", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const cases: [string, string | null][] = [
      ["/", "/"], ["/tools/brackets/", "/tools/brackets/"], ["/tools/brackets", "/tools/brackets"],
      ["/join/?t=SECRET", "/join/"], ["/a/b?x=1#y", "/a/b"], ["/a/b#frag", "/a/b"], ["/a%3Fsecret=1", "/a"], ["/a/b%23c", "/a/b"],
      ["//a///b//", "/a/b/"], ["/a/../b/", "/b/"], ["/a;jsessionid=XYZ/b", "/a/b"],
      [`/tournaments/${uuid}/`, "/tournaments/:id/"], ["/pass/0123456789abcdef0123/", "/pass/:id/"], ["/e/123456789/", "/e/:id/"],
      ["/pass/AbC123xyZ789qwErTy/", "/pass/:id/"], ["/live/ab12cd34ef56/", "/live/:id/"],
      ["/invite/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig/", "/invite/:id/"],
      ["/tournaments/bgmi-college-cup-pune/", "/tournaments/bgmi-college-cup-pune/"], ["/players/yaseen/", "/players/yaseen/"], ["/lft/", "/lft/"],
      ["relative/path", null], ["https://x.example/a", null], ["", null], ["?x=1", null], ["#a", null],
    ];
    for (const [input, out] of cases) expect(normalisePath(input), input).toBe(out);
    expect(normalisePath(5)).toBeNull();
    const long = normalisePath("/" + Array.from({ length: 40 }, (_, i) => `segment-${i}`).join("/") + "/")!;
    expect(long.length).toBeLessThanOrEqual(200);
    expect(long.endsWith("/")).toBe(true);
  });
  it("tokens in the path are collapsed end to end", async () => {
    const c = await created({ page: { path: "/pass/AbC123xyZ789qwErTy/photo/?x=1", referrer: "/join/?t=SECRET2" } });
    const r = await row(c.id);
    expect(r!.page_path).toBe("/pass/:id/photo/");
    expect(r!.referrer_path).toBe("/join/");
    expect(JSON.stringify(r)).not.toContain("AbC123");
  });
});

describe("client errors and message secrets", () => {
  it("sanitiseClientError removes tokens, JWTs, emails, passwords, long opaque runs and queries, and truncates", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSJ9.abcdefghijk";
    const out = [
      sanitiseClientError(`fetch failed Authorization: Bearer ${jwt}`),
      sanitiseClientError("login for a.person@example.com failed, password=hunter2 token: abc123def"),
      sanitiseClientError("GET https://api.example/x?key=VERYSECRET failed"),
      sanitiseClientError("bad id 0123456789abcdef0123456789abcdef and AbCdEfGhIjKlMnOpQrStUv123456"),
      sanitiseClientError("x".repeat(500)),
    ];
    const text = out.join("\n");
    for (const s of [jwt, "a.person", "hunter2", "abc123def", "VERYSECRET", "0123456789abcdef0123", "AbCdEfGh"]) expect(text).not.toContain(s);
    expect(out[4]!.length).toBe(200);
    expect(sanitiseClientError("TypeError: Cannot read properties of undefined")).toBe("TypeError: Cannot read properties of undefined");
  });
  it("only 5 strings are kept, non-strings dropped, and the stored value is a JSON array", async () => {
    const c = await created({ client: { viewport: { w: 5, h: 5 }, errors: ["one", 2, null, "three", "four", "five", "six", "seven", "eight"] } });
    expect(JSON.parse((await row(c.id))!.client_errors)).toEqual(["one", "three", "four", "five", "six"]);
  });
  it("redactSecrets and cleanMessage", () => {
    expect(redactSecrets("go to /x?token=abc&y=1")).toContain("token=[redacted]");
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop")).not.toContain("abcdefghijklmnop");
    expect(cleanMessage("a​b\t c")).toBe("ab c");
    expect(looksLikeNoise("aaaaaaaaaaaaaa")).toBe(true);
    expect(looksLikeNoise("the page crashed when I tapped save")).toBe(false);
    expect(looksLikeNoise("यह पेज मेरे फोन पर नहीं खुलता")).toBe(false);
    expect(validContact("x@y.in") && validContact("name#1234") && !validContact("two words")).toBe(true);
  });
});

describe("device and browser come from the user agent, which is never stored", () => {
  const UAS: [string, string, string][] = [
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36", "mobile", "chrome"],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", "mobile", "safari"],
    ["Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", "tablet", "safari"],
    ["Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36", "tablet", "chrome"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0", "desktop", "edge"],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0", "desktop", "firefox"],
    ["Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36", "mobile", "samsung"],
  ];
  for (const [ua, d, b] of UAS) it(`${d}/${b}`, async () => {
    expect(deviceFromUa(ua)).toEqual({ deviceClass: d, browserFamily: b });
    const c = await created({}, { headers: { "user-agent": ua } });
    const r = await row(c.id);
    expect(r).toMatchObject({ device_class: d, browser_family: b });
    expect(JSON.stringify(r)).not.toMatch(/Mozilla|AppleWebKit|Gecko/);
  });
  it("no user agent: device null, browser other", () => expect(deviceFromUa(undefined)).toEqual({ deviceClass: null, browserFamily: "other" }));
  it("the address is never stored, only a keyed hash that depends on the secret", async () => {
    const ip = "203.0.113.77";
    const c = await created({}, { ip });
    const r = await row(c.id);
    expect(JSON.stringify(r)).not.toContain(ip);
    expect(r!.ip_hash).toBe(await hashIp(ip, env));
    expect(r!.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(await hashIp(ip, { JWT_SECRET: env.JWT_SECRET, FEEDBACK_SALT: "another-long-salt-value" })).not.toBe(r!.ip_hash);
    expect(await hashIp(ip, { JWT_SECRET: "other-jwt-secret-other-jwt-secret" })).not.toBe(r!.ip_hash);
    // the rate_limits table holds only hashes too
    expect(JSON.stringify((await db.prepare("SELECT key FROM rate_limits").all()).results)).not.toContain(ip);
  });
});

describe("linking an account", () => {
  it("only includeAccount with a valid token links; a token alone only sets signed_in", async () => {
    const u = await user("Linker");
    const linked = await created({ includeAccount: true }, { token: u.token });
    expect(await row(linked.id)).toMatchObject({ user_id: u.id, signed_in: 1 });
    const unlinked = await created({ includeAccount: false }, { token: u.token });
    expect(await row(unlinked.id)).toMatchObject({ user_id: null, signed_in: 1 });
    const absent = await created({}, { token: u.token });
    expect((await row(absent.id))!.user_id).toBeNull();
  });
  it("includeAccount without a token, or with a bad one, is accepted anonymously", async () => {
    for (const token of [undefined, "garbage", "a.b.c"]) {
      const c = await created({ includeAccount: true }, { token });
      expect(await row(c.id)).toMatchObject({ user_id: null, signed_in: 0 });
    }
  });
  it("a suspended account is not linked", async () => {
    const u = await user("Suspended");
    await db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1").bind(u.id).run();
    const c = await created({ includeAccount: true }, { token: u.token });
    expect((await row(c.id))!.user_id).toBeNull();
  });
  it("the database refuses a user link on a not-signed-in report", async () => {
    const u = await user("Check");
    await expect(db.prepare("INSERT INTO feedback_reports (id, created_at, kind, message, page_path, consent_version, user_id, signed_in) VALUES ('z1', 1, 'bug', 'long enough message', '/a/', 'feedback-v1', ?1, 0)").bind(u.id).run()).rejects.toThrow();
  });
});

describe("rate limits", () => {
  it("5 per hour per address, then 429 rate_limited; another address is unaffected", async () => {
    const ip = "10.88.0.1";
    for (let i = 0; i < 5; i++) expect((await post(good(), { ip })).status).toBe(201);
    const r = await post(good(), { ip });
    expect(r.status).toBe(429);
    expect(r.json.code).toBe("rate_limited");
    expect((await post(good(), { ip: "10.88.0.2" })).status).toBe(201);
    // an invalid request does not use the budget of a fresh address
    const ip2 = "10.88.0.3";
    for (let i = 0; i < 10; i++) expect((await post(good({ kind: "x" }), { ip: ip2 })).status).toBe(400);
    expect((await post(good(), { ip: ip2 })).status).toBe(201);
  });
  it("20 per day: the hourly window is not the only guard", async () => {
    const ip = "10.88.1.1";
    const key = await sha256(`${env.JWT_SECRET}|feedback-day|subject|${await hashIp(ip, env)}`);
    const ws = Math.floor(nowSec() / 86400) * 86400;
    await db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 20)").bind(key, ws).run();
    const r = await post(good(), { ip });
    expect(r.status).toBe(429);
    expect(r.json.code).toBe("rate_limited");
  });
  it("the global cap of 300 a day answers 429 daily_cap", async () => {
    const key = await sha256(`${env.JWT_SECRET}|feedback-global|subject|all`);
    const ws = Math.floor(nowSec() / 86400) * 86400;
    await db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 299) ON CONFLICT (key, window_start) DO UPDATE SET count = 299").bind(key, ws).run();
    expect((await post(good())).status).toBe(201); // the 300th
    const r = await post(good());
    expect(r.status).toBe(429);
    expect(r.json.code).toBe("daily_cap");
    await db.prepare("DELETE FROM rate_limits WHERE key = ?1").bind(key).run();
    expect((await post(good())).status).toBe(201);
  });
});

describe("attachments: token flow", () => {
  it("a screenshot is stored once, with a checked type, size and hash; blobs are separate", async () => {
    const c = await created();
    const png = PNG(300, 5);
    const r = await upload(c.id, c.attachToken, png);
    expect(r.status, r.text).toBe(201);
    expect(r.json.id).toMatch(/^[0-9a-f]{32}$/);
    const meta = await db.prepare("SELECT mime, size_bytes, sha256 FROM feedback_attachments WHERE id = ?1").bind(r.json.id).first<Record<string, unknown>>();
    expect(meta).toMatchObject({ mime: "png", size_bytes: 300 });
    expect(meta!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await db.prepare("SELECT length(data) AS n FROM feedback_attachment_blobs WHERE attachment_id = ?1").bind(r.json.id).first<{ n: number }>())!.n).toBe(300);
    const j = await upload(c.id, c.attachToken, JPEG(300, 6), "image/jpeg");
    expect(j.status).toBe(201);
    expect((await upload(c.id, c.attachToken, WEBP(300, 7), "image/webp")).status).toBe(409); // a third file
    expect((await upload(c.id, c.attachToken, WEBP(300, 7), "image/webp")).json.code).toBe("too_many");
    expect((await db.prepare("SELECT COUNT(*) AS n FROM feedback_attachments WHERE report_id = ?1").bind(c.id).first<{ n: number }>())!.n).toBe(2);
  });
  it("the same file twice stores nothing new and returns the first id", async () => {
    const c = await created();
    const a = await upload(c.id, c.attachToken, PNG(250, 9));
    const b = await upload(c.id, c.attachToken, PNG(250, 9));
    expect(b.status).toBe(201);
    expect(b.json.id).toBe(a.json.id);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM feedback_attachments WHERE report_id = ?1").bind(c.id).first<{ n: number }>())!.n).toBe(1);
  });
  it("401 bad_token: no token, wrong token, another report's token, unknown report, bad id", async () => {
    const c = await created();
    const other = await created();
    for (const [id, tok] of [[c.id, undefined], [c.id, "wrong"], [c.id, other.attachToken], ["0".repeat(32), c.attachToken], ["not-an-id", c.attachToken]] as const) {
      const r = await upload(id, tok, PNG());
      expect(r.status, `${id} ${tok}`).toBe(401);
      expect(r.json.code).toBe("bad_token");
    }
  });
  it("an expired token is refused", async () => {
    const c = await created();
    await db.prepare("UPDATE feedback_reports SET attach_expires_at = ?2 WHERE id = ?1").bind(c.id, nowSec() - 1).run();
    expect((await upload(c.id, c.attachToken, PNG())).status).toBe(401);
    expect((await api(`/feedback/${c.id}`, { method: "DELETE", headers: { "x-attach-token": c.attachToken } })).status).toBe(401);
    expect(await row(c.id)).not.toBeNull();
  });
  it("wrong magic bytes (a GIF, text, an empty body, a type that disagrees) are 400 bad_image", async () => {
    const c = await created();
    const gif = new TextEncoder().encode("GIF89a-----------------");
    for (const [bytes, type] of [[gif, "image/png"], [new TextEncoder().encode("<svg onload=alert(1)>"), "image/png"], [new Uint8Array(0), "image/png"], [PNG(100), "image/jpeg"], [JPEG(100), "image/webp"]] as const) {
      const r = await upload(c.id, c.attachToken, bytes, type);
      expect(r.status, type).toBe(400);
      expect(r.json.code).toBe("bad_image");
    }
    expect((await db.prepare("SELECT COUNT(*) AS n FROM feedback_attachments WHERE report_id = ?1").bind(c.id).first<{ n: number }>())!.n).toBe(0);
  });
  it("415 for any other content type, 413 above 400 KB (at the limit is fine)", async () => {
    const c = await created();
    for (const type of ["image/gif", "image/svg+xml", "text/html", "application/octet-stream"]) {
      const r = await upload(c.id, c.attachToken, PNG(), type);
      expect(r.status, type).toBe(415);
      expect(r.json.code).toBe("unsupported_type");
    }
    expect((await api(`/feedback/${c.id}/attachments`, { raw: PNG(100) as BodyInit, headers: { "x-attach-token": c.attachToken } })).status).toBe(415);
    const big = await upload(c.id, c.attachToken, PNG(409_601, 2));
    expect(big.status).toBe(413);
    expect(big.json.code).toBe("too_big");
    const exact = await upload(c.id, c.attachToken, PNG(409_600, 3));
    expect(exact.status, exact.text).toBe(201);
  });
  it("a chunked body without Content-Length that is too big is also 413", async () => {
    const c = await created();
    const big = PNG(409_601, 4);
    const stream = new ReadableStream({ start(ctl) { ctl.enqueue(big.slice(0, 200_000)); ctl.enqueue(big.slice(200_000)); ctl.close(); } });
    const res = await app.fetch(new Request(`https://api.test/feedback/${c.id}/attachments`, { method: "POST", headers: { "content-type": "image/png", "x-attach-token": c.attachToken, "cf-connecting-ip": "10.99.9.9" }, body: stream, duplex: "half" } as RequestInit), env, { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext);
    expect(res.status).toBe(413);
  });
  it("two uploads racing for the last slot cannot both win (trigger inside the insert)", async () => {
    const c = await created();
    await upload(c.id, c.attachToken, PNG(200, 11));
    const rs = await Promise.all([upload(c.id, c.attachToken, PNG(200, 12)), upload(c.id, c.attachToken, PNG(200, 13))]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM feedback_attachments WHERE report_id = ?1").bind(c.id).first<{ n: number }>())!.n).toBe(2);
  });
  it("storage and daily screenshot caps answer 429 and the report text still works", async () => {
    const c = await created();
    const ws = Math.floor(nowSec() / 86400) * 86400;
    const gk = await sha256(`${env.JWT_SECRET}|feedback-attach-global|subject|all`);
    await db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES (?1, ?2, 100) ON CONFLICT (key, window_start) DO UPDATE SET count = 100").bind(gk, ws).run();
    const r = await upload(c.id, c.attachToken, PNG(200, 21));
    expect(r.status).toBe(429);
    expect(r.json.code).toBe("daily_cap");
    await db.prepare("DELETE FROM rate_limits WHERE key = ?1").bind(gk).run();
    // storage budget: 310 reports with one 400 KB screenshot row each (metadata only) pass the 120 MB budget
    await db.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 310) INSERT INTO feedback_reports (id, created_at, kind, message, page_path, consent_version) SELECT 'fillr' || i, 5, 'bug', 'filler report for budget', '/fill/', 'feedback-v1' FROM n").run();
    await db.prepare("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 310) INSERT INTO feedback_attachments (id, report_id, mime, size_bytes, sha256, created_at) SELECT 'fillx' || i, 'fillr' || i, 'png', 409600, printf('%064d', i), 5 FROM n").run();
    const full = await upload(c.id, c.attachToken, PNG(200, 22));
    expect(full.status).toBe(429);
    expect(full.json.code).toBe("storage_full");
    await db.prepare("DELETE FROM feedback_reports WHERE id LIKE 'fillr%'").run();
    expect((await upload(c.id, c.attachToken, PNG(200, 23))).status).toBe(201);
  });
});

describe("DELETE /feedback/:id (withdraw)", () => {
  it("with the token: 204 and the report, attachments and bytes are gone; reused token 401", async () => {
    const c = await created();
    const a = await upload(c.id, c.attachToken, PNG(200, 31));
    const bad = await api(`/feedback/${c.id}`, { method: "DELETE", headers: { "x-attach-token": "wrong" } });
    expect(bad.status).toBe(401);
    expect((await api(`/feedback/${c.id}`, { method: "DELETE" })).status).toBe(401);
    expect(await row(c.id)).not.toBeNull();
    const ok = await api(`/feedback/${c.id}`, { method: "DELETE", headers: { "x-attach-token": c.attachToken } });
    expect(ok.status).toBe(204);
    expect(await row(c.id)).toBeNull();
    for (const t of ["feedback_attachments", "feedback_attachment_blobs"]) expect((await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE ${t === "feedback_attachments" ? "id" : "attachment_id"} = ?1`).bind(a.json.id).first<{ n: number }>())!.n).toBe(0);
    expect((await api(`/feedback/${c.id}`, { method: "DELETE", headers: { "x-attach-token": c.attachToken } })).status).toBe(401);
  });
});

describe("staff API", () => {
  const A = (path: string, token?: string, o: { method?: string; body?: unknown } = {}) => api(path, { token, ...o });
  async function seed() {
    const mark = `m${Date.now().toString(36)}`;
    const u = await user("Reporter");
    const c1 = await created({ kind: "idea", message: `${mark} please add dark mode to the bracket page`, page: { path: "/tools/brackets/" }, contact: "fan@example.com", includeAccount: true }, { token: u.token });
    const c2 = await created({ kind: "bug", message: `${mark} save button 100% broken_here`, page: { path: "/join/" } });
    const att = await upload(c1.id, c1.attachToken, PNG(321, 41));
    return { mark, u, c1, c2, att: att.json.id as string };
  }

  it("anonymous, ordinary users, garbage and forged tokens get the console's plain 404; nothing is exposed", async () => {
    await enableConsole();
    const { c1, att } = await seed();
    const u = await user("Plain");
    const paths: [string, string][] = [["GET", "/admin/v1/feedback"], ["GET", "/admin/v1/feedback/summary"], ["GET", `/admin/v1/feedback/${c1.id}`], ["GET", `/admin/v1/feedback/${c1.id}/attachments/${att}`], ["PATCH", `/admin/v1/feedback/${c1.id}`]];
    for (const [method, p] of paths) for (const token of [undefined, u.token, "garbage"]) {
      const r = await A(p, token, { method, body: method === "PATCH" ? { status: "fixed" } : undefined });
      expect(r.status, `${method} ${p} ${token}`).toBe(404);
      expect(r.json).toEqual({ error: "Not found" });
    }
    expect((await row(c1.id))!.status).toBe("new");
  });

  it("a staff token lists newest first without blobs, contact, user id or ip hash, and filters work", async () => {
    const { mark, c1, c2 } = await seed();
    const s = await makeStaff();
    const t = (await s.login()).token;
    await db.prepare("UPDATE feedback_reports SET created_at = created_at - 10 WHERE id = ?1").bind(c1.id).run();
    const list = await A(`/admin/v1/feedback?q=${mark}`, t);
    expect(list.status, list.text).toBe(200);
    expect(list.json.items.map((i: { id: string }) => i.id)).toEqual([c2.id, c1.id]);
    const text = list.text;
    for (const s2 of ["fan@example.com", "ip_hash", "ipHash", "attach_token", "userId", "user_id", "data\":"]) expect(text).not.toContain(s2);
    const item = list.json.items[1];
    expect(Object.keys(item).sort()).toEqual(["attachmentCount", "browserFamily", "buildId", "clientErrors", "consentVersion", "createdAt", "deviceClass", "hasContact", "id", "kind", "linkedAccount", "locale", "message", "pageTitle", "pagePath", "signedIn", "staffNote", "status", "viewport"].sort());
    expect(item).toMatchObject({ kind: "idea", hasContact: true, linkedAccount: true, attachmentCount: 1, pagePath: "/tools/brackets/", viewport: { w: 390, h: 844 }, clientErrors: ["TypeError: x is undefined"] });
    expect((await A(`/admin/v1/feedback?q=${mark}&kind=bug`, t)).json.items.map((i: { id: string }) => i.id)).toEqual([c2.id]);
    expect((await A(`/admin/v1/feedback?q=${mark}&page=/join/`, t)).json.items.map((i: { id: string }) => i.id)).toEqual([c2.id]);
    expect((await A(`/admin/v1/feedback?q=${mark} save button 100%25`, t)).json.items.map((i: { id: string }) => i.id)).toEqual([c2.id]); // % and _ are literal
    expect((await A(`/admin/v1/feedback?q=${mark}&status=fixed`, t)).json.items).toEqual([]);
    for (const bad of ["status=x", "kind=x", "limit=0", "limit=101", "limit=abc", "cursor=zzz", "q=a", "page=nope"]) expect((await A(`/admin/v1/feedback?${bad}`, t)).status, bad).toBe(400);
  });

  it("paging by cursor visits every report once, newest first", async () => {
    const mark = `pg${Date.now().toString(36)}`;
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await created({ message: `${mark} paging report number ${i} here` })).id);
    await db.prepare("UPDATE feedback_reports SET created_at = 1700000000 WHERE message LIKE ?1").bind(`${mark}%`).run(); // equal timestamps: the id breaks ties
    const s = await makeStaff();
    const t = (await s.login()).token;
    const seen: string[] = [];
    let cursor: string | null = "";
    for (let i = 0; i < 5 && cursor !== null; i++) {
      const r = await A(`/admin/v1/feedback?q=${mark}&limit=2${cursor ? `&cursor=${cursor}` : ""}`, t);
      seen.push(...r.json.items.map((x: { id: string }) => x.id));
      cursor = r.json.next;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual([...seen].sort().reverse());
  });

  it("detail adds contact, account id and attachment metadata; the attachment downloads with safe headers; purged is 410", async () => {
    const { c1, u, att } = await seed();
    const s = await makeStaff();
    const t = (await s.login()).token;
    const d = await A(`/admin/v1/feedback/${c1.id}`, t);
    expect(d.status).toBe(200);
    expect(d.json).toMatchObject({ contact: "fan@example.com", userId: u.id, attachments: [{ id: att, mime: "png", sizeBytes: 321, purged: false }] });
    expect(d.text).not.toContain("ip_hash");
    const f = await A(`/admin/v1/feedback/${c1.id}/attachments/${att}`, t);
    expect(f.status).toBe(200);
    expect(f.headers.get("content-type")).toBe("image/png");
    expect(f.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(f.headers.get("x-content-type-options")).toBe("nosniff");
    expect(f.headers.get("cache-control")).toContain("no-store");
    expect(f.bytes.length).toBe(321);
    expect((await A(`/admin/v1/feedback/${c1.id}/attachments/${"0".repeat(32)}`, t)).status).toBe(404);
    expect((await A(`/admin/v1/feedback/${"0".repeat(32)}`, t)).status).toBe(404);
    expect((await A(`/admin/v1/feedback/bad-id`, t)).status).toBe(404);
    await runRetention(env.DB, { daily: true, now: nowSec() + 91 * 86_400 });
    expect((await A(`/admin/v1/feedback/${c1.id}/attachments/${att}`, t)).status).toBe(410);
    expect((await A(`/admin/v1/feedback/${c1.id}`, t)).json.attachments[0].purged).toBe(true);
  });

  it("PATCH sets status and note, validates, and is audited without the note text", async () => {
    const { c2 } = await seed();
    const s = await makeStaff();
    const t = (await s.login()).token;
    const patch = (body: unknown) => A(`/admin/v1/feedback/${c2.id}`, t, { method: "PATCH", body });
    for (const bad of [{}, { status: "done" }, { status: 3 }, { staffNote: 5 }, { staffNote: "x".repeat(1001) }]) expect((await patch(bad)).status, JSON.stringify(bad).slice(0, 30)).toBe(400);
    const r = await patch({ status: "triaged", staffNote: "reproduced on Android, fix in next build" });
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ status: "triaged", staffNote: "reproduced on Android, fix in next build" });
    expect((await patch({ staffNote: null })).json.staffNote).toBeNull();
    expect((await patch({ status: "fixed" })).json.status).toBe("fixed");
    expect((await A(`/admin/v1/feedback/${"1".repeat(32)}`, t, { method: "PATCH", body: { status: "fixed" } })).status).toBe(404);
    const rows = await auditRows("feedback.updated", c2.id);
    expect(rows.length).toBe(3);
    expect(rows.every((x) => x.actor_type === "staff" && x.actor_id === s.id && x.target_type === "feedback")).toBe(true);
    expect(JSON.stringify(rows)).not.toContain("reproduced");
    expect(await auditRows("feedback.updated", "1".repeat(32))).toEqual([]);
    expect((await A(`/admin/v1/feedback`, t, { method: "DELETE" })).status).toBe(404);
  });

  it("summary: counts by status and kind and the top pages of the last 30 days", async () => {
    await db.prepare("DELETE FROM feedback_reports").run();
    for (let i = 0; i < 3; i++) await created({ page: { path: "/hot/" } });
    await created({ kind: "idea", page: { path: "/cold/" } });
    const old = await created({ page: { path: "/old/" } });
    await db.prepare("UPDATE feedback_reports SET created_at = ?2, status = 'fixed' WHERE id = ?1").bind(old.id, nowSec() - 40 * 86_400).run();
    const s = await makeStaff();
    const r = await A("/admin/v1/feedback/summary", (await s.login()).token);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ total: 5, byStatus: { new: 4, triaged: 0, fixed: 1, wontfix: 0 }, byKind: { bug: 4, idea: 1, confusing: 0, other: 0 }, newLast7Days: 4 });
    expect(r.json.topPages).toEqual([{ pagePath: "/hot/", count: 3 }, { pagePath: "/cold/", count: 1 }]);
    expect(r.text).not.toContain("ip_hash");
  });

  it("with feedback.enabled off the staff routes are 404 too", async () => {
    const s = await makeStaff();
    const t = (await s.login()).token;
    await flags();
    expect((await A("/admin/v1/feedback", t)).status).toBe(404);
    expect((await A("/admin/v1/feedback/summary", t)).status).toBe(404);
  });
});

describe("retention", () => {
  it("bytes go after 90 days (row stays with purged_at), reports after 12 months, only on the daily tick", async () => {
    const a = await created();
    const b = await created();
    const f = await upload(a.id, a.attachToken, PNG(200, 51));
    const T = nowSec();
    const tick = await runRetention(env.DB, { daily: false, now: T + 400 * 86_400 });
    expect(tick.feedbackBytesPurged + tick.feedbackDeleted).toBe(0);
    const early = await runRetention(env.DB, { daily: true, now: T + 89 * 86_400 });
    expect(early.feedbackBytesPurged).toBe(0);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM feedback_attachment_blobs WHERE attachment_id = ?1").bind(f.json.id).first<{ n: number }>())!.n).toBe(1);
    const late = await runRetention(env.DB, { daily: true, now: T + 91 * 86_400 });
    expect(late.feedbackBytesPurged).toBeGreaterThanOrEqual(1);
    expect((await db.prepare("SELECT COUNT(*) AS n FROM feedback_attachment_blobs WHERE attachment_id = ?1").bind(f.json.id).first<{ n: number }>())!.n).toBe(0);
    expect((await db.prepare("SELECT purged_at IS NOT NULL AS p FROM feedback_attachments WHERE id = ?1").bind(f.json.id).first<{ p: number }>())!.p).toBe(1);
    expect(await row(a.id)).not.toBeNull();
    await runRetention(env.DB, { daily: true, now: T + 364 * 86_400 }); // other tests' older rows may go; these two are 364 days old and stay
    expect(await row(a.id)).not.toBeNull();
    expect(await row(b.id)).not.toBeNull();
    const year = await runRetention(env.DB, { daily: true, now: T + 366 * 86_400 });
    expect(year.feedbackDeleted).toBeGreaterThanOrEqual(2);
    expect(await row(a.id)).toBeNull();
    expect(await row(b.id)).toBeNull();
    expect((await db.prepare("SELECT COUNT(*) AS n FROM feedback_attachments WHERE id = ?1").bind(f.json.id).first<{ n: number }>())!.n).toBe(0);
  });
  it("runs even while the flag is off", async () => {
    const a = await created();
    await flags();
    await runRetention(env.DB, { daily: true, now: nowSec() + 400 * 86_400 });
    expect(await row(a.id)).toBeNull();
  });
});
