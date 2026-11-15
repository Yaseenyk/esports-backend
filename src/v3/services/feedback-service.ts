/**
 * Feedback bot, public side: accepting a report, the attach token, screenshots, withdrawal. Business rules only; SQL is in feedback-repo.
 * Order of checks for an upload is fixed (see the route): token, declared type, free slot, size, magic bytes, then the daily caps.
 */
import { pwFingerprint, randomToken, sha256, timingSafeEqual, verifyJwt } from "../../crypto";
import { HttpError } from "../../http";
import { CONTENT_TYPE_BY_IMAGE, FEEDBACK, FEEDBACK_CONSENT_VERSION, IMAGE_BY_CONTENT_TYPE, deviceFromUa, hashIp, parseFeedback, type FeedbackImage, type FeedbackInput } from "../lib/feedback";
import { detectImage, sha256Hex } from "../lib/image-magic";
import { newId, nowSec } from "../lib/ids";
import * as repo from "../repositories/feedback-repo";

export const feedbackStatus = () => ({ enabled: true as const, consentVersion: FEEDBACK_CONSENT_VERSION, maxAttachments: FEEDBACK.ATTACH_MAX_FILES, maxAttachmentBytes: FEEDBACK.ATTACH_MAX_BYTES });

export const validateFeedback = (body: Record<string, unknown>): FeedbackInput => parseFeedback(body);
export const feedbackIpHash = (env: { FEEDBACK_SALT?: string; JWT_SECRET: string }, ip: string): Promise<string> => hashIp(ip, env);

/** A normal-looking answer for a filled honeypot: nothing is stored. */
export function fakeAccepted() {
  return { id: newId(), attachToken: randomToken(32), attachExpiresIn: FEEDBACK.TOKEN_TTL_SEC };
}
export const isHoneypotFilled = (website: unknown): boolean => website !== undefined && website !== null && !(typeof website === "string" && website.trim() === "");

/** The user id behind a valid, current bearer token, or null (never throws). */
async function activeUser(db: D1Database, env: { JWT_SECRET: string }, authorization: string | undefined): Promise<string | null> {
  const m = /^Bearer (\S+)$/.exec(authorization ?? "");
  if (!m) return null;
  try {
    const claims = await verifyJwt(m[1]!, env.JWT_SECRET);
    if (!claims) return null;
    const u = await repo.userAuthRow(db, claims.sub);
    if (!u || u.status !== "active" || !timingSafeEqual(await pwFingerprint(u), claims.pv)) return null;
    return claims.sub;
  } catch {
    return null;
  }
}

export async function acceptFeedback(db: D1Database, env: { JWT_SECRET: string }, a: { input: FeedbackInput; ipHash: string; userAgent: string | undefined; authorization: string | undefined }) {
  const { input } = a;
  const uid = await activeUser(db, env, a.authorization);
  const dev = deviceFromUa(a.userAgent);
  const id = newId();
  const token = randomToken(32);
  const at = nowSec();
  await repo.insertReport(db, {
    id, at, kind: input.kind, message: input.message, pagePath: input.pagePath, pageTitle: input.pageTitle, referrerPath: input.referrerPath,
    viewportW: input.viewportW, viewportH: input.viewportH, deviceClass: dev.deviceClass, browserFamily: dev.browserFamily, locale: input.locale, buildId: input.buildId,
    signedIn: uid !== null, userId: input.includeAccount ? uid : null, contact: input.contact, clientErrors: input.clientErrors, consentVersion: FEEDBACK_CONSENT_VERSION,
    ipHash: a.ipHash, tokenHash: await sha256(token), tokenExpiresAt: at + FEEDBACK.TOKEN_TTL_SEC,
  });
  return { id, attachToken: token, attachExpiresIn: FEEDBACK.TOKEN_TTL_SEC };
}

const badToken = () => new HttpError(401, "This link has expired or is not valid", { code: "bad_token" });

/** 401 bad_token for a missing, wrong or expired token and for an unknown report (all identical). */
export async function authoriseToken(db: D1Database, id: string, token: string | undefined): Promise<void> {
  if (!token || !/^[0-9a-f]{32}$/.test(id) || token.length > 200) throw badToken();
  const row = await repo.tokenRow(db, id);
  const given = await sha256(token);
  const ok = row !== null && row.hash !== null && timingSafeEqual(row.hash, given) && row.expires !== null && row.expires > nowSec();
  if (!ok) throw badToken();
}

export async function withdrawFeedback(db: D1Database, id: string, token: string | undefined): Promise<void> {
  await authoriseToken(db, id, token);
  await repo.deleteReport(db, id);
}

export function declaredImage(contentType: string | undefined): FeedbackImage {
  const t = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
  const img = IMAGE_BY_CONTENT_TYPE[t];
  if (!img) throw new HttpError(415, "Only PNG, JPEG or WebP images are accepted", { code: "unsupported_type" });
  return img;
}

export async function assertRoom(db: D1Database, id: string): Promise<void> {
  if ((await repo.attachmentCount(db, id)) >= FEEDBACK.ATTACH_MAX_FILES) throw new HttpError(409, "Two screenshots are the most one report can have", { code: "too_many" });
}

/** Magic-byte check (the declared type must agree) and the SHA-256. 400 bad_image otherwise. */
export async function checkImage(bytes: Uint8Array, declared: FeedbackImage): Promise<{ mime: FeedbackImage; sha: string }> {
  const found = bytes.length === 0 ? null : detectImage(bytes);
  const mime = found === null ? null : (IMAGE_BY_CONTENT_TYPE[found] as FeedbackImage);
  if (mime === null || mime !== declared) throw new HttpError(400, "That file is not a valid PNG, JPEG or WebP image", { code: "bad_image" });
  return { mime, sha: await sha256Hex(bytes) };
}

export const existingAttachment = (db: D1Database, id: string, sha: string): Promise<string | null> => repo.attachmentIdByHash(db, id, sha);

export async function assertStorage(db: D1Database, incoming: number): Promise<void> {
  if ((await repo.liveBytes(db)) + incoming > FEEDBACK.STORAGE_BUDGET_BYTES) throw new HttpError(429, "Screenshots are full for now, please send the report without one", { code: "storage_full" });
}

export async function storeAttachment(db: D1Database, reportId: string, f: { mime: FeedbackImage; sha: string; bytes: Uint8Array }): Promise<string> {
  const id = newId();
  const r = await repo.insertAttachment(db, { id, reportId, mime: f.mime, size: f.bytes.length, sha: f.sha, at: nowSec(), bytes: f.bytes });
  if (r === "too_many") throw new HttpError(409, "Two screenshots are the most one report can have", { code: "too_many" });
  if (r === "duplicate") return (await repo.attachmentIdByHash(db, reportId, f.sha)) ?? id;
  return id;
}

export const contentTypeOf = (m: FeedbackImage): string => CONTENT_TYPE_BY_IMAGE[m];
