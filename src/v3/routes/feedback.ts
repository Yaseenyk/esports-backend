/**
 * Feedback bot, public routes (flag feedback.enabled; kill switch kill.feedback). With the flag off every route answers the router's own 404 BEFORE any
 * feedback table is read (only the legacy `flags` table is). Contract: esports-hub docs/ecosystem/v3/API.md section 8.
 */
import { Hono } from "hono";
import { getFlags } from "../../flags";
import { HttpError, rateLimitSubject, readBytes, readJson, type Ctx } from "../../http";
import type { AppBindings } from "../../types";
import { FEEDBACK } from "../lib/feedback";
import {
  acceptFeedback, assertRoom, assertStorage, authoriseToken, checkImage, declaredImage, existingAttachment, fakeAccepted, feedbackIpHash, feedbackStatus, isHoneypotFilled,
  storeAttachment, validateFeedback, withdrawFeedback,
} from "../services/feedback-service";
import { flagGate, killMw, noStore } from "./common";

export const feedbackRoutes = new Hono<AppBindings>();
const gate = flagGate("feedback.enabled");
const kill = killMw("kill.feedback");
const uploadsKill = killMw("kill.uploads");
const param = (c: Ctx, k: string): string => c.req.param(k) ?? "";
const ipOf = (c: Ctx): string => c.req.header("CF-Connecting-IP") ?? "unknown";

/** A rate limit keyed by the hashed address; the answer carries a feedback code. */
async function limit(c: Ctx, scope: string, subject: string, n: number, sec: number, code: "rate_limited" | "daily_cap"): Promise<void> {
  try {
    await rateLimitSubject(c, scope, subject, n, sec);
  } catch (e) {
    if (e instanceof HttpError && e.status === 429) {
      throw new HttpError(429, code === "daily_cap" ? "We have reached today's limit for feedback. Please come back tomorrow." : "Too many reports from this device. Please try again later.", { code });
    }
    throw e;
  }
}

feedbackRoutes.get("/feedback/status", gate, async (c) => {
  // The widget hides while the kill switch is on (cached read; a status read never writes).
  if ((await getFlags(c.env.DB))["kill.feedback"]) return c.notFound();
  c.header("cache-control", "private, max-age=60");
  return c.json(feedbackStatus());
});

feedbackRoutes.post("/feedback", gate, kill, async (c) => {
  noStore(c);
  let body: Record<string, unknown>;
  try {
    body = await readJson(c, FEEDBACK.MAX_BODY);
  } catch (e) {
    if (e instanceof HttpError && e.status === 413) throw new HttpError(413, "That report is too large", { code: "payload_too_large" });
    if (e instanceof HttpError && e.status === 400) throw new HttpError(400, e.message, { code: "invalid", field: "body" });
    throw e;
  }
  if (isHoneypotFilled(body.website)) return c.json(fakeAccepted(), 201); // accepted and dropped: nothing is stored, nothing is counted
  const input = validateFeedback(body);
  const ipHash = await feedbackIpHash(c.env, ipOf(c));
  await limit(c, "feedback-hour", ipHash, FEEDBACK.HOUR_LIMIT, 3600, "rate_limited");
  await limit(c, "feedback-day", ipHash, FEEDBACK.DAY_LIMIT, 86_400, "rate_limited");
  await limit(c, "feedback-global", "all", FEEDBACK.GLOBAL_DAY_CAP, 86_400, "daily_cap");
  return c.json(await acceptFeedback(c.env.DB, c.env, { input, ipHash, userAgent: c.req.header("user-agent"), authorization: c.req.header("authorization") }), 201);
});

feedbackRoutes.post("/feedback/:id/attachments", gate, kill, uploadsKill, async (c) => {
  noStore(c);
  const id = param(c, "id");
  const ipHash = await feedbackIpHash(c.env, ipOf(c));
  await limit(c, "feedback-attach-hour", ipHash, FEEDBACK.ATTACH_HOUR_LIMIT, 3600, "rate_limited");
  await authoriseToken(c.env.DB, id, c.req.header("x-attach-token"));
  const declared = declaredImage(c.req.header("content-type"));
  await assertRoom(c.env.DB, id);
  let bytes: Uint8Array;
  try {
    bytes = await readBytes(c, FEEDBACK.ATTACH_MAX_BYTES);
  } catch (e) {
    if (e instanceof HttpError && e.status === 413) throw new HttpError(413, "That screenshot is over 400 KB", { code: "too_big" });
    throw e;
  }
  const img = await checkImage(bytes, declared);
  const dup = await existingAttachment(c.env.DB, id, img.sha);
  if (dup) return c.json({ id: dup }, 201); // the same file twice stores nothing new
  await limit(c, "feedback-attach-day", ipHash, FEEDBACK.ATTACH_IP_DAY_LIMIT, 86_400, "rate_limited");
  await limit(c, "feedback-attach-global", "all", FEEDBACK.ATTACH_GLOBAL_DAY_CAP, 86_400, "daily_cap");
  await assertStorage(c.env.DB, bytes.length);
  return c.json({ id: await storeAttachment(c.env.DB, id, { mime: img.mime, sha: img.sha, bytes }) }, 201);
});

// Withdrawal is a deletion, so it keeps working while kill.feedback is on.
feedbackRoutes.delete("/feedback/:id", gate, async (c) => {
  noStore(c);
  await limit(c, "feedback-attach-hour", await feedbackIpHash(c.env, ipOf(c)), FEEDBACK.ATTACH_HOUR_LIMIT, 3600, "rate_limited");
  await withdrawFeedback(c.env.DB, param(c, "id"), c.req.header("x-attach-token"));
  return new Response(null, { status: 204 });
});
