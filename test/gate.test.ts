import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { basicRoster, call, newEvent, newGateKey, newUser, pngBytes, refSig, setupEvent } from "./helpers";

async function codes(token: string, eventId: string) {
  const r = await call(`/events/${eventId}/passes`, { token });
  return Object.fromEntries((r.json as { personId: string; code: string }[]).map((p) => [p.personId, p.code]));
}

describe("gate keys", () => {
  it("shows the raw key once, stores only a hash", async () => {
    const s = await setupEvent();
    const r = await call(`/events/${s.ev.id}/gate-keys`, { token: s.token, body: { label: "Door", expiresInHours: 12 } });
    expect(r.status).toBe(201);
    expect(r.json.key).toMatch(/^gk_[A-Za-z0-9_-]{32}$/);
    expect(r.json.expiresAt).toBeTruthy();
    const list = await call(`/events/${s.ev.id}/gate-keys`, { token: s.token });
    expect(list.text).not.toContain(r.json.key);
    expect(list.json[0]).toMatchObject({ id: r.json.id, label: "Door", revoked: false });
    const row = await env.DB.prepare("SELECT key_hash FROM gate_keys WHERE id = ?").bind(r.json.id).first<{ key_hash: string }>();
    expect(row!.key_hash).not.toContain(r.json.key);
    expect((await call(`/events/${s.ev.id}/gate-keys`, { token: s.token, body: {} })).status).toBe(400);
  });
});

describe("gate", () => {
  it("roster, photos, ok then again with the original time", async () => {
    const s = await setupEvent();
    const gk = await newGateKey(s.token, s.ev.id);
    const c = await codes(s.token, s.ev.id);

    const roster = await call("/gate/roster", { gate: gk.key });
    expect(roster.status).toBe(200);
    expect(roster.json.event).toMatchObject({ name: "Summer Cup", venue: "Hall 1" });
    expect(roster.json.people).toHaveLength(3);
    const ravi = roster.json.people.find((p: any) => p.id === "ALP-002");
    expect(ravi).toMatchObject({ name: "Ravi", team: "Alpha Wolves", role: "Coach", minor: true, guardian: true, checkedInAt: null, photoUrl: "/gate/photos/ALP-002" });
    const photo = await call(ravi.photoUrl, { gate: gk.key });
    expect(photo.status).toBe(200);
    expect(photo.bytes).toEqual(pngBytes());
    expect((await call("/gate/photos/BET-001", { gate: gk.key })).status).toBe(404);

    const first = await call("/gate/checkin", { gate: gk.key, body: { code: c["ALP-001"] } });
    expect(first.status).toBe(200);
    expect(first.json.status).toBe("ok");
    expect(first.json.person).toMatchObject({ id: "ALP-001", name: "Asha", team: "Alpha Wolves", role: "Player" });
    await new Promise((r) => setTimeout(r, 15));
    const again = await call("/gate/checkin", { gate: gk.key, body: { code: c["ALP-001"] } });
    expect(again.json.status).toBe("again");
    expect(again.json.at).toBe(first.json.at);

    const after = await call("/gate/roster", { gate: gk.key });
    expect(after.json.people.find((p: any) => p.id === "ALP-001").checkedInAt).toBe(first.json.at);

    // owner live view
    const live = await call(`/events/${s.ev.id}/checkins`, { token: s.token });
    expect(live.json.total).toBe(3);
    expect(live.json.checkedIn).toBe(1);
    expect(live.json.checkins).toEqual([{ personId: "ALP-001", name: "Asha", team: "Alpha Wolves", role: "Player", at: first.json.at, door: expect.any(String) }]);
    const later = await call(`/events/${s.ev.id}/checkins?since=${encodeURIComponent(first.json.at)}`, { token: s.token });
    expect(later.json.checkins).toEqual([]);
    expect(later.json.checkedIn).toBe(1);
    expect((await call(`/events/${s.ev.id}/checkins?since=garbage`, { token: s.token })).status).toBe(400);
    expect((await call(`/events/${s.ev.id}/checkins`, { token: s.token, method: "DELETE" })).status).toBe(200);
    expect((await call(`/events/${s.ev.id}/checkins`, { token: s.token })).json.checkedIn).toBe(0);
    expect((await call("/gate/checkin", { gate: gk.key, body: { code: c["ALP-001"] } })).json.status).toBe("ok");
  });

  it("returns bad (and records nothing) for edited id, changed role, other event and garbage", async () => {
    const s = await setupEvent();
    const gk = await newGateKey(s.token, s.ev.id);
    const c = await codes(s.token, s.ev.id);
    const secret = (await env.DB.prepare("SELECT signing_secret FROM events WHERE id = ?").bind(s.ev.id).first<{ signing_secret: string }>())!.signing_secret;

    // a second event of the same owner, same people, own key
    const other = await newEvent(s.token, "Other Cup");
    await call(`/events/${other.id}/roster`, { method: "PUT", token: s.token, body: basicRoster() });
    const otherCodes = await codes(s.token, other.id);

    const tries: Record<string, string> = {
      "edited id (existing person)": c["ALP-001"]!.replace("ALP-001", "ALP-002"),
      "edited id (unknown person)": c["ALP-001"]!.replace("ALP-001", "ZZZ-999"),
      "other event code": otherCodes["ALP-001"]!,
      "forged with wrong secret": `EH1.${s.ev.key}.ALP-001.${await refSig("not-the-secret", s.ev.key, "ALP-001", "Player")}`,
      "role escalated in the signature": `EH1.${s.ev.key}.ALP-001.${await refSig(secret, s.ev.key, "ALP-001", "Staff")}`,
      "truncated sig": c["ALP-001"]!.slice(0, -3),
      "garbage": "hello world",
      "empty": "",
      "wrong prefix": c["ALP-001"]!.replace("EH1", "EH2"),
      "too long": "EH1." + "a".repeat(500),
    };
    for (const [name, code] of Object.entries(tries)) {
      const r = await call("/gate/checkin", { gate: gk.key, body: { code } });
      expect(r.status, name).toBe(200);
      expect(r.json.status, name).toBe("bad");
      expect(r.json.reason, name).toBeTruthy();
    }
    expect((await call("/gate/checkin", { gate: gk.key, body: { code: 5 } })).json.status).toBe("bad");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM checkins WHERE event_id = ?").bind(s.ev.id).first<{ n: number }>();
    expect(n!.n).toBe(0);

    // role changed after the pass was issued -> old pass is invalid, new one works
    const changed = basicRoster();
    changed.people[0]!.role = "Staff";
    await call(`/events/${s.ev.id}/roster`, { method: "PUT", token: s.token, body: changed });
    expect((await call("/gate/checkin", { gate: gk.key, body: { code: c["ALP-001"] } })).json.status).toBe("bad");
    const fresh = await codes(s.token, s.ev.id);
    expect((await call("/gate/checkin", { gate: gk.key, body: { code: fresh["ALP-001"] } })).json.status).toBe("ok");
    expect((await call("/gate/checkin", { gate: gk.key, body: { code: c["ALP-002"] } })).json.status).toBe("ok"); // unchanged role stays valid
  });

  it("a key only works for its own event", async () => {
    const s = await setupEvent();
    const other = await newEvent(s.token, "Other Cup");
    await call(`/events/${other.id}/roster`, { method: "PUT", token: s.token, body: basicRoster() });
    const gkOther = await newGateKey(s.token, other.id);
    const c = await codes(s.token, s.ev.id);
    expect((await call("/gate/checkin", { gate: gkOther.key, body: { code: c["ALP-001"] } })).json.status).toBe("bad");
    expect((await call("/gate/roster", { gate: gkOther.key })).json.event.name).toBe("Other Cup");
  });

  it("revoked, expired, missing and unknown keys are 401", async () => {
    const s = await setupEvent();
    const good = await newGateKey(s.token, s.ev.id);
    const revoked = await newGateKey(s.token, s.ev.id);
    const expired = await newGateKey(s.token, s.ev.id);
    const c = await codes(s.token, s.ev.id);

    expect((await call("/gate/roster", { gate: revoked.key })).status).toBe(200);
    expect((await call(`/events/${s.ev.id}/gate-keys/${revoked.id}`, { method: "DELETE", token: s.token })).status).toBe(200);
    await env.DB.prepare("UPDATE gate_keys SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), expired.id).run();

    for (const key of [revoked.key, expired.key, "gk_nonsense", ""]) {
      expect((await call("/gate/roster", { gate: key || undefined })).status, key).toBe(401);
      expect((await call("/gate/checkin", { gate: key || undefined, body: { code: c["ALP-001"] } })).status, key).toBe(401);
      expect((await call("/gate/photos/ALP-002", { gate: key || undefined })).status, key).toBe(401);
    }
    expect((await call("/gate/roster")).status).toBe(401);
    expect((await call("/gate/roster", { token: s.token })).status).toBe(401); // a user JWT is not a gate key
    expect((await call("/gate/roster", { gate: good.key })).status).toBe(200);
    expect((await call(`/events/${s.ev.id}/gate-keys/nope`, { method: "DELETE", token: s.token })).status).toBe(404);
  });
});

describe("gate batch check-in", () => {
  it("replays queued scans in one request: ok, again, bad, and limits", async () => {
    const s = await setupEvent();
    const gk = await newGateKey(s.token, s.ev.id);
    const c = await codes(s.token, s.ev.id);
    await call("/gate/checkin", { gate: gk.key, body: { code: c["ALP-001"] } }); // already in
    const r = await call("/gate/checkin/batch", { gate: gk.key, body: { codes: [c["ALP-001"], c["ALP-002"], "EH1.nope", c["ALP-002"]] } });
    expect(r.status).toBe(200);
    expect(r.json.results.map((x: any) => x.status)).toEqual(["again", "ok", "bad", "again"]);
    expect(r.json.results[1].person.id).toBe("ALP-002");
    const live = await call(`/events/${s.ev.id}/checkins`, { token: s.token });
    expect(live.json.checkedIn).toBe(2);
    expect((await call("/gate/checkin/batch", { gate: gk.key, body: { codes: [] } })).status).toBe(400);
    expect((await call("/gate/checkin/batch", { gate: gk.key, body: { codes: Array(101).fill("x") } })).status).toBe(400);
    expect((await call("/gate/checkin/batch", { body: { codes: [c["ALP-001"]] } })).status).toBe(401);
  });
});

describe("door audit and key-guessing limit", () => {
  it("records which door scanned each guest", async () => {
    const s = await setupEvent();
    const gk = await call(`/events/${s.ev.id}/gate-keys`, { token: s.token, body: { label: "North door" } });
    const c = await codes(s.token, s.ev.id);
    await call("/gate/checkin", { gate: gk.json.key, body: { code: c["ALP-001"] } });
    const live = await call(`/events/${s.ev.id}/checkins`, { token: s.token });
    expect(live.json.checkins[0].door).toBe("North door");
  });
  it("throttles wrong gate keys from one address", async () => {
    const ip = "203.0.113.77";
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await call("/gate/roster", { gate: `gk_wrong${i}`, ip })).status;
    expect(last).toBe(429);
  });
});

describe("account safety", () => {
  it("changes the password only with the current one, and deletes an account with everything in it", async () => {
    const u = await newUser();
    const wrong = await call("/auth/change-password", { token: u.token, body: { current: "nope-nope-nope", next: "A-new-passw0rd!" } });
    expect(wrong.status).toBe(401);
    const short = await call("/auth/change-password", { token: u.token, body: { current: "correct horse", next: "short" } });
    expect(short.status).toBe(400);
    const ok = await call("/auth/change-password", { token: u.token, body: { current: "correct horse", next: "A-new-passw0rd!" } });
    expect(ok.status).toBe(200);
    expect((await call("/auth/login", { body: { email: u.email, password: "correct horse" } })).status).toBe(401);
    expect((await call("/auth/login", { body: { email: u.email, password: "A-new-passw0rd!" } })).status).toBe(200);

    const ev = await newEvent(u.token, "Doomed");
    expect((await call("/auth/delete-account", { token: u.token, body: { password: "wrong-one-here" } })).status).toBe(401);
    expect((await call("/auth/delete-account", { token: u.token, body: { password: "A-new-passw0rd!" } })).status).toBe(200);
    const left = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM users WHERE id = ?1) u, (SELECT COUNT(*) FROM events WHERE id = ?2) e").bind(u.id, ev.id).first<{ u: number; e: number }>();
    expect(left).toEqual({ u: 0, e: 0 });
  });
});
