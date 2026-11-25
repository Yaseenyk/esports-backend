/**
 * Personal match journal rules (flag v3.journal). Pure: no I/O; throws HttpError 400 through `bad`.
 * A journal entry is what the player typed about their own match. It is PRIVATE and SELF-LOGGED: it never feeds the verified stats, a badge or a public page.
 */
import { GAMES, isOneOf, type Game } from "./enums";
import { bad, optInt, optText } from "./validate";

export const JOURNAL = {
  /** Rows per account (the insert refuses the next one). */
  MAX_ENTRIES: 2000,
  MODE_MAX: 40,
  MAP_MAX: 40,
  NOTES_MAX: 500,
  PLACEMENT_MAX: 100,
  KILLS_MAX: 200,
  DAMAGE_MAX: 100_000,
  /** The earliest day an entry may have. */
  FIRST_DAY: "2015-01-01",
} as const;

export interface JournalInput { playedOn: string; game: Game; mode: string | null; map: string | null; placement: number | null; kills: number; damage: number | null; notes: string | null }

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day "YYYY-MM-DD" (no 2026-02-30). */
export function isCalendarDay(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = DAY_RE.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v;
}

/** The latest day allowed: tomorrow in UTC (a player east of UTC may log tonight's match before UTC reaches their date). */
export const latestDay = (nowMs: number): string => new Date(nowMs + 86_400_000).toISOString().slice(0, 10);

function playedOn(v: unknown, nowMs: number): string {
  if (!isCalendarDay(v)) throw bad("playedOn must be a date like 2026-11-25", "invalid_playedOn");
  if (v < JOURNAL.FIRST_DAY || v > latestDay(nowMs)) throw bad("playedOn must be a past date (not in the future)", "invalid_playedOn");
  return v;
}

/** A whole entry (create) or an entry merged with the stored one (edit: send the fields that change; null clears an optional field). */
export function checkJournalEntry(b: Record<string, unknown>, nowMs: number, prev?: JournalInput): JournalInput {
  const pick = <K extends keyof JournalInput>(k: K, v: JournalInput[K] | undefined): JournalInput[K] => (v === undefined ? (prev ? prev[k] : (null as JournalInput[K])) : v);
  const date = b.playedOn === undefined && prev ? prev.playedOn : playedOn(b.playedOn, nowMs);
  let game: Game;
  if (b.game === undefined && prev) game = prev.game;
  else if (isOneOf(GAMES, b.game)) game = b.game;
  else throw bad(`game must be one of: ${GAMES.join(", ")}`, "invalid_game");
  const kills = b.kills === undefined && prev ? prev.kills : optInt(b.kills, "kills", 0, JOURNAL.KILLS_MAX);
  if (typeof kills !== "number") throw bad(`kills must be a whole number from 0 to ${JOURNAL.KILLS_MAX}`, "invalid_kills");
  return {
    playedOn: date,
    game,
    mode: pick("mode", optText(b.mode, "mode", JOURNAL.MODE_MAX)),
    map: pick("map", optText(b.map, "map", JOURNAL.MAP_MAX)),
    placement: pick("placement", optInt(b.placement, "placement", 1, JOURNAL.PLACEMENT_MAX)),
    kills,
    damage: pick("damage", optInt(b.damage, "damage", 0, JOURNAL.DAMAGE_MAX)),
    notes: pick("notes", optText(b.notes, "notes", JOURNAL.NOTES_MAX)),
  };
}
