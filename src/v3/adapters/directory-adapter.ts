/** Phase 5 payloads: the public tournament directory. Pure. `toDirectoryItem` is the only builder: no event id, no organiser, no form token except the opted-in link. */
import { toIso } from "../lib/ids";
import type { DirectoryRow } from "../repositories/directory-repo";

export function toDirectoryItem(r: DirectoryRow, registerUrl: string | null, registrationOpen: boolean) {
  const spotsLeft = r.max_teams === null ? null : Math.max(0, r.max_teams - r.registered);
  return {
    slug: r.slug,
    title: r.title,
    game: r.game,
    format: r.format,
    status: r.status,
    summary: r.summary,
    venue: r.venue,
    city: r.city,
    state: r.state,
    startsAt: toIso(r.starts_at),
    endsAt: toIso(r.ends_at),
    maxTeams: r.max_teams,
    registration: { open: registrationOpen, registered: r.registered, spotsLeft },
    /** The organiser's team sign-up link, only when they chose to show it here and registration is open. Otherwise null: the card opens the tournament page. */
    registerUrl,
    pagePath: `/tournaments/${r.slug}/`,
  };
}
