/**
 * Which player profiles get a pre-rendered, indexable page at /players/<slug>/ (the owner's quality gate). Pure, dependency-free.
 * ALL of these must hold; anything else ships noindex (or not at all):
 *  1. the player switched on "Show my profile in Google search" (off by default);
 *  2. the profile is Public, the owner confirmed 18+, gave resume consent, the account is active and moderation does not hide it
 *     (checked by the service before the page is built: a page that fails them is never readable in the first place);
 *  3. real content on the page as the public sees it (hidden fields do not count): a bio of at least 80 characters plus at least one game,
 *     OR at least one verified result.
 */
export const SEO_BIO_MIN = 80;

export interface PlayerSeoInput {
  visibility: string;
  searchOptIn: boolean;
  /** The public payload's values (after the owner's show/hide switches). */
  bio: string | null;
  games: number;
  verifiedResults: number;
}

/** Why a profile is not indexable, as codes the owner screen explains. Empty = indexable (once the service's checks passed). */
export function playerSeoBlockers(i: PlayerSeoInput): string[] {
  const out: string[] = [];
  if (i.visibility !== "public") out.push("not_public");
  if (!i.searchOptIn) out.push("search_off");
  const richBio = (i.bio ?? "").trim().length >= SEO_BIO_MIN && i.games >= 1;
  if (!richBio && i.verifiedResults < 1) out.push("thin_content");
  return out;
}

export const playerSeoReady = (i: PlayerSeoInput): boolean => playerSeoBlockers(i).length === 0;
