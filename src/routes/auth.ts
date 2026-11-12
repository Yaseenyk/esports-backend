import { Hono } from "hono";
import type { AppBindings } from "../types";
import { hashPassword, iterationsFrom, pwFingerprint, randomToken, sha256, signJwt, verifyPassword } from "../crypto";
import { HttpError, nowIso, rateLimit, rateLimitSubject, readJson, str } from "../http";
import { getMailer, resetLink, resetMail } from "../mailer";
import { requireUser } from "../auth";
import { afterUserDelete, handoverStatements, personalOrgId, planOrgExit, planOwnershipHandover, soloEvents, SOLO_CHUNK_THRESHOLD, SOLO_PER_REQUEST } from "../ownership";
import { auditOff, auditStmts } from "../audit";
import { eventDeleteStatements } from "./events";
import { getFlag } from "../flags";
import { sendSignupVerification } from "./verify";

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

/**
 * One canonical form per mailbox: NFKC folds look-alike forms (fullwidth letters and other compatibility characters)
 * into plain ones, so a fullwidth spelling and the plain one are the same account for sign-up, sign-in and sharing.
 */
export const normEmail = (s: string): string => s.normalize("NFKC").trim().toLowerCase();

function email(v: unknown): string {
  const e = normEmail(str(v, "email", 3, 254));
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
  const mustVerify = (await getFlag(c.env.DB, "auth.verify_required")) ? 1 : 0;
  try {
    // Dual-write (blueprint 5.5): the account, its personal organisation and the admin membership commit together or not at all.
    const orgId = personalOrgId(user.id);
    await c.env.DB.batch([
      c.env.DB.prepare("INSERT INTO users (id, email, name, pw_hash, pw_salt, pw_iter, created_at, verify_required) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(user.id, user.email, user.name, user.pw_hash, user.pw_salt, user.pw_iter, user.created_at, mustVerify),
      c.env.DB.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES (?1, ?2, 'personal', 'active', ?3)").bind(orgId, `${user.name.slice(0, 60)}'s workspace`, user.created_at),
      c.env.DB.prepare("INSERT INTO org_members (org_id, user_id, role, added_by, added_at) VALUES (?1, ?2, 'admin', ?2, ?3)").bind(orgId, user.id, user.created_at),
    ]);
  } catch {
    throw new HttpError(409, "An account with this email already exists");
  }
  // The confirmation link goes out at once, so the person finds it waiting. A mail problem never stops the sign-up: they can ask for another.
  await sendSignupVerification(c, user.id, user.email);
  return c.json({ token: await signJwt(user.id, c.env.JWT_SECRET, await pwFingerprint(user)), user: publicUser(user) }, 201);
});

auth.post("/auth/login", async (c) => {
  await rateLimit(c, "auth", 10, 15 * 60);
  const body = await readJson(c);
  const e = typeof body.email === "string" ? normEmail(body.email) : "";
  const pw = typeof body.password === "string" ? body.password : "";
  if (!e || !pw || pw.length > 200) throw new HttpError(400, "email and password are required");
  const u = await c.env.DB.prepare("SELECT * FROM users WHERE email = ?").bind(e).first<UserRow>();
  const ok = u
    ? await verifyPassword(pw, u.pw_hash, u.pw_salt, u.pw_iter)
    : (await verifyPassword(pw, DUMMY.hash, DUMMY.salt, iterationsFrom(c.env)), false);
  if (!u || !ok) throw new HttpError(401, "Wrong email or password");
  return c.json({ token: await signJwt(u.id, c.env.JWT_SECRET, await pwFingerprint(u)), user: publicUser(u) });
});

auth.get("/me", requireUser, async (c) => {
  const u = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(c.get("userId")).first<UserRow>();
  if (!u) throw new HttpError(401, "Authentication required");
  return c.json(publicUser(u));
});

/** Change the password while signed in. Needs the current one, so a stolen token alone cannot lock the owner out. */
auth.post("/auth/change-password", requireUser, async (c) => {
  await rateLimit(c, "pwchange", 10, 15 * 60);
  const body = await readJson(c);
  const current = typeof body.current === "string" ? body.current : "";
  const next = password(body.next);
  const u = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(c.get("userId")).first<UserRow>();
  if (!u || !(await verifyPassword(current, u.pw_hash, u.pw_salt, u.pw_iter))) throw new HttpError(401, "Current password is wrong");
  const h = await hashPassword(next, iterationsFrom(c.env));
  await c.env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ? WHERE id = ?").bind(h.hash, h.salt, h.iterations, u.id).run();
  // Every older token stops working (its fingerprint no longer matches); hand back a fresh one so this session continues.
  return c.json({ ok: true, token: await signJwt(u.id, c.env.JWT_SECRET, await pwFingerprint({ pw_hash: h.hash, pw_salt: h.salt })) });
});

/**
 * Delete the account and everything under it (rosters, photos, check-ins, links). Needs the password.
 * Events that other people work on are protected (see src/ownership.ts): an event with a co-organiser (editor) is handed to the
 * earliest-added editor; an event with only viewers is deleted only when the request says `deleteEvents: true`.
 * Events nobody else is part of are deleted with the account, as before.
 */
auth.post("/auth/delete-account", requireUser, async (c) => {
  await rateLimit(c, "pwchange", 10, 15 * 60);
  const body = await readJson(c);
  const u = await c.env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(c.get("userId")).first<UserRow>();
  const pw = typeof body.password === "string" ? body.password : "";
  if (!u || !(await verifyPassword(pw, u.pw_hash, u.pw_salt, u.pw_iter))) throw new HttpError(401, "Password is wrong");
  if (body.deleteEvents !== undefined && typeof body.deleteEvents !== "boolean") throw new HttpError(400, "deleteEvents must be true or false");
  // E2: the last admin of a club that other people or other people's events depend on cannot delete the account (nothing is changed).
  const exit = await planOrgExit(c.env.DB, u.id);
  if (exit.blocked.length) {
    throw new HttpError(409, "You are the only admin of a club that other people use. Hand over the club first: make someone else an admin, then delete your account.", { code: "sole_owner", orgs: exit.blocked });
  }
  const plan = await planOwnershipHandover(c.env.DB, u.id);
  if (plan.tooMany) {
    throw new HttpError(409, "You share more than 50 events with other organisers. Remove some co-organisers or delete some events first, then delete your account.", { code: "too_many_shared_events" });
  }
  if (plan.conflicts.length) {
    const first = plan.conflicts[0]!;
    throw new HttpError(
      409,
      `${first.newOwnerName} cannot take over "${first.name}" because they already have an event with the same key ("${first.slug}"). Remove them as a co-organiser or ask them to rename their event, then try again. Nothing was deleted.`,
      { code: "ownership_conflict", events: plan.conflicts.map((e) => ({ id: e.id, name: e.name, newOwnerName: e.newOwnerName })) },
    );
  }
  if (plan.needDeleteConfirmation.length && body.deleteEvents !== true) {
    const names = plan.needDeleteConfirmation.map((e) => `"${e.name}"`).slice(0, 5).join(", ");
    throw new HttpError(
      409,
      `No co-organiser can take over ${names}${plan.needDeleteConfirmation.length > 5 ? " and more" : ""}, so deleting your account will delete ${plan.needDeleteConfirmation.length === 1 ? "this event" : "these events"} for the people who view ${plan.needDeleteConfirmation.length === 1 ? "it" : "them"} too. To go ahead, confirm that you also want to delete your events.`,
      { code: "events_need_delete_confirmation", events: plan.needDeleteConfirmation.map((e) => ({ id: e.id, name: e.name })) },
    );
  }
  // S1c (review N-14): above SOLO_CHUNK_THRESHOLD events that nobody can take over, delete them one event per batch BEFORE the final batch, so no single
  // statement cascades through thousands of rows. All the refusals above happen first; this needs the typed count (at least the number that remain).
  const solo = await soloEvents(c.env.DB, u.id, plan.handovers.map((h) => h.id));
  if (solo.length > SOLO_CHUNK_THRESHOLD) {
    const typed = body.confirmEventCount;
    if (typeof typed !== "number" || !Number.isInteger(typed) || typed < solo.length) {
      throw new HttpError(409, `Deleting your account will delete ${solo.length} events and everything in them. To go ahead, type the number of events (${solo.length}) to confirm.`, { code: "events_need_count_confirmation", eventCount: solo.length });
    }
    const chunk = solo.slice(0, SOLO_PER_REQUEST);
    for (const e of chunk) await c.env.DB.batch(eventDeleteStatements(c.env.DB, e.id, u.id));
    if (solo.length > chunk.length) {
      throw new HttpError(409, `${chunk.length} of your events were deleted. ${solo.length - chunk.length} are left: send the same request again to continue. Your account is not deleted yet.`, { code: "deletion_continues", deleted: chunk.length, remaining: solo.length - chunk.length });
    }
  }
  const off = await auditOff(c.env.DB);
  try {
    await c.env.DB.batch([
      ...handoverStatements(c.env.DB, u.id, plan.handovers),
      ...plan.handovers.flatMap((h) => auditStmts(c.env.DB, { action: "event.handed_over", actorType: "user", actorId: u.id, eventId: h.id, targetType: "event", targetId: h.id }, off)),
      c.env.DB.prepare("DELETE FROM users WHERE id = ?").bind(u.id),
      ...auditStmts(c.env.DB, { action: "auth.account_deleted", actorType: "user", actorId: u.id }, off),
      ...afterUserDelete(c.env.DB, u.id, exit.soleTeamOrgIds),
    ]);
  } catch (e) {
    // A foreign key still points at the account (for example a stray event): the batch rolled back whole, so nothing was deleted (review N-15).
    if (/constraint|foreign key/i.test(e instanceof Error ? `${e.message} ${String((e as { cause?: unknown }).cause ?? "")}` : String(e))) {
      throw new HttpError(409, "Your account still owns something that could not be handed over, so nothing was deleted. Contact support if this keeps happening.", { code: "ownership_conflict" });
    }
    throw e;
  }
  return c.json(plan.handovers.length ? { ok: true, handedOver: plan.handovers.map((h) => ({ id: h.id, name: h.name, newOwnerName: h.newOwnerName })) } : { ok: true });
});

const RESET_TTL_MS = 30 * 60_000;

/** Always 200 for a well-formed request, whether or not the account exists. */
auth.post("/auth/forgot", async (c) => {
  const body = await readJson(c);
  const e = email(body.email);
  await rateLimit(c, "forgot-ip", 20, 3600);
  await rateLimitSubject(c, "forgot-email", e, 5, 3600);
  const u = await c.env.DB.prepare("SELECT id FROM users WHERE email = ?").bind(e).first<{ id: string }>();
  // Same work whether or not the account exists: a token is always generated and hashed.
  const token = randomToken(32);
  const tokenHash = await sha256(token);
  if (u) {
    const now = nowIso();
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL").bind(now, u.id),
      c.env.DB.prepare("INSERT INTO password_resets (id, user_id, token_hash, created_at, expires_at, used_at) VALUES (?, ?, ?, ?, ?, NULL)")
        .bind(crypto.randomUUID(), u.id, tokenHash, now, new Date(Date.now() + RESET_TTL_MS).toISOString()),
    ]);
    const mailer = getMailer(c.env);
    if (!mailer) console.warn("password reset requested but RESEND_API_KEY is not set; no email sent");
    else {
      // Sent after the response, so how long this request takes never reveals whether the account exists.
      const send = (async () => {
        try {
          await mailer.send(resetMail(e, resetLink(c.env, token)));
        } catch {
          console.warn("password reset email failed to send"); // no details: they could contain the address
        }
      })();
      try { c.executionCtx.waitUntil(send); } catch { await send; } // no execution context (some test setups): wait instead
    }
  }
  return c.json({ ok: true });
});

auth.post("/auth/reset", async (c) => {
  await rateLimit(c, "reset", 10, 15 * 60);
  const body = await readJson(c);
  const pw = password(body.password);
  const token = typeof body.token === "string" ? body.token : "";
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw new HttpError(400, "invalid_or_expired");
  const h = await hashPassword(pw, iterationsFrom(c.env));
  // Atomic single use: only one request can flip used_at from NULL.
  const row = await c.env.DB.prepare("UPDATE password_resets SET used_at = ?1 WHERE token_hash = ?2 AND used_at IS NULL AND expires_at > ?1 RETURNING user_id")
    .bind(nowIso(), await sha256(token))
    .first<{ user_id: string }>();
  if (!row) throw new HttpError(400, "invalid_or_expired");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE users SET pw_hash = ?, pw_salt = ?, pw_iter = ? WHERE id = ?").bind(h.hash, h.salt, h.iterations, row.user_id),
    c.env.DB.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(row.user_id),
  ]);
  return c.json({ ok: true });
});
