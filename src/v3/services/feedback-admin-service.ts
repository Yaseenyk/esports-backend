/** Feedback bot, staff side: list, detail, summary, attachment bytes, triage. Staff authentication is done by the /admin/v1 door before this is called. */
import { auditOff, auditStmts } from "../../audit";
import { HttpError } from "../../http";
import { reportDetail, reportItem } from "../adapters/feedback-adapter";
import { FEEDBACK_KINDS, FEEDBACK_STATUSES } from "../lib/feedback";
import { ID32_RE, nowSec } from "../lib/ids";
import * as repo from "../repositories/feedback-repo";

const bad = (m: string) => new HttpError(400, m, { code: "invalid" });
const has = (list: readonly string[], v: string | undefined): boolean => v === undefined || list.includes(v);

const encodeCursor = (at: number, id: string): string => btoa(`${at}.${id}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function decodeCursor(c: string | undefined): { at: number; id: string } | undefined {
  if (c === undefined || c === "") return undefined;
  try {
    const m = /^(\d{1,12})\.([0-9a-f]{32})$/.exec(atob(c.replace(/-/g, "+").replace(/_/g, "/")));
    if (m) return { at: Number(m[1]), id: m[2]! };
  } catch {
    /* fall through */
  }
  throw bad("cursor is not valid");
}

export async function listFeedback(db: D1Database, q: { status?: string; kind?: string; page?: string; q?: string; limit?: string; cursor?: string }) {
  if (!has(FEEDBACK_STATUSES, q.status)) throw bad("status is not valid");
  if (!has(FEEDBACK_KINDS, q.kind)) throw bad("kind is not valid");
  if (q.page !== undefined && (q.page.length > 200 || !q.page.startsWith("/"))) throw bad("page must be a stored page path");
  if (q.q !== undefined && (q.q.length < 2 || q.q.length > 100)) throw bad("q must be 2 to 100 characters");
  let limit = 50;
  if (q.limit !== undefined) {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw bad("limit must be 1 to 100");
  }
  const rows = await repo.listReports(db, { status: q.status, kind: q.kind, page: q.page, q: q.q, limit: limit + 1, cursor: decodeCursor(q.cursor) });
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(reportItem), next: rows.length > limit && last ? encodeCursor(last.created_at, last.id) : null };
}

export async function feedbackDetail(db: D1Database, id: string) {
  if (!ID32_RE.test(id)) throw new HttpError(404, "Not found");
  const r = await repo.getReport(db, id);
  if (!r) throw new HttpError(404, "Not found");
  return reportDetail(r, await repo.listAttachmentMeta(db, id));
}

export async function feedbackSummary(db: D1Database) {
  const now = nowSec();
  const s = await repo.summary(db, now - 30 * 86_400, now - 7 * 86_400);
  const count = (rows: { k: string; n: number }[], keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, rows.find((r) => r.k === k)?.n ?? 0]));
  const byStatus = count(s.byStatus, FEEDBACK_STATUSES);
  return { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus, byKind: count(s.byKind, FEEDBACK_KINDS), topPages: s.pages.map((p) => ({ pagePath: p.page_path, count: p.n })), newLast7Days: s.new7 };
}

export async function feedbackAttachment(db: D1Database, id: string, aid: string): Promise<{ mime: string; bytes: Uint8Array }> {
  if (!ID32_RE.test(id) || !ID32_RE.test(aid)) throw new HttpError(404, "Not found");
  const f = await repo.attachmentFile(db, id, aid);
  if (f === null) throw new HttpError(404, "Not found");
  if (f === "purged") throw new HttpError(410, "This screenshot was deleted by the 90-day retention rule", { code: "purged" });
  return f;
}

export async function triageFeedback(db: D1Database, staffId: string, id: string, body: Record<string, unknown>) {
  if (!ID32_RE.test(id)) throw new HttpError(404, "Not found");
  const status = body.status;
  const note = body.staffNote;
  if (status === undefined && note === undefined) throw bad("Send status, staffNote or both");
  if (status !== undefined && (typeof status !== "string" || !(FEEDBACK_STATUSES as readonly string[]).includes(status))) throw bad("status must be new, triaged, fixed or wontfix");
  let staffNote: string | null | undefined;
  if (note !== undefined) {
    if (note !== null && typeof note !== "string") throw bad("staffNote must be text or null");
    staffNote = note === null || note.trim() === "" ? null : note.trim();
    if (staffNote !== null && Array.from(staffNote).length > 1000) throw bad("staffNote is 1000 characters at most");
  }
  if (!(await repo.getReport(db, id))) throw new HttpError(404, "Not found");
  const off = await auditOff(db);
  const audit = auditStmts(db, { action: "feedback.updated", actorType: "staff", actorId: staffId, targetType: "feedback", targetId: id, meta: status === undefined ? {} : { status } }, off);
  await repo.updateReport(db, id, { status: status as string | undefined, staffNote, setNote: note !== undefined }, nowSec(), audit);
  return feedbackDetail(db, id);
}
