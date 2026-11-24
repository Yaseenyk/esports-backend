/**
 * Saving results read from a screenshot (flag v3.screenshots). The screenshot is read IN THE BROWSER (Tesseract.js); the image never reaches this API.
 * This only receives rows the organiser has checked one by one: every row must carry `confirmed: true`, or nothing is saved (400 unconfirmed_rows).
 * A match number that already has rows is refused (409 match_has_results) unless `replace: true`, which replaces that match only. No SQL here.
 */
import { HttpError, nowIso } from "../../http";
import { bad } from "../lib/validate";
import { loadEventAccess } from "../repositories/event-access-repo";
import * as repo from "../repositories/screenshot-repo";

const MAX_ROWS = 100;
const MAX_BR_ROWS = 4000;

async function access(db: D1Database, userId: string, eventId: string, write: boolean) {
  const a = await loadEventAccess(db, userId, eventId);
  if (!a) throw new HttpError(404, "Event not found");
  if (write && !a.canWrite) throw new HttpError(403, "You can view this event but not change it");
  return a;
}

/** What the review screen needs: the event's confirmed team names (to match what was read) and the match numbers already saved. */
export async function screenshotContext(db: D1Database, userId: string, eventId: string) {
  const a = await access(db, userId, eventId, false);
  const [teams, matchNumbers] = await Promise.all([repo.confirmedTeamNames(db, eventId), repo.brMatchNumbers(db, eventId)]);
  return { event: { id: a.eventId, name: a.name }, canEdit: a.canWrite, teams, matchNumbers, nextMatchNo: (matchNumbers[matchNumbers.length - 1] ?? 0) + 1 };
}

function int(v: unknown, field: string, code: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(`${field} must be a whole number from ${min} to ${max}`, code);
  return v;
}
const CONTROL = /[<>\u0000-\u001f\u007f]/;

export async function saveScreenshotResults(db: D1Database, userId: string, eventId: string, b: Record<string, unknown>) {
  await access(db, userId, eventId, true);
  const matchNo = int(b.matchNo, "matchNo", "invalid_matchNo", 1, 9999);
  if (b.replace !== undefined && typeof b.replace !== "boolean") throw bad("replace must be true or false", "invalid_replace");
  const replace = b.replace === true;
  if (!Array.isArray(b.rows) || b.rows.length < 1 || b.rows.length > MAX_ROWS) throw bad(`rows must be a list of 1-${MAX_ROWS} rows`, "invalid_rows");
  // Every single row must have been confirmed by the person. Checked before anything else about the rows, so an unchecked review never saves.
  const list = b.rows as unknown[];
  if (list.some((r) => !r || typeof r !== "object" || (r as Record<string, unknown>).confirmed !== true)) throw bad("Every row must be checked and confirmed before saving", "unconfirmed_rows");
  const seenTeam = new Set<string>();
  const seenPlace = new Set<number>();
  const rows = (list as Record<string, unknown>[]).map((r, i) => {
    const team = typeof r.team === "string" ? r.team.replace(/\s+/g, " ").trim() : "";
    if (team.length < 1 || team.length > 60 || CONTROL.test(team)) throw bad(`rows[${i}].team must be 1-60 characters of plain text`, "invalid_team");
    const placement = int(r.placement, `rows[${i}].placement`, "invalid_placement", 1, 200);
    const kills = int(r.kills, `rows[${i}].kills`, "invalid_kills", 0, 999);
    if (seenTeam.has(team.toLowerCase())) throw bad(`${team} appears twice`, "duplicate_team");
    if (seenPlace.has(placement)) throw bad(`Placement ${placement} appears twice`, "duplicate_placement");
    seenTeam.add(team.toLowerCase());
    seenPlace.add(placement);
    return { team, placement, kills };
  });
  const existing = await repo.brMatchNumbers(db, eventId);
  if (existing.includes(matchNo) && !replace) throw new HttpError(409, `Match ${matchNo} already has results`, { code: "match_has_results" });
  if ((await repo.brRowCount(db, eventId)) + rows.length > MAX_BR_ROWS) throw new HttpError(409, `An event can have at most ${MAX_BR_ROWS} battle royale rows`, { code: "too_many_rows" });
  await repo.writeBrMatch(db, eventId, matchNo, rows, replace, nowIso());
  return { matchNo, saved: rows.length };
}
