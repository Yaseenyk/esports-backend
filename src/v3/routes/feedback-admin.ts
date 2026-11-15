/**
 * Feedback staff routes, mounted INSIDE /admin/v1 after requireStaff (src/admin/routes.ts). Platform staff tokens only. Answer 404 while feedback.enabled is off.
 * The list never carries the contact, the account id, the address hash or screenshot bytes; the detail adds contact and the account id (an id, never an email).
 */
import { Hono } from "hono";
import { getFlags } from "../../flags";
import { HttpError, readJson } from "../../http";
import type { AdminBindings } from "../../admin/session";
import { CONTENT_TYPE_BY_IMAGE, type FeedbackImage } from "../lib/feedback";
import { feedbackAttachment, feedbackDetail, feedbackSummary, listFeedback, triageFeedback } from "../services/feedback-admin-service";

export const feedbackAdminRoutes = new Hono<AdminBindings>();

feedbackAdminRoutes.use("/feedback", async (c, next) => {
  if (!(await getFlags(c.env.DB))["feedback.enabled"]) throw new HttpError(404, "Not found");
  await next();
});
feedbackAdminRoutes.use("/feedback/*", async (c, next) => {
  if (!(await getFlags(c.env.DB))["feedback.enabled"]) throw new HttpError(404, "Not found");
  await next();
});

feedbackAdminRoutes.get("/feedback", async (c) => {
  const q = (k: string) => c.req.query(k);
  return c.json(await listFeedback(c.env.DB, { status: q("status"), kind: q("kind"), page: q("page"), q: q("q"), limit: q("limit"), cursor: q("cursor") }), 200, { "cache-control": "no-store" });
});
feedbackAdminRoutes.get("/feedback/summary", async (c) => c.json(await feedbackSummary(c.env.DB), 200, { "cache-control": "no-store" }));
feedbackAdminRoutes.get("/feedback/:id", async (c) => c.json(await feedbackDetail(c.env.DB, c.req.param("id")), 200, { "cache-control": "no-store" }));
feedbackAdminRoutes.get("/feedback/:id/attachments/:aid", async (c) => {
  const f = await feedbackAttachment(c.env.DB, c.req.param("id"), c.req.param("aid"));
  const mime = CONTENT_TYPE_BY_IMAGE[f.mime as FeedbackImage];
  if (!mime) throw new HttpError(404, "Not found");
  const ext = f.mime === "jpeg" ? "jpg" : f.mime;
  return new Response(f.bytes as BodyInit, {
    status: 200,
    headers: {
      "content-type": mime,
      "content-disposition": `attachment; filename="feedback-${c.req.param("aid").slice(0, 8)}.${ext}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
});
feedbackAdminRoutes.patch("/feedback/:id", async (c) => c.json(await triageFeedback(c.env.DB, c.get("staff").id, c.req.param("id"), await readJson(c as never, 4_000))));

export const FEEDBACK_ADMIN_ROUTES: readonly { method: string; path: string }[] = [
  { method: "GET", path: "/admin/v1/feedback" },
  { method: "GET", path: "/admin/v1/feedback/summary" },
  { method: "GET", path: "/admin/v1/feedback/:id" },
  { method: "GET", path: "/admin/v1/feedback/:id/attachments/:aid" },
  { method: "PATCH", path: "/admin/v1/feedback/:id" },
];
