/**
 * Moderation vocabulary (blueprint 9.2). Pure module: no database, no Workers imports.
 * Targets are always IMMUTABLE ids (dev-review-r2 N-12), never a slug or a token.
 */
export const REPORT_REASONS = ["spam", "scam", "minor_exposed", "contact_details", "offensive", "copyright", "wrong_info", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

/** Targets a report row may name (directory reports stay in S4's directory_reports). */
export const REPORT_TARGETS = ["team_profile", "live_page", "league_page", "registration_form", "event", "pass", "results"] as const;
/** Targets a takedown may name: the report targets plus the directory entry (the second moderation source, next to S4's held_at). */
export const TAKEDOWN_TARGETS = [...REPORT_TARGETS, "directory_entry"] as const;
export type TargetType = (typeof TAKEDOWN_TARGETS)[number];

/** The public page kinds a visitor can report from (one route for all). */
export const PUBLIC_KINDS = ["live", "team", "league", "registration", "directory", "pass", "results"] as const;
export type PublicKind = (typeof PUBLIC_KINDS)[number];

/** Distinct reporters that hide a target for an ordinary reason. */
export const AUTO_HIDE_AT = 3;
/** The promise shown on the report page (owner decision OD-H). */
export const REVIEW_PROMISE = "We review every report within 3 days. A report that says a child is shown hides the page at once.";
export const NOTE_MAX = 200;

export const isReason = (v: unknown): v is ReportReason => typeof v === "string" && (REPORT_REASONS as readonly string[]).includes(v);
export const isTargetType = (v: unknown): v is TargetType => typeof v === "string" && (TAKEDOWN_TARGETS as readonly string[]).includes(v);
export const isPublicKind = (v: unknown): v is PublicKind => typeof v === "string" && (PUBLIC_KINDS as readonly string[]).includes(v);

/** A minor report hides on ONE report: a false positive costs a reviewed restore, a false negative is not acceptable. */
export const hidesAtOnce = (reason: ReportReason): boolean => reason === "minor_exposed";

/** Queue priority (0 to 3): a child shown is first, then personal details, then fraud. */
export function priorityOf(reason: ReportReason): number {
  switch (reason) {
    case "minor_exposed": return 3;
    case "contact_details": return 2;
    case "scam": return 1;
    default: return 0;
  }
}

/** Staff reason code shape (same as audit_log.reason_code). */
export const REASON_CODE_RE = /^[a-z_]{1,24}$/;
export const isReasonCode = (v: unknown): v is string => typeof v === "string" && REASON_CODE_RE.test(v);
export const ID_RE = /^[A-Za-z0-9._~-]{1,64}$/;

/**
 * Untrusted note: control, bidi and zero-width characters become spaces, whitespace collapses, markup characters are dropped (it is rendered as text only and
 * never auto-linked), and the result is cut to NOTE_MAX characters. Non-strings give "".
 */
export function sanitiseNote(v: unknown): string {
  if (typeof v !== "string") return "";
  const t = v
    .slice(0, 2000)
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, " ")
    .replace(/[<>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(t).slice(0, NOTE_MAX).join("").trim();
}
