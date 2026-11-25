/** Flag reads for services (the flags table is legacy; this wrapper keeps services free of SQL and of the flags module). */
import { getFlag, getFlagFresh, getFlags } from "../../flags";

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

/** The flags the alerts digest needs, in one cached read: its own switch, the mail kill switch and the sources it may read. */
export async function alertFlags(db: D1Database): Promise<{ alerts: boolean; killMail: boolean; tournaments: boolean; calendar: boolean }> {
  const f = await getFlags(db);
  return { alerts: f["v3.alerts"], killMail: f["kill.mail"], tournaments: f["v3.tournaments"] || f["v3.directory"], calendar: f["v3.calendar"] };
}
/** kill.mail read fresh (one primary-key read): a paused mailer bites on the next request. */
export const mailKilled = (db: D1Database): Promise<boolean> => getFlagFresh(db, "kill.mail");
/** Flag v3.lft_match (cached read): language and play-hour filters, match sort, chosen contacts, blocks and request reports on the board. */
export const lftMatchEnabled = (db: D1Database): Promise<boolean> => getFlag(db, "v3.lft_match");
/** Flag v3.achievements (cached read): server badges on player pages and the owner's badge screen. */
export const achievementsEnabled = (db: D1Database): Promise<boolean> => getFlag(db, "v3.achievements");
