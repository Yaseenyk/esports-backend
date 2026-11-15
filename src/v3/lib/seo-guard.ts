/**
 * THIN-PAGE GUARD (esports-hub CLAUDE.md "Programmatic SEO rules", README ADR-5). Pure and dependency-free: it is shared with the frontend build
 * (scripts/verify-seo.mjs) by copying or importing this plain TS file. A tournament page is indexable only when EVERY line holds.
 */
export interface SeoGuardInput {
  title: string | null | undefined;
  /** True when no OTHER published tournament has the same title (case-insensitive). The caller computes it; unknown counts as not unique. */
  titleIsUnique: boolean;
  summary: string | null | undefined;
  description: string | null | undefined;
  /** Epoch seconds. */
  startsAt: number | null | undefined;
  venue: "online" | "offline" | "hybrid" | null | undefined;
  city: string | null | undefined;
  status: string;
  /** Verified results exist for the event (head-to-head finished match or battle royale rows). */
  hasVerifiedResults: boolean;
  /** Epoch seconds of the organiser's publish click. */
  publishedAt: number | null | undefined;
}

export const SEO_SUMMARY_MIN = 80;
export const SEO_DESCRIPTION_MIN = 200;
export const SEO_TITLE_MIN = 8;

export interface SeoVerdict {
  ready: boolean;
  /** Machine-readable names of the lines that failed (empty when ready). */
  failures: string[];
}

const len = (s: string | null | undefined): number => (typeof s === "string" ? s.trim().length : 0);

export function seoVerdict(i: SeoGuardInput): SeoVerdict {
  const f: string[] = [];
  if (len(i.title) < SEO_TITLE_MIN || !i.titleIsUnique) f.push("title_unique");
  if (len(i.summary) < SEO_SUMMARY_MIN) f.push("summary_80");
  if (len(i.description) < SEO_DESCRIPTION_MIN) f.push("description_200");
  if (!i.startsAt) f.push("start_date");
  // "a venue or an online flag": online counts by itself; offline or hybrid needs a city.
  if (!(i.venue === "online" || (i.venue && len(i.city) > 0))) f.push("venue");
  if (!(i.status === "registration_open" || i.hasVerifiedResults)) f.push("registration_or_results");
  if (!i.publishedAt || i.status === "draft" || i.status === "cancelled") f.push("published");
  return { ready: f.length === 0, failures: f };
}

export const seoReady = (i: SeoGuardInput): boolean => seoVerdict(i).ready;
