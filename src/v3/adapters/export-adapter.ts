/** v3 rows to the "Download my data" JSON. Builds payloads only: no SQL, repositories as type imports. Never emits other people's ids, hashes, tokens or bytes. */
import type { AccountV3Row, CaptainRow, DisputeRow, EvidenceMetaRow, GameRow, ListingRow, ProfileRow, RatingReceivedRow, RatingWrittenRow, SentApplicationRow, TeamPageSettingRow } from "../repositories/export-repo";
import type { RequestExportRow, SlotExportRow } from "../repositories/scrim-repo";
import type { FeedbackExportRow } from "../repositories/feedback-repo";
import { toIso } from "../lib/ids";

const strings = (raw: string | null): string[] => {
  if (!raw) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
};

export interface V3ExportInput {
  account: AccountV3Row | null; profile: ProfileRow | null; games: GameRow[];
  listings: ListingRow[]; sent: SentApplicationRow[];
  disputes: DisputeRow[]; evidence: EvidenceMetaRow[]; captains: CaptainRow[];
  feedback: FeedbackExportRow[];
  // phases 3-5 (migration 0056); optional so callers built before them still type-check
  teamPages?: TeamPageSettingRow[]; playerHidden?: { item_key: string; created_at: number }[]; teamHidden?: { slug: string; item_key: string; created_at: number }[];
  slots?: SlotExportRow[]; scrimRequests?: RequestExportRow[]; blocks?: { label: string; created_at: number }[];
  schedules?: { game: string; time_of_day: string; days_ahead: number; region: string; slots_total: number; contact: string; active: number; created_at: number }[];
  waitlistEntries?: { slot_id: string; status: string; created_at: number }[]; notices?: { kind: string; created_at: number; read_at: number | null }[];
  // organiser trust (migration 0080): ratings the user wrote, and ratings of the organisations they are an admin of
  ratingsWritten?: RatingWrittenRow[]; ratingsReceived?: RatingReceivedRow[];
}
/** 0 = everything; 1 = feedback reduced to a count; 2 = also LFT listings, sent applications and ratings received; 3 = also raised disputes (all reduced to counts). */
export type TruncationLevel = 0 | 1 | 2 | 3;
export const MAX_TRUNCATION_LEVEL: TruncationLevel = 3;

export function buildV3Export(i: V3ExportInput, level: TruncationLevel = 0) {
  const meta = (e: EvidenceMetaRow) => ({ mime: e.mime_type, sizeBytes: e.size_bytes, createdAt: toIso(e.created_at), purged: e.purged === 1 });
  const raisedIds = new Set(i.disputes.map((d) => d.id));
  return {
    resume: {
      adultConfirmedAt: toIso(i.account?.adult_confirmed_at),
      resumeConsentAt: toIso(i.account?.resume_consent_at),
      discordLinked: i.account?.has_discord === 1,
      profile: i.profile && { slug: i.profile.slug, handle: i.profile.handle, bio: i.profile.bio, city: i.profile.city, state: i.profile.state, languages: strings(i.profile.languages), visibility: i.profile.visibility, createdAt: toIso(i.profile.created_at) },
      games: i.games.map((g) => ({ game: g.game, inGameName: g.in_game_name, rankCode: g.rank_code, rankOrdinal: g.rank_ordinal, roles: strings(g.roles) })),
    },
    lft: {
      listingCount: i.listings.length,
      listings: level >= 2 ? [] : i.listings.map((l) => ({ id: l.id, kind: l.kind, game: l.game, roles: strings(l.roles), message: l.message, status: l.status, createdAt: toIso(l.created_at), expiresAt: toIso(l.expires_at), state: l.state, city: l.city, onlineOk: l.online_ok === 1, applicationsReceived: l.received })),
      applicationsReceivedTotal: i.listings.reduce((n, l) => n + l.received, 0),
      sentApplicationCount: i.sent.length,
      sentApplications: level >= 2 ? [] : i.sent.map((a) => ({ listingId: a.listing_id, message: a.message, status: a.status, createdAt: toIso(a.created_at), respondedAt: toIso(a.responded_at) })),
    },
    disputes: {
      raisedCount: i.disputes.length,
      raised: level >= 3 ? [] : i.disputes.map((d) => ({ id: d.id, tournament: d.tournament_slug, type: d.type, status: d.status, summary: d.summary, createdAt: toIso(d.created_at), resolvedAt: toIso(d.resolved_at), outcome: d.outcome, resolutionNote: d.resolution_note, evidence: i.evidence.filter((e) => e.dispute_id === d.id).map(meta) })),
      evidenceOnOtherDisputes: level >= 3 ? [] : i.evidence.filter((e) => !raisedIds.has(e.dispute_id)).map(meta),
      captainClaims: i.captains.map((c) => ({ eventId: c.event_id, teamName: c.team_name, createdAt: toIso(c.created_at) })),
    },
    profiles: {
      teamPageSettings: (i.teamPages ?? []).map((t) => ({ teamPage: t.slug, name: t.name, visibility: t.visibility, publicSince: toIso(t.public_since) })),
      hiddenOnPlayerPage: (i.playerHidden ?? []).map((h) => ({ item: h.item_key, createdAt: toIso(h.created_at) })),
      hiddenOnTeamPages: (i.teamHidden ?? []).map((h) => ({ teamPage: h.slug, item: h.item_key, createdAt: toIso(h.created_at) })),
    },
    scrims: {
      slotCount: (i.slots ?? []).length,
      slots: level >= 2 ? [] : (i.slots ?? []).map((s) => ({ id: s.id, game: s.game, startsAt: toIso(s.starts_at), region: s.region, server: s.server, skillNote: s.skill_note, slotsTotal: s.slots_total, slotsFilled: s.slots_filled, contact: s.contact, status: s.status, createdAt: toIso(s.created_at), requestsReceived: s.requests_received })),
      sentRequestCount: (i.scrimRequests ?? []).length,
      sentRequests: level >= 2 ? [] : (i.scrimRequests ?? []).map((q) => ({ slotId: q.slot_id, message: q.message, contact: q.contact, status: q.status, createdAt: toIso(q.created_at), respondedAt: toIso(q.responded_at) })),
      blocksMade: (i.blocks ?? []).map((b) => ({ team: b.label, createdAt: toIso(b.created_at) })),
      schedules: (i.schedules ?? []).map((s) => ({ game: s.game, timeOfDayIst: s.time_of_day, daysAhead: s.days_ahead, region: s.region, slots: s.slots_total, contact: s.contact, active: s.active === 1, createdAt: toIso(s.created_at) })),
      waitlist: (i.waitlistEntries ?? []).map((w) => ({ slotId: w.slot_id, status: w.status, createdAt: toIso(w.created_at) })),
      notices: (i.notices ?? []).map((n) => ({ kind: n.kind, createdAt: toIso(n.created_at), read: n.read_at !== null })),
    },
    ratings: {
      writtenCount: (i.ratingsWritten ?? []).length,
      written: (i.ratingsWritten ?? []).map((r) => ({ id: r.id, eventId: r.event_id, event: r.event_name, displayName: r.display_name, stars: r.stars, onTime: r.on_time, fair: r.fair_play, communication: r.communication, review: r.review, organiserReply: r.reply, organiserReplyAt: toIso(r.reply_at), hiddenByModerators: r.hidden_at !== null, replyHiddenByModerators: r.reply_hidden_at !== null, createdAt: toIso(r.created_at), updatedAt: toIso(r.updated_at) })),
      receivedCount: (i.ratingsReceived ?? []).length,
      received: level >= 2 ? [] : (i.ratingsReceived ?? []).map((r) => ({ id: r.id, orgId: r.org_id, organisation: r.org_name, eventId: r.event_id, event: r.event_name, reviewerDisplayName: r.display_name, stars: r.stars, onTime: r.on_time, fair: r.fair_play, communication: r.communication, review: r.review, reply: r.reply, replyAt: toIso(r.reply_at), replyHiddenByModerators: r.reply_hidden === 1, createdAt: toIso(r.created_at) })),
    },
    feedback: {
      reportCount: i.feedback.length,
      reports: level >= 1 ? [] : i.feedback.map((f) => ({ id: f.id, kind: f.kind, message: f.message, pagePath: f.page_path, createdAt: toIso(f.created_at), status: f.status, contact: f.contact, clientErrors: strings(f.client_errors) })),
    },
  };
}
