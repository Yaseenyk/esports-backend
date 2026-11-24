/**
 * Phase 3 payloads: public player profiles and team pages. Pure: no SQL, repositories as type imports only.
 * `toPublicPlayerPage` and `toPublicTeamPage` are the ONLY builders of these public payloads: fields are listed one by one, so a user id, an email,
 * an event id, a contact or a consent time cannot leak by accident. Results come ONLY from verified rows (see repositories/showcase-repo.ts), with the
 * dispute corrections applied through the same overlay the tournament page uses. Opponents that did not choose to be public show as "Unlisted team".
 */
import { toIso } from "../lib/ids";
import type { GameRow, ProfileRow } from "../repositories/profile-repo";
import type { EntryRow, PublicTeamKeyRow, ShowBrRow, ShowCorrectionRow, ShowMatchRow, TeamPageRow } from "../repositories/showcase-repo";
import type { StatBrRow, StatMatchRow } from "../repositories/stats-repo";
import { toGameOut } from "./profile-adapter";
import { brRef, matchRef, overlayBr, overlayMatches, type BrResultOut, type MatchResultOut } from "./results-overlay";
import type { ResumeStats } from "./stats-adapter";
import { UNLISTED_TEAM } from "./tournament-adapter";

export const MAX_LIST = 100;
export type PageVisibility = "private" | "unlisted" | "public";

/** "<tournament slug>:<team key>": the handle an owner uses to hide one tournament from their page. Public information only. */
export const itemKeyOf = (slug: string, teamKey: string): string => `${slug}:${teamKey}`.slice(0, 140);

/** Effective team page visibility: legacy published = 0 is private whatever the v3 row says; published = 1 is public only when the v3 row says so. */
export function teamVisibility(row: Pick<TeamPageRow, "published" | "v3_visibility">): PageVisibility {
  if (row.published !== 1) return "private";
  return row.v3_visibility === "public" ? "public" : "unlisted";
}

export interface ShowcaseInput {
  entries: EntryRow[];
  matches: ShowMatchRow[];
  br: ShowBrRow[];
  corrections: ShowCorrectionRow[];
  publicTeams: PublicTeamKeyRow[];
  hidden: readonly string[];
  /** The owner's own view keeps hidden entries (marked) so they can be shown again. */
  includeHidden: boolean;
}

const parseStrings = (v: string): string[] => {
  try {
    const x: unknown = JSON.parse(v);
    return Array.isArray(x) ? x.filter((y): y is string => typeof y === "string") : [];
  } catch {
    return [];
  }
};

export function buildShowcase(i: ShowcaseInput) {
  const hiddenSet = new Set(i.hidden);
  const order = new Map<string, number>();
  const entries = i.entries
    .map((e) => ({ e, key: itemKeyOf(e.slug, e.team_key) }))
    .filter(({ key }) => i.includeHidden || !hiddenSet.has(key));
  entries.forEach(({ e }, idx) => order.set(`${e.event_id}|${e.team_key}`, idx));
  const entryOf = new Map(entries.map(({ e, key }) => [`${e.event_id}|${e.team_key}`, { e, key }]));
  const counted = (eventId: string, teamKey: string) => {
    const x = entryOf.get(`${eventId}|${teamKey}`);
    return x && !hiddenSet.has(x.key) ? x : undefined; // hidden entries never count, not even in the owner's view of the numbers
  };
  const visible = new Set(i.publicTeams.map((p) => `${p.event_id}|${p.team_key}`));

  // head to head, corrections applied
  const mineMatches = i.matches.filter((m) => entryOf.has(`${m.event_id}|${m.team_key}`));
  const asOut = (m: ShowMatchRow): MatchResultOut => ({ matchRef: matchRef(m.id), stage: m.stage, round: m.round, slot: 0, teamA: m.a, teamB: m.b, status: m.status, scoreA: m.score_a, scoreB: m.score_b, winner: m.winner, corrected: false });
  // Corrections are applied per event: a battle royale ref ("br:<match no>:<team>") is only unique inside one event.
  const corrOf = (eventId: string) => i.corrections.filter((c) => c.event_id === eventId);
  const overlaid = mineMatches.map((m) => overlayMatches([asOut(m)], corrOf(m.event_id))[0]!);
  const matches = mineMatches
    .map((m, idx) => {
      const o = overlaid[idx]!;
      const side: "a" | "b" = m.a.toLowerCase() === m.team_key ? "a" : "b";
      const opponentRaw = side === "a" ? m.b : m.a;
      const w = o.winner;
      const result = w === "draw" ? "draw" : w === side ? "win" : w === "a" || w === "b" ? "loss" : null;
      const x = entryOf.get(`${m.event_id}|${m.team_key}`)!;
      return {
        sort: order.get(`${m.event_id}|${m.team_key}`) ?? 0,
        itemKey: x.key,
        counted: !!counted(m.event_id, m.team_key),
        row: {
          tournament: { slug: x.e.slug, title: x.e.title },
          team: x.e.team_name,
          stage: m.stage,
          round: m.round,
          opponent: opponentRaw === "" ? "" : visible.has(`${m.event_id}|${opponentRaw.toLowerCase()}`) ? opponentRaw : UNLISTED_TEAM,
          scoreFor: side === "a" ? o.scoreA : o.scoreB,
          scoreAgainst: side === "a" ? o.scoreB : o.scoreA,
          result,
          corrected: o.corrected,
          playedAt: m.starts_at,
        },
        stat: { event_id: m.event_id, id: m.id, game: x.e.game, side, stage: m.stage, score_a: m.score_a, score_b: m.score_b, winner: m.winner } satisfies StatMatchRow,
      };
    })
    .filter((m) => m.row.result !== null);

  // battle royale, corrections applied
  const mineBr = i.br.filter((b) => entryOf.has(`${b.event_id}|${b.team_key}`));
  const brOut: BrResultOut[] = mineBr.map((b) => ({ matchRef: brRef(b.match_no, b.team), matchNo: b.match_no, team: b.team, placement: b.placement, kills: b.kills, corrected: false }));
  const brOver = mineBr.map((b, idx) => overlayBr([brOut[idx]!], corrOf(b.event_id))[0]!);
  const battleRoyale = mineBr.map((b, idx) => {
    const x = entryOf.get(`${b.event_id}|${b.team_key}`)!;
    const o = brOver[idx]!;
    return {
      sort: order.get(`${b.event_id}|${b.team_key}`) ?? 0,
      itemKey: x.key,
      counted: !!counted(b.event_id, b.team_key),
      row: { tournament: { slug: x.e.slug, title: x.e.title }, team: x.e.team_name, matchNo: b.match_no, placement: o.placement, kills: o.kills, corrected: o.corrected },
      stat: { event_id: b.event_id, game: x.e.game, match_no: b.match_no, team: b.team, placement: b.placement, kills: b.kills } satisfies StatBrRow,
    };
  });

  // certificates: completed tournaments only, at least one verified result for that team
  const certificates = entries
    .filter(({ e }) => e.status === "completed")
    .map(({ e, key }) => {
      const ms = matches.filter((m) => m.itemKey === key).map((m) => m.row);
      const bs = battleRoyale.filter((b) => b.itemKey === key).map((b) => b.row);
      if (ms.length === 0 && bs.length === 0) return null;
      const record = ms.length ? { played: ms.length, wins: ms.filter((m) => m.result === "win").length, draws: ms.filter((m) => m.result === "draw").length, losses: ms.filter((m) => m.result === "loss").length } : null;
      const brSum = bs.length ? { matches: bs.length, wins: bs.filter((b) => b.placement === 1).length, bestPlacement: Math.min(...bs.map((b) => b.placement)), kills: bs.reduce((n, b) => n + b.kills, 0) } : null;
      return {
        id: key,
        tournament: { slug: e.slug, title: e.title, game: e.game },
        team: e.team_name,
        completedOn: toIso(e.ends_at ?? e.starts_at),
        record,
        battleRoyale: brSum,
        source: "verified_results" as const,
        hidden: hiddenSet.has(key),
      };
    })
    .filter((c): c is NonNullable<typeof c> => c !== null);

  const byNewest = <T extends { sort: number }>(xs: T[]) => [...xs].sort((a, b) => a.sort - b.sort);
  const shownMatches = byNewest(matches.filter((m) => i.includeHidden || m.counted)).slice(0, MAX_LIST);
  const shownBr = byNewest(battleRoyale.filter((b) => i.includeHidden || b.counted)).slice(0, MAX_LIST);
  const countedMatches = matches.filter((m) => m.counted);
  const countedBr = battleRoyale.filter((b) => b.counted);

  return {
    entries: entries.map(({ e, key }) => ({
      itemKey: key,
      tournament: { slug: e.slug, title: e.title, game: e.game, status: e.status, startsAt: toIso(e.starts_at), endsAt: toIso(e.ends_at) },
      team: e.team_name,
      hidden: hiddenSet.has(key),
    })),
    // Every row carries `hidden`; the public builders below strip it (a public page never holds a hidden row in the first place).
    matches: shownMatches.map((m) => ({ ...m.row, hidden: !m.counted })),
    battleRoyale: shownBr.map((b) => ({ ...b.row, hidden: !b.counted })),
    certificates: certificates.filter((c) => i.includeHidden || !c.hidden),
    /** Rows for the resume stats (hidden entries excluded). */
    statRows: { matches: countedMatches.map((m) => m.stat), br: countedBr.map((b) => b.stat) },
    hasVerifiedContent: countedMatches.length + countedBr.length > 0,
  };
}
export type Showcase = ReturnType<typeof buildShowcase>;

/** Teams on a player page: the teams the person captained, grouped by name, with a link when one of their visible team pages has that name. */
export function playerTeams(entries: Showcase["entries"], teamPages: readonly { slug: string; name: string }[]) {
  const pages = new Map(teamPages.map((p) => [p.name.trim().toLowerCase(), p.slug]));
  const groups = new Map<string, { name: string; games: Set<string>; tournaments: number }>();
  for (const e of entries) {
    if (e.hidden) continue;
    const k = e.team.trim().toLowerCase();
    const g = groups.get(k) ?? { name: e.team, games: new Set<string>(), tournaments: 0 };
    g.games.add(e.tournament.game);
    g.tournaments++;
    groups.set(k, g);
  }
  return [...groups.entries()].map(([k, g]) => ({ name: g.name, games: [...g.games].sort(), tournaments: g.tournaments, teamPageSlug: pages.get(k) ?? null }));
}

/** The result rows of a PUBLIC payload: hidden rows dropped, the `hidden` marker removed. */
function publicRows(s: Showcase) {
  return {
    matches: s.matches.filter((m) => !m.hidden).map(({ hidden: _h, ...rest }) => rest),
    battleRoyale: s.battleRoyale.filter((b) => !b.hidden).map(({ hidden: _h, ...rest }) => rest),
    certificates: s.certificates.filter((c) => !c.hidden).map(({ hidden: _h, ...rest }) => rest),
  };
}

/** Indexable = the owner chose Public AND the page has verified results to show. Anything else ships noindex. */
export const isIndexable = (visibility: PageVisibility, s: Pick<Showcase, "hasVerifiedContent">): boolean => visibility === "public" && s.hasVerifiedContent;

export function toPublicPlayerPage(p: ProfileRow, games: GameRow[], stats: ResumeStats, s: Showcase, teams: ReturnType<typeof playerTeams>) {
  const visibility = p.visibility as PageVisibility;
  return {
    kind: "player" as const,
    slug: p.slug,
    handle: p.handle,
    bio: p.bio,
    city: p.city,
    state: p.state,
    languages: parseStrings(p.languages),
    games: games.map(toGameOut),
    stats,
    visibility,
    indexable: isIndexable(visibility, s),
    teams,
    ...publicRows(s),
    updatedAt: toIso(p.updatedAt),
  };
}

const parseLinks = (v: string): string[] => parseStrings(v).filter((x) => x.startsWith("https://"));

export function toPublicTeamPage(t: TeamPageRow, s: Showcase) {
  const visibility = teamVisibility(t);
  return {
    kind: "team" as const,
    slug: t.slug,
    name: t.name,
    blurb: t.blurb,
    links: parseLinks(t.links),
    visibility,
    indexable: isIndexable(visibility, s),
    tournaments: s.entries.filter((e) => !e.hidden).map(({ hidden: _h, itemKey: _k, ...rest }) => rest),
    ...publicRows(s),
    updatedAt: t.updated_at,
  };
}

/** What still stands between a page and search engines, for the owner's screen. Empty = indexable. */
export function indexBlockers(visibility: PageVisibility, s: Pick<Showcase, "hasVerifiedContent">, extra: string[] = []): string[] {
  const out = [...extra];
  if (visibility !== "public") out.push("not_public");
  if (!s.hasVerifiedContent) out.push("no_verified_results");
  return out;
}

export function toOwnPlayerPage(p: ProfileRow, s: Showcase, extra: { blockers: string[]; moderationHidden: boolean; teams: ReturnType<typeof playerTeams> }) {
  const visibility = p.visibility as PageVisibility;
  return {
    slug: p.slug,
    visibility,
    path: `/players/view/?s=${p.slug}`,
    indexable: extra.blockers.length === 0,
    indexBlockers: extra.blockers,
    hiddenByModeration: extra.moderationHidden,
    teams: extra.teams,
    entries: s.entries,
    matches: s.matches,
    battleRoyale: s.battleRoyale,
    certificates: s.certificates,
  };
}

export function toOwnTeamPage(t: TeamPageRow, s: Showcase | null, extra: { blockers: string[]; moderationHidden: boolean; claimable?: { tournament: { slug: string; title: string }; team: string }[] }) {
  const visibility = teamVisibility(t);
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    visibility,
    path: `/teams/view/?s=${t.slug}`,
    indexable: extra.blockers.length === 0,
    indexBlockers: extra.blockers,
    hiddenByModeration: extra.moderationHidden,
    entries: s?.entries ?? [],
    matches: s?.matches ?? [],
    battleRoyale: s?.battleRoyale ?? [],
    certificates: s?.certificates ?? [],
    ...(extra.claimable ? { claimable: extra.claimable } : {}),
  };
}
