import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { basicRoster, call, newEvent, newUser } from "./helpers";

async function setup() {
  const owner = await newUser("Olivia Owner");
  const editor = await newUser("Eddie Editor");
  const viewer = await newUser("Vera Viewer");
  const stranger = await newUser("Sam Stranger");
  const ev = await newEvent(owner.token, "Shared Cup");
  await call(`/events/${ev.id}/roster`, { method: "PUT", token: owner.token, body: basicRoster() });
  const addE = await call(`/events/${ev.id}/members`, { token: owner.token, body: { email: editor.email, role: "editor" } });
  const addV = await call(`/events/${ev.id}/members`, { token: owner.token, body: { email: viewer.email, role: "viewer" } });
  return { owner, editor, viewer, stranger, ev, addE, addV };
}

describe("several organisers on one event", () => {
  it("the owner adds people by email; unknown emails, the owner and bad roles are refused", async () => {
    const s = await setup();
    expect(s.addE.status).toBe(201);
    expect(s.addE.json).toMatchObject({ email: s.editor.email, role: "editor" });
    expect((await call(`/events/${s.ev.id}/members`, { token: s.owner.token, body: { email: "nobody@example.com", role: "editor" } })).status).toBe(404);
    expect((await call(`/events/${s.ev.id}/members`, { token: s.owner.token, body: { email: s.owner.email, role: "editor" } })).status).toBe(409);
    expect((await call(`/events/${s.ev.id}/members`, { token: s.owner.token, body: { email: s.stranger.email, role: "admin" } })).status).toBe(400);
    const list = await call(`/events/${s.ev.id}/members`, { token: s.owner.token });
    expect(list.json.owner.email).toBe(s.owner.email);
    expect(list.json.members.map((m: { role: string }) => m.role)).toEqual(["editor", "viewer"]);
    // adding again changes the role instead of duplicating
    await call(`/events/${s.ev.id}/members`, { token: s.owner.token, body: { email: s.viewer.email, role: "editor" } });
    expect((await call(`/events/${s.ev.id}/members`, { token: s.owner.token })).json.members).toHaveLength(2);
  });

  it("an editor can read and change the event but cannot delete it or manage access", async () => {
    const s = await setup();
    expect((await call(`/events/${s.ev.id}`, { token: s.editor.token })).status).toBe(200);
    expect((await call(`/events/${s.ev.id}/roster`, { token: s.editor.token })).json.people).toHaveLength(3);
    expect((await call(`/events/${s.ev.id}`, { method: "PUT", token: s.editor.token, body: { venue: "Hall 2" } })).status).toBe(200);
    expect((await call(`/events/${s.ev.id}/gate-keys`, { token: s.editor.token, body: { label: "Door" } })).status).toBe(201);
    expect((await call(`/events/${s.ev.id}`, { method: "DELETE", token: s.editor.token })).status).toBe(403);
    expect((await call(`/events/${s.ev.id}/members`, { token: s.editor.token })).status).toBe(403);
    expect((await call(`/events/${s.ev.id}/members`, { token: s.editor.token, body: { email: s.stranger.email, role: "viewer" } })).status).toBe(403);
    const mine = await call("/events", { token: s.editor.token });
    expect(mine.json.find((e: { id: string }) => e.id === s.ev.id).role).toBe("editor");
    expect((await call("/events", { token: s.owner.token })).json.find((e: { id: string }) => e.id === s.ev.id).role).toBe("owner");
  });

  it("a viewer can look but not change anything", async () => {
    const s = await setup();
    expect((await call(`/events/${s.ev.id}`, { token: s.viewer.token })).status).toBe(200);
    expect((await call(`/events/${s.ev.id}/passes`, { token: s.viewer.token })).status).toBe(403); // the pass codes are credentials
    expect((await call(`/events/${s.ev.id}/passes`, { token: s.editor.token })).status).toBe(200);
    expect((await call(`/events/${s.ev.id}`, { method: "PUT", token: s.viewer.token, body: { venue: "Nope" } })).status).toBe(403);
    expect((await call(`/events/${s.ev.id}/roster`, { method: "PUT", token: s.viewer.token, body: basicRoster() })).status).toBe(403);
    expect((await call(`/events/${s.ev.id}/gate-keys`, { token: s.viewer.token, body: { label: "Door" } })).status).toBe(403);
    expect((await call(`/events/${s.ev.id}`, { method: "DELETE", token: s.viewer.token })).status).toBe(403);
  });

  it("someone with no access sees nothing, and the event does not appear in their list", async () => {
    const s = await setup();
    for (const path of [`/events/${s.ev.id}`, `/events/${s.ev.id}/roster`, `/events/${s.ev.id}/members`]) expect((await call(path, { token: s.stranger.token })).status, path).toBe(404);
    expect((await call("/events", { token: s.stranger.token })).json).toEqual([]);
  });

  it("access can be removed by the owner, or given up by the person themselves", async () => {
    const s = await setup();
    const me = await call("/me", { token: s.editor.token });
    expect((await call(`/events/${s.ev.id}/members/${me.json.id}`, { method: "DELETE", token: s.stranger.token })).status).toBe(404);
    expect((await call(`/events/${s.ev.id}/members/${me.json.id}`, { method: "DELETE", token: s.owner.token })).status).toBe(200);
    expect((await call(`/events/${s.ev.id}`, { token: s.editor.token })).status).toBe(404);
    // the viewer leaves by themselves
    const v = await call("/me", { token: s.viewer.token });
    expect((await call(`/events/${s.ev.id}/members/${v.json.id}`, { method: "DELETE", token: s.viewer.token })).status).toBe(200);
    expect((await call(`/events/${s.ev.id}`, { token: s.viewer.token })).status).toBe(404);
    expect((await call(`/events/${s.ev.id}/members/${v.json.id}`, { method: "DELETE", token: s.owner.token })).status).toBe(404); // already gone
  });

  it("deleting an account removes its access, and deleting the event removes the access list", async () => {
    const s = await setup();
    const e = await call("/me", { token: s.editor.token });
    await call("/auth/delete-account", { token: s.editor.token, body: { password: "correct horse" } });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM event_members WHERE user_id = ?").bind(e.json.id).first<{ n: number }>())!.n).toBe(0);
    await call(`/events/${s.ev.id}`, { method: "DELETE", token: s.owner.token });
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM event_members WHERE event_id = ?").bind(s.ev.id).first<{ n: number }>())!.n).toBe(0);
  });
});
