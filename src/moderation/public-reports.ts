/**
 * The PUBLIC report route (blueprint 11.3, A-37, A-42). ONE route files a report from any public page type: live, team, league, registration, directory,
 * pass or results. Body: { kind, key, reason, note? } where `key` is the slug, token or event id the page's own URL carries.
 *
 *  - Rate limit: the exact D1 limiter (credential class, a rare write): 5 per hour per address, fail closed. Applied BEFORE the body is read.
 *  - Uniform answer: 202 and the same body whether the page exists, is unpublished, was revoked or was already reported. No existence oracle.
 *  - A report with reason `minor_exposed` hides the page on ONE report (a reviewed restore is the cost of a false positive).
 *  - Privacy: stores a reason code, a note of at most 200 sanitised characters, and the reporter only as a salted hash. No name, no address, no account.
 *  - The page's key is resolved to an IMMUTABLE id (resolveTarget), so a later rename or token rotation cannot undo a takedown.
 */
import { Hono } from "hono";
import type { AppBindings } from "../types";
import { HttpError, rateLimit, readJson } from "../http";
import { REVIEW_PROMISE, isPublicKind, isReason } from "./codes";
import { reporterHash, resolveTarget } from "./lookup";
import { fileReport } from "./reports";
import { killGate } from "../admin/kill";

export const publicReports = new Hono<AppBindings>();

export const publicReportRules = {
  "POST /public/report": { public: true, limit: "5 per hour per address" },
} as const;

publicReports.post("/public/report", async (c) => {
  const off = await killGate(c, "kill.public_writes");
  if (off) return off;
  await rateLimit(c, "publicReport", 5, 3600);
  const b = await readJson(c, 4_000);
  if (!isPublicKind(b.kind)) throw new HttpError(400, "kind must be one of live, team, league, registration, directory, pass or results");
  if (typeof b.key !== "string" || b.key.length < 1 || b.key.length > 64) throw new HttpError(400, "key must be the page address, 1 to 64 characters");
  if (!isReason(b.reason)) throw new HttpError(400, "reason is not one of the listed reasons");
  const target = await resolveTarget(c.env.DB, b.kind, b.key);
  if (target) {
    const reporter = await reporterHash(c.env, c.req.header("CF-Connecting-IP") ?? "unknown");
    await fileReport(c.env.DB, { target, reason: b.reason, note: b.note, reporter });
  }
  return c.json({ ok: true, review: REVIEW_PROMISE }, 202);
});
