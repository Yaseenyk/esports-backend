/** Dispute portal routes (flag v3.disputes). Only the two teams, the organiser and moderators (see admin.ts) can read a dispute or its evidence. */
import { Hono } from "hono";
import { requireUser } from "../../auth";
import { HttpError, rateLimit, rateLimitSubject, readBytes, readJson, type Ctx } from "../../http";
import type { AppBindings } from "../../types";
import { EVIDENCE_MAX_BYTES } from "../lib/image-magic";
import {
  addEvidence, claimCaptain, commentOnDispute, evidenceDownload, getDispute, listTournamentDisputes, myDisputes, raiseDispute, resolveDispute, transitionDispute,
} from "../services/dispute-service";
import { flagGate, killMw, noStore } from "./common";

export const disputeRoutes = new Hono<AppBindings>();
const gate = flagGate("v3.disputes");
const writes = killMw("kill.public_writes");
const param = (c: Ctx, k: string): string => c.req.param(k) ?? "";
const actor = (c: Ctx) => ({ kind: "user" as const, userId: c.get("userId") });

disputeRoutes.post("/v3/tournaments/:slug/captain-claim", gate, writes, requireUser, async (c) => {
  noStore(c);
  await rateLimit(c, "v3-captain-claim", 10, 600); // a token guess is throttled per address
  const b = await readJson(c, 1024);
  return c.json(await claimCaptain(c.env.DB, c.get("userId"), param(c, "slug"), b.token));
});
disputeRoutes.post("/v3/tournaments/:slug/disputes", gate, writes, requireUser, async (c) => {
  noStore(c);
  const uid = c.get("userId");
  await rateLimitSubject(c, "v3-dispute-raise", uid, 10, 86_400);
  return c.json(await raiseDispute(c.env.DB, uid, param(c, "slug"), await readJson(c, 8_000)), 201);
});
disputeRoutes.get("/v3/tournaments/:slug/disputes", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await listTournamentDisputes(c.env.DB, c.get("userId"), param(c, "slug")));
});
disputeRoutes.get("/v3/me/disputes", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await myDisputes(c.env.DB, c.get("userId")));
});
disputeRoutes.get("/v3/disputes/:id", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await getDispute(c.env.DB, actor(c), param(c, "id")));
});
disputeRoutes.post("/v3/disputes/:id/comment", gate, writes, requireUser, async (c) => {
  noStore(c);
  await rateLimitSubject(c, "v3-dispute-comment", c.get("userId"), 60, 3600);
  return c.json(await commentOnDispute(c.env.DB, actor(c), param(c, "id"), await readJson(c, 4_000)), 201);
});
disputeRoutes.post("/v3/disputes/:id/transition", gate, writes, requireUser, async (c) => {
  noStore(c);
  return c.json(await transitionDispute(c.env.DB, actor(c), param(c, "id"), await readJson(c, 4_000)));
});
disputeRoutes.post("/v3/disputes/:id/resolve", gate, writes, requireUser, async (c) => {
  noStore(c);
  return c.json(await resolveDispute(c.env.DB, actor(c), param(c, "id"), await readJson(c, 16_000)));
});

// ---- evidence: the raw image bytes are the request body (no JSON, no base64); ?caption= is optional ----
disputeRoutes.post("/v3/disputes/:id/evidence", gate, killMw("kill.uploads"), requireUser, async (c) => {
  noStore(c);
  const uid = c.get("userId");
  await rateLimitSubject(c, "v3-evidence", uid, 20, 3600);
  const bytes = await readBytes(c, EVIDENCE_MAX_BYTES);
  return c.json(await addEvidence(c.env.DB, actor(c), param(c, "id"), bytes, c.req.query("caption")), 201);
});
disputeRoutes.get("/v3/disputes/:id/evidence/:evidenceId", gate, requireUser, async (c) => evidenceResponse(await evidenceDownload(c.env.DB, actor(c), param(c, "id"), param(c, "evidenceId")), param(c, "evidenceId")));

/** The ONE way evidence bytes leave the Worker: type from the checked magic bytes, forced download, no sniffing, never cached by a shared cache. */
export function evidenceResponse(f: { mime: string; bytes: Uint8Array }, evidenceId: string): Response {
  const ext = f.mime === "image/png" ? "png" : f.mime === "image/jpeg" ? "jpg" : "webp";
  if (!/^[0-9a-f]{32}$/.test(evidenceId)) throw new HttpError(404, "Not found");
  return new Response(f.bytes as BodyInit, {
    status: 200,
    headers: {
      "content-type": f.mime,
      "content-disposition": `attachment; filename="evidence-${evidenceId.slice(0, 8)}.${ext}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
