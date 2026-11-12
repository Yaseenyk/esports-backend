/**
 * Usage page data (blueprint 9.5). Four items, each with its source and whether the number is exact. Nothing here reads a person.
 *
 *  GET /admin/v1/usage -> { day, items: [...four], note }
 *
 *  - mail_sent_today: exact, from `mail_budget`, against MAIL_DAY_LIMIT (90 of the 100 a day on the free plan).
 *  - db_size_bytes: `meta.size_after` of one cheap statement (exact at that moment).
 *  - d1_rows_written_today: a 1-in-20 SAMPLE of `meta.rows_written` is not collected yet (no route writes the sample), so `value` is null and
 *    `available` false until the hook sweep adds it. Labelled "estimate" when it exists.
 *  - worker_requests_today: needs the optional read-only Cloudflare analytics token and its daily pull (OD-C); `value` null, `available` false.
 *  Until P0-0 records dated limit values the page says "limits not verified, check Cloudflare" (`note`).
 */
import { Hono } from "hono";
import { MAIL_DAY_LIMIT } from "../mailer";
import { metricDay } from "../metrics";
import type { AdminBindings } from "./session";

export const usageRoutes = new Hono<AdminBindings>();

export interface UsageItem {
  id: "d1_rows_written_today" | "worker_requests_today" | "mail_sent_today" | "db_size_bytes";
  label: string;
  value: number | null;
  limit: number | null;
  exact: boolean;
  available: boolean;
  source: string;
}

usageRoutes.get("/usage", async (c) => {
  const day = metricDay();
  const mail = await c.env.DB.prepare("SELECT sent FROM mail_budget WHERE day = ?1").bind(day).first<{ sent: number }>();
  const size = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM flags").all<{ n: number }>();
  const bytes = (size.meta as { size_after?: number }).size_after;
  const items: UsageItem[] = [
    { id: "d1_rows_written_today", label: "Database rows written today", value: null, limit: null, exact: false, available: false, source: "estimate: 1 in 20 sampled from the rows-written count (not collected yet)" },
    { id: "worker_requests_today", label: "Worker requests today", value: null, limit: null, exact: false, available: false, source: "Cloudflare analytics through the optional read-only token (not configured)" },
    { id: "mail_sent_today", label: "Emails sent today", value: mail?.sent ?? 0, limit: MAIL_DAY_LIMIT, exact: true, available: true, source: "our own mail budget table (exact)" },
    { id: "db_size_bytes", label: "Database size", value: typeof bytes === "number" ? bytes : null, limit: null, exact: typeof bytes === "number", available: typeof bytes === "number", source: "database metadata after the last statement" },
  ];
  return c.json({ day, items, note: "limits not verified, check Cloudflare" });
});
