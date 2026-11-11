/// <reference types="vite/client" />
import { describe, expect, it, vi } from "vitest";
import { call, newEvent, newUser } from "./helpers";
import { ROUTES, world } from "./golden/rows";

// Role sweep: stranger, viewer, editor, owner, revocation and child-id isolation. (split from authz-matrix.test.ts; rows live in test/golden/rows.ts)
vi.setConfig({ testTimeout: 120_000 });
describe("authorization matrix: roles", () => {
  it("a stranger gets the same 404 as for an event that does not exist (no IDOR, no existence leak)", async () => {
    const w = await world();
    const ghost = { ...w.ctx, ev: "00000000-0000-0000-0000-000000000000" };
    for (const r of ROUTES) {
      if (r.path(w.ctx) === "/events") continue;
      const real = await call(r.path(w.ctx), { method: r.method, token: w.stranger.token, body: r.body });
      const none = await call(r.path(ghost), { method: r.method, token: w.stranger.token, body: r.body });
      expect(real.status, `${r.method} ${r.path(w.ctx)}`).toBe(404);
      expect(real.json, `${r.method} ${r.path(w.ctx)}`).toEqual({ error: "Event not found" });
      expect(none.status).toBe(404);
      expect(none.json).toEqual(real.json);
    }
    // and nothing of the owner's leaked into the stranger's list
    const list = await call("/events", { token: w.stranger.token });
    expect(list.json).toEqual([]);
    // a stranger cannot "leave" an event they are not in, and the answer is the same 404
    const leave = await call(`/events/${w.ctx.ev}/members/${w.stranger.id}`, { method: "DELETE", token: w.stranger.token });
    expect(leave.status).toBe(404);
  });

  it("a viewer can only GET; every write is 403, owner-only reads are 403, pass codes are never shown", async () => {
    const w = await world();
    for (const r of ROUTES) {
      if (r.path(w.ctx) === "/events") continue;
      const res = await call(r.path(w.ctx), { method: r.method, token: w.viewer.token, body: r.body });
      if (r.method === "GET" && !r.owner && !r.viewerBlocked) expect(res.status, `viewer ${r.method} ${r.path(w.ctx)}`).toBe(200);
      else expect(res.status, `viewer ${r.method} ${r.path(w.ctx)}`).toBe(403);
    }
    const passes = await call(`/events/${w.ctx.ev}/passes`, { token: w.viewer.token });
    expect(passes.text).not.toContain("EH1.");
    const inList = await call("/events", { token: w.viewer.token });
    expect(inList.json.map((e: any) => e.role)).toContain("viewer");
    // the event is untouched by all those attempts
    expect((await call(`/events/${w.ctx.ev}/roster`, { token: w.o.token })).json.people.length).toBe(3);
    // a viewer can leave on their own
    expect((await call(`/events/${w.ctx.ev}/members/${w.viewer.id}`, { method: "DELETE", token: w.viewer.token })).status).toBe(200);
    expect((await call(`/events/${w.ctx.ev}`, { token: w.viewer.token })).status).toBe(404);
  });

  it("an editor does everything except owner-only actions (delete event, manage members)", async () => {
    const w = await world();
    for (const r of ROUTES) {
      if (r.path(w.ctx) === "/events") continue;
      const res = await call(r.path(w.ctx), { method: r.method, token: w.editor.token, body: r.body });
      if (r.owner) {
        expect(res.status, `editor ${r.method} ${r.path(w.ctx)}`).toBe(403);
      } else {
        expect([401, 403], `editor ${r.method} ${r.path(w.ctx)}`).not.toContain(res.status);
        expect(res.json?.error, `editor ${r.method} ${r.path(w.ctx)}`).not.toBe("Event not found");
        expect(res.status).toBeLessThan(500);
      }
    }
    // the event survived the delete attempt, and the editor cannot grant access to themselves or others
    expect((await call(`/events/${w.ctx.ev}`, { token: w.o.token })).status).toBe(200);
    const sneaky = await newUser();
    expect((await call(`/events/${w.ctx.ev}/members`, { token: w.editor.token, body: { email: sneaky.email, role: "editor" } })).status).toBe(403);
    // an editor cannot remove the owner's other members, but can leave
    expect((await call(`/events/${w.ctx.ev}/members/${w.viewer.id}`, { method: "DELETE", token: w.editor.token })).status).toBe(403);
    expect((await call(`/events/${w.ctx.ev}/members/${w.editor.id}`, { method: "DELETE", token: w.editor.token })).status).toBe(200);
  });

  it("the owner can use every route and can really delete the event", async () => {
    const w = await world();
    const members = await call(`/events/${w.ctx.ev}/members`, { token: w.o.token });
    expect(members.status).toBe(200);
    expect(members.json.members.length).toBe(3);
    expect((await call(`/events/${w.ctx.ev}/passes`, { token: w.o.token })).json.length).toBe(3);
    expect((await call(`/events/${w.ctx.ev}`, { method: "DELETE", token: w.o.token })).status).toBe(200);
    expect((await call(`/events/${w.ctx.ev}`, { token: w.o.token })).status).toBe(404);
    // members lose access with it
    expect((await call(`/events/${w.ctx.ev}`, { token: w.editor.token })).status).toBe(404);
  });

  it("removing a member revokes access immediately", async () => {
    const w = await world();
    expect((await call(`/events/${w.ctx.ev}/roster`, { token: w.editor.token })).status).toBe(200);
    expect((await call(`/events/${w.ctx.ev}/members/${w.editor.id}`, { method: "DELETE", token: w.o.token })).status).toBe(200);
    expect((await call(`/events/${w.ctx.ev}/roster`, { token: w.editor.token })).status).toBe(404);
  });

  it("child ids from one event never resolve under another event of the same owner", async () => {
    const w = await world();
    const other = await newEvent(w.o.token, "Other Cup");
    const a = `/events/${other.id}`;
    expect((await call(`${a}/photos/${w.ctx.pid}`, { token: w.o.token })).status).toBe(404);
    expect((await call(`${a}/submissions/${w.ctx.sid}/photo`, { token: w.o.token })).status).toBe(404);
    expect((await call(`${a}/submissions/${w.ctx.sid}/approve`, { method: "POST", token: w.o.token, body: {} })).status).toBe(404);
    expect((await call(`${a}/submissions/${w.ctx.sid}/reject`, { method: "POST", token: w.o.token, body: {} })).status).toBe(404);
    expect((await call(`${a}/registrations/${w.ctx.rid}/approve`, { method: "POST", token: w.o.token, body: {} })).status).toBe(404);
    expect((await call(`${a}/registrations/${w.ctx.rid}/reject`, { method: "POST", token: w.o.token, body: {} })).status).toBe(404);
    expect((await call(`${a}/gate-keys/${w.ctx.kid}`, { method: "DELETE", token: w.o.token })).status).toBe(404);
    expect((await call(`${a}/invites/${w.ctx.iid}`, { method: "DELETE", token: w.o.token })).status).toBe(404);
    expect((await call(`${a}/people/${w.ctx.pid}/share`, { method: "POST", token: w.o.token, body: {} })).status).toBe(404);
    // none of that changed the original event
    expect((await call(`/events/${w.ctx.ev}/submissions?status=pending`, { token: w.o.token })).json.length).toBe(1);
    expect((await call(`/events/${w.ctx.ev}/gate-keys`, { token: w.o.token })).json[0].revoked).toBe(false);
  });
});
