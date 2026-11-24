/**
 * Scheduled v3 housekeeping (called from the existing cron, src/features/reminders-cron.ts).
 *  - every tick: open LFT listings past their expiry become `expired`;
 *  - daily tick: listings are DELETED 30 days after expiry (applications and reports cascade); dispute evidence bytes are deleted 90 days after the
 *    dispute reached a final state (the metadata row stays with purged_at).
 *  - daily tick (migration 0056): scrim slots are deleted 7 days after they start (requests and reports cascade); reports and moderation rows of team pages
 *    deleted through the legacy route are removed.
 * Safe before migration 0051 is applied: it checks that the v3 tables exist and does nothing otherwise.
 */
import { nowSec } from "../lib/ids";
import * as dispute from "../repositories/dispute-repo";
import * as feedback from "../repositories/feedback-repo";
import { feedbackTablesExist } from "../repositories/feedback-repo";
import { FEEDBACK } from "../lib/feedback";
import * as lft from "../repositories/lft-repo";
import { v3TablesExist } from "../repositories/maintenance-repo";
import { LFT } from "./lft-service";
import * as scrims from "../repositories/scrim-repo";
import { deleteOrphanTeamModeration, showcaseTablesExist } from "../repositories/showcase-repo";
import { SCRIMS } from "./scrim-service";
import { managerTablesExist } from "../repositories/scrim-manager-repo";
import { runManagerTick } from "./scrim-manager-service";

export interface RetentionResult { skipped: boolean; expired: number; deleted: number; purged: number; feedbackBytesPurged: number; feedbackDeleted: number; scrimsDeleted: number; orphansDeleted: number; scrimOffersExpired: number; scrimDaysMade: number }

export async function runRetention(db: D1Database, opts: { daily: boolean; now?: number }): Promise<RetentionResult> {
  const out: RetentionResult = { skipped: false, expired: 0, deleted: 0, purged: 0, feedbackBytesPurged: 0, feedbackDeleted: 0, scrimsDeleted: 0, orphansDeleted: 0, scrimOffersExpired: 0, scrimDaysMade: 0 };
  const now = opts.now ?? nowSec();
  // Feedback bot (migration 0054): runs whatever the flag says, so switching the bot off never keeps data longer than promised.
  if (opts.daily && (await feedbackTablesExist(db))) {
    out.feedbackBytesPurged = await feedback.purgeOldBytes(db, now - FEEDBACK.BYTES_RETENTION_SEC, now);
    out.feedbackDeleted = await feedback.deleteOldReports(db, now - FEEDBACK.REPORT_RETENTION_SEC);
  }
  if (!(await v3TablesExist(db))) return { ...out, skipped: true };
  // Phase 4b scrim manager (migration 0057): late waitlist offers pass on and recurring schedules make their days, only while v3.scrims is on.
  if (await managerTablesExist(db)) {
    const t = await runManagerTick(db, { daily: opts.daily, now });
    out.scrimOffersExpired = t.expired;
    out.scrimDaysMade = t.generated;
  }
  out.expired = await lft.expireOpenListings(db, now);
  if (opts.daily) {
    out.deleted = await lft.deleteOldListings(db, now, LFT.DELETE_AFTER_EXPIRY_SEC);
    out.purged = await dispute.purgeDueEvidence(db, now);
    // Phases 3-5 (migration 0056). Runs whatever the flags say, so switching a feature off never keeps data longer than promised.
    if (await scrims.scrimTablesExist(db)) out.scrimsDeleted = await scrims.deleteOldSlots(db, now, SCRIMS.DELETE_AFTER_START_SEC);
    if (await showcaseTablesExist(db)) out.orphansDeleted = await deleteOrphanTeamModeration(db);
  }
  return out;
}
