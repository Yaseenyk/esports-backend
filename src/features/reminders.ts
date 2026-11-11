import { Hono } from "hono";
import type { AppBindings, Env } from "../types";
import { HttpError, nowIso, optStr, rateLimit, readJson, str } from "../http";
import { ownedEvent, requireUser } from "../auth";
import { deriveToken, hashKey, sha256 } from "../crypto";
import { AUTH_RESERVE, MAIL_DAY_LIMIT, mailerConfigured, refundMail, reserveMail, sendMailWithHeaders, unsubscribeLink, type MailWithHeaders } from "../mailer";
import type { RouteRules } from "./types";

/**
 * Email reminders and result emails. Opt-in only: organisers (owner, editors) and captains who gave an address AND agreed.
 * Free Resend plan: about 100 emails a day, so there is a global per-day budget (mail_budget) and a per-event daily cap.
 * Never logs addresses or bodies. Sending is done by the cron handler in reminders-cron.ts, which calls processDueJobs below.
 */
export const routes = new Hono<AppBindings>();

export const DAY_LIMIT = MAIL_DAY_LIMIT; // one pool of 90 a day under the 100 a day free plan
export const REMINDER_DAY_LIMIT = DAY_LIMIT - AUTH_RESERVE; // 10 are kept for auth mail (email verification), so reminders stop at 80
export const EVENT_DAY_LIMIT = 40;
export const BATCH = 8; // emails per cron run: a Worker has a small subrequest allowance
const MAX_OPEN_JOBS = 20;
const MAX_AHEAD_DAYS = 90;
const STALE_HOURS = 48;
const KINDS = ["tomorrow", "closing", "results", "custom"] as const;
const AUDIENCES = ["organiser", "captain", "both"] as const;
type Audience = (typeof AUDIENCES)[number];
const LINK_RE = /https?:\/\/|www\.|mailto:/i;

export const routeRules: RouteRules = {
  "GET /events/:id/reminders": { roles: ["owner", "editor"], limit: "none (signed in)" },
  "POST /events/:id/reminders": { roles: ["owner", "editor"], limit: "30 per hour per address and event" },
  "DELETE /events/:id/reminders/:rid": { roles: ["owner", "editor"] },
  "POST /events/:id/reminders/test": { roles: ["owner", "editor"], limit: "5 per hour per address and event" },
  "GET /events/:id/reminders/recipients": { roles: ["owner", "editor", "viewer"], limit: "none (signed in); viewers get counts only" },
  "GET /public/unsubscribe/:token": { public: true, limit: "60 per hour per address" },
  "POST /public/unsubscribe/:token": { public: true, limit: "20 per hour per address" },
};

// ---------- pure helpers ----------
export const dayOf = (d = new Date()) => d.toISOString().slice(0, 10);

/** a***@gmail.com: first character, three stars, the domain. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "***";
  return `${email[0]}***${email.slice(at)}`;
}

export const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The only link in an email is ours (the unsubscribe link in the footer). Plain text and simple HTML, no tracking pixels. */
export function buildReminderMail(subject: string, body: string, eventName: string, unsubLink: string): { subject: string; text: string; html: string } {
  const cleanSubject = subject.replace(/[\r\n]+/g, " ").trim();
  const footerText = `You get this email because you chose email updates about ${eventName}.\nUnsubscribe from this event: ${unsubLink}`;
  const text = `${body.trim()}\n\n--\n${footerText}\n`;
  const paras = body.trim().split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${escapeHtml(p).replace(/\n/g, "<br>")}</p>`).join("");
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#111">${paras}<hr style="border:0;border-top:1px solid #ddd;margin:20px 0"><p style="font-size:13px;color:#555;margin:0">You get this email because you chose email updates about ${escapeHtml(eventName)}. <a href="${escapeHtml(unsubLink)}">Unsubscribe from this event</a></p></div>`;
  return { subject: cleanSubject, text, html };
}

/** The unsubscribe token for a recipient, keyed with HASH_KEY (S10), so rotating JWT_SECRET never touches it. */
const tokenFor = (env: Env, recipientId: string): Promise<string> => deriveToken(hashKey(env), "unsub1", recipientId);

/**
 * The token to put in a link for a recipient. Only its hash is stored, so the link must reproduce the stored hash:
 * try the current key, then the pre-S10 key (JWT_SECRET), so mails sent before the split and after a rotation still match.
 * Only when neither matches (a key changed with no fallback) is the stored hash replaced, so the recipient still gets a working link.
 */
async function linkTokenFor(env: Env, recipientId: string, storedHash: string): Promise<string> {
  const current = await tokenFor(env, recipientId);
  if ((await sha256(current)) === storedHash) return current;
  const legacy = await deriveToken(env.JWT_SECRET, "unsub1", recipientId);
  if ((await sha256(legacy)) === storedHash) return legacy;
  await env.DB.prepare("UPDATE reminder_recipients SET token_hash = ? WHERE id = ?").bind(await sha256(current), recipientId).run();
  return current;
}

const audienceKinds = (a: Audience): [string, string] => (a === "organiser" ? ["organiser", "organiser"] : a === "captain" ? ["captain", "captain"] : ["organiser", "captain"]);

// ---------- recipients ----------
/** Brings reminder_recipients in line with who is currently an organiser (owner, editors) and which captains agreed. Unsubscribes are kept. */
export async function syncRecipients(env: Env, eventId: string): Promise<void> {
  const db = env.DB;
  const org = await db.prepare("SELECT u.email AS email FROM events e JOIN users u ON u.id = e.owner_id WHERE e.id = ?1 UNION SELECT u.email FROM event_members m JOIN users u ON u.id = m.user_id WHERE m.event_id = ?1 AND m.role = 'editor'").bind(eventId).all<{ email: string }>();
  const caps = await db.prepare("SELECT captain_email AS email, MIN(email_consent_at) AS at FROM registrations WHERE event_id = ? AND status != 'rejected' AND captain_email IS NOT NULL AND captain_email != '' AND email_consent_at IS NOT NULL GROUP BY captain_email").bind(eventId).all<{ email: string; at: string }>();
  const want = new Map<string, { email: string; kind: "organiser" | "captain"; at: string }>();
  const now = nowIso();
  for (const r of org.results) want.set(`organiser|${r.email.toLowerCase()}`, { email: r.email.toLowerCase(), kind: "organiser", at: now });
  for (const r of caps.results) want.set(`captain|${r.email.toLowerCase()}`, { email: r.email.toLowerCase(), kind: "captain", at: r.at });
  const have = await db.prepare("SELECT id, email, kind FROM reminder_recipients WHERE event_id = ?").bind(eventId).all<{ id: string; email: string; kind: string }>();
  const haveKeys = new Set(have.results.map((h) => `${h.kind}|${h.email}`));
  const stmts: D1PreparedStatement[] = [];
  for (const [k, w] of want) {
    if (haveKeys.has(k)) continue;
    const id = crypto.randomUUID();
    stmts.push(db.prepare("INSERT OR IGNORE INTO reminder_recipients (id, event_id, email, kind, consent_at, unsubscribed_at, token_hash) VALUES (?, ?, ?, ?, ?, NULL, ?)").bind(id, eventId, w.email, w.kind, w.at, await sha256(await tokenFor(env, id))));
  }
  for (const h of have.results) if (!want.has(`${h.kind}|${h.email}`)) stmts.push(db.prepare("DELETE FROM reminder_recipients WHERE id = ?").bind(h.id));
  if (stmts.length) await db.batch(stmts);
}

async function countEligible(env: Env, eventId: string, audience: Audience): Promise<number> {
  const [a, b] = audienceKinds(audience);
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM reminder_recipients WHERE event_id = ?1 AND unsubscribed_at IS NULL AND consent_at IS NOT NULL AND (kind = ?2 OR kind = ?3)").bind(eventId, a, b).first<{ n: number }>();
  return r?.n ?? 0;
}

// ---------- budget ----------
async function sentToday(env: Env, day: string): Promise<number> {
  return (await env.DB.prepare("SELECT sent FROM mail_budget WHERE day = ?").bind(day).first<{ sent: number }>())?.sent ?? 0;
}
async function eventSentToday(env: Env, eventId: string, day: string): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM reminder_deliveries WHERE event_id = ? AND day = ? AND status IN ('sending', 'sent')").bind(eventId, day).first<{ n: number }>())?.n ?? 0;
}
/** Atomically takes one email from today's pool (reminders may use all but the 10 kept for auth mail). False when the day is used up. */
export async function reserveBudget(env: Env, day: string): Promise<boolean> {
  return reserveMail(env, day, "reminder");
}
const refundBudget = refundMail;

async function limits(env: Env, eventId: string) {
  const day = dayOf();
  const [s, e] = await Promise.all([sentToday(env, day), eventSentToday(env, eventId, day)]);
  return { dayLimit: REMINDER_DAY_LIMIT, eventDayLimit: EVENT_DAY_LIMIT, sentToday: s, eventSentToday: e, remainingToday: Math.max(0, Math.min(REMINDER_DAY_LIMIT - s, EVENT_DAY_LIMIT - e)) };
}

// ---------- sending ----------
interface JobRow { id: string; event_id: string; kind: string; subject: string; body: string; audience: Audience; send_at: string; status: string; recipients_snapshot_count: number; note: string; created_by: string; created_at: string; sent_at: string | null; sent_count?: number }

async function deliverBatch(env: Env, job: JobRow, eventName: string, max: number): Promise<{ attempted: number; paused: "" | "day" | "event" }> {
  const db = env.DB;
  const [a, b] = audienceKinds(job.audience);
  const rows = await db.prepare("SELECT r.id AS id, r.email AS email, r.token_hash AS token_hash FROM reminder_recipients r WHERE r.event_id = ?1 AND r.unsubscribed_at IS NULL AND r.consent_at IS NOT NULL AND (r.kind = ?2 OR r.kind = ?3) AND NOT EXISTS (SELECT 1 FROM reminder_deliveries d WHERE d.job_id = ?4 AND d.recipient_id = r.id) ORDER BY r.id LIMIT ?5")
    .bind(job.event_id, a, b, job.id, max).all<{ id: string; email: string; token_hash: string }>();
  let attempted = 0;
  const day = dayOf();
  let usedByEvent = await eventSentToday(env, job.event_id, day);
  for (const r of rows.results) {
    if (usedByEvent >= EVENT_DAY_LIMIT) return { attempted, paused: "event" };
    if (!(await reserveBudget(env, day))) return { attempted, paused: "day" };
    // The primary key (job, recipient) guards against sending twice: only the caller whose insert lands may send.
    const claim = await db.prepare("INSERT OR IGNORE INTO reminder_deliveries (job_id, recipient_id, event_id, day, status) VALUES (?, ?, ?, ?, 'sending')").bind(job.id, r.id, job.event_id, day).run();
    if (claim.meta.changes !== 1) { await refundBudget(env, day); continue; }
    usedByEvent++; attempted++;
    const link = unsubscribeLink(env, await linkTokenFor(env, r.id, r.token_hash));
    const msg: MailWithHeaders = { to: r.email, ...buildReminderMail(job.subject, job.body, eventName, link), headers: { "List-Unsubscribe": `<${link}>` } };
    try {
      if (!(await sendMailWithHeaders(env, msg))) throw new Error("no mailer");
      await db.prepare("UPDATE reminder_deliveries SET status = 'sent' WHERE job_id = ? AND recipient_id = ?").bind(job.id, r.id).run();
    } catch {
      console.warn("reminder email not delivered"); // deliberately no address or body
      await db.prepare("UPDATE reminder_deliveries SET status = 'failed' WHERE job_id = ? AND recipient_id = ?").bind(job.id, r.id).run();
      await refundBudget(env, day);
    }
  }
  return { attempted, paused: "" };
}

/**
 * Sends due jobs in small batches (at most `batch` emails per call). Safe to run twice at once: a job is claimed by an atomic status flip
 * and every email by its (job, recipient) row. Returns what it did, never any addresses.
 */
export async function processDueJobs(env: Env, opt: { batch?: number; now?: Date; eventId?: string } = {}): Promise<{ attempted: number; finished: number; skipped?: "no_mailer" }> {
  if (!mailerConfigured(env)) return { attempted: 0, finished: 0, skipped: "no_mailer" };
  const db = env.DB;
  const now = opt.now ?? new Date();
  let left = opt.batch ?? BATCH;
  let attempted = 0, finished = 0;
  const due = await db.prepare("SELECT j.*, e.name AS event_name FROM reminder_jobs j JOIN events e ON e.id = j.event_id WHERE j.status IN ('pending', 'sending') AND j.send_at <= ?1 AND (?2 IS NULL OR j.event_id = ?2) ORDER BY j.send_at LIMIT 10")
    .bind(now.toISOString(), opt.eventId ?? null).all<JobRow & { event_name: string }>();
  for (const job of due.results) {
    if (left <= 0) break;
    if (job.status === "pending") {
      const flip = await db.prepare("UPDATE reminder_jobs SET status = 'sending' WHERE id = ? AND status = 'pending'").bind(job.id).run();
      if (flip.meta.changes !== 1) continue; // someone else took it
    }
    await syncRecipients(env, job.event_id);
    const res = await deliverBatch(env, job, job.event_name, left);
    left -= res.attempted; attempted += res.attempted;
    if (res.paused) {
      const stale = now.getTime() - Date.parse(job.send_at) > STALE_HOURS * 3600_000;
      const why = res.paused === "event" ? "The daily email limit for this event was reached." : "The daily email limit was reached.";
      if (stale) { await db.prepare("UPDATE reminder_jobs SET status = 'failed', note = ? WHERE id = ? AND status = 'sending'").bind(`${why} It could not finish within two days, so it was stopped.`, job.id).run(); finished++; }
      else await db.prepare("UPDATE reminder_jobs SET note = ? WHERE id = ? AND status = 'sending'").bind(`${why} The rest goes out after midnight UTC.`, job.id).run();
      continue;
    }
    const [a, b] = audienceKinds(job.audience);
    const more = await db.prepare("SELECT COUNT(*) AS n FROM reminder_recipients r WHERE r.event_id = ?1 AND r.unsubscribed_at IS NULL AND r.consent_at IS NOT NULL AND (r.kind = ?2 OR r.kind = ?3) AND NOT EXISTS (SELECT 1 FROM reminder_deliveries d WHERE d.job_id = ?4 AND d.recipient_id = r.id)").bind(job.event_id, a, b, job.id).first<{ n: number }>();
    if ((more?.n ?? 0) > 0) continue; // the next run continues
    const t = await db.prepare("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END), 0) AS ok FROM reminder_deliveries WHERE job_id = ?").bind(job.id).first<{ total: number; ok: number }>();
    const total = t?.total ?? 0, ok = t?.ok ?? 0;
    const status = total > 0 && ok === 0 ? "failed" : "sent";
    const note = total === 0 ? "Nobody was left to send to." : `Sent to ${ok} ${ok === 1 ? "person" : "people"}${ok < total ? `, ${total - ok} could not be delivered` : ""}.`;
    const done = await db.prepare("UPDATE reminder_jobs SET status = ?, sent_at = ?, note = ? WHERE id = ? AND status = 'sending'").bind(status, nowIso(), note, job.id).run();
    if (done.meta.changes === 1) finished++;
  }
  return { attempted, finished };
}

// ---------- organiser routes ----------
const jobOut = (j: JobRow) => ({ id: j.id, kind: j.kind, subject: j.subject, body: j.body, audience: j.audience, sendAt: j.send_at, status: j.status, recipientsSnapshotCount: j.recipients_snapshot_count, sentCount: j.sent_count ?? 0, note: j.note, createdAt: j.created_at, sentAt: j.sent_at });

routes.get("/events/:id/reminders", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  if (ev.my_role === "viewer") throw new HttpError(403, "Only the owner or an editor can see reminders");
  const rows = await c.env.DB.prepare("SELECT j.*, (SELECT COUNT(*) FROM reminder_deliveries d WHERE d.job_id = j.id AND d.status = 'sent') AS sent_count FROM reminder_jobs j WHERE j.event_id = ? ORDER BY j.send_at DESC LIMIT 100").bind(ev.id).all<JobRow>();
  c.header("cache-control", "no-store");
  return c.json({ jobs: rows.results.map(jobOut), limits: await limits(c.env, ev.id), mailer: mailerConfigured(c.env) });
});

routes.post("/events/:id/reminders", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimit(c, "reminder-create", 30, 3600, ev.id);
  const b = await readJson(c);
  if (typeof b.kind !== "string" || !(KINDS as readonly string[]).includes(b.kind)) throw new HttpError(400, "kind must be tomorrow, closing, results or custom");
  const subject = str(b.subject, "subject", 3, 120);
  if (/[\r\n]/.test(subject)) throw new HttpError(400, "subject must be a single line");
  const body = str(b.body, "body", 5, 2000);
  if (LINK_RE.test(subject) || LINK_RE.test(body)) throw new HttpError(400, "Links are not allowed in reminders; every email already has an unsubscribe link");
  const audience = optStr(b.audience, "audience", 10, "both") as Audience;
  if (!(AUDIENCES as readonly string[]).includes(audience)) throw new HttpError(400, "audience must be organiser, captain or both");
  let sendAt = new Date();
  if (b.sendAt !== undefined && b.sendAt !== null) {
    if (typeof b.sendAt !== "string" || Number.isNaN(Date.parse(b.sendAt))) throw new HttpError(400, "sendAt must be a date and time, or empty for now");
    sendAt = new Date(b.sendAt);
    if (sendAt.getTime() < Date.now() - 5 * 60_000) throw new HttpError(400, "Pick a time in the future, or leave it empty to send now");
    if (sendAt.getTime() > Date.now() + MAX_AHEAD_DAYS * 86_400_000) throw new HttpError(400, `Pick a time within ${MAX_AHEAD_DAYS} days`);
  }
  const open = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM reminder_jobs WHERE event_id = ? AND status IN ('pending', 'sending')").bind(ev.id).first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_JOBS) throw new HttpError(409, `You already have ${MAX_OPEN_JOBS} reminders waiting. Cancel one or wait for them to go out`);
  await syncRecipients(c.env, ev.id);
  const count = await countEligible(c.env, ev.id, audience);
  if (count === 0) throw new HttpError(400, "Nobody would get this yet. Captains are emailed only if they gave an address and agreed when they registered");
  if (count > EVENT_DAY_LIMIT) throw new HttpError(400, `This would reach ${count} people but one event can send at most ${EVENT_DAY_LIMIT} emails a day on the free plan. Choose fewer people`);
  const id = crypto.randomUUID();
  await c.env.DB.prepare("INSERT INTO reminder_jobs (id, event_id, kind, subject, body, audience, send_at, status, recipients_snapshot_count, note, created_by, created_at, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, '', ?, ?, NULL)")
    .bind(id, ev.id, b.kind, subject, body, audience, sendAt.toISOString(), count, c.get("userId"), nowIso()).run();
  const row = await c.env.DB.prepare("SELECT *, 0 AS sent_count FROM reminder_jobs WHERE id = ?").bind(id).first<JobRow>();
  return c.json(jobOut(row!), 201);
});

routes.post("/events/:id/reminders/test", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimit(c, "reminder-test", 5, 3600, `${ev.id}|${c.get("userId")}`);
  if (!mailerConfigured(c.env)) throw new HttpError(409, "Email sending is not set up on this server yet");
  const b: Record<string, unknown> = c.req.header("content-length") && c.req.header("content-length") !== "0" ? await readJson(c) : {};
  const u = await c.env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(c.get("userId")).first<{ email: string }>();
  if (!u) throw new HttpError(404, "Not found");
  await syncRecipients(c.env, ev.id);
  const rec = await c.env.DB.prepare("SELECT id, token_hash FROM reminder_recipients WHERE event_id = ? AND email = ? AND kind = 'organiser'").bind(ev.id, u.email.toLowerCase()).first<{ id: string; token_hash: string }>();
  if (!rec) throw new HttpError(404, "Not found");
  const day = dayOf();
  if (!(await reserveBudget(c.env, day))) throw new HttpError(409, `The daily limit of ${REMINDER_DAY_LIMIT} reminder emails has been reached. Try again after midnight UTC`);
  const subject = typeof b.subject === "string" && b.subject.trim() ? b.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 120) : `Reminder for ${ev.name}`;
  const body = typeof b.body === "string" && b.body.trim() && !LINK_RE.test(b.body) ? b.body.slice(0, 2000) : "This is a test of the email reminders for your event. Nothing was sent to anyone else.";
  const link = unsubscribeLink(c.env, await linkTokenFor(c.env, rec.id, rec.token_hash));
  const mail = buildReminderMail(`[Test] ${subject}`, body, ev.name, link);
  try {
    await sendMailWithHeaders(c.env, { to: u.email, ...mail, headers: { "List-Unsubscribe": `<${link}>` } });
  } catch {
    await refundBudget(c.env, day);
    throw new HttpError(409, "The email service did not accept the test. Try again in a few minutes");
  }
  return c.json({ ok: true, sentTo: maskEmail(u.email) });
});

routes.delete("/events/:id/reminders/:rid", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const r = await c.env.DB.prepare("UPDATE reminder_jobs SET status = 'cancelled', note = 'Cancelled before it was sent.' WHERE id = ? AND event_id = ? AND status = 'pending'").bind(c.req.param("rid"), ev.id).run();
  if (r.meta.changes === 1) return c.json({ ok: true });
  const cur = await c.env.DB.prepare("SELECT status FROM reminder_jobs WHERE id = ? AND event_id = ?").bind(c.req.param("rid"), ev.id).first<{ status: string }>();
  if (!cur) throw new HttpError(404, "Reminder not found");
  if (cur.status === "cancelled") return c.json({ ok: true }); // idempotent
  throw new HttpError(409, "That reminder has already started going out, so it cannot be cancelled");
});

routes.get("/events/:id/reminders/recipients", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await syncRecipients(c.env, ev.id);
  const rows = await c.env.DB.prepare("SELECT email, kind, unsubscribed_at FROM reminder_recipients WHERE event_id = ? ORDER BY kind, email LIMIT 500").bind(ev.id).all<{ email: string; kind: "organiser" | "captain"; unsubscribed_at: string | null }>();
  const of = (k: string) => rows.results.filter((r) => r.kind === k);
  const group = (k: string) => ({ count: of(k).filter((r) => !r.unsubscribed_at).length, unsubscribed: of(k).filter((r) => r.unsubscribed_at).length });
  const out: Record<string, unknown> = { organisers: group("organiser"), captains: group("captain"), limits: await limits(c.env, ev.id) };
  if (ev.my_role !== "viewer") out.items = rows.results.map((r) => ({ kind: r.kind, email: maskEmail(r.email), unsubscribed: !!r.unsubscribed_at }));
  c.header("cache-control", "no-store");
  return c.json(out);
});

// ---------- public unsubscribe ----------
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
async function recipientByToken(env: Env, token: string) {
  if (!TOKEN_RE.test(token)) throw new HttpError(404, "Not found");
  const row = await env.DB.prepare("SELECT r.id AS id, r.email AS email, r.unsubscribed_at AS unsubscribed_at, e.name AS event_name FROM reminder_recipients r JOIN events e ON e.id = r.event_id WHERE r.token_hash = ?").bind(await sha256(token)).first<{ id: string; email: string; unsubscribed_at: string | null; event_name: string }>();
  if (!row) throw new HttpError(404, "Not found");
  return row;
}

routes.get("/public/unsubscribe/:token", async (c) => {
  await rateLimit(c, "unsub-get", 60, 3600);
  const r = await recipientByToken(c.env, c.req.param("token"));
  c.header("cache-control", "no-store");
  // A GET never changes anything (mail scanners open links); the page asks for one tap.
  return c.json({ event: r.event_name, email: maskEmail(r.email), unsubscribed: !!r.unsubscribed_at });
});

routes.post("/public/unsubscribe/:token", async (c) => {
  await rateLimit(c, "unsub-post", 20, 3600);
  const r = await recipientByToken(c.env, c.req.param("token"));
  await c.env.DB.prepare("UPDATE reminder_recipients SET unsubscribed_at = ? WHERE id = ? AND unsubscribed_at IS NULL").bind(nowIso(), r.id).run();
  c.header("cache-control", "no-store");
  return c.json({ ok: true, event: r.event_name, email: maskEmail(r.email), unsubscribed: true });
});
