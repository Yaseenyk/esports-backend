/** feedback_reports, feedback_attachments, feedback_attachment_blobs. The only place these tables are queried. Constant SQL only. */
import { blobBytes } from "../../images";

export interface ReportRow {
  id: string; created_at: number; updated_at: number | null; kind: string; message: string; page_path: string; page_title: string | null; referrer_path: string | null;
  viewport_w: number | null; viewport_h: number | null; device_class: string | null; browser_family: string | null; locale: string | null; build_id: string | null;
  signed_in: number; user_id: string | null; contact: string | null; client_errors: string | null; consent_version: string; status: string; staff_note: string | null;
  attachment_count: number;
}
export interface AttachmentMeta { id: string; mime: string; size_bytes: number; sha256: string; created_at: number; purged_at: number | null }

export async function feedbackTablesExist(db: D1Database): Promise<boolean> {
  return (await db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'feedback_reports'").first()) !== null;
}

export interface NewReport {
  id: string; at: number; kind: string; message: string; pagePath: string; pageTitle: string | null; referrerPath: string | null; viewportW: number; viewportH: number;
  deviceClass: string | null; browserFamily: string; locale: string | null; buildId: string | null; signedIn: boolean; userId: string | null; contact: string | null;
  clientErrors: string[]; consentVersion: string; ipHash: string; tokenHash: string; tokenExpiresAt: number;
}
export async function insertReport(db: D1Database, r: NewReport): Promise<void> {
  await db
    .prepare(
      "INSERT INTO feedback_reports (id, created_at, kind, message, page_path, page_title, referrer_path, viewport_w, viewport_h, device_class, browser_family, locale, build_id, signed_in, user_id, contact, client_errors, consent_version, ip_hash, attach_token_hash, attach_expires_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)",
    )
    .bind(r.id, r.at, r.kind, r.message, r.pagePath, r.pageTitle, r.referrerPath, r.viewportW, r.viewportH, r.deviceClass, r.browserFamily, r.locale, r.buildId, r.signedIn ? 1 : 0, r.userId, r.contact, r.clientErrors.length ? JSON.stringify(r.clientErrors) : null, r.consentVersion, r.ipHash, r.tokenHash, r.tokenExpiresAt)
    .run();
}

/** The attach-token facts of a report, or null. */
export async function tokenRow(db: D1Database, id: string): Promise<{ hash: string | null; expires: number | null } | null> {
  const r = await db.prepare("SELECT attach_token_hash, attach_expires_at FROM feedback_reports WHERE id = ?1").bind(id).first<{ attach_token_hash: string | null; attach_expires_at: number | null }>();
  return r ? { hash: r.attach_token_hash, expires: r.attach_expires_at } : null;
}

export async function attachmentCount(db: D1Database, reportId: string): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM feedback_attachments WHERE report_id = ?1").bind(reportId).first<{ n: number }>())!.n;
}
export async function attachmentIdByHash(db: D1Database, reportId: string, sha: string): Promise<string | null> {
  return (await db.prepare("SELECT id FROM feedback_attachments WHERE report_id = ?1 AND sha256 = ?2").bind(reportId, sha).first<{ id: string }>())?.id ?? null;
}
/** Total bytes of screenshots currently stored (bytes not yet purged). The table stays small (daily caps), so this is cheap. */
export async function liveBytes(db: D1Database): Promise<number> {
  return (await db.prepare("SELECT COALESCE(SUM(size_bytes), 0) AS n FROM feedback_attachments WHERE purged_at IS NULL").first<{ n: number }>())!.n;
}

/** Metadata and bytes in ONE batch. The trigger aborts a third file; returns "too_many" then, "duplicate" on the unique hash index, else "ok". */
export async function insertAttachment(db: D1Database, a: { id: string; reportId: string; mime: string; size: number; sha: string; at: number; bytes: Uint8Array }): Promise<"ok" | "too_many" | "duplicate"> {
  try {
    await db.batch([
      db.prepare("INSERT INTO feedback_attachments (id, report_id, mime, size_bytes, sha256, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)").bind(a.id, a.reportId, a.mime, a.size, a.sha, a.at),
      db.prepare("INSERT INTO feedback_attachment_blobs (attachment_id, data) VALUES (?1, ?2)").bind(a.id, a.bytes.buffer.slice(a.bytes.byteOffset, a.bytes.byteOffset + a.bytes.byteLength) as ArrayBuffer),
    ]);
    return "ok";
  } catch (e) {
    const m = `${e instanceof Error ? e.message : ""} ${String((e as { cause?: unknown }).cause ?? "")}`;
    if (/at most 2 attachments/i.test(m)) return "too_many";
    if (/UNIQUE/i.test(m)) return "duplicate";
    throw e;
  }
}

/** Hard delete of one report with its attachments and bytes, explicit (does not rely on cascades). */
export async function deleteReport(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM feedback_attachment_blobs WHERE attachment_id IN (SELECT id FROM feedback_attachments WHERE report_id = ?1)").bind(id),
    db.prepare("DELETE FROM feedback_attachments WHERE report_id = ?1").bind(id),
    db.prepare("DELETE FROM feedback_reports WHERE id = ?1").bind(id),
  ]);
}

/** Statements for the account-deletion batch: every report linked to the user is DELETED, with its bytes. */
export function accountDeletionStatements(db: D1Database, userId: string): D1PreparedStatement[] {
  return [
    db.prepare("DELETE FROM feedback_attachment_blobs WHERE attachment_id IN (SELECT a.id FROM feedback_attachments a JOIN feedback_reports r ON r.id = a.report_id WHERE r.user_id = ?1)").bind(userId),
    db.prepare("DELETE FROM feedback_attachments WHERE report_id IN (SELECT id FROM feedback_reports WHERE user_id = ?1)").bind(userId),
    db.prepare("DELETE FROM feedback_reports WHERE user_id = ?1").bind(userId),
  ];
}

/** Active-account check for the optional account link: the password fingerprint inputs and status. */
export async function userAuthRow(db: D1Database, userId: string): Promise<{ pw_hash: string; pw_salt: string; status: string } | null> {
  return (await db.prepare("SELECT pw_hash, pw_salt, status FROM users WHERE id = ?1").bind(userId).first<{ pw_hash: string; pw_salt: string; status: string }>()) ?? null;
}

// ---------------- retention ----------------
/** Deletes the bytes of screenshots older than `before` and stamps purged_at. Rows stay. At most 200 per run. */
export async function purgeOldBytes(db: D1Database, before: number, now: number): Promise<number> {
  const due = await db.prepare("SELECT id FROM feedback_attachments WHERE purged_at IS NULL AND created_at < ?1 LIMIT 200").bind(before).all<{ id: string }>();
  if (due.results.length === 0) return 0;
  const ids = JSON.stringify(due.results.map((r) => r.id));
  await db.batch([
    db.prepare("DELETE FROM feedback_attachment_blobs WHERE attachment_id IN (SELECT value FROM json_each(?1))").bind(ids),
    db.prepare("UPDATE feedback_attachments SET purged_at = ?2 WHERE id IN (SELECT value FROM json_each(?1))").bind(ids, now),
  ]);
  return due.results.length;
}
/** Deletes reports created before `before` (with attachments and bytes). At most 200 per run. */
export async function deleteOldReports(db: D1Database, before: number): Promise<number> {
  const due = await db.prepare("SELECT id FROM feedback_reports WHERE created_at < ?1 LIMIT 200").bind(before).all<{ id: string }>();
  if (due.results.length === 0) return 0;
  const ids = JSON.stringify(due.results.map((r) => r.id));
  await db.batch([
    db.prepare("DELETE FROM feedback_attachment_blobs WHERE attachment_id IN (SELECT id FROM feedback_attachments WHERE report_id IN (SELECT value FROM json_each(?1)))").bind(ids),
    db.prepare("DELETE FROM feedback_attachments WHERE report_id IN (SELECT value FROM json_each(?1))").bind(ids),
    db.prepare("DELETE FROM feedback_reports WHERE id IN (SELECT value FROM json_each(?1))").bind(ids),
  ]);
  return due.results.length;
}

// ---------------- staff reads (never select blobs, ip_hash or the token hash) ----------------
// Column lists are written out in each statement: every prepare() takes a constant string (test/hardening.test.ts).

export interface ListFilter { status?: string; kind?: string; page?: string; q?: string; limit: number; cursor?: { at: number; id: string } }
export async function listReports(db: D1Database, f: ListFilter): Promise<ReportRow[]> {
  const like = f.q === undefined ? null : `%${f.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const r = await db
    .prepare(
      "SELECT r.id, r.created_at, r.updated_at, r.kind, r.message, r.page_path, r.page_title, r.referrer_path, r.viewport_w, r.viewport_h, r.device_class, r.browser_family, r.locale, r.build_id, r.signed_in, r.user_id, r.contact, r.client_errors, r.consent_version, r.status, r.staff_note, (SELECT COUNT(*) FROM feedback_attachments a WHERE a.report_id = r.id) AS attachment_count FROM feedback_reports r WHERE (?1 IS NULL OR r.status = ?1) AND (?2 IS NULL OR r.kind = ?2) AND (?3 IS NULL OR r.page_path = ?3) AND (?4 IS NULL OR r.message LIKE ?4 ESCAPE '\\') AND (?5 IS NULL OR r.created_at < ?5 OR (r.created_at = ?5 AND r.id < ?6)) ORDER BY r.created_at DESC, r.id DESC LIMIT ?7",
    )
    .bind(f.status ?? null, f.kind ?? null, f.page ?? null, like, f.cursor?.at ?? null, f.cursor?.id ?? "", f.limit)
    .all<ReportRow>();
  return r.results;
}
export async function getReport(db: D1Database, id: string): Promise<ReportRow | null> {
  return (await db.prepare("SELECT r.id, r.created_at, r.updated_at, r.kind, r.message, r.page_path, r.page_title, r.referrer_path, r.viewport_w, r.viewport_h, r.device_class, r.browser_family, r.locale, r.build_id, r.signed_in, r.user_id, r.contact, r.client_errors, r.consent_version, r.status, r.staff_note, (SELECT COUNT(*) FROM feedback_attachments a WHERE a.report_id = r.id) AS attachment_count FROM feedback_reports r WHERE r.id = ?1").bind(id).first<ReportRow>()) ?? null;
}
export async function listAttachmentMeta(db: D1Database, reportId: string): Promise<AttachmentMeta[]> {
  return (await db.prepare("SELECT id, mime, size_bytes, sha256, created_at, purged_at FROM feedback_attachments WHERE report_id = ?1 ORDER BY created_at, rowid").bind(reportId).all<AttachmentMeta>()).results;
}
export async function attachmentFile(db: D1Database, reportId: string, attachmentId: string): Promise<{ mime: string; bytes: Uint8Array } | "purged" | null> {
  const m = await db.prepare("SELECT mime, purged_at FROM feedback_attachments WHERE id = ?1 AND report_id = ?2").bind(attachmentId, reportId).first<{ mime: string; purged_at: number | null }>();
  if (!m) return null;
  if (m.purged_at !== null) return "purged";
  const b = await db.prepare("SELECT data FROM feedback_attachment_blobs WHERE attachment_id = ?1").bind(attachmentId).first<{ data: unknown }>();
  return b ? { mime: m.mime, bytes: blobBytes(b.data) } : "purged";
}

/** Updates status and/or note and writes the audit row in the same batch. Returns false when the report does not exist. */
export async function updateReport(db: D1Database, id: string, patch: { status?: string; staffNote?: string | null; setNote: boolean }, at: number, audit: D1PreparedStatement[]): Promise<boolean> {
  const res = await db.batch([
    db.prepare("UPDATE feedback_reports SET status = COALESCE(?2, status), staff_note = CASE WHEN ?3 = 1 THEN ?4 ELSE staff_note END, updated_at = ?5 WHERE id = ?1").bind(id, patch.status ?? null, patch.setNote ? 1 : 0, patch.staffNote ?? null, at),
    ...audit,
  ]);
  return (res[0]?.meta.changes ?? 0) === 1;
}

export async function summary(db: D1Database, since30: number, since7: number): Promise<{ byStatus: { k: string; n: number }[]; byKind: { k: string; n: number }[]; pages: { page_path: string; n: number }[]; new7: number }> {
  const [s, k, p, n7] = await db.batch([
    db.prepare("SELECT status AS k, COUNT(*) AS n FROM feedback_reports GROUP BY status"),
    db.prepare("SELECT kind AS k, COUNT(*) AS n FROM feedback_reports GROUP BY kind"),
    db.prepare("SELECT page_path, COUNT(*) AS n FROM feedback_reports WHERE created_at >= ?1 GROUP BY page_path ORDER BY n DESC, page_path LIMIT 10").bind(since30),
    db.prepare("SELECT COUNT(*) AS n FROM feedback_reports WHERE created_at >= ?1").bind(since7),
  ]);
  return {
    byStatus: (s!.results as { k: string; n: number }[]),
    byKind: (k!.results as { k: string; n: number }[]),
    pages: (p!.results as { page_path: string; n: number }[]),
    new7: (n7!.results[0] as { n: number }).n,
  };
}
