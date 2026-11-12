/**
 * Plans and entitlements (Phase 7, designed in, nothing charged). There is ONE plan, 'free', and every subject is on it today.
 *
 *  - No payment code, no checkout, no provider, no prices anywhere in this repository.
 *  - `can(subject, feature)` is pure and always resolves to the free plan. When a second plan exists, this is the one place that reads `entitlements`.
 *  - FREE_LIMITS mirrors the seed row of migration 0049 (the documented free-tier numbers in docs/ecosystem/limits-verified.md plus the two caps this code enforces).
 */
export type Subject = `user:${string}` | `org:${string}`;
export const FEATURES = ["analytics", "api_keys", "api_read"] as const;
export type Feature = (typeof FEATURES)[number];

export const FREE_PLAN_ID = "free";
export const API_KEYS_MAX = 5;
export const ANALYTICS_MONTHS_MAX = 12;

export const FREE_LIMITS = {
  apiKeysMax: API_KEYS_MAX,
  analyticsWindowMonthsMax: ANALYTICS_MONTHS_MAX,
  platform: { d1RowsReadPerDay: 5_000_000, d1RowsWrittenPerDay: 100_000, workersRequestsPerDay: 100_000, d1StorageBytes: 5_000_000_000 },
} as const;

const FREE_FEATURES: readonly Feature[] = FEATURES;

export const subjectOf = (kind: "user" | "org", id: string): Subject => `${kind}:${id}`;

/** The plan a subject is on: always the free plan today. */
export function planOf(subject: Subject): string {
  void subject;
  return FREE_PLAN_ID;
}

/** Whether the subject's plan includes the feature. Always the free plan today, which includes every feature this code has. */
export const can = (subject: Subject, feature: Feature): boolean => planOf(subject) === FREE_PLAN_ID && FREE_FEATURES.includes(feature);
