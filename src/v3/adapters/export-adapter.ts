/** v3 rows to the "Download my data" JSON. Builds payloads only: no SQL, repositories as type imports. Never emits other people's ids, hashes, tokens or bytes. */
import type { AccountV3Row, CaptainRow, DisputeRow, EvidenceMetaRow, GameRow, ListingRow, ProfileRow, SentApplicationRow } from "../repositories/export-repo";
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
}
/** 0 = everything; 1 = feedback reduced to a count; 2 = also LFT listings and sent applications; 3 = also raised disputes (all reduced to counts). */
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
    feedback: {
      reportCount: i.feedback.length,
      reports: level >= 1 ? [] : i.feedback.map((f) => ({ id: f.id, kind: f.kind, message: f.message, pagePath: f.page_path, createdAt: toIso(f.created_at), status: f.status, contact: f.contact, clientErrors: strings(f.client_errors) })),
    },
  };
}
