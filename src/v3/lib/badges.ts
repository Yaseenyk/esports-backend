/**
 * Server badges (flag v3.achievements): the ONE list of badges, each with the plain rule the code applies. Pure (no I/O).
 * A badge is earned only from actions the platform itself recorded: approved registrations, results an organiser entered in a public tournament,
 * scrims confirmed on the scrim finder, tournaments published here, a player card link made here. Nothing a player types (journal entries, the
 * achievements they add to their page) and nothing kept on the device (the site's local XP) ever earns one.
 * The rule text is what the site shows and what the public rules page quotes; keep it identical to the check next to it (test/v3/badges.test.ts).
 */

/** What the server knows about one account, already filtered to verified, visible rows. */
export interface BadgeFacts {
  /** Public tournaments where the account captains a team whose registration the organiser approved (entries the owner hid do not count). */
  tournaments: number;
  /** Verified results: finished head-to-head matches plus battle royale match results, corrections applied. */
  verifiedResults: number;
  /** Verified head-to-head wins plus battle royale matches placed 1st. */
  wins: number;
  /** A scrim confirmed on the scrim finder whose start time has passed (live rows or the server's record of one). */
  scrimPlayed: boolean;
  /** A tournament the account organised was published on the site. */
  eventOrganised: boolean;
  /** The account made a player card link (QR). */
  cardCreated: boolean;
}

export interface BadgeDef { id: string; title: string; rule: string; earned: (f: BadgeFacts) => boolean }

export const BADGES = [
  { id: "first_tournament", title: "First tournament", rule: "Captain a team whose registration an organiser approved in a public tournament.", earned: (f: BadgeFacts) => f.tournaments >= 1 },
  { id: "first_result", title: "First verified result", rule: "Have one verified result: a finished match or a battle royale result the organiser entered.", earned: (f: BadgeFacts) => f.verifiedResults >= 1 },
  { id: "first_win", title: "First win", rule: "Win a verified match, or place 1st in a verified battle royale match.", earned: (f: BadgeFacts) => f.wins >= 1 },
  { id: "verified_5", title: "5 verified results", rule: "Have 5 verified results.", earned: (f: BadgeFacts) => f.verifiedResults >= 5 },
  { id: "verified_10", title: "10 verified results", rule: "Have 10 verified results.", earned: (f: BadgeFacts) => f.verifiedResults >= 10 },
  { id: "verified_25", title: "25 verified results", rule: "Have 25 verified results.", earned: (f: BadgeFacts) => f.verifiedResults >= 25 },
  { id: "first_scrim", title: "First scrim", rule: "Play a scrim confirmed on the scrim finder: a confirmed seat, or your own slot with a team confirmed, once its start time has passed.", earned: (f: BadgeFacts) => f.scrimPlayed },
  { id: "first_event", title: "First event organised", rule: "Organise a tournament that is published on the site.", earned: (f: BadgeFacts) => f.eventOrganised },
  { id: "player_card", title: "Player card", rule: "Make a player card link (QR) for your profile.", earned: (f: BadgeFacts) => f.cardCreated },
] as const satisfies readonly BadgeDef[];

export type BadgeId = (typeof BADGES)[number]["id"];
export const BADGE_IDS: readonly BadgeId[] = BADGES.map((b) => b.id);
export const isBadgeId = (v: unknown): v is BadgeId => typeof v === "string" && (BADGE_IDS as readonly string[]).includes(v);

/** Badges recorded by the server when their source rows are deleted later (scrims are deleted 7 days after they start). */
export const RECORDED_BADGES: readonly BadgeId[] = ["first_scrim"];

export const NO_FACTS: BadgeFacts = { tournaments: 0, verifiedResults: 0, wins: 0, scrimPlayed: false, eventOrganised: false, cardCreated: false };

/** The ids earned, in list order. `recorded` holds badges the server recorded earlier (only RECORDED_BADGES count from it). */
export function earnedBadges(f: BadgeFacts, recorded: readonly string[] = []): BadgeId[] {
  const rec = new Set(recorded.filter((r) => (RECORDED_BADGES as readonly string[]).includes(r)));
  return BADGES.filter((b) => b.earned(f) || rec.has(b.id)).map((b) => b.id);
}

/** What a public page shows: earned, not hidden one by one, and the whole section not switched off. Never a rule for a badge not earned. */
export function publicBadges(earned: readonly BadgeId[], hidden: readonly string[], sectionHidden: boolean): { id: BadgeId; title: string }[] {
  if (sectionHidden) return [];
  const off = new Set(hidden);
  return BADGES.filter((b) => earned.includes(b.id) && !off.has(b.id)).map((b) => ({ id: b.id, title: b.title }));
}
