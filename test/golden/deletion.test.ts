import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { call, newEvent, newUser, setupEvent } from "../helpers";

vi.setConfig({ testTimeout: 180_000 });

const PW = "correct horse";
const del = (token: string, body: Record<string, unknown> = {}) => call("/auth/delete-account", { token, body: { password: PW, ...body } });
const addMember = async (ev: string, token: string, email: string, role: "editor" | "viewer") => expect((await call(`/events/${ev}/members`, { token, body: { email, role } })).status).toBe(201);

/** Every (table.column) that still holds rows for this event or this user: tables with an event_id column, plus every foreign key to events and to users. */
async function holders(eventId: string, userId: string): Promise<string[]> {
  const tables = await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'").all<{ name: string }>();
  const found: string[] = [];
  for (const t of tables.results) {
    const cols = (await env.DB.prepare(`PRAGMA table_info(${t.name})`).all<{ name: string }>()).results.map((c) => c.name);
    const fks = (await env.DB.prepare(`PRAGMA foreign_key_list(${t.name})`).all<{ table: string; from: string }>()).results;
    const checks = new Map<string, string>();
    if (cols.includes("event_id")) checks.set("event_id", eventId);
    for (const fk of fks) {
      if (fk.table === "events") checks.set(fk.from, eventId);
      if (fk.table === "users") checks.set(fk.from, userId);
    }
    if (t.name === "brand_kits") checks.set("scope", eventId); // the event kit is keyed by the event id without a foreign key
    for (const [col, val] of checks) {
      const n = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t.name} WHERE ${col} = ?`).bind(val).first<{ n: number }>();
      if (n!.n > 0) found.push(`${t.name}.${col}`);
    }
  }
  return found.sort();
}

/** An event with something in as many tables as the public API allows. Returns the owner, the event id and a viewer. */
async function fullEvent(name = "Full Cup") {
  const o = await setupEvent(name);
  const ev = o.ev.id;
  const t = o.token;
  const viewer = await newUser("Vi");
  await addMember(ev, t, viewer.email, "viewer");
  await call(`/events/${ev}/gate-keys`, { token: t, body: { label: "Door" } });
  const inv = (await call(`/events/${ev}/invites`, { token: t, body: { teamId: "t1" } })).json;
  await call(`/public/invite/${inv.token}/submit`, { body: { name: "Sub Mitter" } });
  await call(`/events/${ev}/people/ALP-001/share`, { token: t, body: {} });
  const form = (await call(`/events/${ev}/registration`, { method: "PUT", token: t, body: { acknowledge: true, title: "Reg", teamSize: 1, subs: 0 } })).json;
  await call(`/public/registration/${form.token}/submit`, { body: { teamName: "Reg Team", captainName: "Cap Tain", captainContact: "cap@example.com", players: [{ name: "P One" }] } });
  const live = await call(`/events/${ev}/live`, { method: "PUT", token: t, body: { published: true, snapshot: { views: [], announcements: [], sponsors: [], ticker: [] } } });
  await call(`/public/hit/${live.json.slug}`, { body: { source: "live" } });
  await call(`/events/${ev}/matches`, { method: "PUT", token: t, body: { matches: [{ stage: "main", round: 1, slot: 1, a: "Alpha Wolves", b: "Beta Hawks" }] } });
  await call(`/events/${ev}/captain-links`, { token: t, body: { team: "Alpha Wolves" } });
  await call(`/events/${ev}/scorer-links`, { token: t, body: { label: "Ref", hours: 1 } });
  await call(`/events/${ev}/runofshow/link`, { token: t, body: {} });
  await call(`/events/${ev}/directory`, { method: "PUT", token: t, body: { listed: true, title: "Full Cup open", game: "BGMI", city: "Pune", mode: "in-person", startsOn: new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10), blurb: "Squads of four." } });
  const kit = { name: "Brand", primaryColor: "#0a84ff", secondaryColor: "#7c3aed" };
  await call(`/events/${ev}/brand`, { method: "PUT", token: t, body: kit });
  await call("/brand", { method: "PUT", token: t, body: kit });
  await call("/profiles", { token: t, body: { name: "Alpha Wolves Page" } });
  return { ...o, ev, viewer, slug: live.json.slug as string };
}

describe("golden: deletion completeness", () => {
  it("deleting an event leaves no row for it in any table (the hand-written list in events.ts lags the schema)", async () => {
    const f = await fullEvent();
    const before = await holders(f.ev, f.id);
    expect(before.length, `tables holding data before the delete: ${before.join(", ")}`).toBeGreaterThanOrEqual(15);
    expect((await call(`/events/${f.ev}`, { method: "DELETE", token: f.token })).status).toBe(200);
    expect(await holders(f.ev, "no-such-user")).toEqual([]);
    // the account itself is untouched by an event delete
    expect((await call("/me", { token: f.token })).status).toBe(200);
  });

  it("deleting an account leaves no row for the user or their events in any table, and other people's data is untouched", async () => {
    const f = await fullEvent("Doomed Cup");
    const other = await fullEvent("Bystander Cup");
    const otherBefore = await holders(other.ev, other.id);
    expect((await holders(f.ev, f.id)).length).toBeGreaterThanOrEqual(15);
    // the viewer makes this event shared, so the explicit confirmation is sent (it changes nothing for a user without shared events)
    expect((await del(f.token, { deleteEvents: true })).status).toBe(200);
    expect(await holders(f.ev, f.id)).toEqual([]);
    expect(await holders(other.ev, other.id)).toEqual(otherBefore);
    expect((await call("/me", { token: f.token })).status).toBe(401);
    // the viewer is still a normal account
    expect((await call("/me", { token: f.viewer.token })).status).toBe(200);
  });
});

describe("account deletion keeps events other people work on (S1)", () => {
  it("(a) an event with an editor survives: the editor becomes the owner, their member row is gone, the brand kit follows", async () => {
    const f = await fullEvent("Handover Cup");
    const ed = await newUser("Ed");
    await addMember(f.ev, f.token, ed.email, "editor");
    const r = await del(f.token);
    expect(r.status).toBe(200);
    expect(r.json.handedOver).toEqual([{ id: f.ev, name: "Handover Cup", newOwnerName: "Ed" }]);
    const e = await call(`/events/${f.ev}`, { token: ed.token });
    expect(e.status).toBe(200);
    expect((await call("/events", { token: ed.token })).json.find((x: any) => x.id === f.ev).role).toBe("owner");
    const row = await env.DB.prepare("SELECT owner_id FROM events WHERE id = ?").bind(f.ev).first<{ owner_id: string }>();
    expect(row!.owner_id).toBe(ed.id);
    const members = await call(`/events/${f.ev}/members`, { token: ed.token });
    expect(members.status).toBe(200); // owner-only route
    expect(members.json.owner.userId).toBe(ed.id);
    expect(members.json.members.map((m: any) => m.userId)).toEqual([f.viewer.id]); // the editor is no longer a member row
    expect((await call(`/events/${f.ev}/brand`, { token: ed.token })).json).toMatchObject({ source: "event", brand: { name: "Brand" } });
    expect((await call(`/public/brand/${f.slug}`)).json).toMatchObject({ brand: { name: "Brand", primaryColor: "#0a84ff" } });
    expect((await call(`/public/live/${f.slug}`)).status).toBe(200);
    // the leaver's own things are gone, and so is the account
    expect((await call("/me", { token: f.token })).status).toBe(401);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM brand_kits WHERE owner_user_id = ?").bind(f.id).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });

  it("the editor added earliest takes over", async () => {
    const f = await fullEvent("Earliest Cup");
    const e1 = await newUser("First");
    const e2 = await newUser("Second");
    await addMember(f.ev, f.token, e2.email, "editor");
    await addMember(f.ev, f.token, e1.email, "editor");
    await env.DB.prepare("UPDATE event_members SET added_at = ? WHERE event_id = ? AND user_id = ?").bind("2026-01-01T00:00:00.000Z", f.ev, e1.id).run();
    await env.DB.prepare("UPDATE event_members SET added_at = ? WHERE event_id = ? AND user_id = ?").bind("2026-02-01T00:00:00.000Z", f.ev, e2.id).run();
    expect((await del(f.token)).status).toBe(200);
    const row = await env.DB.prepare("SELECT owner_id FROM events WHERE id = ?").bind(f.ev).first<{ owner_id: string }>();
    expect(row!.owner_id).toBe(e1.id);
    expect((await call(`/events/${f.ev}`, { token: e2.token })).status).toBe(200); // still an editor
    expect((await call(`/events/${f.ev}`, { method: "DELETE", token: e2.token })).status).toBe(403);
  });

  it("(b) a slug conflict with the editor's own event is a 409 ownership_conflict and nothing is deleted", async () => {
    const f = await fullEvent("Clash Cup");
    const ed = await newUser("Ed Itor");
    await newEvent(ed.token, "Clash Cup"); // same key (slug) under the editor
    await addMember(f.ev, f.token, ed.email, "editor");
    const r = await del(f.token);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("ownership_conflict");
    expect(r.json.error).toContain("Ed Itor");
    expect(r.json.error).toContain("Clash Cup");
    expect(r.json.error).toContain("Nothing was deleted");
    expect(r.json.events).toEqual([{ id: f.ev, name: "Clash Cup", newOwnerName: "Ed Itor" }]);
    expect((await call("/me", { token: f.token })).status).toBe(200);
    expect((await call(`/events/${f.ev}`, { token: f.token })).status).toBe(200);
    expect((await call("/brand", { token: f.token })).json.brand).not.toBeNull();
    // after the editor is removed there is no conflict any more, and the account can go (the viewer needs the confirmation)
    expect((await call(`/events/${f.ev}/members/${ed.id}`, { method: "DELETE", token: f.token })).status).toBe(200);
    expect((await del(f.token)).status).toBe(409);
    expect((await del(f.token, { deleteEvents: true })).status).toBe(200);
  });

  it("(c) an event with only viewers needs deleteEvents: true, otherwise 409 and nothing changes", async () => {
    const f = await fullEvent("Viewers Cup");
    const r = await del(f.token);
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("events_need_delete_confirmation");
    expect(r.json.error).toContain("Viewers Cup");
    expect(r.json.events).toEqual([{ id: f.ev, name: "Viewers Cup" }]);
    expect((await call(`/events/${f.ev}`, { token: f.viewer.token })).status).toBe(200);
    expect((await call("/me", { token: f.token })).status).toBe(200);
    expect((await del(f.token, { deleteEvents: "yes" })).status).toBe(400);
    expect((await del(f.token, { deleteEvents: false })).status).toBe(409);
    expect((await del(f.token, { deleteEvents: true })).status).toBe(200);
    expect((await call(`/events/${f.ev}`, { token: f.viewer.token })).status).toBe(404);
    expect((await call(`/public/live/${f.slug}`)).status).toBe(404);
  });

  it("(d) a user without shared events: identical to before (200 { ok: true }, everything deleted, no confirmation needed)", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token, "Solo Cup");
    const r = await del(u.token);
    expect(r).toMatchObject({ status: 200, json: { ok: true } });
    expect(Object.keys(r.json)).toEqual(["ok"]);
    expect((await call(`/events/${ev.id}`, { token: u.token })).status).toBe(401);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE id = ?").bind(ev.id).first<{ n: number }>();
    expect(n!.n).toBe(0);
    // a wrong password is still refused first
    const v = await newUser();
    expect((await call("/auth/delete-account", { token: v.token, body: { password: "wrong wrong", deleteEvents: true } })).status).toBe(401);
  });

  it("(e) mixed: handover for the shared event, silent delete for the solo one, the viewer-only one waits for confirmation", async () => {
    const u = await newUser();
    const shared = await newEvent(u.token, "Shared Cup");
    const solo = await newEvent(u.token, "Solo Two Cup");
    const lonely = await newEvent(u.token, "Viewed Cup");
    const ed = await newUser("Ed");
    const vi = await newUser("Vi");
    await addMember(shared.id, u.token, ed.email, "editor");
    await addMember(lonely.id, u.token, vi.email, "viewer");
    const first = await del(u.token);
    expect(first.status).toBe(409);
    expect(first.json.events).toEqual([{ id: lonely.id, name: "Viewed Cup" }]);
    expect((await del(u.token, { deleteEvents: true })).status).toBe(200);
    expect((await call(`/events/${shared.id}`, { token: ed.token })).status).toBe(200);
    expect((await call(`/events/${lonely.id}`, { token: vi.token })).status).toBe(404);
    const gone = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE id = ?").bind(solo.id).first<{ n: number }>();
    expect(gone!.n).toBe(0);
  });

  it("more than 50 shared events is a 409 too_many_shared_events and nothing is deleted", async () => {
    const u = await newUser();
    const vi = await newUser("Vi");
    for (let i = 0; i < 51; i++) {
      const ev = await newEvent(u.token, `Many ${i}`);
      await addMember(ev.id, u.token, vi.email, "viewer");
    }
    const r = await del(u.token, { deleteEvents: true });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("too_many_shared_events");
    expect((await call("/me", { token: u.token })).status).toBe(200);
    expect((await call("/events", { token: vi.token })).json.length).toBe(51);
  });
});
