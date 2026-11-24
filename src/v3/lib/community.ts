/**
 * Community features (college esports calendar, organiser trust score): constants and pure rules. Dependency-free, so the frontend tests can mirror
 * the numbers and the score maths can be unit-tested without a database.
 */

export const CALENDAR = {
  /** The public calendar page may be indexed only with at least this many upcoming entries from verified organisations. */
  MIN_UPCOMING_FOR_INDEX: 5,
  /** Listed upcoming entries one organisation may have at once. */
  MAX_UPCOMING_PER_ORG: 30,
  /** An event may last at most this many days (a fest week plus a weekend). */
  MAX_SPAN_DAYS: 31,
  /** How far ahead an entry may start. */
  MAX_AHEAD_DAYS: 400,
  /** Rows one public read returns at most. */
  LIST_MAX: 300,
} as const;

export const TRUST = {
  /** No average is published below this many visible ratings. */
  MIN_RATINGS: 5,
  /** Ratings open when the event ends and close this many days later. */
  WINDOW_DAYS: 30,
  /** Reviews returned with the public summary. */
  REVIEWS_MAX: 50,
  REVIEW_MAX: 1000,
  REPLY_MAX: 1000,
  NOTE_MAX: 200,
} as const;

export const TRUST_REPORT_REASONS = ["abuse", "personal_info", "false_claim", "spam", "conflict_of_interest", "other"] as const;
export type TrustReportReason = (typeof TRUST_REPORT_REASONS)[number];
export const TRUST_TARGETS = ["review", "reply"] as const;
export type TrustTarget = (typeof TRUST_TARGETS)[number];
/** Reason codes staff pick when hiding or restoring (stored in the moderation log and audit_log.reason_code). */
export const MODERATION_REASONS = ["abuse", "personal_info", "false_claim", "spam", "conflict_of_interest", "off_topic", "report_unfounded", "appeal_upheld", "other"] as const;
export type ModerationReason = (typeof MODERATION_REASONS)[number];

/** Hosts a registration link may never point at: payment pages (no money on this platform) and link shorteners (they hide the destination). */
const BLOCKED_HOSTS = /(^|\.)(razorpay|stripe|paytm|payu|phonepe|cashfree|paypal|braintree|instamojo|billdesk|ccavenue|juspay|adyen|bit\.ly|tinyurl|t\.co|cutt\.ly|rb\.gy|is\.gd|shorturl)(\.|$)/i;

export type UrlCheck = { ok: true; url: string; stripped: boolean } | { ok: false; code: "url_not_https" | "url_invalid" | "url_blocked_host" | "url_too_long" };

/**
 * A registration link as it may be stored: https only, no credentials, no port, a public-looking host, and NEVER a query string or fragment (those
 * are where secret tokens live, for example our own `?t=` invite links). The query and fragment are removed, not rejected, and the caller is told.
 */
export function cleanRegistrationUrl(raw: string): UrlCheck {
  const s = raw.trim();
  if (s.length > 600) return { ok: false, code: "url_too_long" };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, code: "url_invalid" };
  }
  if (u.protocol !== "https:") return { ok: false, code: "url_not_https" };
  if (u.username || u.password || u.port) return { ok: false, code: "url_invalid" };
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host) || /^\d+\.\d+\.\d+\.\d+$/.test(host) || host === "localhost") return { ok: false, code: "url_invalid" };
  if (BLOCKED_HOSTS.test(host)) return { ok: false, code: "url_blocked_host" };
  const stripped = u.search !== "" || u.hash !== "" || s.includes("?") || s.includes("#");
  const out = `https://${host}${u.pathname}`;
  if (out.length > 300) return { ok: false, code: "url_too_long" };
  return { ok: true, url: out, stripped };
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** A real calendar day "YYYY-MM-DD" (rejects 2026-02-30), or null. */
export function parseDay(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = DAY_RE.exec(v);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === v ? v : null;
}
/** Today in India (the audience): calendar days are local days. */
export const todayIst = (nowMs: number = Date.now()): string => new Date(nowMs + 330 * 60_000).toISOString().slice(0, 10);
export const addDays = (day: string, n: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string): number => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/** The rating window of one event: it opens when the event ends (ends_at, or starts_at when no end is set) and lasts TRUST.WINDOW_DAYS. */
export function ratingWindow(t: { startsAt: number | null; endsAt: number | null }, nowS: number): { opensAt: number | null; closesAt: number | null; state: "no_dates" | "not_yet" | "open" | "closed" } {
  const end = t.endsAt ?? t.startsAt;
  if (end === null) return { opensAt: null, closesAt: null, state: "no_dates" };
  const closesAt = end + TRUST.WINDOW_DAYS * 86_400;
  return { opensAt: end, closesAt, state: nowS < end ? "not_yet" : nowS > closesAt ? "closed" : "open" };
}

export interface RatingStars { stars: number; onTime: number; fair: number; communication: number }
export interface TrustScore {
  count: number;
  minimum: number;
  /** null below the minimum: no average, no breakdown, so a handful of ratings cannot be read one by one. */
  average: number | null;
  aspects: { onTime: number; fair: number; communication: number } | null;
  distribution: { 1: number; 2: number; 3: number; 4: number; 5: number } | null;
}
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** The published score: a plain average of the overall stars of every visible rating, one decimal, with the count and the breakdown. No weighting. */
export function trustScore(rows: readonly RatingStars[], minimum: number = TRUST.MIN_RATINGS): TrustScore {
  const count = rows.length;
  if (count < minimum || count === 0) return { count, minimum, average: null, aspects: null, distribution: null };
  const sum = (f: (r: RatingStars) => number) => rows.reduce((a, r) => a + f(r), 0);
  const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const r of rows) distribution[r.stars as 1 | 2 | 3 | 4 | 5]++;
  return {
    count, minimum,
    average: round1(sum((r) => r.stars) / count),
    aspects: { onTime: round1(sum((r) => r.onTime) / count), fair: round1(sum((r) => r.fair) / count), communication: round1(sum((r) => r.communication) / count) },
    distribution,
  };
}

/** Display names that would make a review look anonymous or official are refused. */
export function displayNameProblem(name: string): "name_anonymous" | null {
  return /^(anon(ymous)?|guest|user|player|unknown|someone|admin|staff|moderator|esports hub|organiser|organizer)\d*$/i.test(name.replace(/\s+/g, " ").trim()) ? "name_anonymous" : null;
}

/**
 * The trust score is per organiser: the organisation that owns the event (every event created since the organisations backfill has one, a
 * personal organisation for a solo organiser). An old event without one is scored on its own.
 */
export const organiserKeyOf = (e: { orgId: string | null; eventId: string }): string => (e.orgId ? `org:${e.orgId}` : `event:${e.eventId}`);

/** A pass link as pasted (`https://.../pass/?t=TOKEN`, `?t=TOKEN` or the bare token) to the token, or null. Never stored. */
export function tokenFromLink(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (s.length < 8 || s.length > 400) return null;
  const m = /[?&#]t=([A-Za-z0-9_-]{8,64})(?:[&#]|$)/.exec(s);
  const tok = m ? m[1]! : s;
  return /^[A-Za-z0-9_-]{8,64}$/.test(tok) ? tok : null;
}
