import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { call, freshIp, newGateKey, setupEvent } from "../helpers";

vi.setConfig({ testTimeout: 180_000 });

// Token principals: a gate key, scorer, captain, run-of-show, invite, registration or share (pass) token reaches only its own event.
// Two events with distinctive names; every token minted on A must show A and never B, and must not act on B's match ids.
async function twoEvents() {
  const a = await setupEvent("Alpha Event Aaaa");
  const b = await setupEvent("Bravo Event Bbbb");
  const matches = { matches: [{ stage: "main", round: 1, slot: 1, a: "Alpha Wolves", b: "Beta Hawks" }] };
  const ma = (await call(`/events/${a.ev.id}/matches`, { method: "PUT", token: a.token, body: matches })).json.matches[0].id as string;
  const mb = (await call(`/events/${b.ev.id}/matches`, { method: "PUT", token: b.token, body: matches })).json.matches[0].id as string;
  return { a, b, ma, mb };
}
const onlyA = (text: string) => {
  expect(text).toContain("Alpha Event Aaaa");
  expect(text).not.toContain("Bravo Event Bbbb");
};

describe("golden: token principals reach only their own event", () => {
  it("gate key", async () => {
    const { a, b } = await twoEvents();
    const ka = await newGateKey(a.token, a.ev.id);
    const r = await call("/gate/roster", { gate: ka.key });
    expect(r.status).toBe(200);
    onlyA(r.text);
    // the key cannot be used on any user route, nor for B's data
    expect((await call(`/events/${b.ev.id}/roster`, { gate: ka.key })).status).toBe(401);
    expect((await call(`/events/${a.ev.id}/roster`, { gate: ka.key })).status).toBe(401);
  });

  it("invite link", async () => {
    const { a, b } = await twoEvents();
    const inv = (await call(`/events/${a.ev.id}/invites`, { token: a.token, body: { teamId: "t1" } })).json;
    const r = await call(`/public/invite/${inv.token}`);
    expect(r.status).toBe(200);
    onlyA(r.text);
    expect((await call(`/public/invite/${inv.token}/submit`, { body: { name: "Only Alpha" } })).status).toBe(201);
    expect((await call(`/events/${b.ev.id}/submissions`, { token: b.token })).json).toEqual([]);
    expect((await call(`/events/${a.ev.id}/submissions`, { token: a.token })).json.length).toBe(1);
  });

  it("registration form", async () => {
    const { a, b } = await twoEvents();
    const form = (await call(`/events/${a.ev.id}/registration`, { method: "PUT", token: a.token, body: { acknowledge: true, title: "Reg", teamSize: 1, subs: 0 } })).json;
    const r = await call(`/public/registration/${form.token}`);
    expect(r.status).toBe(200);
    onlyA(r.text);
    const sub = await call(`/public/registration/${form.token}/submit`, { body: { teamName: "Only Alpha Team", captainName: "Cap Tain", captainContact: "cap@example.com", players: [{ name: "P One" }] } });
    expect(sub.status).toBe(201);
    expect((await call(`/events/${b.ev.id}/registrations`, { token: b.token })).json).toEqual([]);
  });

  it("share (pass) link", async () => {
    const { a } = await twoEvents();
    const t = (await call(`/events/${a.ev.id}/people/ALP-001/share`, { token: a.token, body: {} })).json.token;
    const r = await call(`/public/pass/${t}`);
    expect(r.status).toBe(200);
    onlyA(r.text);
    expect(r.json.person.name).toBe("Asha");
  });

  it("scorer link", async () => {
    const { a, b, mb } = await twoEvents();
    const link = (await call(`/events/${a.ev.id}/scorer-links`, { token: a.token, body: { label: "Ref", hours: 1 } })).json;
    const r = await call(`/public/score/${link.token}`);
    expect(r.status).toBe(200);
    onlyA(r.text);
    const cross = await call(`/public/score/${link.token}/matches/${mb}/result`, { body: { scoreA: 1, scoreB: 0 } });
    expect(cross.status).toBe(404);
    const row = await env.DB.prepare("SELECT status FROM matches WHERE id = ? AND event_id = ?").bind(mb, b.ev.id).first<{ status: string }>();
    expect(row!.status).toBe("scheduled");
  });

  it("captain link", async () => {
    const { a, b, mb } = await twoEvents();
    const link = (await call(`/events/${a.ev.id}/captain-links`, { token: a.token, body: { team: "Alpha Wolves" } })).json;
    const r = await call(`/public/report/${link.token}`);
    expect(r.status).toBe(200);
    onlyA(r.text);
    const cross = await call(`/public/report/${link.token}/matches/${mb}`, { body: { scoreA: 1, scoreB: 0 } });
    expect(cross.status).toBe(404);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM result_submissions WHERE event_id = ?").bind(b.ev.id).first<{ n: number }>();
    expect(n!.n).toBe(0);
  });

  it("run-of-show link", async () => {
    const { a } = await twoEvents();
    const link = (await call(`/events/${a.ev.id}/runofshow/link`, { token: a.token, body: {} })).json;
    const r = await call(`/public/run/${link.token}`, { ip: freshIp() });
    expect(r.status).toBe(200);
    onlyA(r.text);
  });

  it("a user token of the owner of A is not a way into B", async () => {
    const { a, b } = await twoEvents();
    expect((await call(`/events/${b.ev.id}`, { token: a.token })).status).toBe(404);
    expect((await call(`/events/${b.ev.id}/roster`, { method: "PUT", token: a.token, body: {} })).status).toBe(404);
  });
});

describe("golden: limiter scope for credential routes is unchanged", () => {
  it("login: 10 tries per address per 15 minutes, the 11th is 429; another address is unaffected", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await call("/auth/login", { ip, body: { email: "ghost@example.com", password: "nope nope nope" } })).status);
    expect(statuses).toEqual([...Array(10).fill(401), 429]);
    expect((await call("/auth/login", { body: { email: "ghost@example.com", password: "nope nope nope" } })).status).toBe(401);
  });

  it("forgot: 5 per email per hour (from any address), the 6th is 429; the answer never says whether the account exists", async () => {
    const email = `ghost-${Date.now()}@example.com`;
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call("/auth/forgot", { body: { email } })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });

  it("wrong gate keys: 20 per address per 10 minutes are 401, the 21st is 429", async () => {
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < 21; i++) statuses.push((await call("/gate/roster", { gate: `gk_wrong${i}`, ip })).status);
    expect(statuses).toEqual([...Array(20).fill(401), 429]);
  });

  it("contact: 5 per address per hour, the 6th is 429", async () => {
    const ip = freshIp();
    const body = { name: "Asha", email: "asha@example.com", message: "Hello, I would like to know more." };
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await call("/public/contact", { ip, body })).status);
    expect(statuses.slice(0, 5).every((s) => s === 200 || s === 201)).toBe(true);
    expect(statuses[5]).toBe(429);
  });
});
