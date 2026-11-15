/** Profile payloads. `toPublicPlayer` is the ONLY public builder: no user id, email, Discord id or consent timestamps. */
import { toIso } from "../lib/ids";
import type { GameRow, ProfileRow } from "../repositories/profile-repo";

const arr = (v: string): string[] => {
  try {
    const x: unknown = JSON.parse(v);
    return Array.isArray(x) ? x.filter((y): y is string => typeof y === "string") : [];
  } catch {
    return [];
  }
};

export const toGameOut = (g: GameRow) => ({ game: g.game, inGameName: g.inGameName, rankCode: g.rankCode, rankOrdinal: g.rankOrdinal, roles: arr(g.roles) });

export function toPublicPlayer(p: ProfileRow, games: GameRow[]) {
  return { slug: p.slug, handle: p.handle, bio: p.bio, city: p.city, state: p.state, languages: arr(p.languages), games: games.map(toGameOut), updatedAt: toIso(p.updatedAt) };
}

/** The owner's own view: adds visibility and the consent state. */
export function toOwnProfile(p: ProfileRow, games: GameRow[], consent: { adultConfirmedAt: number | null; resumeConsentAt: number | null }) {
  return {
    slug: p.slug, handle: p.handle, bio: p.bio, city: p.city, state: p.state, languages: arr(p.languages), visibility: p.visibility, games: games.map(toGameOut),
    adultConfirmedAt: toIso(consent.adultConfirmedAt), resumeConsentAt: toIso(consent.resumeConsentAt), createdAt: toIso(p.createdAt), updatedAt: toIso(p.updatedAt),
  };
}
