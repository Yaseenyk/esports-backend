import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { basicRoster } from "../helpers";
import { call, club, db, joined, one, teamOff, teamOn, verified } from "./helpers";

vi.setConfig({ testTimeout: 180_000 });
beforeEach(teamOn);
afterEach(teamOff);

const TODAY = "2026-12-10";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

/** An organisation with events on every side of "today", plus pending work in some of them. */
async function seeded() {
  const a = await club("Boss", "Seeded Club");
  const mk = async (name: string, date: string | undefined, token = a.token) => (await call("/events", { token, body: { name, date, orgId: a.orgId } })).json as { id: string };
  const live = await mk("Live cup", TODAY);
  const up1 = await mk("Upcoming one", "2026-12-20");
  const up2 = await mk("Upcoming two", "2027-01-05");
  const past = await mk("Past cup", "2026-11-01");
  const none = await mk("Undated", undefined);
  const free = await mk("Free text date", "next Friday");
  // pending registrations in Live and Upcoming one (the form needs the acknowledgement)
  for (const [ev, n] of [[live, 2], [up1, 1]] as const) {
    const form = (await call(`/events/${ev.id}/registration`, { method: "PUT", token: a.token, body: { acknowledge: true, title: "Reg", teamSize: 1, subs: 0 } })).json;
    for (let i = 0; i < n; i++) {
      const r = await call(`/public/registration/${form.token}/submit`, { body: { teamName: `Team ${ev.id.slice(0, 4)} ${i}`, captainName: "Cap Tain", captainContact: "cap@example.com", players: [{ name: "P One" }] } });
      expect(r.status, r.text).toBe(201);
    }
  }
  // matches in Live: two open matches; one side has tapped ready
  await call(`/events/${live.id}/roster`, { method: "PUT", token: a.token, body: basicRoster() });
  const ms = await call(`/events/${live.id}/matches`, { method: "PUT", token: a.token, body: { matches: [{ stage: "main", round: 1, slot: 1, a: "Alpha Wolves", b: "Beta Hawks" }, { stage: "main", round: 1, slot: 2, a: "Gamma", b: "" }] } });
  expect(ms.status, ms.text).toBe(200);
  const m1 = ms.json.matches[0].id as string;
  await db.prepare("INSERT INTO ready_checks (id, event_id, match_id, team, ready_at) VALUES (?3, ?1, ?2, 'ALPHA wolves', 't')").bind(live.id, m1, crypto.randomUUID()).run();
  // pending and decided result submissions
  for (const [tag, status] of [["rs1", "pending"], ["rs2", "pending"], ["rs3", "approved"]] as const) {
    const id = `${tag}-${crypto.randomUUID()}`;
    await db.prepare("INSERT INTO result_submissions (id, event_id, match_id, team, score_a, score_b, status, created_at) VALUES (?1, ?2, ?3, ?4, 1, 0, ?5, 't')").bind(id, live.id, m1, `t-${id}`, status).run();
  }
  return { a, ids: { live, up1, up2, past, none, free } };
}

describe("organisation home: GET /orgs/:id/events", () => {
  it("groups and the three 'what needs you' counts equal direct queries on the seeded data", async () => {
    const { a, ids } = await seeded();
    const r = await call(`/orgs/${a.orgId}/events?today=${TODAY}`, { token: a.token });
    expect(r.status, r.text).toBe(200);
    // direct queries, written independently of the route
    const direct = {
      total: await one("SELECT COUNT(*) FROM events WHERE org_id = ?1", a.orgId),
      live: await one("SELECT COUNT(*) FROM events WHERE org_id = ?1 AND starts_on = ?2", a.orgId, TODAY),
      upcoming: await one("SELECT COUNT(*) FROM events WHERE org_id = ?1 AND starts_on > ?2", a.orgId, TODAY),
      past: await one("SELECT COUNT(*) FROM events WHERE org_id = ?1 AND starts_on < ?2", a.orgId, TODAY),
      undated: await one("SELECT COUNT(*) FROM events WHERE org_id = ?1 AND starts_on IS NULL", a.orgId),
      results: await one("SELECT COUNT(*) FROM result_submissions WHERE status = 'pending' AND event_id IN (SELECT id FROM events WHERE org_id = ?1)", a.orgId),
      regs: await one("SELECT COUNT(*) FROM registrations WHERE status = 'pending' AND event_id IN (SELECT id FROM events WHERE org_id = ?1)", a.orgId),
    };
    expect(r.json.total).toBe(6);
    expect(direct).toMatchObject({ total: 6, live: 1, upcoming: 2, past: 1, undated: 2, results: 2, regs: 3 });
    expect(r.json.groups).toEqual({ live: direct.live, upcoming: direct.upcoming, past: direct.past, undated: direct.undated });
    // teams not ready: Alpha Wolves tapped ready (case-insensitive), so Beta Hawks and Gamma are waiting; the empty side is not a team
    expect(r.json.needsYou).toEqual({ pendingResults: direct.results, pendingRegistrations: direct.regs, teamsNotReady: 2 });
    // per event
    const byId = new Map<string, { group: string; needsYou: { pendingResults: number; pendingRegistrations: number; teamsNotReady: number } }>(r.json.events.map((e: { id: string }) => [e.id, e]));
    expect(byId.get(ids.live.id)).toMatchObject({ group: "live", needsYou: { pendingResults: 2, pendingRegistrations: 2, teamsNotReady: 2 } });
    expect(byId.get(ids.up1.id)).toMatchObject({ group: "upcoming", needsYou: { pendingResults: 0, pendingRegistrations: 1, teamsNotReady: 0 } });
    expect(byId.get(ids.past.id)?.group).toBe("past");
    expect(byId.get(ids.none.id)?.group).toBe("undated");
    expect(byId.get(ids.free.id)?.group).toBe("undated"); // free text is not an ISO day
    const sum = r.json.events.reduce((n: number, e: { needsYou: { pendingRegistrations: number } }) => n + e.needsYou.pendingRegistrations, 0);
    expect(sum).toBe(direct.regs);
    expect(r.json.next).toBeNull();
  });

  it("runs in at most 6 queries, sign-in and flag read included", async () => {
    const { a } = await seeded();
    let prepared = 0;
    const counting = new Proxy(env.DB, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target) as unknown;
        if (prop === "prepare") return (sql: string) => { prepared++; return (target.prepare as (s: string) => D1PreparedStatement)(sql); };
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(target) : v;
      },
    });
    const res = await app.fetch(new Request(`https://api.test/orgs/${a.orgId}/events?today=${TODAY}&limit=3`, { headers: { authorization: `Bearer ${a.token}`, "cf-connecting-ip": "10.9.9.9" } }), { ...env, DB: counting } as typeof env, ctx);
    expect(res.status).toBe(200);
    expect(prepared).toBeLessThanOrEqual(6);
    expect(prepared).toBe(6);
  });

  it("pages newest first with a cursor, no event twice, none missing; group filters narrow the page", async () => {
    const { a } = await seeded();
    const seen: string[] = [];
    let after: string | null = null;
    for (let i = 0; i < 10; i++) {
      const r: { status: number; json: { events: { id: string }[]; next: string | null } } = await call(`/orgs/${a.orgId}/events?today=${TODAY}&limit=2${after ? `&after=${encodeURIComponent(after)}` : ""}`, { token: a.token });
      expect(r.status).toBe(200);
      seen.push(...r.json.events.map((e) => e.id));
      after = r.json.next;
      if (!after) break;
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen).size).toBe(6);
    const all = (await db.prepare("SELECT id FROM events WHERE org_id = ?1 ORDER BY created_at DESC, id DESC").bind(a.orgId).all<{ id: string }>()).results.map((r) => r.id);
    expect(seen).toEqual(all);
    const up = await call(`/orgs/${a.orgId}/events?today=${TODAY}&group=upcoming`, { token: a.token });
    expect(up.json.events).toHaveLength(2);
    expect(up.json.events.every((e: { group: string }) => e.group === "upcoming")).toBe(true);
    // the caller's own day moves the groups
    const later = await call(`/orgs/${a.orgId}/events?today=2027-01-05`, { token: a.token });
    expect(later.json.groups).toEqual({ live: 1, upcoming: 0, past: 3, undated: 2 });
  });

  it("validates its inputs and hides the club from non-members", async () => {
    const a = await club();
    for (const q of ["today=2026-13-45", "today=tomorrow", "limit=0", "limit=51", "limit=x", "group=other", "after=junk"]) {
      expect((await call(`/orgs/${a.orgId}/events?${q}`, { token: a.token })).status, q).toBe(400);
    }
    const s = await verified();
    expect((await call(`/orgs/${a.orgId}/events`, { token: s.token })).status).toBe(404);
    const m = await joined(a, "member");
    expect((await call(`/orgs/${a.orgId}/events`, { token: m.token })).status).toBe(200); // org.read is for members too
  });

  it("an empty club returns empty groups and zero counts", async () => {
    const a = await club();
    const r = await call(`/orgs/${a.orgId}/events?today=${TODAY}`, { token: a.token });
    expect(r.json).toMatchObject({ total: 0, groups: { live: 0, upcoming: 0, past: 0, undated: 0 }, needsYou: { pendingResults: 0, pendingRegistrations: 0, teamsNotReady: 0 }, events: [], next: null });
  });
});
