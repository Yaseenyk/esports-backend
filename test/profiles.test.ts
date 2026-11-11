import { describe, expect, it, vi } from "vitest";
import { computeTeamResults, validateLinks } from "../src/features/profiles";
import { call, newUser, setupEvent } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

const mk = (o: Record<string, unknown>) => ({ id: "m", stage: "main", round: 1, slot: 1, a: "", b: "", status: "finished", scoreA: null, scoreB: null, winner: null, startsAt: null, nextId: null, nextSide: null, updatedAt: "", ...o }) as any;

describe("pure helpers", () => {
  it("computes a record from finished matches and ignores the rest", () => {
    const r = computeTeamResults("alpha wolves", [
      mk({ a: "Alpha Wolves", b: "B", scoreA: 2, scoreB: 1, winner: "a" }),
      mk({ a: "C", b: "Alpha Wolves", scoreA: 3, scoreB: 0, winner: "a" }),
      mk({ a: "Alpha Wolves", b: "D", scoreA: 1, scoreB: 1, winner: "draw" }),
      mk({ a: "Alpha Wolves", b: "E", status: "scheduled" }),
      mk({ a: "X", b: "Y", scoreA: 1, scoreB: 0, winner: "a" }),
    ], []);
    expect(r.record).toEqual({ played: 3, wins: 1, draws: 1, losses: 1 });
    expect(r.br).toBeNull();
  });
  it("summarises battle royale rows", () => {
    const r = computeTeamResults("Alpha", [], [
      { matchNo: 1, team: "Alpha", placement: 4, kills: 5 }, { matchNo: 2, team: "alpha", placement: 2, kills: 7 }, { matchNo: 1, team: "Beta", placement: 1, kills: 9 },
    ]);
    expect(r).toEqual({ record: null, br: { matches: 2, bestPlacement: 2, kills: 12 } });
  });
  it("accepts only https links to the allowed social sites", () => {
    expect(validateLinks(["https://www.instagram.com/team", "https://discord.gg/abc", "https://x.com/a"])).toHaveLength(3);
    for (const bad of ["http://instagram.com/a", "https://evil.com/instagram.com", "https://instagram.com.evil.com/a", "https://u:p@instagram.com/a", "javascript:alert(1)", "https://notinstagram.com/a", "nonsense"]) {
      expect(() => validateLinks([bad]), bad).toThrow();
    }
  });
});

async function world() {
  const o = await setupEvent("Profile Cup");
  const ev = o.ev.id;
  const m = await call(`/events/${ev}/matches`, { method: "PUT", token: o.token, body: { matches: [{ stage: "main", round: 1, slot: 1, a: "Alpha Wolves", b: "Beta Hawks" }, { stage: "main", round: 2, slot: 1, a: "Alpha Wolves", b: "Gamma" }] } });
  expect(m.status).toBe(200);
  const first = m.json.matches.find((x: any) => x.round === 1);
  expect((await call(`/events/${ev}/matches/${first.id}/result`, { token: o.token, body: { scoreA: 2, scoreB: 0 } })).status).toBe(200);
  expect((await call(`/events/${ev}/br-results`, { method: "PUT", token: o.token, body: { results: [{ matchNo: 1, team: "Alpha Wolves", placement: 3, kills: 4 }] } })).status).toBe(200);
  return { o, ev };
}

const mkProfile = (token: string, over: Record<string, unknown> = {}) => call("/profiles", { token, body: { name: "Alpha Wolves", blurb: "We play for fun.", links: ["https://instagram.com/alphawolves"], ...over } });

describe("profiles: owner side", () => {
  it("every route refuses anonymous callers with 401", async () => {
    for (const [method, path] of [["GET", "/profiles"], ["POST", "/profiles"], ["PUT", "/profiles/x"], ["DELETE", "/profiles/x"], ["POST", "/profiles/x/link"], ["POST", "/profiles/x/unlink"]] as const) {
      expect((await call(path, { method, body: method === "GET" ? undefined : {} })).status, `${method} ${path}`).toBe(401);
    }
  });

  it("creates a hidden page, validates input, and keeps pages private to their owner", async () => {
    const u = await newUser("Own"), other = await newUser("Oth");
    const a = await mkProfile(u.token);
    expect(a.status).toBe(201);
    expect(a.json.published).toBe(false);
    expect(a.json.slug).toMatch(/^[a-z2-7]{12}$/);
    expect(a.json.consentAt).toBeNull();
    expect((await mkProfile(u.token, { name: "x" })).status).toBe(400);
    expect((await mkProfile(u.token, { blurb: "x".repeat(201) })).status).toBe(400);
    expect((await mkProfile(u.token, { blurb: "mail me cap@example.com" })).status).toBe(400);
    expect((await mkProfile(u.token, { blurb: "call 98765 43210" })).status).toBe(400);
    expect((await mkProfile(u.token, { links: ["https://evil.example/x"] })).status).toBe(400);
    expect((await mkProfile(u.token, { links: ["http://instagram.com/x"] })).status).toBe(400);
    expect((await call("/profiles", { token: u.token })).json.profiles).toHaveLength(1);
    expect((await call("/profiles", { token: other.token })).json.profiles).toEqual([]);
    expect((await call(`/profiles/${a.json.id}`, { method: "PUT", token: other.token, body: { name: "Hijack" } })).status).toBe(404);
    expect((await call(`/profiles/${a.json.id}`, { method: "DELETE", token: other.token })).status).toBe(404);
    expect((await call(`/profiles/${a.json.id}`, { method: "PUT", token: u.token, body: { name: "Alpha Wolves 2" } })).json.name).toBe("Alpha Wolves 2");
  });

  it("link needs edit access to the event: stranger 404, viewer 403, editor ok", async () => {
    const w = await world();
    const ed = await newUser("Ed"), vi_ = await newUser("Vi"), st = await newUser("St");
    await call(`/events/${w.ev}/members`, { token: w.o.token, body: { email: ed.email, role: "editor" } });
    await call(`/events/${w.ev}/members`, { token: w.o.token, body: { email: vi_.email, role: "viewer" } });
    for (const [u, status] of [[st, 404], [vi_, 403], [ed, 201], [w.o, 201]] as const) {
      const p = await mkProfile(u.token);
      const r = await call(`/profiles/${p.json.id}/link`, { token: u.token, body: { eventId: w.ev, teamName: "Alpha Wolves" } });
      expect(r.status, u.email).toBe(status);
    }
    const p = await mkProfile(w.o.token);
    const dup = await call(`/profiles/${p.json.id}/link`, { token: w.o.token, body: { eventId: w.ev, teamName: "Alpha Wolves" } });
    const dup2 = await call(`/profiles/${p.json.id}/link`, { token: w.o.token, body: { eventId: w.ev, teamName: "Alpha Wolves" } });
    expect(dup.json.events).toHaveLength(1);
    expect(dup2.json.events).toHaveLength(1);
    const un = await call(`/profiles/${p.json.id}/unlink`, { token: w.o.token, body: { eventId: w.ev, teamName: "Alpha Wolves" } });
    expect(un.json.events).toEqual([]);
  });
});

describe("profiles: consent and the public page", () => {
  it("publishing needs consent; the public page shows results only; unpublishing hides it and clears consent", async () => {
    const w = await world();
    const p = (await mkProfile(w.o.token)).json;
    await call(`/profiles/${p.id}/link`, { token: w.o.token, body: { eventId: w.ev, teamName: "Alpha Wolves" } });
    expect((await call(`/public/team/${p.slug}`)).status).toBe(404); // not published yet
    expect((await call(`/profiles/${p.id}`, { method: "PUT", token: w.o.token, body: { published: true } })).status).toBe(400);
    expect((await call(`/profiles/${p.id}`, { method: "PUT", token: w.o.token, body: { published: true, consent: false } })).status).toBe(400);
    const pub = await call(`/profiles/${p.id}`, { method: "PUT", token: w.o.token, body: { published: true, consent: true } });
    expect(pub.status).toBe(200);
    expect(pub.json.published).toBe(true);
    expect(pub.json.consentAt).toMatch(/^\d{4}-/);

    const r = await call(`/public/team/${p.slug}`);
    expect(r.status).toBe(200);
    expect(r.json.name).toBe("Alpha Wolves");
    expect(r.json.links).toEqual(["https://instagram.com/alphawolves"]);
    expect(r.json.history).toEqual([{ eventName: "Profile Cup", date: "2026-12-01", record: { played: 1, wins: 1, draws: 0, losses: 0 }, br: { matches: 1, bestPlacement: 3, kills: 4 } }]);
    // no personal data: none of the roster names, emails or ids leak
    for (const s of ["Asha", "Ravi", "Mira", "@example.com", "photo", "owner", w.ev]) expect(r.text).not.toContain(s);
    expect(Object.keys(r.json).sort()).toEqual(["blurb", "history", "links", "name", "updatedAt"]);

    const etag = r.headers.get("etag")!;
    expect(etag).toBeTruthy();
    const again = await call(`/public/team/${p.slug}`, { headers: { "if-none-match": etag } });
    expect(again.status).toBe(304);

    const off = await call(`/profiles/${p.id}`, { method: "PUT", token: w.o.token, body: { published: false } });
    expect(off.json.published).toBe(false);
    expect(off.json.consentAt).toBeNull();
    expect((await call(`/public/team/${p.slug}`)).status).toBe(404);
    // publishing again asks for consent again
    expect((await call(`/profiles/${p.id}`, { method: "PUT", token: w.o.token, body: { published: true } })).status).toBe(400);
  });

  it("bad slugs are 404, deleting removes the page, and the public route is rate limited", async () => {
    const u = await newUser("Del");
    const p = (await mkProfile(u.token)).json;
    await call(`/profiles/${p.id}`, { method: "PUT", token: u.token, body: { published: true, consent: true } });
    expect((await call("/public/team/nope")).status).toBe(404);
    expect((await call(`/profiles/${p.id}`, { method: "DELETE", token: u.token })).status).toBe(200);
    expect((await call(`/public/team/${p.slug}`)).status).toBe(404);
    expect((await call("/profiles", { token: u.token })).json.profiles).toEqual([]);
    const ip = "203.0.113.77";
    let last = 0;
    for (let i = 0; i < 242; i++) last = (await call(`/public/team/${p.slug}`, { ip })).status;
    expect(last).toBe(429);
  });
});
