/**
 * Scheduled v3 housekeeping (called from the existing cron, src/features/reminders-cron.ts).
 *  - every tick: open LFT listings past their expiry become `expired`;
 *  - daily tick: listings are DELETED 30 days after expiry (applications and reports cascade); dispute evidence bytes are deleted 90 days after the
 *    dispute reached a final state (the metadata row stays with purged_at).
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

export interface RetentionResult { skipped: boolean; expired: number; deleted: number; purged: number; feedbackBytesPurged: number; feedbackDeleted: number }

export async function runRetention(db: D1Database, opts: { daily: boolean; now?: number }): Promise<RetentionResult> {
  const out: RetentionResult = { skipped: false, expired: 0, deleted: 0, purged: 0, feedbackBytesPurged: 0, feedbackDeleted: 0 };
  const now = opts.now ?? nowSec();
  // Feedback bot (migration 0054): runs whatever the flag says, so switching the bot off never keeps data longer than promised.
  if (opts.daily && (await feedbackTablesExist(db))) {
    out.feedbackBytesPurged = await feedback.purgeOldBytes(db, now - FEEDBACK.BYTES_RETENTION_SEC, now);
    out.feedbackDeleted = await feedback.deleteOldReports(db, now - FEEDBACK.REPORT_RETENTION_SEC);
  }
  if (!(await v3TablesExist(db))) return { ...out, skipped: true };
  out.expired = await lft.expireOpenListings(db, now);
  if (opts.daily) {
    out.deleted = await lft.deleteOldListings(db, now, LFT.DELETE_AFTER_EXPIRY_SEC);
    out.purged = await dispute.purgeDueEvidence(db, now);
  }
  return out;
}
