import { describe, expect, it, vi } from "vitest";
import { ACK_TEXT, ACK_VERSION } from "../../src/orgs/ack";
import { call, db, newEvent, newUser } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

const put = (ev: string, token: string, body: Record<string, unknown>) => call(`/events/${ev}/registration`, { method: "PUT", token, body });

describe("registration form acknowledgement (privacy minimum)", () => {
  it("the text is the PM's interim wording, version interim-1, defined once", () => {
    expect(ACK_VERSION).toBe("interim-1");
    expect(ACK_TEXT).toBe("Before you open this form: you are responsible for having permission to collect these details, including permission from a parent or guardian where a player is under 18. Ask only for what you need. Do not publish the names or photos of players under 18. Remove players' details when you no longer need them. Esports Hub does not collect entry fees or hold prize money.");
  });

  it("a form cannot be created open, or opened, without the acknowledgement; the refusal carries the text to show", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    const r = await put(ev.id, u.token, { title: "Cup" });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("acknowledgement_required");
    expect(r.json.acknowledgement).toEqual({ version: ACK_VERSION, text: ACK_TEXT });
    expect(await db.prepare("SELECT COUNT(*) AS n FROM registration_forms WHERE event_id = ?1").bind(ev.id).first<{ n: number }>()).toEqual({ n: 0 });
    for (const bad of ["yes", 1, null, "true"]) expect((await put(ev.id, u.token, { title: "Cup", acknowledge: bad })).status, JSON.stringify(bad)).toBe(400);
  });

  it("a form can be saved closed without it, but cannot then be opened without it", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    const closed = await put(ev.id, u.token, { title: "Draft", open: false });
    expect(closed.status).toBe(201);
    expect(closed.json).toMatchObject({ open: false, ackVersion: null, ackAt: null });
    const opened = await put(ev.id, u.token, { open: true });
    expect(opened.status).toBe(400);
    expect(opened.json.code).toBe("acknowledgement_required");
    // and the public form stays closed meanwhile
    expect((await call(`/public/registration/${closed.json.token}`)).json.form.status).toBe("closed");
  });

  it("ticking it stores the version and the time; later saves keep them; the time is not refreshed", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    const first = await put(ev.id, u.token, { title: "Cup", acknowledge: true });
    expect(first.status).toBe(201);
    expect(first.json.open).toBe(true);
    expect(first.json.ackVersion).toBe(ACK_VERSION);
    expect(Date.parse(first.json.ackAt)).toBeGreaterThan(Date.now() - 60_000);
    const again = await put(ev.id, u.token, { intro: "hello" });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ ackVersion: ACK_VERSION, ackAt: first.json.ackAt });
    const ticked = await put(ev.id, u.token, { acknowledge: true });
    expect(ticked.json.ackAt).toBe(first.json.ackAt);
    const row = await db.prepare("SELECT ack_version, ack_at FROM registration_forms WHERE event_id = ?1").bind(ev.id).first<{ ack_version: string; ack_at: string }>();
    expect(row).toEqual({ ack_version: ACK_VERSION, ack_at: first.json.ackAt });
  });

  it("a stored older text version does not count: the new text must be ticked again to keep or reopen the form", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    await put(ev.id, u.token, { title: "Cup", acknowledge: true });
    await db.prepare("UPDATE registration_forms SET ack_version = 'interim-0' WHERE event_id = ?1").bind(ev.id).run();
    expect((await put(ev.id, u.token, { open: true })).status).toBe(400);
    const r = await put(ev.id, u.token, { acknowledge: true });
    expect(r.status).toBe(200);
    expect(r.json.ackVersion).toBe(ACK_VERSION);
  });

  it("closing a form never needs it; GET shows the text and the stored acknowledgement", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    await put(ev.id, u.token, { title: "Cup", acknowledge: true });
    expect((await put(ev.id, u.token, { open: false })).status).toBe(200);
    const g = await call(`/events/${ev.id}/registration`, { token: u.token });
    expect(g.json.acknowledgement).toEqual({ version: ACK_VERSION, text: ACK_TEXT });
    expect(g.json.form).toMatchObject({ ackVersion: ACK_VERSION, open: false });
    const none = await newEvent(u.token, "No form");
    expect((await call(`/events/${none.id}/registration`, { token: u.token })).json).toMatchObject({ form: null, acknowledgement: { version: ACK_VERSION } });
  });

  it("a copied event's form starts closed and unacknowledged, and needs its own tick", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token);
    await put(ev.id, u.token, { title: "Cup", acknowledge: true });
    const copy = await call(`/events/${ev.id}/duplicate`, { token: u.token, body: { name: "Copy", include: { registrationForm: true } } });
    expect(copy.status).toBe(201);
    const form = (await call(`/events/${copy.json.id}/registration`, { token: u.token })).json.form;
    expect(form).toMatchObject({ open: false, ackVersion: null, ackAt: null });
    expect((await put(copy.json.id, u.token, { open: true })).status).toBe(400);
    expect((await put(copy.json.id, u.token, { open: true, acknowledge: true })).status).toBe(200);
  });

  it("a viewer cannot acknowledge for the organiser", async () => {
    const o = await newUser();
    const v = await newUser();
    const ev = await newEvent(o.token);
    await db.prepare("INSERT INTO event_members (event_id, user_id, role, added_at) VALUES (?1, ?2, 'viewer', 't')").bind(ev.id, v.id).run();
    expect((await put(ev.id, v.token, { title: "x", acknowledge: true })).status).toBe(403);
  });
});
