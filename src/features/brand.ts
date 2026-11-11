import { Hono } from "hono";
import type { AppBindings } from "../types";
import { HttpError, nowIso, rateLimit, rateLimitSubject, readJson, str, type Ctx } from "../http";
import { sha256 } from "../crypto";
import { ownedEvent, requireUser } from "../auth";
import { validateLogo } from "../images";

export const routes = new Hono<AppBindings>();

const HEX = /^#[0-9a-fA-F]{6}$/;
const SLUG_RE = /^[a-z2-7]{12}$/;

interface KitRow { name: string; logo: string | null; primary_color: string; secondary_color: string; updated_at: string }
interface Kit { name: string; logo: string | null; primaryColor: string; secondaryColor: string; updatedAt: string }

const shape = (r: KitRow | null): Kit | null =>
  r ? { name: r.name, logo: r.logo, primaryColor: r.primary_color, secondaryColor: r.secondary_color, updatedAt: r.updated_at } : null;

function colour(v: unknown, field: string): string {
  if (typeof v !== "string" || !HEX.test(v)) throw new HttpError(400, `${field} must be a colour like #1a2b3c`);
  return v.toLowerCase();
}

async function readBody(c: Ctx) {
  const b = await readJson(c, 100_000);
  const name = b.name === undefined || b.name === null ? "My brand" : str(b.name, "name", 1, 60);
  const logo = validateLogo(b.logo, "logo");
  return { name, logo, primary: colour(b.primaryColor, "primaryColor"), secondary: colour(b.secondaryColor, "secondaryColor") };
}

const readKit = (c: Ctx, owner: string, scope: string) =>
  c.env.DB.prepare("SELECT name, logo, primary_color, secondary_color, updated_at FROM brand_kits WHERE owner_user_id = ? AND scope = ?").bind(owner, scope).first<KitRow>();

async function saveKit(c: Ctx, owner: string, scope: string, b: Awaited<ReturnType<typeof readBody>>) {
  await c.env.DB.prepare(
    "INSERT INTO brand_kits (id, owner_user_id, scope, name, logo, primary_color, secondary_color, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (owner_user_id, scope) DO UPDATE SET name = excluded.name, logo = excluded.logo, primary_color = excluded.primary_color, secondary_color = excluded.secondary_color, updated_at = excluded.updated_at",
  ).bind(crypto.randomUUID(), owner, scope, b.name, b.logo, b.primary, b.secondary, nowIso()).run();
}

routes.get("/brand", requireUser, async (c) => {
  const kit = shape(await readKit(c, c.get("userId"), "account"));
  return c.json({ brand: kit, source: kit ? "account" : "none" });
});

routes.put("/brand", requireUser, async (c) => {
  await rateLimitSubject(c, "brandPut", c.get("userId"), 60, 3600);
  const b = await readBody(c);
  await saveKit(c, c.get("userId"), "account", b);
  return c.json({ brand: shape(await readKit(c, c.get("userId"), "account")), source: "account" });
});

routes.delete("/brand", requireUser, async (c) => {
  await c.env.DB.prepare("DELETE FROM brand_kits WHERE owner_user_id = ? AND scope = 'account'").bind(c.get("userId")).run();
  return c.json({ brand: null, source: "none" });
});

/** The kit that applies to an event: its own kit, else its owner's account kit. */
async function effective(c: Ctx, eventId: string, ownerId: string) {
  const own = shape(await readKit(c, ownerId, eventId));
  if (own) return { brand: own, source: "event" as const };
  const acc = shape(await readKit(c, ownerId, "account"));
  return acc ? { brand: acc, source: "account" as const } : { brand: null, source: "none" as const };
}

routes.get("/events/:id/brand", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  return c.json(await effective(c, ev.id, ev.owner_id));
});

routes.put("/events/:id/brand", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "brandPut", c.get("userId"), 60, 3600);
  const b = await readBody(c);
  await saveKit(c, ev.owner_id, ev.id, b);
  return c.json(await effective(c, ev.id, ev.owner_id));
});

routes.delete("/events/:id/brand", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await c.env.DB.prepare("DELETE FROM brand_kits WHERE owner_user_id = ? AND scope = ?").bind(ev.owner_id, ev.id).run();
  return c.json(await effective(c, ev.id, ev.owner_id));
});

routes.get("/public/brand/:slug", async (c) => {
  await rateLimit(c, "brandPublic", 240, 60);
  const slug = c.req.param("slug");
  if (!SLUG_RE.test(slug)) throw new HttpError(404, "not_found");
  const ev = await c.env.DB.prepare("SELECT e.id AS id, e.owner_id AS owner_id FROM live_pages l JOIN events e ON e.id = l.event_id WHERE l.slug = ? AND l.published = 1")
    .bind(slug).first<{ id: string; owner_id: string }>();
  if (!ev) throw new HttpError(404, "not_found");
  const { brand } = await effective(c, ev.id, ev.owner_id);
  // Only what the page shows: no ids, no owner, no timestamps.
  const body = JSON.stringify({ brand: brand ? { name: brand.name, logo: brand.logo, primaryColor: brand.primaryColor, secondaryColor: brand.secondaryColor } : null });
  const etag = `"${(await sha256(body)).slice(0, 27)}"`;
  const cache = "public, max-age=30";
  const inm = c.req.header("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers: { "cache-control": cache, etag } });
  return new Response(body, { status: 200, headers: { "cache-control": cache, etag, "content-type": "application/json; charset=UTF-8" } });
});

export const routeRules: import("./types").RouteRules = {
  "GET /brand": { roles: ["owner", "editor", "viewer"], limit: "signed-in only" },
  "PUT /brand": { roles: ["owner", "editor", "viewer"], limit: "60/hour per user" },
  "DELETE /brand": { roles: ["owner", "editor", "viewer"] },
  "GET /events/:id/brand": { roles: ["owner", "editor", "viewer"] },
  "PUT /events/:id/brand": { roles: ["owner", "editor"], limit: "60/hour per user" },
  "DELETE /events/:id/brand": { roles: ["owner", "editor"] },
  "GET /public/brand/:slug": { public: true, limit: "240/min per IP" },
};
