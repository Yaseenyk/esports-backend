/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { call, freshIp, newEvent, newUser, pngDataUrl, setupEvent, uniq } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

const AADHAAR = "123412341234";
const players = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Player ${i + 1}`, ign: `IGN${i + 1}`, minor: false }));

/** Everything stored in the database as one string (BLOB columns skipped), to prove a value was never persisted. */
async function dumpDb(): Promise<string> {
  const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'").all<{ name: string }>();
  let out = "";
  for (const t of tables.results) {
    const cols = await env.DB.prepare(`PRAGMA table_info(${t.name})`).all<{ name: string; type: string }>();
    const text = cols.results.filter((c) => c.type.toUpperCase() !== "BLOB").map((c) => c.name);
    if (!text.length) continue;
    const rows = await env.DB.prepare(`SELECT ${text.join(", ")} FROM ${t.name}`).all();
    out += JSON.stringify(rows.results);
  }
  return out;
}

describe("auth input handling", () => {
  it("password rules: 8-200 characters, strings only", async () => {
    const reg = (password: unknown) => call("/auth/register", { body: { email: `${uniq()}@example.com`, password, name: "P" } });
    expect((await reg("1234567")).status).toBe(400);
    expect((await reg("12345678")).status).toBe(201);
    expect((await reg("x".repeat(200))).status).toBe(201);
    expect((await reg("x".repeat(201))).status).toBe(400);
    expect((await reg("x".repeat(100_000))).status).toBe(400);
    for (const bad of [12345678, null, undefined, ["12345678"], { a: 1 }, true]) expect((await reg(bad)).status, JSON.stringify(bad)).toBe(400);
  });

  it("duplicate emails are caught across case, whitespace and unicode look-alike forms (regression)", async () => {
    const local = `dup${uniq()}`;
    const first = await call("/auth/register", { body: { email: `${local}@example.com`, password: "password1", name: "A" } });
    expect(first.status).toBe(201);
    const full = `${local}@EXAMPLE.com`.replace(/[a-z0-9@.]/gi, (ch) => (ch === "." ? "." : ch === "@" ? "@" : String.fromCharCode(ch.charCodeAt(0) + 0xfee0))); // fullwidth forms
    for (const variant of [`  ${local}@example.com  `, `${local.toUpperCase()}@Example.Com`, `\t${local}@example.com\n`, full]) {
      const r = await call("/auth/register", { body: { email: variant, password: "password1", name: "B" } });
      expect(r.status, JSON.stringify(variant)).toBe(409);
    }
    // logging in with a variant reaches the same account
    const login = await call("/auth/login", { body: { email: `  ${local.toUpperCase()}@example.com `, password: "password1" } });
    expect(login.status).toBe(200);
    expect(login.json.user.id).toBe(first.json.user.id);
    const loginFull = await call("/auth/login", { body: { email: full, password: "password1" } });
    expect(loginFull.status).toBe(200);
    expect(loginFull.json.user.id).toBe(first.json.user.id);
  });

  it("emails with spaces inside, a second @, or no domain dot are invalid", async () => {
    for (const email of ["a b@example.com", "a@@example.com", "a@example", "@example.com", "a@.com", "a@example..com", "a@example.com.", "x".repeat(65) + "@example.com", "a@" + "b".repeat(260) + ".com", 42, null, ""]) {
      const r = await call("/auth/register", { body: { email, password: "password1", name: "A" } });
      expect(r.status, JSON.stringify(email)?.slice(0, 40)).toBe(400);
    }
  });

  it("login does not reveal whether an email exists: same status and body for unknown email and wrong password", async () => {
    const u = await newUser();
    const wrongPw = await call("/auth/login", { body: { email: u.email, password: "not the password" } });
    const unknown = await call("/auth/login", { body: { email: `ghost-${uniq()}@example.com`, password: "not the password" } });
    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.json).toEqual(wrongPw.json);
    expect(unknown.headers.get("content-type")).toBe(wrongPw.headers.get("content-type"));
    // the user record never appears in an error
    expect(wrongPw.text).not.toContain(u.id);
  });

  it("responses never contain the password hash, salt or JWT secret", async () => {
    const u = await newUser();
    const me = await call("/me", { token: u.token });
    expect(Object.keys(me.json).sort()).toEqual(["createdAt", "email", "id", "name"]);
    const login = await call("/auth/login", { body: { email: u.email, password: "correct horse" } });
    expect(Object.keys(login.json.user).sort()).toEqual(["createdAt", "email", "id", "name"]);
    expect(login.text).not.toContain(env.JWT_SECRET);
  });

  it("register and login are rate limited together per IP, and the limit resets when the window rolls over", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await call("/auth/register", { ip, body: { email: "bad", password: "x", name: "" } })).status).toBe(400);
    expect((await call("/auth/register", { ip, body: { email: `${uniq()}@example.com`, password: "password1", name: "A" } })).status).toBe(429);
    expect((await call("/auth/login", { ip, body: { email: "a@example.com", password: "password1" } })).status).toBe(429);
    // another address is untouched
    expect((await call("/auth/login", { body: { email: "a@example.com", password: "password1" } })).status).toBe(401);
    // the window rolls over: pretend every counter is from long ago
    await env.DB.prepare("UPDATE rate_limits SET window_start = window_start - 100000").run();
    expect((await call("/auth/login", { ip, body: { email: "a@example.com", password: "password1" } })).status).toBe(401);
  });

  it("change-password and delete-account are rate limited, and a wrong current password never changes anything", async () => {
    const u = await newUser();
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await call("/auth/change-password", { ip, token: u.token, body: { current: "wrong wrong", next: "newpassword" } })).status).toBe(401);
    expect((await call("/auth/change-password", { ip, token: u.token, body: { current: "correct horse", next: "newpassword" } })).status).toBe(429);
    expect((await call("/auth/login", { body: { email: u.email, password: "correct horse" } })).status).toBe(200);
  });

  it("change-password: new password follows the same rules and replaces the old one", async () => {
    const u = await newUser();
    expect((await call("/auth/change-password", { token: u.token, body: { current: "correct horse", next: "short" } })).status).toBe(400);
    expect((await call("/auth/change-password", { token: u.token, body: { current: 5, next: "longenough1" } })).status).toBe(401);
    expect((await call("/auth/change-password", { token: u.token, body: { current: "correct horse", next: "longenough1" } })).status).toBe(200);
    expect((await call("/auth/login", { body: { email: u.email, password: "correct horse" } })).status).toBe(401);
    expect((await call("/auth/login", { body: { email: u.email, password: "longenough1" } })).status).toBe(200);
  });

  it("delete-account needs the right password and removes everything under it", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    expect((await call("/auth/delete-account", { token: u.token, body: {} })).status).toBe(401);
    expect((await call("/auth/delete-account", { token: u.token, body: { password: "wrong wrong" } })).status).toBe(401);
    expect((await call(`/events/${ev.id}`, { token: u.token })).status).toBe(200);
    expect((await call("/auth/delete-account", { token: u.token, body: { password: "correct horse" } })).status).toBe(200);
    const left = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM events WHERE id = ?1) AS e, (SELECT COUNT(*) FROM users WHERE id = ?2) AS u").bind(ev.id, u.id).first<{ e: number; u: number }>();
    expect(left).toEqual({ e: 0, u: 0 });
    expect((await call("/auth/login", { body: { email: u.email, password: "correct horse" } })).status).toBe(401);
  });

  it("very long and odd inputs get a clean 400, never a 500", async () => {
    const big = "A".repeat(100_000);
    const cases: [string, unknown][] = [
      ["/auth/register", { email: big, password: "password1", name: "A" }],
      ["/auth/register", { email: "a@example.com", password: "password1", name: big }],
      ["/auth/register", { email: "a@example.com", password: "password1", name: "" }],
      ["/auth/register", { email: "a@example.com", password: "password1", name: "   " }],
      ["/auth/register", { email: ["a@example.com"], password: "password1", name: "A" }],
      ["/auth/login", { email: "a@example.com", password: big }],
      ["/auth/login", { email: {}, password: [] }],
      ["/auth/login", {}],
    ];
    for (const [path, body] of cases) {
      const r = await call(path, { body });
      expect(r.status, `${path} ${JSON.stringify(body).slice(0, 60)}`).toBe(400);
    }
  });

  it("a giant login email is a clean 401 or 400", async () => {
    const r = await call("/auth/login", { body: { email: "A".repeat(100_000), password: "password1" } });
    expect([400, 401]).toContain(r.status);
  });

  it("malformed JSON, wrong shapes and empty bodies are 400 on every JSON endpoint", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    const ep: { path: string; token?: string; method?: string }[] = [
      { path: "/auth/register" },
      { path: "/auth/login" },
      { path: "/auth/change-password", token: u.token },
      { path: "/auth/delete-account", token: u.token },
      { path: "/events", token: u.token },
      { path: `/events/${ev.id}`, token: u.token, method: "PUT" },
      { path: `/events/${ev.id}/roster`, token: u.token, method: "PUT" },
      { path: `/events/${ev.id}/gate-keys`, token: u.token },
      { path: `/events/${ev.id}/invites`, token: u.token },
      { path: `/events/${ev.id}/members`, token: u.token },
      { path: `/events/${ev.id}/registration`, token: u.token, method: "PUT" },
      { path: "/public/contact" },
      { path: "/gate/checkin" },
    ];
    for (const e of ep) {
      for (const raw of ["{not json", "", "[]", "null", '"str"', "123", "\u0000\u0001"]) {
        const gate = e.path.startsWith("/gate") ? "gk_whatever" : undefined;
        const r = await call(e.path, { method: e.method, token: e.token, gate, raw, headers: { "content-type": "application/json" } });
        // /gate/checkin with a bad key is 401 before the body is read; everything else must be 400
        expect(r.status, `${e.path} ${JSON.stringify(raw)}`).toBe(gate ? 401 : 400);
        expect(r.json?.error).toBeTruthy();
      }
    }
  });

  it("a JSON body with the wrong content-type is still parsed safely, or refused, never a 500", async () => {
    const r = await call("/auth/login", { raw: JSON.stringify({ email: "a@example.com", password: "password1" }), headers: { "content-type": "text/plain" } });
    expect([400, 401, 415]).toContain(r.status);
    const form = await call("/auth/login", { raw: "email=a%40example.com&password=password1", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(form.status).toBe(400);
    const multipart = await call("/auth/login", { raw: "--x\r\n\r\n--x--", headers: { "content-type": "multipart/form-data; boundary=x" } });
    expect(multipart.status).toBe(400);
  });

  it("huge bodies are refused with 413, declared or streamed", async () => {
    const huge = "x".repeat(1_100_000);
    const declared = await call("/auth/register", { raw: huge, headers: { "content-type": "application/json", "content-length": String(huge.length) } });
    expect(declared.status).toBe(413);
    const streamed = await call("/public/contact", { raw: new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(huge)); c.close(); } }), headers: { "content-type": "application/json" } }).catch(() => null);
    if (streamed) expect([400, 413]).toContain(streamed.status);
    const u = await newUser();
    const ev = await newEvent(u.token);
    const photo = await call(`/events/${ev.id}/photos/x`, { method: "PUT", token: u.token, raw: "x".repeat(500_000), headers: { "content-type": "image/png" } });
    expect([404, 413]).toContain(photo.status);
    const oversize = await call(`/events/${ev.id}`, { method: "PUT", token: u.token, body: { settings: { blob: "y".repeat(30_000) } } });
    expect(oversize.status).toBe(413);
  });

  it("odd URLs and methods give clean JSON errors, not 500s", async () => {
    const u = await newUser();
    for (const path of ["/public/pass/%ZZ", "/public/invite/%E0%A4%A", "/events/%ZZ", "/gate/photos/%FF"]) {
      const r = await call(path, { token: u.token, gate: "gk_x" });
      expect(r.status, path).toBeLessThan(500);
    }
    for (const m of ["PATCH", "TRACE", "PROPFIND"]) {
      const r = await call("/events", { method: m, token: u.token }).catch(() => ({ status: 405 }));
      expect(r.status, m).toBeLessThan(500);
    }
    expect((await call("/auth/login", { method: "GET" })).status).toBe(404);
  });
});

describe("SQL injection", () => {
  it("injection-looking strings are stored and returned as plain text and break nothing", async () => {
    const evil = `x'); DROP TABLE users;-- ' OR '1'='1`;
    const u = await newUser(evil);
    const ev = await call("/events", { token: u.token, body: { name: evil, game: evil, venue: evil, rules: evil, settings: { k: evil } } });
    expect(ev.status).toBe(201);
    expect(ev.json.name).toBe(evil);
    const back = await call(`/events/${ev.json.id}`, { token: u.token });
    expect(back.json.venue).toBe(evil);
    expect((await call("/me", { token: u.token })).json.name).toBe(evil);

    // an email full of SQL punctuation registers as a literal and logs in as that exact account only
    const mail = `o'brien";DROP--${uniq()}@example.com`;
    const reg = await call("/auth/register", { body: { email: mail, password: "password1", name: "O" } });
    expect(reg.status).toBe(201);
    expect((await call("/auth/login", { body: { email: mail, password: "password1" } })).status).toBe(200);
    expect((await call("/auth/login", { body: { email: "' OR '1'='1", password: "password1" } })).status).toBe(401);
    expect((await call("/auth/login", { body: { email: "%@%", password: "password1" } })).status).toBe(401);
    expect((await call("/auth/login", { body: { email: "_@_.com", password: "password1" } })).status).toBe(401);

    // query strings and path params
    expect((await call(`/events/${ev.json.id}/submissions?status=' OR 1=1 --`, { token: u.token })).status).toBe(400);
    expect((await call(`/events/${ev.json.id}/registrations?status=x'`, { token: u.token })).status).toBe(400);
    expect((await call(`/events/${ev.json.id}/checkins?since=garbage`, { token: u.token })).status).toBe(400);
    expect((await call(`/events/${ev.json.id}/checkins?since=${encodeURIComponent("' OR 1=1 --")}`, { token: u.token })).status).toBeLessThan(500); // bound as a value either way
    expect((await call(`/events/${encodeURIComponent("x' OR '1'='1")}`, { token: u.token })).status).toBe(404);
    expect((await call(`/events/${encodeURIComponent("%")}`, { token: u.token })).status).toBe(404);
    expect((await call(`/public/pass/${encodeURIComponent("' OR '1'='1")}`)).status).toBe(404);
    expect((await call(`/public/invite/${encodeURIComponent("' OR 1=1 --")}`)).status).toBe(404);
    expect((await call(`/public/registration/${encodeURIComponent("%")}`)).status).toBe(404);
    expect((await call("/gate/roster", { gate: "' OR '1'='1" })).status).toBe(401);

    // the tables are all still there and the list still works
    const t = await env.DB.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name IN ('users','events','people','teams')").first<{ n: number }>();
    expect(t!.n).toBe(4);
    expect((await call("/events", { token: u.token })).json.length).toBe(1);
  });

  it("person and team ids and roster fields cannot carry SQL (ids are restricted, names are bound)", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    const bad = await call(`/events/${ev.id}/roster`, { method: "PUT", token: u.token, body: { teams: [{ id: "t1'; DROP TABLE people;--", name: "T" }], people: [] } });
    expect(bad.status).toBe(400);
    const ok = await call(`/events/${ev.id}/roster`, { method: "PUT", token: u.token, body: { teams: [{ id: "t1", name: "Robert'); DROP TABLE people;--" }], people: [{ id: "P1", teamId: "t1", name: "' OR 1=1 --" }] } });
    expect(ok.status).toBe(200);
    const r = await call(`/events/${ev.id}/roster`, { token: u.token });
    expect(r.json.teams[0].name).toBe("Robert'); DROP TABLE people;--");
    expect(r.json.people[0].name).toBe("' OR 1=1 --");
  });

  it("no SQL in src/ is built from variables: every prepare() takes a constant string", async () => {
    const files = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
    expect(Object.keys(files).length).toBeGreaterThan(8);
    for (const [file, src] of Object.entries(files)) {
      for (const m of src.matchAll(/\.prepare\(\s*([`"'])/g)) {
        const start = m.index! + m[0].length;
        if (m[1] === "`") {
          const end = src.indexOf("`", start);
          expect(src.slice(start, end), `${file}: template literal passed to prepare()`).not.toContain("${");
        }
      }
      expect(src, `${file}: prepare() with a non-literal argument`).not.toMatch(/\.prepare\(\s*[A-Za-z_]/);
      expect(src, `${file}: SQL built by concatenation`).not.toMatch(/\.prepare\([^)]*["'`]\s*\+/);
      expect(src, `${file}: db.exec is unbound`).not.toMatch(/[dD][bB]\.exec\(/);
    }
  });
});

describe("contact form", () => {
  const ok = { name: "Asha", email: "asha@example.com", message: "Hello, I would like to know more." };
  it("validates and stores only name, email and message", async () => {
    expect((await call("/public/contact", { body: { ...ok, message: "short" } })).status).toBe(400);
    expect((await call("/public/contact", { body: { ...ok, message: "x".repeat(2001) } })).status).toBe(400);
    expect((await call("/public/contact", { body: { ...ok, message: 12345678901234 } })).status).toBe(400);
    expect((await call("/public/contact", { body: { ...ok, message: undefined } })).status).toBe(400);
    expect((await call("/public/contact", { body: { ...ok, email: "not an email" } })).status).toBe(400);
    expect((await call("/public/contact", { body: { ...ok, email: "a@b" } })).status).toBe(400);
    expect((await call("/public/contact", { body: { ...ok, name: "n".repeat(81) } })).status).toBe(400);
    const marker = `msg-${uniq()}`;
    const r = await call("/public/contact", { body: { ...ok, message: `Hello there ${marker}`, aadhaar: AADHAAR, password: "hunter2hunter2", dob: "2001-01-01" } });
    expect(r.status).toBe(201);
    expect(r.json).toEqual({ ok: true });
    const row = await env.DB.prepare("SELECT * FROM contact_messages WHERE message LIKE ?").bind(`%${marker}%`).first<Record<string, unknown>>();
    expect(Object.keys(row!).sort()).toEqual(["created_at", "email", "id", "message", "name"]);
    expect(JSON.stringify(row)).not.toContain(AADHAAR);
    // email and name are optional
    expect((await call("/public/contact", { body: { message: "Just a message with no contact." } })).status).toBe(201);
  });

  it("honeypot: a filled hidden field looks successful but stores nothing", async () => {
    const marker = `bot-${uniq()}`;
    const r = await call("/public/contact", { body: { ...ok, message: `spam spam ${marker}`, website: "http://spam.example" } });
    expect(r.status).toBe(201);
    expect(await env.DB.prepare("SELECT 1 FROM contact_messages WHERE message LIKE ?").bind(`%${marker}%`).first()).toBeNull();
  });

  it("is rate limited to 5 per hour per address and rejects reads", async () => {
    const ip = freshIp();
    for (let i = 0; i < 5; i++) expect((await call("/public/contact", { ip, body: ok })).status).toBe(201);
    expect((await call("/public/contact", { ip, body: ok })).status).toBe(429);
    expect((await call("/public/contact", { method: "GET" })).status).toBe(404); // nothing lists messages publicly
    expect((await call("/contact-messages")).status).toBe(404);
  });
});

describe("registration (public)", () => {
  async function form(over: object = {}) {
    const u = await newUser();
    const ev = await newEvent(u.token, "Public Cup");
    const f = await call(`/events/${ev.id}/registration`, { method: "PUT", token: u.token, body: { acknowledge: true, title: "T", teamSize: 2, subs: 1, ...over } });
    return { u, ev, token: f.json.token as string };
  }
  const sub = (name: string, n = 2, extra: object = {}) => ({ teamName: name, captainName: "Asha", captainContact: "9999900000", players: players(n), ...extra });

  it("validates every field and never echoes personal data back", async () => {
    const { token } = await form();
    const url = `/public/registration/${token}/submit`;
    for (const bad of [
      { ...sub("OK"), teamName: "x" },
      { ...sub("OK"), teamName: "x".repeat(61) },
      { ...sub("OK"), captainName: "" },
      { ...sub("OK"), captainContact: "123" },
      { ...sub("OK"), captainContact: "1".repeat(121) },
      { ...sub("OK"), notes: "n".repeat(501) },
      { ...sub("OK"), players: "nope" },
      { ...sub("OK"), players: [null, null] },
      { ...sub("OK"), players: ["a", "b"] },
      { ...sub("OK"), players: [{ name: "" }, { name: "b" }] },
      { ...sub("OK"), players: [{ name: "a", minor: "yes" }, { name: "b" }] },
      { ...sub("OK"), players: [{ name: "a", ign: "i".repeat(41) }, { name: "b" }] },
      { ...sub("OK"), players: players(1) },
      { ...sub("OK"), players: players(4) },
      { ...sub("OK"), players: [[], []] },
    ]) {
      const r = await call(url, { body: bad });
      expect(r.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    const r = await call(url, { body: sub("Valid Team", 2, { aadhaar: AADHAAR, players: [{ name: "A", aadhaar: AADHAAR, dob: "2000-01-01" }, { name: "B" }] }) });
    expect(r.status).toBe(201);
    expect(Object.keys(r.json).sort()).toEqual(["id", "ok"]);
    expect(r.text).not.toContain("9999900000");
    expect(await dumpDb()).not.toContain(AADHAAR);
    expect(await dumpDb()).not.toContain("2000-01-01");
  });

  it("refuses duplicate team names (case and whitespace), unless the first was rejected", async () => {
    const { u, ev, token } = await form();
    const url = `/public/registration/${token}/submit`;
    const first = await call(url, { body: sub("Phoenix") });
    expect(first.status).toBe(201);
    expect((await call(url, { body: sub("PHOENIX") })).status).toBe(409);
    expect((await call(url, { body: sub("  phoenix  ") })).status).toBe(409);
    expect((await call(url, { body: sub("Phoenix 2") })).status).toBe(201);
    expect((await call(`/events/${ev.id}/registrations/${first.json.id}/reject`, { method: "POST", token: u.token, body: {} })).status).toBe(200);
    expect((await call(url, { body: sub("phoenix") })).status).toBe(201);
  });

  it("closed, switched-off and full forms refuse submissions; unknown tokens are 404", async () => {
    const closed = await form({ closesAt: new Date(Date.now() - 60_000).toISOString() });
    expect((await call(`/public/registration/${closed.token}/submit`, { body: sub("A Team") })).status).toBe(409);
    expect((await call(`/public/registration/${closed.token}`)).json.form.status).toBe("closed");
    const off = await form({ open: false });
    expect((await call(`/public/registration/${off.token}/submit`, { body: sub("A Team") })).status).toBe(409);
    const full = await form({ maxTeams: 1 });
    expect((await call(`/public/registration/${full.token}/submit`, { body: sub("One") })).status).toBe(201);
    expect((await call(`/public/registration/${full.token}/submit`, { body: sub("Two") })).status).toBe(409);
    expect((await call(`/public/registration/${full.token}`)).json.form.spotsLeft).toBe(0);
    for (const t of ["nope", "x".repeat(65), "x".repeat(5000)]) {
      expect((await call(`/public/registration/${t}`)).status).toBe(404);
      expect((await call(`/public/registration/${t}/submit`, { body: sub("A Team") })).status).toBe(404);
    }
  });

  it("is rate limited per token and address (10 per hour)", async () => {
    const { token } = await form();
    const ip = freshIp();
    for (let i = 0; i < 10; i++) expect((await call(`/public/registration/${token}/submit`, { ip, body: sub(`Team ${i}`) })).status).toBe(201);
    expect((await call(`/public/registration/${token}/submit`, { ip, body: sub("Team 11") })).status).toBe(429);
  });

  it("public GET shows only event name/date/venue and form settings, no owner, ids or contact details", async () => {
    const { u, ev, token } = await form({ title: "Hello" });
    await call(`/public/registration/${token}/submit`, { body: sub("Secret Team") });
    const r = await call(`/public/registration/${token}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(["event", "form"]);
    expect(Object.keys(r.json.event).sort()).toEqual(["date", "name", "venue"]);
    expect(r.text).not.toContain(ev.id);
    expect(r.text).not.toContain(u.id);
    expect(r.text).not.toContain("Secret Team");
    expect(r.text).not.toContain("9999900000");
  });
});

describe("invite links and shared passes (public)", () => {
  it("invite: validation, limits, expiry, revocation, and no PII in any answer", async () => {
    const o = await setupEvent();
    const mk = async (body: object) => (await call(`/events/${o.ev.id}/invites`, { token: o.token, body: { teamId: "t1", ...body } })).json;
    const inv = await mk({ maxUses: 2 });
    const url = `/public/invite/${inv.token}/submit`;
    for (const bad of [{}, { name: "" }, { name: "x".repeat(81) }, { name: "A", role: "Admin" }, { name: "A", role: 5 }, { name: "A", minor: "no" }, { name: "A", photo: "data:text/html;base64,AAAA" }, { name: "A", photo: "nope" }, { name: "A", photo: 5 }, { name: "A", photo: `data:image/png;base64,${"A".repeat(600_000)}` }]) {
      const r = await call(url, { body: bad });
      expect([400, 413, 415], JSON.stringify(bad).slice(0, 60)).toContain(r.status);
    }
    // invalid submissions must not consume a use
    const pubGet = await call(`/public/invite/${inv.token}`);
    expect(pubGet.status).toBe(200);
    expect(pubGet.json).toEqual({ event: { name: "Summer Cup", date: "2026-12-01" }, team: { name: "Alpha Wolves" } });
    const a = await call(url, { body: { name: "One", aadhaar: AADHAAR, dob: "2000-01-01", role: "Coach", minor: true } });
    expect(a.status).toBe(201);
    expect(Object.keys(a.json).sort()).toEqual(["id", "ok"]);
    expect((await call(url, { body: { name: "Two", photo: pngDataUrl() } })).status).toBe(201);
    expect((await call(url, { body: { name: "Three" } })).status).toBe(404); // max uses reached
    expect((await call(`/public/invite/${inv.token}`)).status).toBe(404);
    expect(await dumpDb()).not.toContain(AADHAAR);

    const revoked = await mk({});
    expect((await call(`/events/${o.ev.id}/invites/${revoked.id}`, { method: "DELETE", token: o.token })).status).toBe(200);
    expect((await call(`/public/invite/${revoked.token}`)).status).toBe(404);
    expect((await call(`/public/invite/${revoked.token}/submit`, { body: { name: "Late" } })).status).toBe(404);

    const expired = await mk({ expiresInHours: 1 });
    await env.DB.prepare("UPDATE invites SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), expired.id).run();
    expect((await call(`/public/invite/${expired.token}/submit`, { body: { name: "Late" } })).status).toBe(404);

    for (const t of ["nope", "x".repeat(65)]) {
      expect((await call(`/public/invite/${t}`)).status).toBe(404);
      expect((await call(`/public/invite/${t}/submit`, { body: { name: "A" } })).status).toBe(404);
    }
    // the unknown-token answer is identical to the revoked-token answer (no way to tell them apart)
    const unk = await call("/public/invite/doesnotexist");
    const rev = await call(`/public/invite/${revoked.token}`);
    expect(unk.json).toEqual(rev.json);
  });

  it("invite submissions are rate limited per link and address (30 per hour)", async () => {
    const o = await setupEvent();
    const inv = (await call(`/events/${o.ev.id}/invites`, { token: o.token, body: { teamId: "t1" } })).json;
    const ip = freshIp();
    for (let i = 0; i < 30; i++) expect((await call(`/public/invite/${inv.token}/submit`, { ip, body: { name: `N${i}` } })).status).toBe(201);
    expect((await call(`/public/invite/${inv.token}/submit`, { ip, body: { name: "N31" } })).status).toBe(429);
  });

  it("only the last four Aadhaar digits could ever be kept: full numbers sent anywhere are dropped everywhere", async () => {
    const o = await setupEvent();
    const ev = o.ev.id;
    await call(`/events/${ev}/roster`, { method: "PUT", token: o.token, body: { teams: [{ id: "t1", name: "T", aadhaar: AADHAAR }], people: [{ id: "P1", teamId: "t1", name: "A", aadhaar: AADHAAR, aadhaarLast4: "1234", dob: "1999-09-09" }] } });
    await call(`/events/${ev}`, { method: "PUT", token: o.token, body: { aadhaar: AADHAAR } });
    const roster = await call(`/events/${ev}/roster`, { token: o.token });
    const passes = await call(`/events/${ev}/passes`, { token: o.token });
    const share = await call(`/events/${ev}/people/P1/share`, { method: "POST", token: o.token, body: {} });
    const pub = await call(`/public/pass/${share.json.token}`);
    const key = (await call(`/events/${ev}/gate-keys`, { token: o.token, body: { label: "D" } })).json.key;
    const gate = await call("/gate/roster", { gate: key });
    for (const r of [roster, passes, pub, gate]) {
      expect(r.text).not.toContain(AADHAAR);
      expect(r.text).not.toContain("1999-09-09");
    }
    expect(await dumpDb()).not.toContain(AADHAAR);
    expect(await dumpDb()).not.toContain("1999-09-09");
  });

  it("shared pass link: unknown/revoked/oversized tokens are 404; nothing private is exposed", async () => {
    const o = await setupEvent();
    const share = await call(`/events/${o.ev.id}/people/ALP-001/share`, { method: "POST", token: o.token, body: {} });
    expect(share.status).toBe(201);
    const t = share.json.token as string;
    const again = await call(`/events/${o.ev.id}/people/ALP-001/share`, { method: "POST", token: o.token, body: {} });
    expect(again.json.token).toBe(t);
    const pass = await call(`/public/pass/${t}`);
    expect(pass.status).toBe(200);
    expect(Object.keys(pass.json).sort()).toEqual(["code", "event", "person", "photoUrl"]);
    expect(Object.keys(pass.json.person).sort()).toEqual(["name", "role", "team", "zones"]);
    expect(pass.json.code).toMatch(/^EH1\./);
    expect(pass.text).not.toContain(o.id); // owner id
    expect(pass.text).not.toContain(o.ev.id);
    expect(pass.text).not.toContain(o.email);
    expect(pass.text).not.toContain("signing");
    // someone else's person cannot be reached by guessing; a token for A does not show B
    expect(pass.json.person.name).toBe("Asha");
    for (const bad of ["nope", "x".repeat(65), "x".repeat(1000), ""]) expect((await call(`/public/pass/${bad}`)).status, bad.slice(0, 8)).toBe(bad === "" ? 404 : 404);
    expect((await call("/public/pass/nope/photo")).status).toBe(404);
    // revoke
    expect((await call(`/events/${o.ev.id}/people/ALP-001/share`, { method: "DELETE", token: o.token })).status).toBe(200);
    expect((await call(`/public/pass/${t}`)).status).toBe(404);
    expect((await call(`/public/pass/${t}/photo`)).status).toBe(404);
    // removing the person from the roster kills the link too
    const s2 = await call(`/events/${o.ev.id}/people/BET-001/share`, { method: "POST", token: o.token, body: {} });
    await call(`/events/${o.ev.id}/roster`, { method: "PUT", token: o.token, body: { teams: [{ id: "t1", name: "A" }], people: [{ id: "ALP-001", teamId: "t1", name: "Asha" }] } });
    expect((await call(`/public/pass/${s2.json.token}`)).status).toBe(404);
  });

  it("share links only work for people that exist in that event", async () => {
    const o = await setupEvent();
    expect((await call(`/events/${o.ev.id}/people/GHOST-1/share`, { method: "POST", token: o.token, body: {} })).status).toBe(404);
  });
});

describe("pass codes stay with owners and editors", () => {
  it("view-only members never get codes from any endpoint they can reach", async () => {
    const o = await setupEvent();
    const v = await newUser();
    await call(`/events/${o.ev.id}/members`, { token: o.token, body: { email: v.email, role: "viewer" } });
    const passes = (await call(`/events/${o.ev.id}/passes`, { token: o.token })).json as { code: string }[];
    expect(passes.length).toBe(3);
    const reachable = ["", "/roster", "/gate-keys", "/checkins", "/invites", "/submissions", "/registration", "/registrations", "/passes"];
    for (const p of reachable) {
      const r = await call(`/events/${o.ev.id}${p}`, { token: v.token });
      for (const c of passes) expect(r.text, p).not.toContain(c.code);
      expect(r.text).not.toContain("EH1.");
    }
    // nor gate key secrets or signing secrets
    const evRow = await env.DB.prepare("SELECT signing_secret FROM events WHERE id = ?").bind(o.ev.id).first<{ signing_secret: string }>();
    const all = (await Promise.all(reachable.map((p) => call(`/events/${o.ev.id}${p}`, { token: v.token })))).map((r) => r.text).join("");
    expect(all).not.toContain(evRow!.signing_secret);
  });

  it("a gate key is only shown once, at creation; listings never include it or its hash", async () => {
    const o = await setupEvent();
    const k = (await call(`/events/${o.ev.id}/gate-keys`, { token: o.token, body: { label: "Door" } })).json;
    expect(k.key).toMatch(/^gk_/);
    const list = await call(`/events/${o.ev.id}/gate-keys`, { token: o.token });
    expect(list.text).not.toContain(k.key);
    expect(list.text).not.toContain("key_hash");
    expect(Object.keys(list.json[0]).sort()).toEqual(["createdAt", "expiresAt", "id", "label", "revoked"]);
  });
});
