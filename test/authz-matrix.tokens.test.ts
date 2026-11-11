/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { call, freshIp, newEvent, newGateKey, newUser, setupEvent } from "./helpers";
import { GATE } from "./golden/rows";

// Token principals: gate keys and JWT validation. (split from authz-matrix.test.ts; rows live in test/golden/rows.ts)
vi.setConfig({ testTimeout: 120_000 });

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
