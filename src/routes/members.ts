import { Hono } from "hono";
import type { AppBindings } from "../types";
import { HttpError, nowIso, rateLimit, readJson, str } from "../http";
import { ownerEvent, requireUser } from "../auth";
import { normEmail } from "./auth";
import { teamOrgsOn } from "../orgs/access";
import { createEventInvitation } from "../orgs/invitations";

export const members = new Hono<AppBindings>();

interface MemberRow { user_id: string; name: string; email: string; role: string; added_at: string }

/** Who has access to an event. Owner only. */
members.get("/events/:id/members", requireUser, async (c) => {
  const ev = await ownerEvent(c, c.req.param("id"));
  const owner = await c.env.DB.prepare("SELECT id, name, email FROM users WHERE id = ?").bind(ev.owner_id).first<{ id: string; name: string; email: string }>();
  const rows = await c.env.DB.prepare("SELECT m.user_id, u.name, u.email, m.role, m.added_at FROM event_members m JOIN users u ON u.id = m.user_id WHERE m.event_id = ? ORDER BY m.added_at").bind(ev.id).all<MemberRow>();
  return c.json({
    owner: owner ? { userId: owner.id, name: owner.name, email: owner.email } : null,
    members: rows.results.map((r) => ({ userId: r.user_id, name: r.name, email: r.email, role: r.role, addedAt: r.added_at })),
  });
});

/** Give another account access, by the email it signed up with. Owner only. An editor can do everything except delete the event and manage access. A viewer can only look. */
members.post("/events/:id/members", requireUser, async (c) => {
  const ev = await ownerEvent(c, c.req.param("id"));
  await rateLimit(c, "members", 30, 3600);
  const b = await readJson(c);
  // Phase 2a: with flag orgs.team on, adding a guest creates a pending invitation (copy link, accepted with a verified matching email). The answer is the same
  // whether or not an account exists for the address, so this route no longer reveals who has an account. With the flag off nothing changes.
  if (await teamOrgsOn(c.env.DB)) return createEventInvitation(c, ev.id, ev.org_id ?? null, b.email, b.role);
  const email = normEmail(str(b.email, "email", 3, 254));
  if (b.role !== "editor" && b.role !== "viewer") throw new HttpError(400, "role must be editor or viewer");
  const user = await c.env.DB.prepare("SELECT id, name, email FROM users WHERE email = ?").bind(email).first<{ id: string; name: string; email: string }>();
  if (!user) throw new HttpError(404, "There is no account with that email. Ask them to sign up first, then add them.");
  if (user.id === ev.owner_id) throw new HttpError(409, "That is the owner of this event");
  await c.env.DB.prepare("INSERT INTO event_members (event_id, user_id, role, added_at) VALUES (?, ?, ?, ?) ON CONFLICT (event_id, user_id) DO UPDATE SET role = excluded.role")
    .bind(ev.id, user.id, b.role, nowIso()).run();
  return c.json({ userId: user.id, name: user.name, email: user.email, role: b.role }, 201);
});

/** Remove someone's access (owner), or leave an event you were added to (yourself). */
members.delete("/events/:id/members/:userId", requireUser, async (c) => {
  const me = c.get("userId");
  const target = c.req.param("userId");
  const eventId = c.req.param("id");
  if (target === me) {
    const res = await c.env.DB.prepare("DELETE FROM event_members WHERE event_id = ? AND user_id = ?").bind(eventId, me).run();
    if (res.meta.changes === 0) throw new HttpError(404, "Event not found");
    return c.json({ ok: true });
  }
  const ev = await ownerEvent(c, eventId);
  const res = await c.env.DB.prepare("DELETE FROM event_members WHERE event_id = ? AND user_id = ?").bind(ev.id, target).run();
  if (res.meta.changes === 0) throw new HttpError(404, "That person does not have access");
  return c.json({ ok: true });
});
