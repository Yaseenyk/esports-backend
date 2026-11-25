/**
 * Squad availability planner (flag v3.planner). No accounts: a captain creates a plan and gets a share token and a captain key; teammates vote with a
 * display name and a per-browser edit key. Only SHA-256 hashes of the token and the keys are stored. Every miss (unknown, expired, malformed token,
 * wrong key) is the same plain 404, so nothing can be learned by guessing. Rules here, SQL in the repository.
 */
import { HttpError } from "../../http";
import { randomToken, sha256 } from "../../crypto";
import { GAMES } from "../lib/enums";
import { newId, nowSec } from "../lib/ids";
import { EDIT_KEY_RE, PLANNER, SERVER_TOKEN_RE, checkPicks, checkPlainLabel, checkSlots, intList, validTimeZone } from "../lib/planner";
import { bad, reqEnum } from "../lib/validate";
import * as repo from "../repositories/planner-repo";
import { toPlanView } from "../adapters/planner-adapter";

type Body = Record<string, unknown>;
const notFound = (): HttpError => new HttpError(404, "Not found");

const SLOT_MESSAGES: Record<string, string> = {
  slots_missing: "Pick at least one time slot",
  slots_too_many: `A plan can have at most ${PLANNER.MAX_SLOTS} time slots`,
  slots_not_aligned: "Every slot must start on the hour or half hour",
  slots_order: "Slots must be in time order with no repeats",
  slots_range: "Slots must be between yesterday and 60 days from now",
  slots_span: "A plan can cover at most 15 days",
};

function label(v: unknown, field: string, max: number, required: boolean): string {
  const r = checkPlainLabel(v, max, required);
  if (r.ok) return r.text;
  const msg = r.code === "empty" ? `${field} is required` : r.code === "too_long" ? `${field} must be at most ${max} characters` : `${field} must be plain text with no links, phone numbers or handles`;
  throw bad(msg, `invalid_${field}`);
}

/** The live plan for a token, or the uniform 404. A malformed token never reaches the database. */
async function livePlan(db: D1Database, token: unknown, now: number) {
  if (typeof token !== "string" || !SERVER_TOKEN_RE.test(token)) throw notFound();
  const p = await repo.findLivePlan(db, await sha256(token), now);
  if (!p) throw notFound();
  return p;
}

export async function createPlan(db: D1Database, b: Body) {
  const now = nowSec();
  const game = reqEnum(b.game, GAMES, "game");
  const title = label(b.title, "title", PLANNER.TITLE_MAX, false);
  const tz = b.tz === undefined ? "Asia/Kolkata" : b.tz;
  if (!validTimeZone(tz)) throw bad("tz must be a time zone such as Asia/Kolkata", "invalid_tz");
  const slotMinutes = b.slotMinutes === undefined ? 60 : b.slotMinutes;
  if (slotMinutes !== 30 && slotMinutes !== 60) throw bad("slotMinutes must be 30 or 60", "invalid_slotMinutes");
  const s = checkSlots(b.slots, slotMinutes, now);
  if (!s.ok) throw bad(SLOT_MESSAGES[s.code] ?? "slots are not valid", s.code);
  const token = randomToken(24);
  const captainKey = randomToken(24);
  const expiresAt = now + PLANNER.TTL_SEC;
  await repo.insertPlan(db, { id: newId(), tokenHash: await sha256(token), captainKeyHash: await sha256(captainKey), game, title, tz, slotMinutes, slots: JSON.stringify(s.slots), expiresAt, at: now });
  return { token, captainKey, expiresAt: new Date(expiresAt * 1000).toISOString() };
}

export async function openPlan(db: D1Database, b: Body) {
  const p = await livePlan(db, b.token, nowSec());
  return toPlanView(p, await repo.listVotes(db, p.id));
}

export async function vote(db: D1Database, b: Body) {
  const now = nowSec();
  const p = await livePlan(db, b.token, now);
  if (typeof b.editKey !== "string" || !EDIT_KEY_RE.test(b.editKey)) throw bad("editKey is missing or not valid", "invalid_editKey");
  const name = label(b.name, "name", PLANNER.NAME_MAX, true);
  const picks = checkPicks(b.picks, intList(p.slots).length);
  if (!picks) throw bad("picks must be a list of slot numbers from this plan", "invalid_picks");
  const r = await repo.upsertVote(db, { id: newId(), planId: p.id, editKeyHash: await sha256(b.editKey), name, picks: JSON.stringify(picks), at: now }, PLANNER.MAX_VOTERS);
  if (r === "full") throw new HttpError(409, `This plan already has ${PLANNER.MAX_VOTERS} people`, { code: "plan_full" });
  return toPlanView(p, await repo.listVotes(db, p.id));
}

export async function unvote(db: D1Database, b: Body) {
  const p = await livePlan(db, b.token, nowSec());
  if (typeof b.editKey !== "string" || !EDIT_KEY_RE.test(b.editKey)) throw notFound();
  if (!(await repo.deleteVote(db, p.id, await sha256(b.editKey)))) throw notFound();
  return toPlanView(p, await repo.listVotes(db, p.id));
}

export async function deletePlan(db: D1Database, b: Body) {
  if (typeof b.token !== "string" || !SERVER_TOKEN_RE.test(b.token) || typeof b.captainKey !== "string" || !SERVER_TOKEN_RE.test(b.captainKey)) throw notFound();
  if (!(await repo.deletePlanByKeys(db, await sha256(b.token), await sha256(b.captainKey)))) throw notFound();
  return { ok: true, deleted: true };
}

/** Retention (cron, daily): plans are deleted 30 days after they were made, whatever the flag says. Safe before migration 0090. */
export async function purgeExpiredPlans(db: D1Database, now = nowSec()): Promise<number> {
  if (!(await repo.plannerTablesExist(db))) return 0;
  return repo.deleteExpiredPlans(db, now);
}
