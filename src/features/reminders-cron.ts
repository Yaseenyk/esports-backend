import type { Env } from "../types";
import { processDueJobs } from "./reminders";

/** Cloudflare cron handler (see [triggers] in wrangler.toml, every 15 minutes). Sends due reminders in a small batch. */
export async function scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(processDueJobs(env).then(() => undefined, () => { console.error("reminder run failed"); }));
}

export { processDueJobs };
