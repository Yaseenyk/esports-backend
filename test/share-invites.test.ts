import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, freshIp, pngBytes, pngDataUrl, refSig, toB64, setupEvent } from "./helpers";

describe("share links", () => {
  it("works, matches the signed pass, then 404 after revoke", async () => {
    const s = await setupEvent("Share Cup");
    const mk = await call(`/events/${s.ev.id}/people/ALP-002/share`, { token: s.token, method: "POST" });
    expect(mk.status).toBe(201);
    const token = mk.json.token as string;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    // idempotent while active
    expect((await call(`/events/${s.ev.id}/people/ALP-002/share`, { token: s.token, method: "POST" })).json.token).toBe(token);

    const pub = await call(`/public/pass/${token}`); // no auth
    expect(pub.status).toBe(200);
    expect(pub.json.event).toEqual({ name: "Share Cup", date: "2026-12-01", venue: "Hall 1" });
    expect(pub.json.person).toEqual({ name: "Ravi", team: "Alpha Wolves", role: "Coach", zones: [] });
    const secret = (await env.DB.prepare("SELECT signing_secret FROM events WHERE id = ?").bind(s.ev.id).first<{ signing_secret: string }>())!.signing_secret;
    expect(pub.json.code).toBe(`EH1.share-cup.ALP-002.${await refSig(secret, "share-cup", "ALP-002", "Coach")}`);
    expect(pub.json.photoUrl).toBe(`/public/pass/${token}/photo`);
    expect(pub.text).not.toContain(secret);
    expect(pub.text).not.toContain("minor");
    const photo = await call(pub.json.photoUrl);
    expect(photo.status).toBe(200);
    expect(photo.bytes).toEqual(pngBytes());

    expect((await call(`/events/${s.ev.id}/people/NOPE/share`, { token: s.token, method: "POST" })).status).toBe(404);
    expect((await call("/public/pass/not-a-token")).status).toBe(404);

    expect((await call(`/events/${s.ev.id}/people/ALP-002/share`, { token: s.token, method: "DELETE" })).status).toBe(200);
    expect((await call(`/public/pass/${token}`)).status).toBe(404);
    expect((await call(`/public/pass/${token}/photo`)).status).toBe(404);
    // a new link after revocation gets a new token
    const again = await call(`/events/${s.ev.id}/people/ALP-002/share`, { token: s.token, method: "POST" });
    expect(again.json.token).not.toBe(token);
  });

  it("returns 404 when the person has been removed from the roster", async () => {
    const s = await setupEvent();
    const { json } = await call(`/events/${s.ev.id}/people/ALP-001/share`, { token: s.token, method: "POST" });
    await call(`/events/${s.ev.id}/roster`, { method: "PUT", token: s.token, body: { teams: [{ id: "t1", name: "A" }], people: [{ id: "X", name: "x", teamId: "t1" }] } });
    expect((await call(`/public/pass/${json.token}`)).status).toBe(404);
  });
});

async function invite(s: Awaited<ReturnType<typeof setupEvent>>, body: Record<string, unknown> = {}) {
  const r = await call(`/events/${s.ev.id}/invites`, { token: s.token, body: { teamId: "t1", label: "Wolves link", ...body } });
  expect(r.status).toBe(201);
  return r.json as { id: string; token: string };
}
const submit = (token: string, body: unknown, ip = freshIp()) => call(`/public/invite/${token}/submit`, { body, ip });

describe("invites and self-submission", () => {
  it("public view, submit, owner approve creates a person with generated id and photo", async () => {
    const s = await setupEvent("Invite Cup");
    const inv = await invite(s, { maxUses: 5 });
    expect(inv.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const pub = await call(`/public/invite/${inv.token}`);
    expect(pub.json).toEqual({ event: { name: "Invite Cup", date: "2026-12-01" }, team: { name: "Alpha Wolves" } });

    const sub = await submit(inv.token, { name: "  Newbie  ", minor: true, photo: pngDataUrl(80) });
    expect(sub.status).toBe(201);
    const defaultRole = await submit(inv.token, { name: "Second" });
    expect(defaultRole.status).toBe(201);

    const pend = await call(`/events/${s.ev.id}/submissions?status=pending`, { token: s.token });
    expect(pend.json).toHaveLength(2);
    expect(pend.json[0]).toMatchObject({ name: "Newbie", role: "Player", minor: true, status: "pending", team: "Alpha Wolves", teamId: "t1" });
    expect(pend.json[0].photoUrl).toBeTruthy();
    expect(pend.json[1].photoUrl).toBeNull();
    expect((await call(pend.json[0].photoUrl, { token: s.token })).status).toBe(200);
    expect((await call(`/events/${s.ev.id}/submissions?status=bogus`, { token: s.token })).status).toBe(400);
    // uses incremented
    const list = await call(`/events/${s.ev.id}/invites`, { token: s.token });
    expect(list.json[0]).toMatchObject({ uses: 2, maxUses: 5, revoked: false });

    const ap = await call(`/events/${s.ev.id}/submissions/${pend.json[0].id}/approve`, { token: s.token, method: "POST" });
    expect(ap.status).toBe(200);
    expect(ap.json.personId).toBe("ALP-003"); // ALP-001 and ALP-002 exist
    const ap2 = await call(`/events/${s.ev.id}/submissions/${pend.json[1].id}/approve`, { token: s.token, body: { personId: "CUSTOM-1" } });
    expect(ap2.json.personId).toBe("CUSTOM-1");

    const roster = await call(`/events/${s.ev.id}/roster`, { token: s.token });
    const p = roster.json.people.find((x: any) => x.id === "ALP-003");
    expect(p).toMatchObject({ name: "Newbie", teamId: "t1", role: "Player", minor: true, guardian: false });
    expect(p.photoUrl).toBe(`/events/${s.ev.id}/photos/ALP-003`);
    expect(roster.json.people.find((x: any) => x.id === "CUSTOM-1").photoUrl).toBeNull();
    expect((await call(`/events/${s.ev.id}/submissions?status=pending`, { token: s.token })).json).toEqual([]);
    expect((await call(`/events/${s.ev.id}/submissions?status=approved`, { token: s.token })).json).toHaveLength(2);
    // cannot approve twice; duplicate person id refused
    expect((await call(`/events/${s.ev.id}/submissions/${pend.json[0].id}/approve`, { token: s.token, method: "POST" })).status).toBe(409);
    const s3 = await submit(inv.token, { name: "Third" });
    const pend3 = (await call(`/events/${s.ev.id}/submissions?status=pending`, { token: s.token })).json[0];
    expect(s3.status).toBe(201);
    expect((await call(`/events/${s.ev.id}/submissions/${pend3.id}/approve`, { token: s.token, body: { personId: "CUSTOM-1" } })).status).toBe(409);
  });

  it("reject marks the submission and creates nobody", async () => {
    const s = await setupEvent();
    const inv = await invite(s);
    await submit(inv.token, { name: "Spammer", photo: pngDataUrl() });
    const [sub] = (await call(`/events/${s.ev.id}/submissions?status=pending`, { token: s.token })).json;
    expect((await call(`/events/${s.ev.id}/submissions/${sub.id}/reject`, { token: s.token, method: "POST" })).status).toBe(200);
    expect((await call(`/events/${s.ev.id}/submissions?status=rejected`, { token: s.token })).json).toHaveLength(1);
    expect((await call(`/events/${s.ev.id}/submissions/${sub.id}/approve`, { token: s.token, method: "POST" })).status).toBe(409);
    expect((await call(`/events/${s.ev.id}/roster`, { token: s.token })).json.people).toHaveLength(3);
    expect((await call(`/events/${s.ev.id}/submissions/missing/reject`, { token: s.token, method: "POST" })).status).toBe(404);
  });

  it("enforces max_uses", async () => {
    const s = await setupEvent();
    const inv = await invite(s, { maxUses: 2 });
    expect((await submit(inv.token, { name: "One" })).status).toBe(201);
    expect((await submit(inv.token, { name: "Two" })).status).toBe(201);
    expect((await submit(inv.token, { name: "Three" })).status).toBe(404);
    expect((await call(`/public/invite/${inv.token}`)).status).toBe(404); // used up
    expect((await call(`/events/${s.ev.id}/submissions`, { token: s.token })).json).toHaveLength(2);
  });

  it("enforces expiry and revocation", async () => {
    const s = await setupEvent();
    const exp = await invite(s, { expiresInHours: 1 });
    expect((await call(`/public/invite/${exp.token}`)).status).toBe(200);
    await env.DB.prepare("UPDATE invites SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), exp.id).run();
    expect((await call(`/public/invite/${exp.token}`)).status).toBe(404);
    expect((await submit(exp.token, { name: "Late" })).status).toBe(404);

    const rev = await invite(s);
    expect((await submit(rev.token, { name: "Early" })).status).toBe(201);
    expect((await call(`/events/${s.ev.id}/invites/${rev.id}`, { token: s.token, method: "DELETE" })).status).toBe(200);
    expect((await call(`/public/invite/${rev.token}`)).status).toBe(404);
    expect((await submit(rev.token, { name: "After" })).status).toBe(404);
    expect((await call(`/events/${s.ev.id}/invites/nope`, { token: s.token, method: "DELETE" })).status).toBe(404);
    expect((await call("/public/invite/unknown-token")).status).toBe(404);
  });

  it("validates public submissions", async () => {
    const s = await setupEvent();
    const inv = await invite(s);
    const bad = async (b: unknown, status: number) => expect((await submit(inv.token, b)).status, JSON.stringify(b).slice(0, 60)).toBe(status);
    await bad({}, 400);
    await bad({ name: "" }, 400);
    await bad({ name: "x".repeat(81) }, 400);
    await bad({ name: "A", role: "Admin" }, 400);
    await bad({ name: "A", role: "Owner" }, 400);
    await bad({ name: "A", minor: "yes" }, 400);
    await bad({ name: "A", photo: "data:image/gif;base64,R0lGODlh" }, 415);
    await bad({ name: "A", photo: `data:image/png;base64,${toB64(pngBytes(500 * 1024))}` }, 413);
    for (const role of ["Player", "Substitute", "Coach", "Manager", "Staff"]) await bad({ name: "A", role }, 201);
    // failed submissions consumed no invite uses
    const list = await call(`/events/${s.ev.id}/invites`, { token: s.token });
    expect(list.json[0].uses).toBe(5);
    // creating an invite for an unknown team / bad maxUses
    expect((await call(`/events/${s.ev.id}/invites`, { token: s.token, body: { teamId: "nope" } })).status).toBe(404);
    expect((await call(`/events/${s.ev.id}/invites`, { token: s.token, body: { teamId: "t1", maxUses: 0 } })).status).toBe(400);
  });

  it("rate limits public submissions per invite and IP (30 per hour)", async () => {
    const s = await setupEvent();
    const inv = await invite(s);
    const ip = freshIp();
    for (let i = 0; i < 30; i++) expect((await submit(inv.token, { name: `P${i}` }, ip)).status).toBe(201);
    expect((await submit(inv.token, { name: "overflow" }, ip)).status).toBe(429);
    expect((await submit(inv.token, { name: "other ip" })).status).toBe(201);
  });
});
