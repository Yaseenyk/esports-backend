import { Hono } from "hono";
import type { AppBindings } from "../types";
import { HttpError, nowIso, optStr, rateLimit, readJson, str } from "../http";

export const contact = new Hono<AppBindings>();

/** The public contact form. Messages are stored for the owner to read; nothing is emailed or shared. */
contact.post("/public/contact", async (c) => {
  await rateLimit(c, "contact", 5, 3600);
  const b = await readJson(c);
  // A hidden field real people never fill in: a filled one means a bot, which gets a normal-looking answer and no stored message.
  if (typeof b.website === "string" && b.website.trim() !== "") return c.json({ ok: true }, 201);
  const message = str(b.message, "message", 10, 2000);
  const name = optStr(b.name, "name", 80);
  const email = optStr(b.email, "email", 254);
  if (email && !/^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/.test(email)) throw new HttpError(400, "email is not valid");
  await c.env.DB.prepare("INSERT INTO contact_messages (id, name, email, message, created_at) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), name || null, email || null, message, nowIso()).run();
  return c.json({ ok: true }, 201);
});
