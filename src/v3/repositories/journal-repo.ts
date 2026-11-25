/**
 * v3_journal_entries (migration 0091). The only place this table is queried. Every statement is scoped to ONE owner by user_id, so a row of another
 * account can never be read, changed or deleted through it. Constant SQL, every value bound. Decides nothing about who may see a row.
 */
import type { JournalInput } from "../lib/journal";

export interface JournalRow {
  id: string; played_on: string; game: string; mode: string | null; map: string | null; placement: number | null; kills: number; damage: number | null; notes: string | null; created_at: number; updated_at: number;
}

export async function journalTableExists(db: D1Database): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'v3_journal_entries'").first()) !== null;
}

/** The owner's entries, newest day first, at most `limit`. */
export async function listEntries(db: D1Database, userId: string, limit: number): Promise<JournalRow[]> {
  return (await db.prepare("SELECT id, played_on, game, mode, map, placement, kills, damage, notes, created_at, updated_at FROM v3_journal_entries WHERE user_id = ?1 ORDER BY played_on DESC, created_at DESC, id LIMIT ?2").bind(userId, limit).all<JournalRow>()).results;
}

export async function countEntries(db: D1Database, userId: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM v3_journal_entries WHERE user_id = ?1").bind(userId).first<{ n: number }>())?.n ?? 0;
}

export async function getEntry(db: D1Database, userId: string, id: string): Promise<JournalRow | null> {
  return (await db.prepare("SELECT id, played_on, game, mode, map, placement, kills, damage, notes, created_at, updated_at FROM v3_journal_entries WHERE id = ?1 AND user_id = ?2").bind(id, userId).first<JournalRow>()) ?? null;
}

/** Inserts only while the owner has fewer than `cap` entries (one statement, so parallel requests cannot pass the cap). False = at the cap. */
export async function insertEntry(db: D1Database, id: string, userId: string, e: JournalInput, at: number, cap: number): Promise<boolean> {
  const r = await db
    .prepare(
      `INSERT INTO v3_journal_entries (id, user_id, played_on, game, mode, map, placement, kills, damage, notes, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11 WHERE (SELECT COUNT(*) FROM v3_journal_entries WHERE user_id = ?2) < ?12`,
    )
    .bind(id, userId, e.playedOn, e.game, e.mode, e.map, e.placement, e.kills, e.damage, e.notes, at, cap)
    .run();
  return (r.meta?.changes ?? 0) === 1;
}

export async function updateEntry(db: D1Database, userId: string, id: string, e: JournalInput, at: number): Promise<boolean> {
  const r = await db
    .prepare("UPDATE v3_journal_entries SET played_on = ?3, game = ?4, mode = ?5, map = ?6, placement = ?7, kills = ?8, damage = ?9, notes = ?10, updated_at = ?11 WHERE id = ?1 AND user_id = ?2")
    .bind(id, userId, e.playedOn, e.game, e.mode, e.map, e.placement, e.kills, e.damage, e.notes, at)
    .run();
  return (r.meta?.changes ?? 0) === 1;
}

export async function deleteEntry(db: D1Database, userId: string, id: string): Promise<boolean> {
  const r = await db.prepare("DELETE FROM v3_journal_entries WHERE id = ?1 AND user_id = ?2").bind(id, userId).run();
  return (r.meta?.changes ?? 0) === 1;
}

export async function deleteAllEntries(db: D1Database, userId: string): Promise<number> {
  const r = await db.prepare("DELETE FROM v3_journal_entries WHERE user_id = ?1").bind(userId).run();
  return r.meta?.changes ?? 0;
}
