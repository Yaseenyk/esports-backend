/** Flag reads for services (the flags table is legacy; this wrapper keeps services free of SQL and of the flags module). */
import { getFlag, getFlags } from "../../flags";

export const takedownEnforced = (db: D1Database): Promise<boolean> => getFlag(db, "takedown.enforce");

/** Flag v3.discord (cached read, default OFF). The Discord drain and the approval hook ask this FIRST, before any v3 table. */
export const discordEnabled = (db: D1Database): Promise<boolean> => getFlag(db, "v3.discord");

/** Flag v3.scrims (cached read). The scheduled scrim work (recurring slots, waitlist offers) runs only while it is on. */
export const scrimsEnabled = (db: D1Database): Promise<boolean> => getFlag(db, "v3.scrims");

/** The three organiser-tool flags (cached read, default OFF), for the one probe the event page makes. */
export async function organiserToolFlags(db: D1Database): Promise<{ rooms: boolean; recaps: boolean; screenshots: boolean }> {
  const f = await getFlags(db);
  return { rooms: f["v3.rooms"], recaps: f["v3.recaps"], screenshots: f["v3.screenshots"] };
}
