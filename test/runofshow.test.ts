import { describe, expect, it, vi } from "vitest";
import { call, newUser, setupEvent } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

const item = (title: string, atTime: string, over: Record<string, unknown> = {}) => ({ title, atTime, ...over });
const put = (id: string, token: string, items: unknown[]) => call(`/events/${id}/runofshow`, { method: "PUT", token, body: { items } });

async function world() {
  const o = await setupEvent("Run Cup");
  const editor = await newUser("Ed");
  const viewer = await newUser("Vi");
  const stranger = await newUser("Str");
  expect((await call(`/events/${o.ev.id}/members`, { token: o.token, body: { email: editor.email, role: "editor" } })).status).toBe(201);
  expect((await call(`/events/${o.ev.id}/members`, { token: o.token, body: { email: viewer.email, role: "viewer" } })).status).toBe(201);
  return { o, id: o.ev.id, editor, viewer, stranger };
}

describe("run of show, organiser side", () => {
  it("is empty at first; owner and editor save, viewer reads only, stranger gets 404", async () => {
    const w = await world();
    const e = await call(`/events/${w.id}/runofshow`, { token: w.o.token });
    expect(e.json).toEqual({ items: [], link: null });
    const a = await put(w.id, w.o.token, [item("Doors open", "09:00", { ownerName: "Asha", notes: "Gate 2" }), item("Tech check", "09:30")]);
    expect(a.status).toBe(200);
    expect(a.json.items.map((i: any) => [i.title, i.atTime, i.ownerName, i.status, i.dayOffset])).toEqual([["Doors open", "09:00", "Asha", "todo", 0], ["Tech check", "09:30", "", "todo", 0]]);
    expect((await put(w.id, w.editor.token, [item("Only one", "10:00")])).json.items).toHaveLength(1);
    expect((await call(`/events/${w.id}/runofshow`, { token: w.viewer.token })).status).toBe(200);
    expect((await put(w.id, w.viewer.token, [])).status).toBe(403);
    expect((await call(`/events/${w.id}/runofshow`, { token: w.stranger.token })).status).toBe(404);
    expect((await call(`/events/${w.id}/runofshow`)).status).toBe(401);
  });

  it("keeps order and ids of existing items, and rejects bad input", async () => {
    const w = await world();
    const a = await put(w.id, w.o.token, [item("One", "09:00"), item("Two", "10:00")]);
    const [one, two] = a.json.items;
    const b = await put(w.id, w.o.token, [two, one, item("  Three   spaced ", "11:00", { dayOffset: 1 })]);
    expect(b.json.items.map((i: any) => i.title)).toEqual(["Two", "One", "Three spaced"]);
    expect(b.json.items[0].id).toBe(two.id);
    expect(b.json.items[2].dayOffset).toBe(1);
    for (const bad of [
      [item("x", "9:00")], [item("x", "24:00")], [item("", "09:00")], [item("t".repeat(101), "09:00")],
      [item("x", "09:00", { ownerName: "o".repeat(61) })], [item("x", "09:00", { notes: "n".repeat(301) })],
      [item("x", "09:00", { status: "weird" })], [item("x", "09:00", { dayOffset: -1 })], [item("x", "09:00", { dayOffset: 1.5 })], ["nope"],
    ]) expect((await put(w.id, w.o.token, bad as unknown[])).status).toBe(400);
    expect((await put(w.id, w.o.token, Array.from({ length: 201 }, (_, i) => item(`i${i}`, "09:00")))).status).toBe(400);
    expect((await put(w.id, w.o.token, Array.from({ length: 200 }, (_, i) => item(`i${i}`, "09:00")))).status).toBe(200);
    // a failed save changed nothing
    expect((await call(`/events/${w.id}/runofshow`, { token: w.o.token })).json.items).toHaveLength(200);
  });

  it("does not take over item ids that belong to another event", async () => {
    const w = await world();
    const x = await world();
    const a = await put(w.id, w.o.token, [item("Mine", "09:00")]);
    const r = await put(x.id, x.o.token, [{ ...a.json.items[0], title: "Copy" }]);
    expect(r.status).toBe(200);
    expect(r.json.items[0].id).not.toBe(a.json.items[0].id);
    expect((await call(`/events/${w.id}/runofshow`, { token: w.o.token })).json.items[0].title).toBe("Mine");
  });

  it("changes one status; viewers cannot; unknown item is 404", async () => {
    const w = await world();
    const a = await put(w.id, w.o.token, [item("One", "09:00")]);
    const iid = a.json.items[0].id;
    const s = await call(`/events/${w.id}/runofshow/${iid}/status`, { token: w.editor.token, body: { status: "doing" } });
    expect(s.status).toBe(200);
    expect(s.json.item.status).toBe("doing");
    expect((await call(`/events/${w.id}/runofshow/${iid}/status`, { token: w.o.token, body: { status: "bad" } })).status).toBe(400);
    expect((await call(`/events/${w.id}/runofshow/${iid}/status`, { token: w.viewer.token, body: { status: "done" } })).status).toBe(403);
    expect((await call(`/events/${w.id}/runofshow/nope/status`, { token: w.o.token, body: { status: "done" } })).status).toBe(404);
    const other = await world();
    expect((await call(`/events/${other.id}/runofshow/${iid}/status`, { token: other.o.token, body: { status: "done" } })).status).toBe(404);
  });
});

describe("run of show, volunteer link", () => {
  it("shows the list read-only, hides notes unless ticked, and revokes", async () => {
    const w = await world();
    await put(w.id, w.o.token, [item("Doors open", "09:00", { ownerName: "Asha", notes: "Key is with security" })]);
    expect((await call(`/events/${w.id}/runofshow/link`, { token: w.viewer.token, body: {} })).status).toBe(403);
    const l = await call(`/events/${w.id}/runofshow/link`, { token: w.editor.token, body: {} });
    expect(l.status).toBe(201);
    const tok = l.json.token as string;
    expect(tok.length).toBeGreaterThanOrEqual(20);
    // the token is never returned again
    expect(JSON.stringify((await call(`/events/${w.id}/runofshow`, { token: w.o.token })).json)).not.toContain(tok);
    const p = await call(`/public/run/${tok}`);
    expect(p.status).toBe(200);
    expect(p.json.event.name).toBe("Run Cup");
    expect(p.json.items[0]).toMatchObject({ title: "Doors open", ownerName: "Asha", status: "todo", atTime: "09:00" });
    expect(p.text).not.toContain("Key is with security");
    expect(p.text).not.toContain("roster");
    // conditional request
    const again = await call(`/public/run/${tok}`, { headers: { "if-none-match": p.headers.get("etag")! } });
    expect(again.status).toBe(304);
    // with notes
    const l2 = await call(`/events/${w.id}/runofshow/link`, { token: w.o.token, body: { showNotes: true } });
    expect((await call(`/public/run/${tok}`)).status).toBe(404); // a new link replaced the old one
    const p2 = await call(`/public/run/${l2.json.token}`);
    expect(p2.json.items[0].notes).toBe("Key is with security");
    expect((await call(`/events/${w.id}/runofshow`, { token: w.o.token })).json.link).toMatchObject({ active: true, showNotes: true });
    // status changes show up
    const iid = p2.json.items[0].id;
    await call(`/events/${w.id}/runofshow/${iid}/status`, { token: w.o.token, body: { status: "done" } });
    expect((await call(`/public/run/${l2.json.token}`)).json.items[0].status).toBe("done");
    // revoke
    expect((await call(`/events/${w.id}/runofshow/link`, { method: "DELETE", token: w.viewer.token })).status).toBe(403);
    expect((await call(`/events/${w.id}/runofshow/link`, { method: "DELETE", token: w.o.token })).json).toEqual({ ok: true });
    expect((await call(`/public/run/${l2.json.token}`)).status).toBe(404);
    expect((await call(`/events/${w.id}/runofshow`, { token: w.o.token })).json.link).toBeNull();
  });

  it("answers 404 for malformed or unknown tokens and rate limits", async () => {
    expect((await call("/public/run/short")).status).toBe(404);
    expect((await call(`/public/run/${"a".repeat(32)}`)).status).toBe(404);
    const ip = "10.250.1.1";
    let last = 0;
    for (let i = 0; i < 125; i++) last = (await call(`/public/run/${"b".repeat(32)}`, { ip })).status;
    expect(last).toBe(429);
  });

  it("is deleted with the event", async () => {
    const w = await world();
    await put(w.id, w.o.token, [item("One", "09:00")]);
    const l = await call(`/events/${w.id}/runofshow/link`, { token: w.o.token, body: {} });
    expect((await call(`/events/${w.id}`, { method: "DELETE", token: w.o.token })).status).toBeLessThan(300);
    expect((await call(`/public/run/${l.json.token}`)).status).toBe(404);
  });
});
