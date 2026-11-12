import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { sha256 } from "../../src/crypto";
import { resetFlagsCache } from "../../src/flags";
import { hashToken } from "../../src/links";
import { call, newGateKey, setupEvent, uniq } from "../helpers";

vi.setConfig({ testTimeout: 180_000 });

/**
 * The serial sweep (dev-review-r2 6.3, 8.1 rule 5): every public route that serves organiser-published content answers the SAME 404 as a missing page
 * when its target is taken down, but only while flag takedown.enforce is on; every public write route answers 503 temporarily_disabled when its kill
 * switch is on, and recovers when it is off. This file is the capability-matrix row per route: SWEPT lists the routes, and the inventory test below fails
 * for any /public/ route that is neither swept nor named in EXEMPT with a reason.
 */
const db = env.DB;
const now = () => new Date().toISOString();
const slug12 = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghijklmnopqrstuvwxyz234567"[b & 31]).join("");

async function setFlag(key: string, value: boolean | null) {
  if (value === null) await db.prepare("DELETE FROM flags WHERE key = ?").bind(key).run();
  else await db.prepare("INSERT INTO flags (key, value, updated_by, updated_at, note) VALUES (?, ?, 'test', ?, '') ON CONFLICT (key) DO UPDATE SET value = excluded.value").bind(key, JSON.stringify(value), now()).run();
  resetFlagsCache();
}
const hide = (type: string, id: string) =>
  db.prepare("INSERT INTO takedowns (target_type, target_id, state, reason_code, by_staff, at) VALUES (?, ?, 'hidden', 'spam', 'test-staff', ?) ON CONFLICT (target_type, target_id) DO UPDATE SET state = 'hidden'").bind(type, id, now()).run();
const lift = (type: string, id: string) => db.prepare("UPDATE takedowns SET state = 'restored' WHERE target_type = ? AND target_id = ?").bind(type, id).run();

type Res = { status: number; text: string; json: any };
interface Fixture {
  /** The request under test. */
  req: () => Promise<Res>;
  /** What the sweep hides it by. */
  subject: { type: string; id: string };
  /** True when a response is the takedown 404 (and not some other 404 the route gives for unrelated reasons). */
  gone: (r: Res) => boolean;
  /** The kill switch that guards the write, when it is one. */
  kill?: string;
}
interface Case { route: string; make: () => Promise<Fixture> }

async function liveFixture() {
  const o = await setupEvent("Sweep Cup");
  const slug = slug12();
  await db.prepare("INSERT INTO live_pages (event_id, slug, published, snapshot, updated_at) VALUES (?, ?, 1, '{}', ?)").bind(o.ev.id, slug, now()).run();
  return { ...o, slug };
}
async function captainLink(eventId: string) {
  const id = `cl${uniq()}`;
  const token = `cap-token-${uniq()}-padpadpad`;
  await db.prepare("INSERT INTO captain_links (id, event_id, team, token_hash, created_at) VALUES (?, ?, 'Alpha Wolves', ?, ?)").bind(id, eventId, await hashToken(token), now()).run();
  return { id, token };
}
async function passFixture(suffix: string): Promise<Fixture> {
  const o = await setupEvent("Pass Cup");
  const id = `sl${uniq()}`;
  const token = `pass-token-${uniq()}-padpadpad`;
  await db.prepare("INSERT INTO share_links (id, event_id, person_id, token, created_at, revoked, token_hash) VALUES (?, ?, 'ALP-002', ?, ?, 0, ?)").bind(id, o.ev.id, `x-${id}`, now(), await hashToken(token)).run();
  return { req: () => call(`/public/pass/${token}${suffix}`), subject: { type: "pass", id }, gone: is404 };
}
async function registrationFixture() {
  const o = await setupEvent("Reg Cup");
  const form = (await call(`/events/${o.ev.id}/registration`, { method: "PUT", token: o.token, body: { title: "Reg", teamSize: 1, subs: 0 } })).json;
  return { ev: o.ev.id, token: form.token as string };
}
async function inviteFixture() {
  const o = await setupEvent("Invite Cup");
  const inv = (await call(`/events/${o.ev.id}/invites`, { token: o.token, body: { teamId: "t1" } })).json;
  return { ev: o.ev.id, token: inv.token as string };
}
async function scorerFixture() {
  const o = await setupEvent("Score Cup");
  const token = `score-token-${uniq()}-padpadpad`;
  await db.prepare("INSERT INTO scorer_links (id, event_id, label, token_hash, stage, expires_at, created_at) VALUES (?, ?, 'Ref', ?, NULL, '2999-01-01T00:00:00.000Z', ?)").bind(`sc${uniq()}`, o.ev.id, await sha256(token), now()).run();
  return { ev: o.ev.id, token };
}
function is404(r: { status: number }): boolean { return r.status === 404; }
const has = (s: string) => (r: Res) => r.status === 404 && r.text.includes(s);

const SWEPT: Case[] = [
  { route: "GET /public/live/:slug", make: async () => {
    const l = await liveFixture();
    return { req: () => call(`/public/live/${l.slug}`), subject: { type: "live_page", id: l.ev.id }, gone: is404 };
  } },
  { route: "GET /public/brand/:slug", make: async () => {
    const l = await liveFixture();
    return { req: () => call(`/public/brand/${l.slug}`), subject: { type: "live_page", id: l.ev.id }, gone: is404 };
  } },
  { route: "GET /public/league/:slug", make: async () => {
    const o = await setupEvent("League Cup");
    const slug = slug12();
    await db.prepare("INSERT INTO league_settings (event_id, slug, published, updated_at) VALUES (?, ?, 1, ?)").bind(o.ev.id, slug, now()).run();
    return { req: () => call(`/public/league/${slug}`), subject: { type: "league_page", id: o.ev.id }, gone: is404 };
  } },
  { route: "GET /public/team/:slug", make: async () => {
    const o = await setupEvent("Team owner");
    const id = `tp${uniq()}`;
    const slug = slug12();
    await db.prepare("INSERT INTO team_profiles (id, owner_user_id, name, slug, published, updated_at) VALUES (?, ?, 'Wolves', ?, 1, ?)").bind(id, o.id, slug, now()).run();
    return { req: () => call(`/public/team/${slug}`), subject: { type: "team_profile", id }, gone: is404 };
  } },
  { route: "GET /public/pass/:token", make: () => passFixture("") },
  { route: "GET /public/pass/:token/photo", make: () => passFixture("/photo") },
  { route: "GET /public/registration/:token", make: async () => {
    const f = await registrationFixture();
    return { req: () => call(`/public/registration/${f.token}`), subject: { type: "registration_form", id: f.ev }, gone: is404 };
  } },
  { route: "POST /public/registration/:token/submit", make: async () => {
    const f = await registrationFixture();
    return { req: () => call(`/public/registration/${f.token}/submit`, { body: {} }), subject: { type: "registration_form", id: f.ev }, gone: is404, kill: "kill.public_forms" };
  } },
  { route: "GET /public/invite/:token", make: async () => {
    const f = await inviteFixture();
    return { req: () => call(`/public/invite/${f.token}`), subject: { type: "event", id: f.ev }, gone: is404 };
  } },
  { route: "POST /public/invite/:token/submit", make: async () => {
    const f = await inviteFixture();
    return { req: () => call(`/public/invite/${f.token}/submit`, { body: { name: "Sub Mitter" } }), subject: { type: "event", id: f.ev }, gone: is404, kill: "kill.public_forms" };
  } },
  { route: "GET /public/report/:token", make: async () => {
    const o = await setupEvent("Results Cup");
    const c = await captainLink(o.ev.id);
    return { req: () => call(`/public/report/${c.token}`), subject: { type: "results", id: c.id }, gone: is404 };
  } },
  { route: "POST /public/report/:token/matches/:mid", make: async () => {
    const o = await setupEvent("Results Cup");
    const c = await captainLink(o.ev.id);
    return { req: () => call(`/public/report/${c.token}/matches/m1`, { body: { scoreA: 1, scoreB: 0 } }), subject: { type: "results", id: c.id }, gone: has("not valid any more"), kill: "kill.public_writes" };
  } },
  { route: "GET /public/ready/:token", make: async () => {
    const o = await setupEvent("Ready Cup");
    const c = await captainLink(o.ev.id);
    return { req: () => call(`/public/ready/${c.token}`), subject: { type: "results", id: c.id }, gone: is404 };
  } },
  { route: "POST /public/ready/:token/matches/:mid", make: async () => {
    const o = await setupEvent("Ready Cup");
    const c = await captainLink(o.ev.id);
    return { req: () => call(`/public/ready/${c.token}/matches/m1`, { body: { ready: true } }), subject: { type: "results", id: c.id }, gone: has("This link is not valid."), kill: "kill.public_writes" };
  } },
  { route: "GET /public/run/:token", make: async () => {
    const o = await setupEvent("Run Cup");
    const token = `run-token-${uniq()}-padpadpad`;
    await db.prepare("INSERT INTO runofshow_links (event_id, token_hash, show_notes, created_at) VALUES (?, ?, 0, ?)").bind(o.ev.id, await sha256(token), now()).run();
    return { req: () => call(`/public/run/${token}`), subject: { type: "event", id: o.ev.id }, gone: is404 };
  } },
  { route: "GET /public/score/:token", make: async () => {
    const s = await scorerFixture();
    return { req: () => call(`/public/score/${s.token}`), subject: { type: "event", id: s.ev }, gone: is404 };
  } },
  { route: "POST /public/score/:token/matches/:mid/result", make: async () => {
    const s = await scorerFixture();
    return { req: () => call(`/public/score/${s.token}/matches/m1/result`, { body: { scoreA: 1, scoreB: 0 } }), subject: { type: "event", id: s.ev }, gone: has("scoring link is not valid"), kill: "kill.public_writes" };
  } },
  { route: "POST /public/score/:token/br", make: async () => {
    const s = await scorerFixture();
    return { req: () => call(`/public/score/${s.token}/br`, { body: { matchNo: 1, rows: [] } }), subject: { type: "event", id: s.ev }, gone: has("scoring link is not valid"), kill: "kill.public_writes" };
  } },
  { route: "POST /public/directory/:eventId/report", make: async () => {
    const o = await setupEvent("Dir Cup");
    await db.prepare("INSERT INTO directory_entries (event_id, listed, title, game, city, mode, starts_on, updated_at) VALUES (?, 1, 'Cup', 'BGMI', 'Pune', 'in-person', '2030-01-01', ?)").bind(o.ev.id, now()).run();
    return { req: () => call(`/public/directory/${o.ev.id}/report`, { body: { reason: "x" } }), subject: { type: "directory_entry", id: o.ev.id }, gone: is404, kill: "kill.directory" };
  } },
];

describe("takedown sweep: each swept public route (the matrix row per route)", () => {
  for (const c of SWEPT) {
    it(`${c.route}: live while enforce is off, 404 once hidden with enforce on, back after the restore`, async () => {
      await setFlag("takedown.enforce", null);
      const f = await c.make();
      const base = await f.req();
      expect(f.gone(base), `baseline ${base.status} ${base.text.slice(0, 80)}`).toBe(false);
      await hide(f.subject.type, f.subject.id);
      // rollout switch off: reports and takedowns are recorded but nothing changes
      const off = await f.req();
      expect(f.gone(off), "enforce off must be inert").toBe(false);
      expect(off.status).toBe(base.status);
      await setFlag("takedown.enforce", true);
      const on = await f.req();
      expect(f.gone(on), `enforce on, got ${on.status} ${on.text.slice(0, 80)}`).toBe(true);
      expect(on.status).toBe(404);
      await lift(f.subject.type, f.subject.id);
      const back = await f.req();
      expect(f.gone(back), "restored").toBe(false);
      await setFlag("takedown.enforce", null);
    });

    if (c.route.startsWith("POST")) {
      it(`${c.route}: kill switch gives 503 on the next write, off again recovers`, async () => {
        const f = await c.make();
        const keys = [f.kill!, "kill.public_writes"];
        expect(f.kill).toBeTruthy();
        for (const key of new Set(keys)) {
          await setFlag(key, null);
          const before = await f.req();
          expect(before.status, `${key} before`).not.toBe(503);
          await setFlag(key, true);
          const killed = await f.req();
          expect(killed.status, key).toBe(503);
          expect(killed.json).toEqual({ error: "This feature is temporarily switched off", code: "temporarily_disabled", retryAfter: 300 });
          await setFlag(key, false);
          const after = await f.req();
          expect(after.status, `${key} off again`).not.toBe(503);
          await setFlag(key, null);
        }
      });
    }
  }
});

describe("takedown sweep: routes whose answer is not a status", () => {
  it("GET /public/directory: a hidden entry and an entry of a suspended organisation leave the list only while enforce is on", async () => {
    const mk = async (title: string) => {
      const o = await setupEvent(title);
      await db.prepare("INSERT INTO directory_entries (event_id, listed, title, game, city, mode, starts_on, updated_at) VALUES (?, 1, ?, 'SweepGame', 'Pune', 'in-person', '2031-05-05', ?)").bind(o.ev.id, title, now()).run();
      return o.ev.id;
    };
    const a = await mk("Sweep A");
    const b = await mk("Sweep B");
    const org = `org${uniq()}`;
    await db.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES (?, 'Club', 'team', 'active', ?)").bind(org, now()).run();
    await db.prepare("UPDATE events SET org_id = ? WHERE id = ?").bind(org, b).run();
    const ids = async () => ((await call("/public/directory?game=SweepGame")).json.entries as { id: string }[]).map((e) => e.id);
    await setFlag("takedown.enforce", null);
    await hide("directory_entry", a);
    await db.prepare("UPDATE organisations SET status = 'suspended' WHERE id = ?").bind(org).run();
    expect(await ids()).toEqual(expect.arrayContaining([a, b])); // inert
    await setFlag("takedown.enforce", true);
    const on = await ids();
    expect(on).not.toContain(a);
    expect(on).not.toContain(b);
    await lift("directory_entry", a);
    await db.prepare("UPDATE organisations SET status = 'active' WHERE id = ?").bind(org).run();
    expect(await ids()).toEqual(expect.arrayContaining([a, b]));
    await setFlag("takedown.enforce", null);
  });

  it("POST /public/hit/:slug: a hit counts normally, and counts nothing when hidden (enforce on) or killed; always 204", async () => {
    const l = await liveFixture();
    const hits = async () => (await db.prepare("SELECT COALESCE(SUM(hits), 0) AS n FROM live_hits WHERE event_id = ?").bind(l.ev.id).first<{ n: number }>())!.n;
    const hit = () => call(`/public/hit/${l.slug}`, { body: { source: "live" } });
    await setFlag("takedown.enforce", null);
    expect((await hit()).status).toBe(204);
    expect(await hits()).toBe(1);
    await hide("live_page", l.ev.id);
    await hit();
    expect(await hits()).toBe(2); // enforce off: inert
    await setFlag("takedown.enforce", true);
    expect((await hit()).status).toBe(204);
    expect(await hits()).toBe(2);
    await lift("live_page", l.ev.id);
    await hit();
    expect(await hits()).toBe(3);
    await setFlag("kill.public_writes", true);
    expect((await hit()).status).toBe(204);
    expect(await hits()).toBe(3);
    await setFlag("kill.public_writes", false);
    await hit();
    expect(await hits()).toBe(4);
    await setFlag("kill.public_writes", null);
    await setFlag("takedown.enforce", null);
  });

  it("a suspended organisation hides its live page when enforce is on (and not when it is off), with the body of a missing page", async () => {
    const l = await liveFixture();
    const org = `org${uniq()}`;
    await db.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES (?, 'Club', 'team', 'suspended', ?)").bind(org, now()).run();
    await db.prepare("UPDATE events SET org_id = ? WHERE id = ?").bind(org, l.ev.id).run();
    await setFlag("takedown.enforce", null);
    expect((await call(`/public/live/${l.slug}`)).status).toBe(200);
    await setFlag("takedown.enforce", true);
    const r = await call(`/public/live/${l.slug}`);
    expect(r.status).toBe(404);
    expect(r.json).toEqual((await call(`/public/live/nope${uniq()}`)).json);
    await setFlag("takedown.enforce", null);
  });
});

describe("kill switches on the write routes that are not public pages", () => {
  const cases: { name: string; key: string; make: () => Promise<() => ReturnType<typeof call>> }[] = [
    { name: "POST /public/contact", key: "kill.public_forms", make: async () => () => call("/public/contact", { body: { message: "hello there, a test message" } }) },
    { name: "POST /public/report", key: "kill.public_writes", make: async () => () => call("/public/report", { body: { kind: "live", key: `nope${uniq()}`, reason: "spam" } }) },
    { name: "PUT /events/:id/live (live publish)", key: "kill.public_writes", make: async () => {
      const o = await setupEvent("Pub Cup");
      return () => call(`/events/${o.ev.id}/live`, { method: "PUT", token: o.token, body: { published: true } });
    } },
    { name: "POST /gate/checkin", key: "kill.public_writes", make: async () => {
      const o = await setupEvent("Gate Cup");
      const k = await newGateKey(o.token, o.ev.id);
      return () => call("/gate/checkin", { gate: k.key, body: { code: "x" } });
    } },
    { name: "POST /gate/checkin/batch", key: "kill.public_writes", make: async () => {
      const o = await setupEvent("Gate Cup");
      const k = await newGateKey(o.token, o.ev.id);
      return () => call("/gate/checkin/batch", { gate: k.key, body: { codes: ["x"] } });
    } },
  ];
  for (const c of cases) {
    it(`${c.name}: 503 on the next write, recovers when off`, async () => {
      const req = await c.make();
      await setFlag(c.key, null);
      expect((await req()).status).not.toBe(503);
      await setFlag(c.key, true);
      const k = await req();
      expect(k.status).toBe(503);
      expect(k.json.code).toBe("temporarily_disabled");
      await setFlag(c.key, false);
      expect((await req()).status).not.toBe(503);
      await setFlag(c.key, null);
    });
  }
  it("the master valve kill.public_writes also stops the form routes", async () => {
    const f = await registrationFixture();
    await setFlag("kill.public_writes", true);
    expect((await call(`/public/registration/${f.token}/submit`, { body: {} })).status).toBe(503);
    expect((await call("/public/contact", { body: { message: "hello there, a test message" } })).status).toBe(503);
    await setFlag("kill.public_writes", null);
  });
});

describe("inventory: no public route escapes the sweep", () => {
  /** Public routes that are deliberately NOT subject to a takedown 404, each with its reason. */
  const EXEMPT: Record<string, string> = {
    "GET /public/directory": "swept by a SQL filter (own test above)",
    "POST /public/hit/:slug": "swept, answers 204 (own test above)",
    "POST /public/report": "kill switch only (own test above); a report can never be taken down",
    "POST /public/contact": "kill switch only (own test above); serves no published content",
    "POST /public/t": "tracking beacon: already honours kill.tracking and shed.tracking (src/routes/track.ts); no content",
    "GET /public/unsubscribe/:token": "must always work (legal duty to stop mail); no published content",
    "POST /public/unsubscribe/:token": "must always work (legal duty to stop mail); no published content",
  };
  it("every registered /public/ route is in SWEPT or EXEMPT", () => {
    const registered = [...new Set(app.routes.filter((r) => r.method !== "ALL" && r.path.startsWith("/public/")).map((r) => `${r.method} ${r.path}`))].sort();
    const known = new Set([...SWEPT.map((c) => c.route), ...Object.keys(EXEMPT)]);
    expect(registered.filter((r) => !known.has(r))).toEqual([]);
    expect([...known].filter((r) => !registered.includes(r))).toEqual([]);
  });
});
