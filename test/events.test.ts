import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { basicRoster, call, newEvent, newGateKey, newUser, pngBytes, pngDataUrl, refSig, setupEvent, toB64 } from "./helpers";

describe("events", () => {
  it("CRUD with derived, unique per-owner keys", async () => {
    const u = await newUser();
    const a = await newEvent(u.token, "Summer Cup 2026!!");
    expect(a.key).toBe("summer-cup-2026");
    const b = await newEvent(u.token, "Summer Cup 2026!!");
    expect(b.key).toBe("summer-cup-2026-2");
    const c = await newEvent(u.token, "Summer Cup 2026!!");
    expect(c.key).toBe("summer-cup-2026-3");
    expect((await newEvent(u.token, "???")).key).toBe("event");
    const long = await newEvent(u.token, "An Extremely Long Tournament Name That Goes On");
    expect(long.key.length).toBeLessThanOrEqual(24);
    expect(long.key).toMatch(/^[a-z0-9-]+$/);
    // another owner may reuse the same key
    const other = await newUser();
    expect((await newEvent(other.token, "Summer Cup 2026!!")).key).toBe("summer-cup-2026");

    const list = await call("/events", { token: u.token });
    expect(list.status).toBe(200);
    expect(list.json.length).toBe(5);

    const upd = await call(`/events/${a.id}`, { method: "PUT", token: u.token, body: { name: "Renamed", venue: "Arena" } });
    expect(upd.status).toBe(200);
    expect(upd.json.name).toBe("Renamed");
    expect(upd.json.venue).toBe("Arena");
    expect(upd.json.game).toBe("BGMI"); // untouched
    expect(upd.json.key).toBe("summer-cup-2026"); // key is stable so issued passes stay valid
    expect((await call(`/events/${a.id}`, { token: u.token })).json.settings).toEqual({ a: 1 });
    expect((await call("/events", { token: u.token, body: { name: "" } })).status).toBe(400);
  });

  it("requires authentication on every /events route", async () => {
    const s = await setupEvent();
    const id = s.ev.id;
    for (const [m, p] of [
      ["GET", "/events"],
      ["POST", "/events"],
      ["GET", `/events/${id}`],
      ["PUT", `/events/${id}`],
      ["DELETE", `/events/${id}`],
      ["GET", `/events/${id}/roster`],
      ["PUT", `/events/${id}/roster`],
      ["GET", `/events/${id}/passes`],
      ["POST", `/events/${id}/gate-keys`],
      ["GET", `/events/${id}/gate-keys`],
      ["GET", `/events/${id}/checkins`],
      ["DELETE", `/events/${id}/checkins`],
      ["POST", `/events/${id}/invites`],
      ["GET", `/events/${id}/submissions`],
      ["POST", `/events/${id}/people/ALP-001/share`],
      ["GET", `/events/${id}/photos/ALP-002`],
    ] as const) {
      const r = await call(p, { method: m });
      expect(r.status, `${m} ${p}`).toBe(401);
    }
  });

  it("deletes with cascade", async () => {
    const s = await setupEvent();
    const gk = await newGateKey(s.token, s.ev.id);
    await call(`/events/${s.ev.id}/people/ALP-001/share`, { token: s.token, method: "POST" });
    const tables = ["teams", "people", "photos", "gate_keys", "share_links"];
    for (const t of tables) {
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE event_id = ?`).bind(s.ev.id).first<{ n: number }>();
      expect(n!.n, t).toBeGreaterThan(0);
    }
    expect((await call(`/events/${s.ev.id}`, { method: "DELETE", token: s.token })).status).toBe(200);
    for (const t of tables) {
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE event_id = ?`).bind(s.ev.id).first<{ n: number }>();
      expect(n!.n, t).toBe(0);
    }
    expect((await call(`/events/${s.ev.id}`, { token: s.token })).status).toBe(404);
    expect((await call("/gate/roster", { gate: gk.key })).status).toBe(401);
  });
});

describe("tenant isolation", () => {
  it("user B gets 404 on everything of user A", async () => {
    const a = await setupEvent();
    const b = await newUser();
    const id = a.ev.id;
    await call(`/events/${id}/people/ALP-001/share`, { token: a.token, method: "POST" });
    const gk = await newGateKey(a.token, id);
    await call("/gate/checkin", { gate: gk.key, body: { code: "EH1.x.y.z" } });

    const attempts: [string, string, unknown?][] = [
      ["GET", `/events/${id}`],
      ["PUT", `/events/${id}`, { name: "hijack" }],
      ["DELETE", `/events/${id}`],
      ["GET", `/events/${id}/roster`],
      ["PUT", `/events/${id}/roster`, basicRoster()],
      ["GET", `/events/${id}/passes`],
      ["GET", `/events/${id}/photos/ALP-002`],
      ["PUT", `/events/${id}/photos/ALP-002`],
      ["DELETE", `/events/${id}/photos/ALP-002`],
      ["GET", `/events/${id}/checkins`],
      ["DELETE", `/events/${id}/checkins`],
      ["GET", `/events/${id}/gate-keys`],
      ["POST", `/events/${id}/gate-keys`, { label: "x" }],
      ["DELETE", `/events/${id}/gate-keys/${gk.id}`],
      ["POST", `/events/${id}/people/ALP-001/share`],
      ["DELETE", `/events/${id}/people/ALP-001/share`],
      ["POST", `/events/${id}/invites`, { teamId: "t1", label: "x" }],
      ["GET", `/events/${id}/invites`],
      ["GET", `/events/${id}/submissions`],
    ];
    for (const [m, p, body] of attempts) {
      const r = await call(p, { method: m, token: b.token, body });
      expect(r.status, `${m} ${p}`).toBe(404);
    }
    // and nothing was changed
    const still = await call(`/events/${id}`, { token: a.token });
    expect(still.json.name).toBe("Summer Cup");
    expect((await call(`/events/${id}/roster`, { token: a.token })).json.people.length).toBe(3);
    expect((await call("/events", { token: b.token })).json).toEqual([]);
    const keys = await call(`/events/${id}/gate-keys`, { token: a.token });
    expect(keys.json[0].revoked).toBe(false);
  });
});

describe("roster", () => {
  it("returns teams, people and photo URLs", async () => {
    const s = await setupEvent();
    const r = await call(`/events/${s.ev.id}/roster`, { token: s.token });
    expect(r.status).toBe(200);
    expect(r.json.teams.map((t: any) => t.id)).toEqual(["t1", "t2"]);
    const ravi = r.json.people.find((p: any) => p.id === "ALP-002");
    expect(ravi).toMatchObject({ name: "Ravi", teamId: "t1", role: "Coach", minor: true, guardian: true });
    expect(ravi.photoUrl).toBe(`/events/${s.ev.id}/photos/ALP-002`);
    expect(r.json.people.find((p: any) => p.id === "ALP-001").photoUrl).toBeNull();
    expect(r.json.people.find((p: any) => p.id === "ALP-001").zones).toEqual(["Stage"]);
    const photo = await call(ravi.photoUrl, { token: s.token });
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/png");
    expect(photo.bytes).toEqual(pngBytes());
    expect((await call(ravi.photoUrl)).status).toBe(401);
  });

  it("replaces the roster and reports counts; keeps photos of retained people, drops the rest", async () => {
    const s = await setupEvent();
    const r = await call(`/events/${s.ev.id}/roster`, {
      method: "PUT",
      token: s.token,
      body: { teams: [{ id: "t9", name: "New" }], people: [{ id: "ALP-002", name: "Ravi K", teamId: "t9", role: "Coach" }, { id: "NEW-1", name: "Zed", teamId: "t9" }] },
    });
    expect(r.json).toMatchObject({ ok: true, teams: 1, people: 2 });
    const g = await call(`/events/${s.ev.id}/roster`, { token: s.token });
    expect(g.json.people.map((p: any) => p.id)).toEqual(["ALP-002", "NEW-1"]);
    expect(g.json.people[0].photoUrl).not.toBeNull(); // kept
    expect(g.json.people[1].role).toBe("Player"); // default
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM photos WHERE event_id = ?").bind(s.ev.id).first<{ n: number }>();
    expect(n!.n).toBe(1);
    // explicit photo:null removes it
    await call(`/events/${s.ev.id}/roster`, { method: "PUT", token: s.token, body: { teams: [{ id: "t9", name: "New" }], people: [{ id: "ALP-002", name: "Ravi", teamId: "t9", photo: null }] } });
    expect((await call(`/events/${s.ev.id}/photos/ALP-002`, { token: s.token })).status).toBe(404);
  });

  it("is all-or-nothing: an invalid roster leaves the old one untouched", async () => {
    const s = await setupEvent();
    const before = (await call(`/events/${s.ev.id}/roster`, { token: s.token })).json;
    const bads: unknown[] = [
      { teams: [{ id: "t1", name: "A" }], people: [{ id: "P1", name: "ok", teamId: "t1" }, { id: "P2", name: "bad team", teamId: "nope" }] },
      { teams: [{ id: "t1", name: "A" }], people: [{ id: "P1", name: "ok", teamId: "t1" }, { id: "P1", name: "dup", teamId: "t1" }] },
      { teams: [{ id: "t1", name: "A" }], people: [{ id: "P1", name: "ok", teamId: "t1" }, { id: "P2", name: "bad photo", teamId: "t1", photo: "data:image/gif;base64,R0lGOA==" }] },
      { teams: [{ id: "t1", name: "A", logo: "data:image/png;base64," + "A".repeat(70_000) }], people: [] },
      { teams: "nope", people: [] },
    ];
    for (const body of bads) {
      const r = await call(`/events/${s.ev.id}/roster`, { method: "PUT", token: s.token, body });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.status).toBeLessThan(500);
    }
    expect((await call(`/events/${s.ev.id}/roster`, { token: s.token })).json).toEqual(before);
  });

  it("rolls the whole batch back when a statement fails mid-way (database-level atomicity)", async () => {
    const s = await setupEvent();
    const before = (await call(`/events/${s.ev.id}/roster`, { token: s.token })).json;
    await env.DB.exec("CREATE TRIGGER boom BEFORE INSERT ON people WHEN NEW.name = 'BOOM' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    try {
      const r = await call(`/events/${s.ev.id}/roster`, {
        method: "PUT",
        token: s.token,
        body: { teams: [{ id: "z", name: "Z" }], people: [{ id: "a", name: "fine", teamId: "z" }, { id: "b", name: "BOOM", teamId: "z" }] },
      });
      expect(r.status).toBe(500);
      expect(r.json).toEqual({ error: "Internal server error" }); // no internals leaked
    } finally {
      await env.DB.exec("DROP TRIGGER boom");
    }
    expect((await call(`/events/${s.ev.id}/roster`, { token: s.token })).json).toEqual(before);
  });

  it("enforces limits: 100 teams, 2000 people", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    const teams = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `T${i}` }));
    const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, name: `P${i}`, teamId: "t0" }));
    expect((await call(`/events/${ev.id}/roster`, { method: "PUT", token: u.token, body: { teams: teams(101), people: [] } })).status).toBe(400);
    expect((await call(`/events/${ev.id}/roster`, { method: "PUT", token: u.token, body: { teams: teams(1), people: people(2001) } })).status).toBe(400);
    const ok = await call(`/events/${ev.id}/roster`, { method: "PUT", token: u.token, body: { teams: teams(100), people: people(2000) } });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ teams: 100, people: 2000 });
    const g = await call(`/events/${ev.id}/roster`, { token: u.token });
    expect(g.json.people.length).toBe(2000);
    expect(g.json.teams.length).toBe(100);
  });

  it("does not store a date of birth or Aadhaar number even if a client sends one", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    await call(`/events/${ev.id}/roster`, {
      method: "PUT",
      token: u.token,
      body: { teams: [{ id: "t", name: "T" }], people: [{ id: "p1", name: "Kid", teamId: "t", minor: true, dob: "2012-01-01", aadhaar: "123412341234" }] },
    });
    const row = await env.DB.prepare("SELECT * FROM people WHERE event_id = ?").bind(ev.id).first<Record<string, unknown>>();
    expect(Object.keys(row!).sort()).toEqual(["event_id", "guardian", "id", "minor", "name", "role", "team_id", "zones"]);
    expect(JSON.stringify(row)).not.toMatch(/2012|1234/);
    const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%cf_%' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%'").all<{ name: string }>();
    expect(tables.results.length).toBeGreaterThan(8);
    for (const t of tables.results) {
      const cols = await env.DB.prepare(`PRAGMA table_info(${t.name})`).all<{ name: string }>();
      expect(cols.results.filter((c) => /dob|birth|aadhaar|aadhar/i.test(c.name)), t.name).toEqual([]);
    }
  });

  it("rejects bad image types, wrong magic bytes and oversized photos", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    const put = (photo: unknown) =>
      call(`/events/${ev.id}/roster`, { method: "PUT", token: u.token, body: { teams: [{ id: "t", name: "T" }], people: [{ id: "p1", name: "A", teamId: "t", photo }] } });
    expect((await put("data:image/gif;base64,R0lGODlh")).status).toBe(415);
    expect((await put("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).status).toBe(415);
    expect((await put("data:text/html;base64,PGI+")).status).toBe(415);
    expect((await put("not a data url")).status).toBe(415);
    expect((await put(`data:image/jpeg;base64,${toB64(pngBytes())}`)).status).toBe(415); // magic mismatch
    expect((await put(`data:image/png;base64,${toB64(pngBytes(401 * 1024))}`)).status).toBe(413);
    expect((await put(pngDataUrl(400 * 1024))).status).toBe(200); // exactly at the limit
    // raw upload endpoint
    await call(`/events/${ev.id}/photos/p1`, { method: "DELETE", token: u.token });
    const up = (type: string, bytes: Uint8Array) => call(`/events/${ev.id}/photos/p1`, { method: "PUT", token: u.token, raw: bytes as BodyInit, headers: { "content-type": type } });
    expect((await up("image/gif", pngBytes())).status).toBe(415);
    expect((await up("image/png", pngBytes(500 * 1024))).status).toBe(413);
    expect((await up("image/png", pngBytes())).status).toBe(200);
  });

  it("rejects oversized request bodies with 413", async () => {
    const u = await newUser();
    const big = JSON.stringify({ name: "x", rules: "y".repeat(1_100_000) });
    const r = await call("/events", { token: u.token, raw: big, headers: { "content-type": "application/json" } });
    expect(r.status).toBe(413);
    expect(r.json.error).toBeTruthy();
    expect((await call("/events", { token: u.token, raw: "{not json", headers: { "content-type": "application/json" } })).status).toBe(400);
  });
});

describe("passes", () => {
  it("verify with an independent HMAC implementation", async () => {
    const s = await setupEvent("Pass Test Cup");
    const secretRow = await env.DB.prepare("SELECT signing_secret, slug FROM events WHERE id = ?").bind(s.ev.id).first<{ signing_secret: string; slug: string }>();
    const r = await call(`/events/${s.ev.id}/passes`, { token: s.token });
    expect(r.status).toBe(200);
    expect(r.json.length).toBe(3);
    const roles: Record<string, string> = { "ALP-001": "Player", "ALP-002": "Coach", "BET-001": "Player" };
    for (const p of r.json as { personId: string; code: string }[]) {
      const expected = `EH1.pass-test-cup.${p.personId}.${await refSig(secretRow!.signing_secret, "pass-test-cup", p.personId, roles[p.personId]!)}`;
      expect(p.code).toBe(expected);
      expect(p.code.split(".")[3]).toHaveLength(16);
    }
    expect(secretRow!.signing_secret.length).toBeGreaterThanOrEqual(43); // 32 random bytes, base64url
  });
});

describe("secrets never leak", () => {
  it("no response contains the signing secret, key hashes or password hashes", async () => {
    const s = await setupEvent();
    const gk = await newGateKey(s.token, s.ev.id);
    await call(`/events/${s.ev.id}/people/ALP-001/share`, { token: s.token });
    await call("/gate/checkin", { gate: gk.key, body: { code: "EH1.a.b.c" } });
    const secret = (await env.DB.prepare("SELECT signing_secret FROM events WHERE id = ?").bind(s.ev.id).first<{ signing_secret: string }>())!.signing_secret;
    const keyHash = (await env.DB.prepare("SELECT key_hash FROM gate_keys WHERE id = ?").bind(gk.id).first<{ key_hash: string }>())!.key_hash;
    const pw = (await env.DB.prepare("SELECT pw_hash, pw_salt FROM users WHERE id = ?").bind(s.id).first<{ pw_hash: string; pw_salt: string }>())!;
    expect(keyHash).not.toBe(gk.key); // only a hash is stored
    const paths = ["/me", "/events", `/events/${s.ev.id}`, `/events/${s.ev.id}/roster`, `/events/${s.ev.id}/passes`, `/events/${s.ev.id}/gate-keys`, `/events/${s.ev.id}/checkins`, `/events/${s.ev.id}/invites`, `/events/${s.ev.id}/submissions`];
    const bodies = [];
    for (const p of paths) bodies.push((await call(p, { token: s.token })).text);
    bodies.push((await call("/gate/roster", { gate: gk.key })).text);
    bodies.push((await call("/auth/login", { body: { email: s.email, password: "correct horse" } })).text);
    for (const b of bodies) {
      expect(b).not.toContain(secret);
      expect(b).not.toContain(keyHash);
      expect(b).not.toContain(pw.pw_hash);
      expect(b).not.toContain(pw.pw_salt);
      expect(b).not.toContain("signing_secret");
      expect(b).not.toContain("owner_id");
    }
  });
});
