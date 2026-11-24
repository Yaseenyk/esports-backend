/**
 * Payloads of the community features (calendar, organiser trust). Explicit field lists only: no organisation id on a public entry, no user id,
 * proof reference, reporter or staff id on a public review. Repositories are type imports only.
 */
import { toIso } from "../lib/ids";
import type { TrustScore } from "../lib/community";
import type { CalendarRow, EntryActionRow } from "../repositories/calendar-repo";
import type { ActionRow, PublicReviewRow, RatingRow, ReportQueueRow } from "../repositories/trust-repo";

/** A calendar entry for the public page. `tournamentSlug` only when that tournament is public; a cancelled entry keeps its row with status "cancelled". */
export const toPublicEntry = (r: CalendarRow) => ({
  id: r.id,
  title: r.title,
  game: r.game,
  city: r.city,
  online: r.online === 1,
  startsOn: r.starts_on,
  endsOn: r.ends_on,
  status: r.status,
  registrationUrl: r.registration_url,
  tournamentSlug: r.tournament_public === 1 ? r.tournament_slug : null,
  organiser: { name: r.org_name, slug: r.org_slug, verified: true },
});

/** An entry as its own organisation sees it (adds the hidden state and the reason staff gave). */
export const toOwnEntry = (r: CalendarRow) => ({
  ...toPublicEntry(r),
  orgId: r.org_id,
  tournamentSlug: r.tournament_slug,
  hidden: r.hidden_at !== null,
  hiddenReason: r.hidden_reason,
  updatedAt: toIso(r.updated_at),
});

export const toEntryAction = (a: EntryActionRow) => ({ action: a.action, reason: a.reason_code, note: a.note, staffId: a.staff_user_id, at: toIso(a.created_at) });

// ---------------- trust ----------------

/** One public review. Stars are shown only when the organiser's score itself is shown (the minimum count is reached). */
export function toPublicReview(r: PublicReviewRow, showStars: boolean) {
  return {
    id: r.id,
    displayName: r.display_name,
    verifiedAs: r.proof_kind === "played" ? "played" : "checked_in",
    stars: showStars ? r.stars : null,
    review: r.review,
    createdAt: toIso(r.created_at),
    tournament: r.t_slug ? { slug: r.t_slug, title: r.t_title } : null,
    reply: r.reply && r.reply_hidden_at === null ? { text: r.reply, at: toIso(r.reply_at) } : null,
    replyHidden: r.reply !== null && r.reply_hidden_at !== null,
  };
}

export const toScore = (s: TrustScore) => ({ count: s.count, minimum: s.minimum, average: s.average, aspects: s.aspects, distribution: s.distribution });

/** The rater's own row (everything they wrote, plus whether staff hid it and why). */
export const toOwnRating = (r: RatingRow & { t_slug?: string | null; t_title?: string | null }) => ({
  id: r.id,
  displayName: r.display_name,
  verifiedAs: r.proof_kind,
  stars: r.stars,
  onTime: r.on_time,
  fair: r.fair_play,
  communication: r.communication,
  review: r.review,
  reply: r.reply ? { text: r.reply, at: toIso(r.reply_at), hidden: r.reply_hidden_at !== null } : null,
  hidden: r.hidden_at !== null,
  hiddenReason: r.hidden_reason,
  createdAt: toIso(r.created_at),
  ...(r.t_slug !== undefined ? { tournament: r.t_slug ? { slug: r.t_slug, title: r.t_title ?? null } : null } : {}),
});

export const toQueueItem = (q: ReportQueueRow) => ({
  id: q.id,
  ratingId: q.rating_id,
  target: q.target,
  reason: q.reason_code,
  note: q.note,
  status: q.status,
  createdAt: toIso(q.created_at),
  rating: { displayName: q.display_name, stars: q.stars, review: q.review, reply: q.reply, hidden: q.hidden_at !== null, replyHidden: q.reply_hidden_at !== null, eventId: q.event_id },
});

export const toAction = (a: ActionRow) => ({ target: a.target, action: a.action, reason: a.reason_code, note: a.note, staffId: a.staff_user_id, at: toIso(a.created_at) });
