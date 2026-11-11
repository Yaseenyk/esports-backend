import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { call, freshIp, newEvent, newGateKey, newUser, pngDataUrl, setupEvent, uniq } from "./helpers";

// One row per route in src/routes. `owner` = owner-only. `viewerOk` = a view-only member may call it (GET) and gets 200.
interface R {
  method: string;
  path: (c: Ctx) => string;
  body?: unknown;
  owner?: boolean;
  viewerBlocked?: boolean; // GET that a viewer still may not do (403)
}
interface Ctx {
  ev: string;
  pid: string; // a real person id
  kid: string; // a real gate key id
  iid: string; // a real invite id
  sid: string; // a real submission id
  rid: string; // a real registration id
  uid: string; // another member's user id
}
vi.setConfig({ testTimeout: 120_000 });
const D = "nope"; // dummy child id: never exists, so a state-changing call by an allowed role can only 404 on the child

const ROUTES: R[] = [
  { method: "GET", path: () => "/events" },
  { method: "POST", path: () => "/events", body: { name: "x" } },
  { method: "GET", path: (c) => `/events/${c.ev}` },
  { method: "PUT", path: (c) => `/events/${c.ev}`, body: {} },
  { method: "DELETE", path: (c) => `/events/${c.ev}`, owner: true },
  { method: "GET", path: (c) => `/events/${c.ev}/roster` },
  { method: "PUT", path: (c) => `/events/${c.ev}/roster`, body: {} },
  { method: "GET", path: (c) => `/events/${c.ev}/photos/${c.pid}` },
  { method: "PUT", path: (c) => `/events/${c.ev}/photos/${D}`, body: {} },
  { method: "DELETE", path: (c) => `/events/${c.ev}/photos/${D}` },
  { method: "GET", path: (c) => `/events/${c.ev}/passes`, viewerBlocked: true },
  { method: "POST", path: (c) => `/events/${c.ev}/gate-keys`, body: { label: "" } },
  { method: "GET", path: (c) => `/events/${c.ev}/gate-keys` },
  { method: "DELETE", path: (c) => `/events/${c.ev}/gate-keys/${D}` },
  { method: "GET", path: (c) => `/events/${c.ev}/checkins` },
  { method: "DELETE", path: (c) => `/events/${c.ev}/checkins` },
  { method: "POST", path: (c) => `/events/${c.ev}/people/${D}/share`, body: {} },
  { method: "DELETE", path: (c) => `/events/${c.ev}/people/${D}/share` },
  { method: "POST", path: (c) => `/events/${c.ev}/invites`, body: {} },
  { method: "GET", path: (c) => `/events/${c.ev}/invites` },
  { method: "DELETE", path: (c) => `/events/${c.ev}/invites/${D}` },
  { method: "GET", path: (c) => `/events/${c.ev}/submissions` },
  { method: "GET", path: (c) => `/events/${c.ev}/submissions/${c.sid}/photo` },
  { method: "POST", path: (c) => `/events/${c.ev}/submissions/${D}/approve`, body: {} },
  { method: "POST", path: (c) => `/events/${c.ev}/submissions/${D}/reject`, body: {} },
  { method: "PUT", path: (c) => `/events/${c.ev}/registration`, body: { title: "t" } },
  { method: "GET", path: (c) => `/events/${c.ev}/registration` },
  { method: "GET", path: (c) => `/events/${c.ev}/registrations` },
  { method: "POST", path: (c) => `/events/${c.ev}/registrations/${D}/approve`, body: {} },
  { method: "POST", path: (c) => `/events/${c.ev}/registrations/${D}/reject`, body: {} },
  { method: "GET", path: (c) => `/events/${c.ev}/members`, owner: true },
  { method: "POST", path: (c) => `/events/${c.ev}/members`, body: { email: "x@example.com", role: "viewer" }, owner: true },
  { method: "DELETE", path: (c) => `/events/${c.ev}/members/${c.uid}`, owner: true },
];

// Account-level routes: need a user token, have no event.
const ACCOUNT: { method: string; path: string; body?: unknown }[] = [
  { method: "GET", path: "/me" },
  { method: "POST", path: "/auth/change-password", body: { current: "x", next: "yyyyyyyy" } },
  { method: "POST", path: "/auth/delete-account", body: { password: "x" } },
];

const GATE: { method: string; path: string; body?: unknown }[] = [
  { method: "GET", path: "/gate/roster" },
  { method: "GET", path: "/gate/photos/ALP-002" },
  { method: "POST", path: "/gate/checkin", body: { code: "x" } },
  { method: "POST", path: "/gate/checkin/batch", body: { codes: ["x"] } },
];

// Intentionally unauthenticated (rate limited and token-gated where they expose anything).
const PUBLIC = new Set([
  "GET /",
  "POST /auth/register",
  "POST /auth/login",
  "GET /public/pass/:token",
  "GET /public/pass/:token/photo",
  "GET /public/invite/:token",
  "POST /public/invite/:token/submit",
  "GET /public/registration/:token",
  "POST /public/registration/:token/submit",
  "POST /public/contact",
]);

async function world() {
  const o = await setupEvent();
  const ev = o.ev.id;
  const key = await newGateKey(o.token, ev);
  const inv = (await call(`/events/${ev}/invites`, { token: o.token, body: { teamId: "t1" } })).json;
  const sub = await call(`/public/invite/${inv.token}/submit`, { body: { name: "Sub Mitter", photo: pngDataUrl() } });
  const sid = sub.json.id as string;
  const form = (await call(`/events/${ev}/registration`, { method: "PUT", token: o.token, body: { title: "Reg", teamSize: 1, subs: 0 } })).json;
  const reg = await call(`/public/registration/${form.token}/submit`, { body: { teamName: `Team ${uniq()}`, captainName: "Cap Tain", captainContact: "cap@example.com", players: [{ name: "P One" }] } });
  const editor = await newUser("Ed");
  const viewer = await newUser("Vi");
  const stranger = await newUser("Str");
  const third = await newUser("Third");
  expect((await call(`/events/${ev}/members`, { token: o.token, body: { email: third.email, role: "viewer" } })).status).toBe(201);
  expect((await call(`/events/${ev}/members`, { token: o.token, body: { email: editor.email, role: "editor" } })).status).toBe(201);
  expect((await call(`/events/${ev}/members`, { token: o.token, body: { email: viewer.email, role: "viewer" } })).status).toBe(201);
  const ctx: Ctx = { ev, pid: "ALP-002", kid: key.id, iid: inv.id, sid, rid: reg.json.id, uid: third.id };
  return { o, key, inv, editor, viewer, stranger, ctx, form };
}

describe("route inventory", () => {
  it("every registered route is covered by this matrix or explicitly public", () => {
    const covered = new Set<string>([
      ...ROUTES.map((r) => `${r.method} ${r.path({ ev: ":id", pid: ":personId", kid: ":keyId", iid: ":inviteId", sid: ":sid", rid: ":rid", uid: ":userId" }).replace(`/${D}`, "/:x")}`),
    ]);
    // normalise the matrix paths to the registered pattern shapes by only comparing method + segment count + literal prefix
    const shape = (m: string, p: string) => `${m} ${p.split("/").map((s) => (s.startsWith(":") ? ":" : s)).join("/")}`;
    const matrixShapes = new Set<string>([
      ...[...covered].map((k) => { const [m, p] = k.split(" "); return shape(m!, p!.replace(/\/nope/g, "/:x")); }),
      ...ACCOUNT.map((r) => shape(r.method, r.path)),
      ...GATE.map((r) => shape(r.method, r.path.replace("/ALP-002", "/:personId"))),
      ...[...PUBLIC].map((k) => { const [m, p] = k.split(" "); return shape(m!, p!); }),
    ]);
    const missing: string[] = [];
    for (const r of app.routes) {
      if (r.method === "ALL") continue;
      const k = shape(r.method, r.path);
      if (!matrixShapes.has(k)) missing.push(`${r.method} ${r.path}`);
    }
    expect(missing).toEqual([]);
  });

  it("every non-public route refuses an anonymous caller with 401 (even for ids that do not exist)", async () => {
    for (const r of app.routes) {
      if (r.method === "ALL" || PUBLIC.has(`${r.method} ${r.path}`)) continue;
      const path = r.path.replace(/:[A-Za-z]+/g, "x1");
      const res = await call(path, { method: r.method, body: r.method === "GET" ? undefined : {} });
      expect(res.status, `${r.method} ${path}`).toBe(401);
    }
  });
});

describe("authorization matrix", () => {
  it("unauthenticated, garbage tokens and gate keys on user routes are all 401", async () => {
    const w = await world();
    const all = [...ROUTES.map((r) => ({ method: r.method, path: r.path(w.ctx), body: r.body })), ...ACCOUNT];
    for (const r of all) {
      const send = (extra: object) => call(r.path, { method: r.method, body: r.body ?? (r.method === "GET" ? undefined : {}), ...extra });
      expect((await send({})).status, `anon ${r.method} ${r.path}`).toBe(401);
      expect((await send({ token: "garbage" })).status, `garbage ${r.method} ${r.path}`).toBe(401);
      expect((await send({ gate: w.key.key })).status, `gate key ${r.method} ${r.path}`).toBe(401);
      expect((await send({ headers: { authorization: `Basic ${w.o.token}` } })).status, `basic ${r.method} ${r.path}`).toBe(401);
    }
  });

  it("a stranger gets the same 404 as for an event that does not exist (no IDOR, no existence leak)", async () => {
    const w = await world();
    const ghost = { ...w.ctx, ev: "00000000-0000-0000-0000-000000000000" };
    for (const r of ROUTES) {
      if (r.path(w.ctx) === "/events") continue;
      const real = await call(r.path(w.ctx), { method: r.method, token: w.stranger.token, body: r.body });
      const none = await call(r.path(ghost), { method: r.method, token: w.stranger.token, body: r.body });
      expect(real.status, `${r.method} ${r.path(w.ctx)}`).toBe(404);
      expect(real.json, `${r.method} ${r.path(w.ctx)}`).toEqual({ error: "Event not found" });
      expect(none.status).toBe(404);
      expect(none.json).toEqual(real.json);
    }
    // and nothing of the owner's leaked into the stranger's list
    const list = await call("/events", { token: w.stranger.token });
    expect(list.json).toEqual([]);
    // a stranger cannot "leave" an event they are not in, and the answer is the same 404
    const leave = await call(`/events/${w.ctx.ev}/members/${w.stranger.id}`, { method: "DELETE", token: w.stranger.token });
    expect(leave.status).toBe(404);
  });

  it("a viewer can only GET; every write is 403, owner-only reads are 403, pass codes are never shown", async () => {
    const w = await world();
    for (const r of ROUTES) {
      if (r.path(w.ctx) === "/events") continue;
      const res = await call(r.path(w.ctx), { method: r.method, token: w.viewer.token, body: r.body });
      if (r.method === "GET" && !r.owner && !r.viewerBlocked) expect(res.status, `viewer ${r.method} ${r.path(w.ctx)}`).toBe(200);
      else expect(res.status, `viewer ${r.method} ${r.path(w.ctx)}`).toBe(403);
    }
    const passes = await call(`/events/${w.ctx.ev}/passes`, { token: w.viewer.token });
    expect(passes.text).not.toContain("EH1.");
    const inList = await call("/events", { token: w.viewer.token });
    expect(inList.json.map((e: any) => e.role)).toContain("viewer");
    // the event is untouched by all those attempts
    expect((await call(`/events/${w.ctx.ev}/roster`, { token: w.o.token })).json.people.length).toBe(3);
    // a viewer can leave on their own
    expect((await call(`/events/${w.ctx.ev}/members/${w.viewer.id}`, { method: "DELETE", token: w.viewer.token })).status).toBe(200);
    expect((await call(`/events/${w.ctx.ev}`, { token: w.viewer.token })).status).toBe(404);
  });

  it("an editor does everything except owner-only actions (delete event, manage members)", async () => {
    const w = await world();
    for (const r of ROUTES) {
      if (r.path(w.ctx) === "/events") continue;
      const res = await call(r.path(w.ctx), { method: r.method, token: w.editor.token, body: r.body });
      if (r.owner) {
        expect(res.status, `editor ${r.method} ${r.path(w.ctx)}`).toBe(403);
      } else {
        expect([401, 403], `editor ${r.method} ${r.path(w.ctx)}`).not.toContain(res.status);
        expect(res.json?.error, `editor ${r.method} ${r.path(w.ctx)}`).not.toBe("Event not found");
        expect(res.status).toBeLessThan(500);
      }
    }
    // the event survived the delete attempt, and the editor cannot grant access to themselves or others
    expect((await call(`/events/${w.ctx.ev}`, { token: w.o.token })).status).toBe(200);
    const sneaky = await newUser();
    expect((await call(`/events/${w.ctx.ev}/members`, { token: w.editor.token, body: { email: sneaky.email, role: "editor" } })).status).toBe(403);
    // an editor cannot remove the owner's other members, but can leave
    expect((await call(`/events/${w.ctx.ev}/members/${w.viewer.id}`, { method: "DELETE", token: w.editor.token })).status).toBe(403);
    expect((await call(`/events/${w.ctx.ev}/members/${w.editor.id}`, { method: "DELETE", token: w.editor.token })).status).toBe(200);
  });

  it("the owner can use every route and can really delete the event", async () => {
    const w = await world();
    const members = await call(`/events/${w.ctx.ev}/members`, { token: w.o.token });
    expect(members.status).toBe(200);
    expect(members.json.members.length).toBe(3);
    expect((await call(`/events/${w.ctx.ev}/passes`, { token: w.o.token })).json.length).toBe(3);
    expect((await call(`/events/${w.ctx.ev}`, { method: "DELETE", token: w.o.token })).status).toBe(200);
    expect((await call(`/events/${w.ctx.ev}`, { token: w.o.token })).status).toBe(404);
    // members lose access with it
    expect((await call(`/events/${w.ctx.ev}`, { token: w.editor.token })).status).toBe(404);
  });

  it("removing a member revokes access immediately", async () => {
    const w = await world();
    expect((await call(`/events/${w.ctx.ev}/roster`, { token: w.editor.token })).status).toBe(200);
    expect((await call(`/events/${w.ctx.ev}/members/${w.editor.id}`, { method: "DELETE", token: w.o.token })).status).toBe(200);
    expect((await call(`/events/${w.ctx.ev}/roster`, { token: w.editor.token })).status).toBe(404);
  });

  it("child ids from one event never resolve under another event of the same owner", async () => {
    const w = await world();
    const other = await newEvent(w.o.token, "Other Cup");
    const a = `/events/${other.id}`;
    expect((await call(`${a}/photos/${w.ctx.pid}`, { token: w.o.token })).status).toBe(404);
    expect((await call(`${a}/submissions/${w.ctx.sid}/photo`, { token: w.o.token })).status).toBe(404);
    expect((await call(`${a}/submissions/${w.ctx.sid}/approve`, { method: "POST", token: w.o.token, body: {} })).status).toBe(404);
    expect((await call(`${a}/submissions/${w.ctx.sid}/reject`, { method: "POST", token: w.o.token, body: {} })).status).toBe(404);
    expect((await call(`${a}/registrations/${w.ctx.rid}/approve`, { method: "POST", token: w.o.token, body: {} })).status).toBe(404);
    expect((await call(`${a}/registrations/${w.ctx.rid}/reject`, { method: "POST", token: w.o.token, body: {} })).status).toBe(404);
    expect((await call(`${a}/gate-keys/${w.ctx.kid}`, { method: "DELETE", token: w.o.token })).status).toBe(404);
    expect((await call(`${a}/invites/${w.ctx.iid}`, { method: "DELETE", token: w.o.token })).status).toBe(404);
    expect((await call(`${a}/people/${w.ctx.pid}/share`, { method: "POST", token: w.o.token, body: {} })).status).toBe(404);
    // none of that changed the original event
    expect((await call(`/events/${w.ctx.ev}/submissions?status=pending`, { token: w.o.token })).json.length).toBe(1);
    expect((await call(`/events/${w.ctx.ev}/gate-keys`, { token: w.o.token })).json[0].revoked).toBe(false);
  });
});

describe("gate keys", () => {
  it("only reach gate endpoints, only for their own event", async () => {
    const a = await setupEvent("Cup A");
    const b = await setupEvent("Cup B");
    const ka = await newGateKey(a.token, a.ev.id);
    const kb = await newGateKey(b.token, b.ev.id);
    // each key sees only its own roster
    const ra = await call("/gate/roster", { gate: ka.key });
    const rb = await call("/gate/roster", { gate: kb.key });
    expect(ra.status).toBe(200);
    expect(ra.json.event.name).toBe("Cup A");
    expect(rb.json.event.name).toBe("Cup B");
    // a pass from A scanned at B's gate is refused, and checks nothing in
    const passes = (await call(`/events/${a.ev.id}/passes`, { token: a.token })).json as { personId: string; code: string }[];
    const scan = await call("/gate/checkin", { gate: kb.key, body: { code: passes[0]!.code } });
    expect(scan.json.status).toBe("bad");
    const batch = await call("/gate/checkin/batch", { gate: kb.key, body: { codes: passes.map((p) => p.code) } });
    expect(batch.json.results.every((x: any) => x.status === "bad")).toBe(true);
    expect((await call(`/events/${a.ev.id}/checkins`, { token: a.token })).json.checkedIn).toBe(0);
    expect((await call(`/events/${b.ev.id}/checkins`, { token: b.token })).json.checkedIn).toBe(0);
    // photos are scoped to the key's event too
    expect((await call("/gate/photos/ALP-002", { gate: ka.key })).status).toBe(200);
    // ...even though B has an ALP-002 with no photo set up differently: delete B's photo and A's still works, B's is 404
    await call(`/events/${b.ev.id}/photos/ALP-002`, { method: "DELETE", token: b.token });
    expect((await call("/gate/photos/ALP-002", { gate: kb.key })).status).toBe(404);
    expect((await call("/gate/photos/ALP-002", { gate: ka.key })).status).toBe(200);
    // a gate key is not a user token and a user token is not a gate key
    for (const g of GATE) {
      expect((await call(g.path, { method: g.method, token: a.token, body: g.body })).status, `user token on ${g.path}`).toBe(401);
      expect((await call(g.path, { method: g.method, body: g.body })).status, `anon on ${g.path}`).toBe(401);
      expect((await call(g.path, { method: g.method, gate: "gk_unknown", body: g.body })).status, `bad key on ${g.path}`).toBe(401);
      expect((await call(g.path, { method: g.method, gate: "x".repeat(500), body: g.body })).status, `long key on ${g.path}`).toBe(401);
    }
    // the key hash, not the key, is what is stored
    const row = await env.DB.prepare("SELECT key_hash FROM gate_keys WHERE id = ?").bind(ka.id).first<{ key_hash: string }>();
    expect(row!.key_hash).not.toContain(ka.key);
  });

  it("revoked and expired keys stop working; revoking one key leaves the others alone", async () => {
    const a = await setupEvent();
    const k1 = await newGateKey(a.token, a.ev.id);
    const k2 = await newGateKey(a.token, a.ev.id);
    const exp = (await call(`/events/${a.ev.id}/gate-keys`, { token: a.token, body: { label: "short", expiresInHours: 1 } })).json;
    expect((await call("/gate/roster", { gate: exp.key })).status).toBe(200);
    await env.DB.prepare("UPDATE gate_keys SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), exp.id).run();
    expect((await call("/gate/roster", { gate: exp.key })).status).toBe(401);
    expect((await call(`/events/${a.ev.id}/gate-keys/${k1.id}`, { method: "DELETE", token: a.token })).status).toBe(200);
    expect((await call("/gate/roster", { gate: k1.key })).status).toBe(401);
    expect((await call("/gate/roster", { gate: k2.key })).status).toBe(200);
  });

  it("stop working when the event is deleted", async () => {
    const a = await setupEvent();
    const k = await newGateKey(a.token, a.ev.id);
    expect((await call(`/events/${a.ev.id}`, { method: "DELETE", token: a.token })).status).toBe(200);
    expect((await call("/gate/roster", { gate: k.key })).status).toBe(401);
  });

  it("repeated wrong keys from one address get 429", async () => {
    const ip = freshIp();
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await call("/gate/roster", { gate: `gk_wrong${i}`, ip })).status;
    expect(last).toBe(429);
  });
});

describe("JWT validation", () => {
  const b64u = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const SECRET = "test-secret-test-secret-test-secret";
  async function sign(header: object, payload: object, secret = SECRET, alg: "SHA-256" | "SHA-512" = "SHA-256") {
    const data = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(payload))}`;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: alg }, false, ["sign"]);
    const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data)));
    let bin = "";
    for (const x of sig) bin += String.fromCharCode(x);
    return `${data}.${b64u(bin)}`;
  }
  const H = { alg: "HS256", typ: "JWT" };
  const future = () => Math.floor(Date.now() / 1000) + 3600;

  it("accepts a correctly signed token and rejects every variant that is not", async () => {
    const u = await newUser();
    const pv = JSON.parse(atob(u.token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))).pv;
    expect((await call("/me", { token: await sign(H, { sub: u.id, exp: future(), pv }) })).status).toBe(200);
    const bad: Record<string, string> = {
      expired: await sign(H, { sub: u.id, exp: Math.floor(Date.now() / 1000) - 10 }),
      expiresNow: await sign(H, { sub: u.id, exp: Math.floor(Date.now() / 1000) }),
      noExp: await sign(H, { sub: u.id }),
      stringExp: await sign(H, { sub: u.id, exp: String(future()) }),
      noSub: await sign(H, { exp: future() }),
      numericSub: await sign(H, { sub: 1, exp: future() }),
      wrongSecret: await sign(H, { sub: u.id, exp: future() }, "another-secret-another-secret-xx"),
      algNone: `${b64u(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64u(JSON.stringify({ sub: u.id, exp: future() }))}.`,
      algNoneWithSig: `${b64u(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64u(JSON.stringify({ sub: u.id, exp: future() }))}.AAAA`,
      hs512: await sign({ alg: "HS512", typ: "JWT" }, { sub: u.id, exp: future() }, SECRET, "SHA-512"),
      hs256HeaderButSha512: await sign(H, { sub: u.id, exp: future() }, SECRET, "SHA-512"),
      rs256: await sign({ alg: "RS256", typ: "JWT" }, { sub: u.id, exp: future() }),
      emptySig: `${(await sign(H, { sub: u.id, exp: future() })).split(".").slice(0, 2).join(".")}.`,
      twoParts: (await sign(H, { sub: u.id, exp: future() })).split(".").slice(0, 2).join("."),
      fourParts: `${await sign(H, { sub: u.id, exp: future() })}.x`,
      notBase64: "a.b.c!",
      empty: "x",
    };
    for (const [name, t] of Object.entries(bad)) expect((await call("/me", { token: t })).status, name).toBe(401);
    // tampering with the payload (swap in another user's id) invalidates the signature
    const other = await newUser();
    const good = (await sign(H, { sub: u.id, exp: future() })).split(".");
    const forged = `${good[0]}.${b64u(JSON.stringify({ sub: other.id, exp: future() }))}.${good[2]}`;
    expect((await call("/me", { token: forged })).status).toBe(401);
    // flipping one bit of the signature
    const flipped = `${good[0]}.${good[1]}.${good[2]![0] === "A" ? "B" : "A"}${good[2]!.slice(1)}`;
    expect((await call("/me", { token: flipped })).status).toBe(401);
  });

  it("a token for a user id that does not exist is refused on every route, not only /me", async () => {
    const ghost = await sign(H, { sub: crypto.randomUUID(), exp: future() });
    expect((await call("/me", { token: ghost })).status).toBe(401);
    expect((await call("/events", { token: ghost })).status).toBe(401);
    expect((await call("/events", { token: ghost, body: { name: "Ghost Cup" } })).status).toBe(401);
  });

  it("a deleted account's token stops working everywhere and leaves no events behind (regression)", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    const del = await call("/auth/delete-account", { token: u.token, body: { password: "correct horse" } });
    expect(del.status).toBe(200);
    expect((await call("/me", { token: u.token })).status).toBe(401);
    expect((await call("/events", { token: u.token })).status).toBe(401);
    expect((await call(`/events/${ev.id}`, { token: u.token })).status).toBe(401);
    const created = await call("/events", { token: u.token, body: { name: "Zombie" } });
    expect(created.status).toBe(401);
    const orphans = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE owner_id = ?").bind(u.id).first<{ n: number }>();
    expect(orphans!.n).toBe(0);
  });

  it("authorization header must be exactly Bearer <token>", async () => {
    const u = await newUser();
    for (const h of [`bearer ${u.token}`, `Bearer  ${u.token}`, `Bearer ${u.token} extra`, u.token, `Token ${u.token}`, "Bearer "]) {
      expect((await call("/me", { headers: { authorization: h } })).status, h.slice(0, 12)).toBe(401);
    }
  });
});
