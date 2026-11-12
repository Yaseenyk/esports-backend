import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { afterUserDelete, extraPerHandover } from "../src/ownership";
import { call, newEvent, newUser } from "./helpers";

vi.setConfig({ testTimeout: 180_000 });

const PW = "correct horse";
const del = (token: string, body: Record<string, unknown> = {}) => call("/auth/delete-account", { token, body: { password: PW, ...body } });
const kit = { name: "Acct Brand", primaryColor: "#0a84ff", secondaryColor: "#7c3aed" };

async function shared(name: string) {
  const o = await newUser("Owner");
  const ev = await newEvent(o.token, name);
  const ed = await newUser("Ed");
  expect((await call(`/events/${ev.id}/members`, { token: o.token, body: { email: ed.email, role: "editor" } })).status).toBe(201);
  const live = await call(`/events/${ev.id}/live`, { method: "PUT", token: o.token, body: { published: true, snapshot: { views: [], announcements: [], sponsors: [], ticker: [] } } });
  return { o, ev, ed, slug: live.json.slug as string };
}
const pub = async (slug: string) => (await call(`/public/brand/${slug}`)).json;

describe("S1 follow-ups (N-1, N-15, seams)", () => {
  it("N-1: an event that relied on the leaver's account kit keeps the same public brand after the hand-over", async () => {
    const w = await shared("Acct Only Cup");
    await call("/brand", { method: "PUT", token: w.o.token, body: kit });
    const before = await pub(w.slug);
    expect(before.brand.name).toBe("Acct Brand");
    expect((await del(w.o.token)).status).toBe(200);
    expect(await pub(w.slug)).toEqual(before);
    expect((await call(`/events/${w.ev.id}/brand`, { token: w.ed.token })).json).toMatchObject({ source: "event", brand: { name: "Acct Brand" } });
  });

  it("N-1: an event with its own kit keeps it, and the account kit is not copied over it", async () => {
    const w = await shared("Own Kit Cup");
    await call("/brand", { method: "PUT", token: w.o.token, body: kit });
    await call(`/events/${w.ev.id}/brand`, { method: "PUT", token: w.o.token, body: { ...kit, name: "Event Brand" } });
    const before = await pub(w.slug);
    expect(before.brand.name).toBe("Event Brand");
    expect((await del(w.o.token)).status).toBe(200);
    expect(await pub(w.slug)).toEqual(before);
  });

  it("N-1: no account kit and no event kit stays unbranded", async () => {
    const w = await shared("No Kit Cup");
    expect((await del(w.o.token)).status).toBe(200);
    expect(await pub(w.slug)).toEqual({ brand: null });
  });

  it("N-15: a constraint failure at the final delete is a 409 ownership_conflict and nothing is deleted", async () => {
    const w = await shared("Stray Cup");
    await call("/brand", { method: "PUT", token: w.o.token, body: kit });
    // stands in for the foreign key a stray event will hold on the personal organisation
    await env.DB.prepare("CREATE TRIGGER stray_guard BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed'); END").run();
    try {
      const r = await del(w.o.token);
      expect(r.status).toBe(409);
      expect(r.json.code).toBe("ownership_conflict");
    } finally {
      await env.DB.prepare("DROP TRIGGER stray_guard").run();
    }
    expect((await call("/me", { token: w.o.token })).status).toBe(200);
    const row = await env.DB.prepare("SELECT owner_id FROM events WHERE id = ?").bind(w.ev.id).first<{ owner_id: string }>();
    expect(row!.owner_id).toBe(w.o.id); // the batch rolled back whole: no hand-over happened
    expect((await call("/brand", { token: w.o.token })).json.brand).not.toBeNull();
    expect((await del(w.o.token)).status).toBe(200); // and it works once the obstacle is gone
  });

  it("the seams: E1 moves a personal-organisation hand-over, E2 leaves a club event where it is, afterUserDelete removes the leaver's organisations", () => {
    const h = { id: "e", name: "n", slug: "s", newOwnerId: "u", newOwnerName: "U" };
    expect(extraPerHandover(env.DB, h)).toHaveLength(1);
    expect(extraPerHandover(env.DB, { ...h, keepOrg: true })).toEqual([]);
    expect(afterUserDelete(env.DB, "u")).toHaveLength(1);
    expect(afterUserDelete(env.DB, "u", ["a", "b"])).toHaveLength(3);
  });
});
