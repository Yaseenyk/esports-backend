/**
 * Personal match journal (flag v3.journal). Owner only: every read and write is scoped to the signed-in account, and an entry of another account,
 * a malformed id and an unknown id all give the same plain 404. Entries are SELF-LOGGED: they never reach a public page, the verified stats or a badge.
 * Rules here, SQL in repositories/journal-repo.ts, payloads in adapters/journal-adapter.ts.
 */
import { HttpError } from "../../http";
import { ID32_RE, newId, nowSec } from "../lib/ids";
import { checkJournalEntry, JOURNAL, type JournalInput } from "../lib/journal";
import * as repo from "../repositories/journal-repo";
import * as users from "../repositories/user-repo";
import { toJournalEntry } from "../adapters/journal-adapter";

type Body = Record<string, unknown>;
const notFound = (): HttpError => new HttpError(404, "Not found");

async function me(db: D1Database, userId: string, write: boolean) {
  const u = await users.getUserV3(db, userId);
  if (!u) throw new HttpError(401, "Authentication required");
  if (write && u.adultConfirmedAt === null) throw new HttpError(403, "Confirm that you are 18 or older to use the match journal", { code: "adult_required" });
  return u;
}

const inputOf = (r: repo.JournalRow): JournalInput => ({ playedOn: r.played_on, game: r.game as JournalInput["game"], mode: r.mode, map: r.map, placement: r.placement, kills: r.kills, damage: r.damage, notes: r.notes });

/** GET /v3/me/journal: every entry of the owner (newest day first), how many there are and the cap. */
export async function myJournal(db: D1Database, userId: string) {
  await me(db, userId, false);
  const rows = await repo.listEntries(db, userId, JOURNAL.MAX_ENTRIES);
  return { items: rows.map(toJournalEntry), count: rows.length, cap: JOURNAL.MAX_ENTRIES, selfLogged: true as const };
}

/** POST /v3/me/journal: one new entry. 409 journal_full at the cap. */
export async function addEntry(db: D1Database, userId: string, b: Body) {
  await me(db, userId, true);
  const e = checkJournalEntry(b, Date.now());
  const id = newId();
  if (!(await repo.insertEntry(db, id, userId, e, nowSec(), JOURNAL.MAX_ENTRIES))) {
    throw new HttpError(409, `Your journal is full (${JOURNAL.MAX_ENTRIES} matches). Export it, then delete old matches to add more.`, { code: "journal_full" });
  }
  return { item: toJournalEntry((await repo.getEntry(db, userId, id))!) };
}

async function own(db: D1Database, userId: string, id: string): Promise<repo.JournalRow> {
  const r = ID32_RE.test(id) ? await repo.getEntry(db, userId, id) : null;
  if (!r) throw notFound();
  return r;
}

/** PUT /v3/me/journal/:id: change the fields sent (null clears an optional one). */
export async function editEntry(db: D1Database, userId: string, id: string, b: Body) {
  await me(db, userId, true);
  const prev = await own(db, userId, id);
  const e = checkJournalEntry(b, Date.now(), inputOf(prev));
  if (!(await repo.updateEntry(db, userId, id, e, nowSec()))) throw notFound();
  return { item: toJournalEntry((await repo.getEntry(db, userId, id))!) };
}

/** DELETE /v3/me/journal/:id */
export async function removeEntry(db: D1Database, userId: string, id: string) {
  await me(db, userId, false);
  if (!ID32_RE.test(id) || !(await repo.deleteEntry(db, userId, id))) throw notFound();
  return { ok: true };
}

/** POST /v3/me/journal/clear {confirm: true}: deletes every entry of the owner. Allowed without the 18+ check (deleting is always allowed). */
export async function clearJournal(db: D1Database, userId: string, b: Body) {
  await me(db, userId, false);
  if (b.confirm !== true) throw new HttpError(400, "Send confirm: true to delete every match in your journal", { code: "confirm_required" });
  return { ok: true, deleted: await repo.deleteAllEntries(db, userId) };
}
