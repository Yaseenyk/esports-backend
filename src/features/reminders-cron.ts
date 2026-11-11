import type { Env } from "../types";
import { cleanupRateLimits } from "../http";
import { processDueJobs } from "./reminders";
import { dailyHousekeeping } from "./housekeeping";

/** True for the one 15-minute tick that starts at 03:00 UTC: the daily housekeeping slot. */
export const isDailyTick = (scheduledTime: number): boolean => {
  const d = new Date(scheduledTime);
  return d.getUTCHours() === 3 && d.getUTCMinutes() < 15;
};

/** Cloudflare cron handler (see [triggers] in wrangler.toml, every 15 minutes). Sends due reminders in a small batch; once a day also drops old rate-limit windows. */
export async function scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(processDueJobs(env).then(() => undefined, () => { console.error("reminder run failed"); }));
  if (isDailyTick(controller.scheduledTime)) ctx.waitUntil(cleanupRateLimits(env.DB).then(() => undefined, () => { console.error("rate limit cleanup failed"); }));
  if (isDailyTick(controller.scheduledTime)) ctx.waitUntil(dailyHousekeeping(env, controller.scheduledTime));
}

export { processDueJobs };
