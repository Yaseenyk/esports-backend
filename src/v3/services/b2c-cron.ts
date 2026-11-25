/** Scheduled work for the planner and alerts (called from the cron handler in src/index.ts). Retention runs whatever the flags say. */
import type { Env } from "../../types";
import { purgeAlerts, runDigestTick } from "./alert-service";
import { purgeExpiredPlans } from "./planner-service";

/** True for the one 15-minute tick that starts at 03:00 UTC (same slot as the existing daily housekeeping). */
const isDailyTick = (ms: number): boolean => {
  const d = new Date(ms);
  return d.getUTCHours() === 3 && d.getUTCMinutes() < 15;
};

export async function runB2cCron(env: Env, scheduledTime: number): Promise<void> {
  if (isDailyTick(scheduledTime)) {
    const now = Math.floor(scheduledTime / 1000);
    await purgeExpiredPlans(env.DB, now);
    await purgeAlerts(env.DB, now);
    return;
  }
  await runDigestTick(env, { nowMs: scheduledTime });
}
