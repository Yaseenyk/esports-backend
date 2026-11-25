/**
 * Tournament alerts (flag v3.alerts). A signed-in adult saves up to 5 rules, confirms the account email by a double opt-in link, and then gets at most ONE
 * email a day listing new matching tournaments (published or opened for registration) and college calendar events. Every email has a one-click
 * unsubscribe link that needs no sign-in. Sending stops at the alerts' own daily cap (ALERTS.DAY_CAP) AND the shared daily mail pool, and honours kill.mail,
 * so it can never run past the free email plan. Nobody who has not confirmed is ever emailed. Rules here, SQL in the repository.
 */
import { HttpError } from "../../http";
import { deriveToken, hashKey, randomToken, sha256 } from "../../crypto";
import { DEFAULT_APP_URL, mailerConfigured, refundMail, reserveMail, sendMailWithHeaders } from "../../mailer";
import type { Env } from "../../types";
import { ALERTS, buildConfirmMail, buildDigestMail, checkRules, inDigestWindow, istDay, maskEmail, type AlertItem } from "../lib/alerts";
import { newId, nowSec, toIso } from "../lib/ids";
import { bad } from "../lib/validate";
import * as repo from "../repositories/alert-repo";
import { alertFlags, mailKilled } from "../repositories/flag-repo";
import * as users from "../repositories/user-repo";

type Body = Record<string, unknown>;
const notFound = (): HttpError => new HttpError(404, "Not found");
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const DEFAULT_API_URL = "https://esports-api.yaseenyk.workers.dev";
const dayOf = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10);
const appBase = (env: Pick<Env, "APP_URL">): string => (env.APP_URL || DEFAULT_APP_URL).replace(/\/+$/, "");

async function requireAdult(db: D1Database, userId: string): Promise<void> {
  const u = await users.getUserV3(db, userId);
  if (!u) throw new HttpError(401, "Authentication required");
  if (u.adultConfirmedAt === null) throw new HttpError(403, "Confirm that you are 18 or older to use tournament alerts", { code: "adult_required" });
}

/** The unsubscribe token of an account: derived (HMAC) from HASH_KEY and the account, so every email can carry it while only its hash is stored. */
const unsubTokenFor = (env: Env, userId: string, createdAt: number): Promise<string> => deriveToken(hashKey(env), "alertUnsub1", `${userId}:${createdAt}`);

export async function myAlerts(env: Env, userId: string) {
  const [sub, rules, email] = await Promise.all([repo.findSub(env.DB, userId), repo.listRules(env.DB, userId), repo.accountEmail(env.DB, userId)]);
  const now = nowSec();
  const status = !sub ? "off" : sub.status === "pending" ? ((sub.confirm_expires_at ?? 0) > now ? "pending" : "expired") : sub.status === "active" ? "active" : "stopped";
  return {
    status,
    email: email ? maskEmail(email) : null,
    confirmedAt: toIso(sub?.confirmed_at ?? null),
    rules: rules.map((r) => ({ game: r.game, place: r.place, kind: r.kind })),
    limits: { maxRules: ALERTS.MAX_RULES, emailsPerDay: 1 },
    mailer: mailerConfigured(env),
  };
}

export async function saveRules(env: Env, userId: string, b: Body) {
  await requireAdult(env.DB, userId);
  const r = checkRules(b.rules);
  if (!r.ok) {
    const msg = { invalid_rules: "rules must be a list", too_many_rules: `You can save at most ${ALERTS.MAX_RULES} alerts`, invalid_game: "Pick a game from the list", invalid_place: "Place must be Any, Online or a city name", invalid_kind: "Pick a type from the list" }[r.code];
    throw bad(msg, r.code);
  }
  await repo.replaceRules(env.DB, userId, r.rules.map((x) => ({ id: newId(), ...x })), nowSec());
  return myAlerts(env, userId);
}

/** Sends the double opt-in email to the ACCOUNT's address (never an address typed in the request). */
export async function requestConfirm(env: Env, userId: string) {
  await requireAdult(env.DB, userId);
  if (await mailKilled(env.DB)) throw new HttpError(503, "Email is paused right now. Try again later", { code: "temporarily_disabled" });
  if (!mailerConfigured(env)) throw new HttpError(409, "Email sending is not set up on this server yet", { code: "mailer_not_configured" });
  if ((await repo.listRules(env.DB, userId)).length === 0) throw bad("Save at least one alert first", "no_rules");
  const email = await repo.accountEmail(env.DB, userId);
  if (!email) throw new HttpError(401, "Authentication required");
  const now = nowSec();
  const existing = await repo.findSub(env.DB, userId);
  if (existing?.status === "active") return myAlerts(env, userId); // already confirmed: no email
  const createdAt = existing?.created_at ?? now;
  const token = randomToken(24);
  const hash = await sha256(token);
  await repo.setPending(env.DB, userId, hash, now + ALERTS.CONFIRM_TTL_SEC, await sha256(await unsubTokenFor(env, userId, createdAt)), now);
  const day = dayOf(now);
  if (!(await repo.reserveAlertMail(env.DB, day, ALERTS.DAY_CAP))) {
    await repo.clearConfirm(env.DB, userId, hash);
    throw new HttpError(429, "Alert emails are paused for today. Try again after midnight UTC", { code: "mail_budget_exhausted" });
  }
  if (!(await reserveMail(env, day, "reminder"))) {
    await repo.refundAlertMail(env.DB, day);
    await repo.clearConfirm(env.DB, userId, hash);
    throw new HttpError(429, "Email sending is paused for today. Try again after midnight UTC", { code: "mail_budget_exhausted" });
  }
  try {
    const mail = buildConfirmMail(`${appBase(env)}/alerts/confirm/#t=${token}`);
    if (!(await sendMailWithHeaders(env, { to: email, ...mail }))) throw new Error("no mailer");
  } catch {
    console.warn("alert confirm email not delivered"); // no address, no body
    await repo.refundAlertMail(env.DB, day);
    await refundMail(env, day);
    await repo.clearConfirm(env.DB, userId, hash);
    throw new HttpError(502, "The confirmation email could not be sent. Try again in a few minutes", { code: "mail_failed" });
  }
  return myAlerts(env, userId);
}

export async function stopMine(env: Env, userId: string) {
  await repo.stopForUser(env.DB, userId, nowSec());
  return myAlerts(env, userId);
}

export async function deleteMine(env: Env, userId: string) {
  await repo.deleteAll(env.DB, userId);
  return { ok: true, deleted: true };
}

/** The double opt-in click (no sign-in). A wrong, used or expired token is the same 404. */
export async function confirmByToken(env: Env, b: Body) {
  if (typeof b.token !== "string" || !TOKEN_RE.test(b.token)) throw notFound();
  const uid = await repo.confirmByHash(env.DB, await sha256(b.token), nowSec());
  if (!uid) throw notFound();
  return { ok: true, status: "active" };
}

/** The one-click unsubscribe (no sign-in). A second click on the same link still answers ok. An unknown token is a 404. */
export async function unsubscribeByToken(env: Env, token: unknown) {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) throw notFound();
  if (!(await repo.stopByUnsubHash(env.DB, await sha256(token), nowSec()))) throw notFound();
  return { ok: true, status: "stopped" };
}

// ---------------- the daily digest (cron) ----------------
export interface DigestResult { ran: boolean; reason?: string; checked: number; sent: number; capped: boolean }

function toItems(env: Env, t: repo.TournamentMatch[], c: repo.CalendarMatch[]): AlertItem[] {
  const base = appBase(env);
  const items: AlertItem[] = [
    ...t.map((x) => ({ key: `t:${x.id}`, kind: "tournament" as const, title: x.title, game: x.game, where: x.venue === "online" ? "Online" : x.city ? `${x.city}${x.venue === "hybrid" ? " and online" : ""}` : "Venue on the page", when: istDay(x.starts_at), link: `${base}/tournaments/?game=${encodeURIComponent(x.game)}`, status: x.status })),
    ...c.map((x) => ({ key: `c:${x.id}`, kind: "college" as const, title: x.title, game: x.game, where: x.online === 1 ? `${x.city} and online` : x.city, when: istDay(Date.parse(`${x.starts_on}T06:30:00Z`) / 1000), link: `${base}/calendar/`, status: "listed" })),
  ];
  return items.slice(0, ALERTS.MAX_ITEMS_PER_EMAIL);
}

/**
 * One cron tick of the digest. Runs only with v3.alerts on, kill.mail off, a mailer, the tables, and inside the daily window (unless `force` for tests).
 * Spends at most ALERTS.TICK_QUERY_BUDGET statements; the next tick continues. Each account is claimed for the day BEFORE anything is sent, so it gets
 * at most one email a day even if two ticks overlap. When either daily cap is reached it stops, logs once, and the rest wait for tomorrow.
 */
export async function runDigestTick(env: Env, opts: { nowMs?: number; force?: boolean } = {}): Promise<DigestResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const out: DigestResult = { ran: false, checked: 0, sent: 0, capped: false };
  if (!opts.force && !inDigestWindow(nowMs)) return { ...out, reason: "window" };
  const flags = await alertFlags(env.DB);
  if (!flags.alerts) return { ...out, reason: "flag" };
  if (flags.killMail) return { ...out, reason: "kill" };
  if (!mailerConfigured(env)) return { ...out, reason: "no_mailer" };
  if (!(await repo.alertTablesExist(env.DB))) return { ...out, reason: "no_tables" };
  const now = Math.floor(nowMs / 1000);
  const day = dayOf(now);
  if ((await repo.dayBudget(env.DB, day)).capped) return { ...out, reason: "capped", capped: true };
  out.ran = true;
  let budget = ALERTS.TICK_QUERY_BUDGET - 5;
  const due = await repo.listDue(env.DB, day, 6);
  const sources = { tournaments: flags.tournaments, calendar: flags.calendar };
  for (const d of due) {
    if (budget < 9) break;
    budget -= 1;
    if (!(await repo.claimDay(env.DB, d.user_id, day))) continue;
    out.checked++;
    const since = Math.max(d.confirmed_at, now - ALERTS.LOOKBACK_SEC);
    const t = sources.tournaments ? await repo.matchTournaments(env.DB, d.user_id, since, now, ALERTS.MAX_ITEMS_PER_EMAIL) : [];
    const c = sources.calendar ? await repo.matchCalendar(env.DB, d.user_id, since, day, ALERTS.MAX_ITEMS_PER_EMAIL) : [];
    budget -= 2;
    const items = toItems(env, t, c);
    if (!items.length) continue;
    budget -= 6;
    if (!(await repo.reserveAlertMail(env.DB, day, ALERTS.DAY_CAP))) {
      if (await repo.markCapped(env.DB, day, now)) console.warn("alert digest stopped: the alerts daily email cap is reached"); // once a day, no details
      out.capped = true;
      break;
    }
    if (!(await reserveMail(env, day, "reminder"))) {
      await repo.refundAlertMail(env.DB, day);
      if (await repo.markCapped(env.DB, day, now)) console.warn("alert digest stopped: the shared daily email pool is used up");
      out.capped = true;
      break;
    }
    const keys = items.map((i) => i.key);
    await repo.markSent(env.DB, d.user_id, keys, now);
    try {
      const token = await unsubTokenFor(env, d.user_id, d.created_at);
      const hash = await sha256(token);
      if (hash !== d.unsub_hash) await repo.setUnsubHash(env.DB, d.user_id, hash); // HASH_KEY changed: keep the link in this email working
      const base = appBase(env);
      const apiBase = DEFAULT_API_URL;
      const mail = buildDigestMail(items, `${base}/alerts/unsubscribe/#t=${token}`, `${base}/app/alerts/`);
      const sent = await sendMailWithHeaders(env, { to: d.email, ...mail, headers: { "List-Unsubscribe": `<${apiBase}/public/alerts/one-click/${token}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
      if (!sent) throw new Error("no mailer");
      out.sent++;
    } catch {
      console.warn("alert digest email not delivered"); // no address, no body
      await repo.unmarkSent(env.DB, d.user_id, keys);
      await repo.refundAlertMail(env.DB, day);
      await refundMail(env, day);
    }
  }
  return out;
}

/** Daily retention: forget sent items after 120 days, old budget rows, and pending sign-ups that were never confirmed. Safe before migration 0090. */
export async function purgeAlerts(db: D1Database, now = nowSec()): Promise<void> {
  if (!(await repo.alertTablesExist(db))) return;
  await repo.purgeOld(db, now - ALERTS.SENT_RETENTION_SEC, dayOf(now - 30 * 86_400));
}

