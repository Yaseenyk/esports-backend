/**
 * LFT payloads. `toPublicListing` is the ONLY public builder: it never carries the author id, the contact, the team profile id, report data or hidden state.
 * `toOwnListing` is for the author. Contact reveal is decided in the service and passed in here as a plain value.
 */
import { toIso } from "../lib/ids";
import type { ApplicationForApplicant, ApplicationForAuthor, ListingRow, PublicListingRow } from "../repositories/lft-repo";

const roles = (v: string): string[] => {
  try {
    const x: unknown = JSON.parse(v);
    return Array.isArray(x) ? x.filter((y): y is string => typeof y === "string") : [];
  } catch {
    return [];
  }
};

export function toPublicListing(r: PublicListingRow) {
  return {
    id: r.id,
    kind: r.kind,
    game: r.game,
    roles: roles(r.roles),
    rankMin: r.rank_min_ordinal,
    rankMax: r.rank_max_ordinal,
    state: r.state,
    city: r.city,
    onlineOk: r.online_ok === 1,
    message: r.message,
    teamName: r.team_name,
    createdAt: toIso(r.created_at),
    lastBumpedAt: toIso(r.last_bumped_at),
    expiresAt: toIso(r.expires_at),
  };
}

export const encodeCursor = (ts: number, id: string): string => `${ts}_${id}`;
export function decodeCursor(v: string | undefined): { ts: number; id: string } | null | undefined {
  if (v === undefined || v === "") return undefined;
  const m = /^(\d{1,12})_([0-9a-f]{32})$/.exec(v);
  return m ? { ts: Number(m[1]), id: m[2]! } : null;
}

export function toOwnListing(l: ListingRow & { applications?: number }) {
  return {
    id: l.id, kind: l.kind, game: l.game, roles: roles(l.roles), rankMin: l.rankMinOrdinal, rankMax: l.rankMaxOrdinal, state: l.state, city: l.city, onlineOk: l.onlineOk,
    message: l.message, contact: l.contact, teamProfileId: l.teamProfileId, status: l.status, hidden: l.hiddenAt !== null, reportCount: l.reportCount,
    expiresAt: toIso(l.expiresAt), lastBumpedAt: toIso(l.lastBumpedAt), createdAt: toIso(l.createdAt), applications: l.applications ?? 0,
  };
}

/** To the listing author: the applicant's contact only once accepted. */
export function toApplicationForAuthor(a: ApplicationForAuthor) {
  return {
    id: a.id, status: a.status, message: a.message, createdAt: toIso(a.created_at), respondedAt: toIso(a.responded_at), profileSlug: a.profile_slug,
    contact: a.status === "accepted" ? a.contact : null,
  };
}
/** To the applicant: the listing author's contact only once accepted. */
export function toApplicationForApplicant(a: ApplicationForApplicant) {
  return {
    id: a.id, listingId: a.listing_id, status: a.status, kind: a.kind, game: a.game, teamName: a.team_name, listingStatus: a.listing_status,
    createdAt: toIso(a.created_at), respondedAt: toIso(a.responded_at), contact: a.status === "accepted" ? a.listing_contact : null,
  };
}
