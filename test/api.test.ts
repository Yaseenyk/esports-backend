/// <reference types="vite/client" />
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { callDirect as call } from "./golden/direct";
import { newEvent, newUser } from "./helpers";
import { setFlag, teamOn, teamOff, club, joined, verified } from "./orgs/helpers";
import { can, subjectOf } from "../src/plans";

const db = env.DB;
const T = "2026-11-01T00:00:00.000Z";

async function mkKey(token: string, label = "ci") {
  const r = await call("/me/api-keys", { token, body: { label } });
  expect(r.status, r.text).toBe(201);
  return r.json as { id: string; key: string; hint: string };
}
const bearer = (key: string) => ({ headers: { authorization: `Bearer ${key}` } });

/** Seeds counts for an event: 3 registrations (2 pending, 1 approved) with recognisable personal strings, 2 check-ins, live hits. */
async function seed(eventId: string) {
  const reg = (id: string, status: string) =>
    db.prepare("INSERT INTO registrations (id, event_id, team_name, captain_name, captain_contact, players, status, created_at) VALUES (?1, ?2, 'SecretTeamName', 'SecretCaptain', 'secret@contact.example', '[{\"name\":\"SecretKid\",\"minor\":true}]', ?3, ?4)").bind(id, eventId, status, T).run();
  await reg(`r1-${eventId}`, "pending");
  await reg(`r2-${eventId}`, "pending");
  await reg(`r3-${eventId}`, "approved");
  await db.prepare("INSERT INTO checkins (event_id, person_id, at) VALUES (?1, 'SecretPerson1', ?2), (?1, 'SecretPerson2', ?2)").bind(eventId, T).run();
  await db.prepare("INSERT INTO live_hits (event_id, day, source, view, hits) VALUES (?1, '2026-11-02', 'live', '', 7), (?1, '2026-11-02', 'embed', '', 3)").bind(eventId).run();
}

describe("API keys", () => {
  it("key is returned once, stored only as a hash, listed without the secret, max 5, revoke works, audit rows written", async () => {
    const u = await newUser("Keys");
    const k = await mkKey(u.token, "first");
    expect(k.key).toMatch(/^ehk_[A-Za-z0-9_-]{32}$/);
    expect(k.hint).toBe(k.key.slice(0, 8));
    const dump = JSON.stringify((await db.prepare("SELECT * FROM api_keys WHERE user_id = ?1").bind(u.id).all()).results);
    expect(dump).not.toContain(k.key);
    expect(dump).toContain('"scope":"read"');
    const list = await call("/me/api-keys", { token: u.token });
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(k.key);
    expect(list.text).not.toContain("key_hash");
    expect(list.json.keys).toHaveLength(1);
    expect(list.json.keys[0].lastUsedAt).toBeNull();
    for (let i = 0; i < 4; i++) await mkKey(u.token, `k${i}`);
    const sixth = await call("/me/api-keys", { token: u.token, body: { label: "six" } });
    expect(sixth.status).toBe(409);
    expect(sixth.json.code).toBe("api_key_limit");
    expect((await call("/me/api-keys", { token: u.token, body: { label: "" } })).status).toBe(400);
    // another user cannot revoke it; the owner can; a revoked key no longer authenticates and frees a slot
    const other = await newUser("Other");
    expect((await call(`/me/api-keys/${k.id}`, { method: "DELETE", token: other.token })).status).toBe(404);
    expect((await call("/api/v1/events", bearer(k.key))).status).toBe(200);
    expect((await call(`/me/api-keys/${k.id}`, { method: "DELETE", token: u.token })).status).toBe(200);
    expect((await call(`/me/api-keys/${k.id}`, { method: "DELETE", token: u.token })).status).toBe(404);
    expect((await call("/api/v1/events", bearer(k.key))).status).toBe(401);
    await mkKey(u.token, "after revoke");
    const audits = await db.prepare("SELECT action, actor_id, target_id, meta FROM audit_log WHERE actor_id = ?1 AND action LIKE 'apikey.%' ORDER BY id").bind(u.id).all<{ action: string; target_id: string; meta: string }>();
    const names = audits.results.map((r) => r.action);
    expect(names.filter((n) => n === "apikey.created")).toHaveLength(6);
    expect(names.filter((n) => n === "apikey.revoked")).toHaveLength(1);
    expect(JSON.stringify(audits.results)).not.toContain("ehk_");
  });
});

describe("public API v1", () => {
  it("needs an API key (not a user token), returns counts and metadata only, only the owner's events, closed CORS, ETag, last_used_at once an hour", async () => {
    const u = await newUser("Owner");
    const stranger = await newUser("Stranger");
    const ev = await newEvent(u.token, "Mine Cup");
    const theirs = await newEvent(stranger.token, "Theirs Cup");
    await seed(ev.id);
    await seed(theirs.id);
    const k = await mkKey(u.token);

    for (const path of ["/api/v1/events", `/api/v1/events/${ev.id}/summary`]) {
      expect((await call(path)).status, path).toBe(401);
      expect((await call(path, { token: u.token })).status, "user token").toBe(401);
      expect((await call(path, bearer("ehk_" + "A".repeat(32)))).status, "unknown key").toBe(401);
      expect((await call(path, bearer("nonsense"))).status).toBe(401);
    }
    expect((await call("/api/v1/events", { method: "POST", ...bearer(k.key), body: {} })).status).toBe(404);
    // an API key is not a user token
    expect((await call("/me/api-keys", bearer(k.key))).status).toBe(401);

    const list = await call("/api/v1/events", bearer(k.key));
    expect(list.status).toBe(200);
    expect(list.json.events.map((e: { id: string }) => e.id)).toEqual([ev.id]);
    expect(list.json.events[0].registrations).toEqual({ total: 3, pending: 2, approved: 1 });
    expect(list.json.events[0].checkIns).toBe(2);
    expect(list.json.events[0].liveViews).toBe(10);

    const sum = await call(`/api/v1/events/${ev.id}/summary`, bearer(k.key));
    expect(sum.status, sum.text).toBe(200);
    expect(sum.json.event.name).toBe("Mine Cup");
    expect(sum.json.counts).toEqual({
      registrations: { total: 3, pending: 2, approved: 1, byStatus: { approved: 1, pending: 2 } },
      checkIns: 2,
      liveViews: { total: 10, bySource: { embed: 3, live: 7 } },
    });
    // not the owner's: indistinguishable from a missing event
    const foreign = await call(`/api/v1/events/${theirs.id}/summary`, bearer(k.key));
    const missing = await call("/api/v1/events/nope/summary", bearer(k.key));
    expect(foreign.status).toBe(404);
    expect(foreign.text).toBe(missing.text);

    // privacy: nothing personal in any output, and none of the owner's secrets either
    for (const text of [list.text, sum.text]) {
      for (const s of ["SecretTeamName", "SecretCaptain", "secret@contact", "SecretKid", "SecretPerson", "minor", u.email, "venue", "emergency", "owner_id", "signing_secret", "photo"]) expect(text, s).not.toContain(s);
    }

    // CORS closed: no allow-origin header even for an allowed origin, and the pre-flight is refused
    const cors = await call("/api/v1/events", { headers: { authorization: `Bearer ${k.key}`, origin: "https://esports.streamerosai.com" } });
    expect(cors.status).toBe(200);
    expect(cors.headers.get("access-control-allow-origin")).toBeNull();
    const pre = await call("/api/v1/events", { method: "OPTIONS", headers: { origin: "https://esports.streamerosai.com", "access-control-request-method": "GET" } });
    expect(pre.status).toBe(403);

    // ETag and a short private cache; If-None-Match gives 304
    const etag = sum.headers.get("etag")!;
    expect(etag).toBeTruthy();
    expect(sum.headers.get("cache-control")).toMatch(/private, max-age=\d+/);
    const again = await call(`/api/v1/events/${ev.id}/summary`, { headers: { authorization: `Bearer ${k.key}`, "if-none-match": etag } });
    expect(again.status).toBe(304);

    // last_used_at: set on first use, then not touched again within the hour
    const used = await db.prepare("SELECT last_used_at FROM api_keys WHERE id = ?1").bind(k.id).first<{ last_used_at: string }>();
    expect(used!.last_used_at).toBeTruthy();
    await call("/api/v1/events", bearer(k.key));
    expect((await db.prepare("SELECT last_used_at FROM api_keys WHERE id = ?1").bind(k.id).first<{ last_used_at: string }>())!.last_used_at).toBe(used!.last_used_at);
    await db.prepare("UPDATE api_keys SET last_used_at = '2020-01-01T00:00:00.000Z' WHERE id = ?1").bind(k.id).run();
    await call("/api/v1/events", bearer(k.key));
    expect((await db.prepare("SELECT last_used_at FROM api_keys WHERE id = ?1").bind(k.id).first<{ last_used_at: string }>())!.last_used_at > "2021").toBe(true);
  });

  it("is rate limited per key (429 after 60 requests a minute)", async () => {
    const u = await newUser("Limited");
    const k = await mkKey(u.token);
    const ip = "203.0.113.77";
    let last = 0;
    for (let i = 0; i < 61; i++) last = (await call("/api/v1/events", { ip, ...bearer(k.key) })).status;
    expect(last).toBe(429);
  });

  it("a suspended account's key stops working", async () => {
    const u = await newUser("Susp");
    const k = await mkKey(u.token);
    await db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1").bind(u.id).run();
    expect((await call("/api/v1/events", bearer(k.key))).status).toBe(401);
  });
});

describe("analytics (counts only)", () => {
  it("GET /me/analytics works without the club flag and matches the data; window is capped at 12 months", async () => {
    await teamOff();
    const u = await newUser("Me");
    const ev = await newEvent(u.token, "Analytics Cup");
    await seed(ev.id);
    expect((await call("/me/analytics")).status).toBe(401);
    const r = await call("/me/analytics", { token: u.token });
    expect(r.status, r.text).toBe(200);
    expect(r.json.events.total).toBe(1);
    expect(r.json.events.byMonth).toHaveLength(1);
    expect(r.json.registrations).toEqual({ total: 3, byStatus: { approved: 1, pending: 2 } });
    expect(r.json.checkIns.total).toBe(2);
    expect(r.json.liveViews).toEqual({ total: 10, bySource: { embed: 3, live: 7 } });
    expect(r.json.perEvent).toHaveLength(1);
    for (const s of ["SecretTeamName", "SecretCaptain", "secret@contact", "SecretKid", "SecretPerson", u.email]) expect(r.text, s).not.toContain(s);
    expect(r.headers.get("etag")).toBeTruthy();
    expect((await call("/me/analytics?months=13", { token: u.token })).status).toBe(400);
    expect((await call("/me/analytics?months=0", { token: u.token })).status).toBe(400);
    const narrow = await call("/me/analytics?months=1", { token: u.token });
    expect(narrow.json.window.months).toBe(1);
  });

  it("GET /orgs/:id/analytics: flag off is the unknown-route 404; member and admin may read; a stranger gets 404", async () => {
    await teamOn();
    try {
      const admin = await club("Admin A", "Analytics Club");
      const member = await joined(admin, "member", "Helper A");
      const stranger = await verified("Stranger A");
      const ev = await call("/events", { token: admin.token, body: { name: "Club Cup", orgId: admin.orgId } });
      expect(ev.status, ev.text).toBe(201);
      await seed(ev.json.id);
      for (const t of [admin.token, member.token]) {
        const r = await call(`/orgs/${admin.orgId}/analytics`, { token: t });
        expect(r.status, r.text).toBe(200);
        expect(r.json.org).toEqual({ id: admin.orgId, name: "Analytics Club", kind: "team" });
        expect(r.json.events.total).toBe(1);
        expect(r.json.registrations.total).toBe(3);
        expect(r.json.checkIns.total).toBe(2);
        expect(r.json.liveViews.total).toBe(10);
        expect(r.text).not.toContain("SecretTeamName");
      }
      expect((await call(`/orgs/${admin.orgId}/analytics`, { token: stranger.token })).status).toBe(404);
      expect((await call(`/orgs/${admin.orgId}/analytics`)).status).toBe(401);
      expect((await call(`/orgs/${admin.orgId}/analytics?months=99`, { token: admin.token })).status).toBe(400);
      await teamOff();
      const off = await call(`/orgs/${admin.orgId}/analytics`, { token: admin.token });
      const unknown = await call("/nothing-here", { token: admin.token });
      expect(off.status).toBe(404);
      expect(off.text).toBe(unknown.text);
    } finally {
      await setFlag("orgs.team", undefined);
    }
  });

  it("makes no D1 writes (rows_written stays 0 for the analytics batch)", async () => {
    const u = await newUser("NoWrite");
    await newEvent(u.token);
    const before = await db.prepare("SELECT (SELECT COUNT(*) FROM audit_log) AS a, (SELECT COUNT(*) FROM rate_limits) AS r, (SELECT COUNT(*) FROM metrics_daily) AS m").first();
    await call("/me/analytics", { token: u.token });
    await call("/me/analytics", { token: u.token });
    expect(await db.prepare("SELECT (SELECT COUNT(*) FROM audit_log) AS a, (SELECT COUNT(*) FROM rate_limits) AS r, (SELECT COUNT(*) FROM metrics_daily) AS m").first()).toEqual(before);
  });
});

describe("plans and entitlements", () => {
  it("GET /me/entitlements returns the free plan; the seed row exists; can() resolves to free; no billing words", async () => {
    const u = await newUser("Plan");
    expect((await call("/me/entitlements")).status).toBe(401);
    const r = await call("/me/entitlements", { token: u.token });
    expect(r.status).toBe(200);
    expect(r.json.plan.id).toBe("free");
    expect(r.json.subject).toBe(`user:${u.id}`);
    expect(r.json.since).toBeNull();
    expect(r.json.features).toEqual({ analytics: true, apiKeys: true, apiRead: true });
    const seeded = await db.prepare("SELECT id, name, limits FROM plans").all<{ id: string; limits: string }>();
    expect(seeded.results.map((p) => p.id)).toEqual(["free"]);
    expect(JSON.parse(seeded.results[0]!.limits)).toEqual(r.json.plan.limits);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM entitlements").first<{ n: number }>()).toEqual({ n: 0 });
    expect(can(subjectOf("org", "anything"), "api_read")).toBe(true);
    expect(r.text).not.toMatch(/price|pay|checkout|invoice/i);
  });
});
