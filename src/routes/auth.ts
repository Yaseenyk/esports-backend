import { Hono } from "hono";
import type { AppBindings } from "../types";
import { hashPassword, iterationsFrom, signJwt, verifyPassword } from "../crypto";
import { HttpError, nowIso, rateLimit, readJson, str } from "../http";
import { requireUser } from "../auth";

export const auth = new Hono<AppBindings>();

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@.]+(\.[^\s@.]+)+$/;
// Used to spend comparable time when the email is unknown (avoids user enumeration by timing).
const DUMMY = { hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", salt: "AAAAAAAAAAAAAAAAAAAAAA" };

interface UserRow {
  id: string;
  email: string;
  name: string;
  pw_hash: string;
  pw_salt: string;
  pw_iter: number;
  created_at: string;
}
const publicUser = (u: UserRow) => ({ id: u.id, email: u.email, name: u.name, createdAt: u.created_at });

function email(v: unknown): string {
  const e = str(v, "email", 3, 254).toLowerCase();
  if (!EMAIL_RE.test(e)) throw new HttpError(400, "email is not valid");
  return e;
}

function password(v: unknown): string {
  if (typeof v !== "string" || v.length < 8 || v.length > 200) throw new HttpError(400, "password must be 8-200 characters");
  return v;
}

auth.post("/auth/register", async (c) => {
  await rateLimit(c, "auth", 10, 15 * 60);
  const body = await readJson(c);
  const e = email(body.email);
  const name = str(body.name, "name", 1, 80);
  const pw = password(body.password);
  const exists = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(e).first();
  if (exists) throw new HttpError(409, "An account with this email already exists");
  const h = await hashPassword(pw, iterationsFrom(c.env));
  const user: UserRow = { id: crypto.randomUUID(), email: e, name, pw_hash: h.hash, pw_salt: h.salt, pw_iter: h.iterations, created_at: nowIso() };
  try {
    await c.env.DB.prepare("INSERT INTO users (id, email, name, pw_hash, pw_salt, pw_iter, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(user.id, user.email, user.name, user.pw_hash, user.pw_salt, user.pw_iter, user.created_at)
      .run();
  } catch {
    throw new HttpError(409, "An account with this email already exists");
  }
  return c.json({ token: await signJwt(user.id, c.env.JWT_SECRET), user: publicUser(user) }, 201);
});

auth.post("/auth/login", async (c) => {
  await rateLimit(c, "auth", 10, 15 * 60);
  const body = await readJson(c);
  const e = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const pw = typeof body.password === "string" ? body.password : "";
  if (!e || !pw || pw.length > 200) throw new HttpError(400, "email and password are required");
  const u = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(e).first<UserRow>();
  const ok = u
    ? await verifyPassword(pw, u.pw_hash, u.pw_salt, u.pw_iter)
    : (await verifyPassword(pw, DUMMY.hash, DUMMY.salt, iterationsFrom(c.env)), false);
  if (!u || !ok) throw new HttpError(401, "Wrong email or password");
  return c.json({ token: await signJwt(u.id, c.env.JWT_SECRET), user: publicUser(u) });
});

auth.get("/me", requireUser, async (c) => {
  const u = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(c.get("userId")).first<UserRow>();
  if (!u) throw new HttpError(401, "Authentication required");
  return c.json(publicUser(u));
});
