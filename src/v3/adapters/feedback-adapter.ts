/** Feedback rows to staff JSON. Builds payloads only: no SQL, repositories as type imports. Never emits ip_hash, token hashes or bytes. */
import type { AttachmentMeta, ReportRow } from "../repositories/feedback-repo";
import { toIso } from "../lib/ids";

function errors(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** The list item: no contact, no user id. */
export function reportItem(r: ReportRow) {
  return {
    id: r.id,
    createdAt: toIso(r.created_at),
    kind: r.kind,
    status: r.status,
    message: r.message,
    pagePath: r.page_path,
    pageTitle: r.page_title,
    viewport: { w: r.viewport_w, h: r.viewport_h },
    deviceClass: r.device_class,
    browserFamily: r.browser_family,
    locale: r.locale,
    buildId: r.build_id,
    signedIn: r.signed_in === 1,
    linkedAccount: r.user_id !== null,
    hasContact: r.contact !== null,
    clientErrors: errors(r.client_errors),
    consentVersion: r.consent_version,
    staffNote: r.staff_note,
    attachmentCount: r.attachment_count,
  };
}

export function reportDetail(r: ReportRow, atts: AttachmentMeta[]) {
  return {
    ...reportItem(r),
    updatedAt: toIso(r.updated_at),
    contact: r.contact,
    userId: r.user_id,
    referrerPath: r.referrer_path,
    attachments: atts.map((a) => ({ id: a.id, mime: a.mime, sizeBytes: a.size_bytes, sha256: a.sha256, createdAt: toIso(a.created_at), purged: a.purged_at !== null })),
  };
}
