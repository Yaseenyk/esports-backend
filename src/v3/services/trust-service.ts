/**
 * Organiser trust score. Proof-based only:
 *  - a rating needs PROOF that the player took part in THAT event: their own pass link for a roster entry that was scanned in at the gate (checked_in),
 *    or a captain link / captain claim for a team with an approved registration and a verified result (played). A minor's roster entry never qualifies.
 *  - one rating per player per event, and one per pass / team per event (unique indexes), only inside the window (event end + TRUST.WINDOW_DAYS).
 *  - the organiser (anyone with access to the event) cannot rate their own event.
 *  - the public score is a plain average of the visible ratings, shown only from TRUST.MIN_RATINGS ratings, with the count and the breakdown.
 *  - written reviews are tied to the account and shown with the display name the player chose (names that read as anonymous are refused).
 *  - the organiser may reply once per review; anyone signed in may report; staff hide / restore with a reason (log + audit row). No auto-hide on reports.
 * No SQL here. Not found and not allowed answer the same 404.
 */
import { auditOff, auditStmts } from "../../audit";
import { sha256 } from "../../crypto";
import { HttpError } from "../../http";
import { hashToken } from "../../links";
import {
  MODERATION_REASONS, TRUST, TRUST_REPORT_REASONS, TRUST_TARGETS, displayNameProblem, organiserKeyOf, ratingWindow, tokenFromLink, trustScore, type TrustTarget,
} from "../lib/community";
import { ID32_RE, newId, nowSec, toIso } from "../lib/ids";
import { bad, optText, reqEnum, reqText } from "../lib/validate";
import { loadEventAccess } from "../repositories/event-access-repo";
import * as tournaments from "../repositories/tournament-repo";
import { PUBLIC_STATUSES } from "../repositories/tournament-repo";
import * as repo from "../repositories/trust-repo";
import * as users from "../repositories/user-repo";
import { toAction, toOwnRating, toPublicReview, toQueueItem, toScore } from "../adapters/community-adapter";

type Body = Record<string, unknown>;
const notFound = () => new HttpError(404, "Not found");

async function requireAdult(db: D1Database, userId: string): Promise<void> {
  const u = await users.getUserV3(db, userId);
  if (!u) throw new HttpError(401, "Authentication required");
  if (u.adultConfirmedAt === null) throw new HttpError(403, "Confirm that you are 18 or older first", { code: "adult_required" });
}

/** A PUBLIC, not taken-down tournament and the facts of its event. Anything else is the same 404. */
async function publicTournament(db: D1Database, slug: string) {
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) throw notFound();
  const t = await tournaments.findBySlug(db, slug);
  if (!t || !(PUBLIC_STATUSES as readonly string[]).includes(t.status)) throw notFound();
  if (await tournaments.eventHidden(db, t.eventId)) throw notFound();
  const ev = await repo.eventFacts(db, t.eventId);
  if (!ev) throw notFound();
  return { t, ev, key: organiserKeyOf(ev) };
}

const organiserOf = (ev: repo.EventFacts) => ({ name: ev.orgName ?? (ev.organiserText.trim() ? ev.organiserText.trim().slice(0, 80) : null), verified: ev.orgVerified });
const windowOut = (w: ReturnType<typeof ratingWindow>) => ({ state: w.state, opensAt: toIso(w.opensAt), closesAt: toIso(w.closesAt), days: TRUST.WINDOW_DAYS });

async function scoreOf(db: D1Database, key: string) {
  const rows = await repo.visibleStars(db, key);
  return trustScore(rows.map((r) => ({ stars: r.stars, onTime: r.on_time, fair: r.fair_play, communication: r.communication })));
}

// ---------------- public ----------------

/** GET /public/tournaments/:slug/trust: the organiser's score across all their events, recent reviews, and this event's rating window. */
export async function publicTrust(db: D1Database, slug: string, nowS: number = nowSec()) {
  const { t, ev, key } = await publicTournament(db, slug);
  const score = await scoreOf(db, key);
  const reviews = await repo.visibleReviews(db, key, TRUST.REVIEWS_MAX);
  return {
    tournament: { slug: t.slug, title: t.title },
    organiser: organiserOf(ev),
    score: toScore(score),
    reviews: reviews.map((r) => toPublicReview(r, score.average !== null)),
    window: windowOut(ratingWindow({ startsAt: t.startsAt, endsAt: t.endsAt }, nowS)),
  };
}

// ---------------- signed in ----------------

/** GET /v3/tournaments/:slug/trust/me: what this user may do here. */
export async function myTrust(db: D1Database, userId: string, slug: string, nowS: number = nowSec()) {
  const { t } = await publicTournament(db, slug);
  const [u, access, mine, name] = await Promise.all([users.getUserV3(db, userId), loadEventAccess(db, userId, t.eventId), repo.myRating(db, t.eventId, userId), repo.accountName(db, userId)]);
  if (!u) throw new HttpError(401, "Authentication required");
  return {
    adultConfirmed: u.adultConfirmedAt !== null,
    isOrganiser: access !== null,
    canReply: access?.canWrite === true,
    window: windowOut(ratingWindow({ startsAt: t.startsAt, endsAt: t.endsAt }, nowS)),
    myRating: mine ? toOwnRating(mine) : null,
    suggestedName: name ? name.slice(0, 40) : null,
  };
}

const stars = (v: unknown, field: string): number => {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 5) throw bad(`${field} must be a whole number from 1 to 5`, `invalid_${field}`);
  return v;
};

/** Proof that THIS user took part in THIS event. Throws 403 with a code the screen can explain. The presented link is never stored. */
async function proveParticipation(db: D1Database, eventId: string, userId: string, p: unknown): Promise<{ kind: "checked_in" | "played"; ref: string }> {
  const o = (p && typeof p === "object" ? p : {}) as Record<string, unknown>;
  const kind = reqEnum(o.kind, ["pass", "captain"] as const, "proof");
  if (kind === "pass") {
    const token = tokenFromLink(o.link);
    if (!token) throw bad("Paste the link to your pass for this event", "invalid_proof");
    const person = await repo.passPerson(db, eventId, await hashToken(token), token);
    if (!person) throw new HttpError(403, "That pass link does not belong to this event", { code: "proof_not_found" });
    if (person.minor) throw new HttpError(403, "This roster entry is marked under 18, so it cannot be used to rate", { code: "minor_roster" });
    if (!person.checkedIn) throw new HttpError(403, "This pass was never scanned in at the event, so it cannot be used to rate", { code: "not_checked_in" });
    return { kind: "checked_in", ref: `person:${person.personId}` };
  }
  let teams: string[];
  if (o.link !== undefined && o.link !== null && o.link !== "") {
    const token = tokenFromLink(o.link);
    if (!token) throw bad("Paste your captain link for this event", "invalid_proof");
    const team = await repo.captainLinkTeam(db, eventId, await sha256(token));
    if (!team) throw new HttpError(403, "That captain link does not belong to this event", { code: "proof_not_found" });
    teams = [team];
  } else {
    teams = await repo.claimedTeams(db, eventId, userId);
    if (teams.length === 0) throw new HttpError(403, "Paste your captain link for this event", { code: "proof_not_found" });
  }
  for (const team of teams) if (await repo.teamPlayed(db, eventId, team)) return { kind: "played", ref: `team:${team.toLowerCase().slice(0, 100)}` };
  throw new HttpError(403, "That team has no approved registration with a verified result in this event", { code: "team_not_played" });
}

/** POST /v3/tournaments/:slug/trust/ratings. */
export async function rateOrganiser(db: D1Database, userId: string, slug: string, b: Body, nowS: number = nowSec()) {
  const { t, key } = await publicTournament(db, slug);
  await requireAdult(db, userId);
  if (await loadEventAccess(db, userId, t.eventId)) throw new HttpError(403, "You run this event, so you cannot rate it", { code: "own_event" });
  const w = ratingWindow({ startsAt: t.startsAt, endsAt: t.endsAt }, nowS);
  if (w.state !== "open") {
    const msg = { no_dates: "This event has no dates, so it cannot be rated", not_yet: "Ratings open when the event ends", closed: `Ratings closed ${TRUST.WINDOW_DAYS} days after the event` }[w.state];
    throw new HttpError(409, msg, { code: `window_${w.state}` });
  }
  const s = stars(b.stars, "stars"), onTime = stars(b.onTime, "onTime"), fair = stars(b.fair, "fair"), communication = stars(b.communication, "communication");
  const displayName = reqText(b.displayName, "displayName", 2, 40);
  if (displayNameProblem(displayName)) throw bad("Use the name people know you by. Reviews are never anonymous.", "name_anonymous");
  const review = optText(b.review, "review", TRUST.REVIEW_MAX, 10) ?? null;
  const proof = await proveParticipation(db, t.eventId, userId, b.proof);
  const id = newId();
  const res = await repo.insertRating(db, { id, eventId: t.eventId, organiserKey: key, userId, displayName, proofKind: proof.kind, proofRef: proof.ref, stars: s, onTime, fair, communication, review, at: nowS });
  if (res === "dup_user") throw new HttpError(409, "You have already rated this event", { code: "already_rated" });
  if (res === "dup_proof") throw new HttpError(409, "That pass or team has already been used to rate this event", { code: "proof_used" });
  return toOwnRating((await repo.findRating(db, id))!);
}

/** DELETE /v3/trust/ratings/:id: the rater removes their own rating (and review). */
export async function deleteMyRating(db: D1Database, userId: string, id: string) {
  if (!ID32_RE.test(id) || !(await repo.deleteRating(db, id, userId))) throw notFound();
  return { ok: true };
}

/** GET /v3/me/trust/ratings: every rating the user gave. */
export async function myRatings(db: D1Database, userId: string) {
  return { items: (await repo.ratingsOfUser(db, userId)).map(toOwnRating) };
}

/** POST /v3/trust/ratings/:id/reply: the organiser (owner, editor, organisation admin) answers a written review once, publicly. */
export async function replyToReview(db: D1Database, userId: string, id: string, b: Body) {
  if (!ID32_RE.test(id)) throw notFound();
  const r = await repo.findRating(db, id);
  if (!r) throw notFound();
  const access = await loadEventAccess(db, userId, r.event_id);
  if (!access?.canWrite) throw notFound();
  await requireAdult(db, userId);
  if (r.hidden_at !== null) throw new HttpError(409, "This review is hidden by a moderator", { code: "review_hidden" });
  if (r.review === null) throw new HttpError(409, "Only written reviews can be answered", { code: "nothing_to_reply" });
  const text = reqText(b.text, "text", 2, TRUST.REPLY_MAX);
  const at = nowSec();
  if (!(await repo.setReplyOnce(db, r.id, text, userId, at))) throw new HttpError(409, "You have already replied to this review", { code: "already_replied" });
  return { ok: true, reply: { text, at: toIso(at) } };
}

/** POST /v3/trust/ratings/:id/report: a signed-in, 18+ user flags a review or a reply for staff. Nothing is hidden until a moderator decides. */
export async function reportReview(db: D1Database, userId: string, id: string, b: Body) {
  if (!ID32_RE.test(id)) throw notFound();
  const r = await repo.findRating(db, id);
  if (!r || r.hidden_at !== null) throw notFound();
  const target = reqEnum(b.target ?? "review", TRUST_TARGETS, "target");
  if (target === "reply" && (r.reply === null || r.reply_hidden_at !== null)) throw notFound();
  if (target === "review" && r.user_id === userId) throw new HttpError(403, "You cannot report your own review", { code: "own_review" });
  await requireAdult(db, userId);
  const reason = reqEnum(b.reason, TRUST_REPORT_REASONS, "reason");
  const note = optText(b.note, "note", TRUST.NOTE_MAX) ?? "";
  if (!(await repo.insertReport(db, { id: newId(), ratingId: r.id, target, reporterId: userId, reason, note, at: nowSec() }))) {
    throw new HttpError(409, "You have already reported this", { code: "already_reported" });
  }
  return { ok: true };
}

// ---------------- staff ----------------

export async function staffReportQueue(db: D1Database, status: string | undefined) {
  const s = status === undefined || status === "" ? "open" : reqEnum(status, ["open", "actioned", "dismissed"] as const, "status");
  return { items: (await repo.reportQueue(db, s, 200)).map(toQueueItem) };
}

export async function staffRating(db: D1Database, id: string) {
  if (!ID32_RE.test(id)) throw notFound();
  const r = await repo.findRating(db, id);
  if (!r) throw notFound();
  const [actions, reports] = await Promise.all([repo.actionsOf(db, id), repo.reportsOf(db, id)]);
  return {
    rating: { ...toOwnRating(r), userId: r.user_id, eventId: r.event_id, replyHidden: r.reply_hidden_at !== null, replyHiddenReason: r.reply_hidden_reason },
    reports: reports.map((x) => ({ id: x.id, target: x.target, reason: x.reason_code, note: x.note, status: x.status, createdAt: toIso(x.created_at) })),
    actions: actions.map(toAction),
  };
}

function moderationInput(b: Body) {
  const target: TrustTarget = reqEnum(b.target ?? "review", TRUST_TARGETS, "target");
  const reason = reqEnum(b.reason, MODERATION_REASONS, "reason");
  const note = optText(b.note, "note", 300) ?? "";
  return { target, reason, note };
}

/** POST /admin/v1/v3/trust/ratings/:id/hide | restore. Hiding a review removes it AND its stars from the score; hiding a reply removes only the reply. */
export async function staffSetHidden(db: D1Database, staffId: string, id: string, hide: boolean, b: Body) {
  if (!ID32_RE.test(id)) throw notFound();
  const r = await repo.findRating(db, id);
  if (!r) throw notFound();
  const { target, reason, note } = moderationInput(b);
  if (target === "reply" && r.reply === null) throw notFound();
  const hidden = target === "review" ? r.hidden_at !== null : r.reply_hidden_at !== null;
  if (hide && hidden) throw new HttpError(409, "Already hidden", { code: "already_hidden" });
  if (!hide && !hidden) throw new HttpError(409, "Not hidden", { code: "not_hidden" });
  const at = nowSec();
  const audit = auditStmts(db, { action: hide ? "trust.hidden" : "trust.restored", actorType: "staff", actorId: staffId, eventId: r.event_id, targetType: "organiser_rating", targetId: r.id, reasonCode: reason, meta: { target } }, await auditOff(db));
  await repo.setVisibility(db, { id: newId(), ratingId: r.id, target, action: hide ? "hidden" : "restored", reason, note, staffId, at }, audit);
  return staffRating(db, r.id);
}

/** POST /admin/v1/v3/trust/reports/:id/dismiss: the report is unfounded; nothing changes on the review. */
export async function staffDismissReport(db: D1Database, staffId: string, reportId: string, b: Body) {
  if (!ID32_RE.test(reportId)) throw notFound();
  const p = await repo.findReport(db, reportId);
  if (!p) throw notFound();
  if (p.status !== "open") throw new HttpError(409, "This report is already decided", { code: "report_decided" });
  const note = optText(b.note, "note", 300) ?? "";
  const target = p.target as TrustTarget;
  const at = nowSec();
  const audit = auditStmts(db, { action: "trust.report_dismissed", actorType: "staff", actorId: staffId, targetType: "organiser_rating", targetId: p.rating_id, reasonCode: "report_unfounded", meta: { target } }, await auditOff(db));
  await repo.dismissReport(db, p.id, { id: newId(), ratingId: p.rating_id, target, action: "report_dismissed", reason: "report_unfounded", note, staffId, at }, audit);
  return staffRating(db, p.rating_id);
}
