import { HttpError, ID_RE, type Ctx } from "../http";
import { requireOrg } from "./access";

/**
 * GET /orgs/:id/events?after=&limit=&group=&today= : the organisation home (blueprint 11.4, 17.4 exit 7). Capability org.read.
 *
 * At most 6 D1 queries including sign-in (one for the token check, one for the 10-second cached flag, one membership read, then ONE fixed-SQL batch of
 * three statements): the page of events, the group counts with the three "what needs you" totals for the whole organisation, and the same three counts per event on
 * the page. Counts equal direct queries on the same data (test/orgs/home.test.ts seeds data and compares).
 *
 * Groups come from events.starts_on against `today` (YYYY-MM-DD, the caller's local day; default the UTC day):
 *   live = starts today, upcoming = later, past = earlier, undated = no ISO date. Paged newest-created first; `group` narrows the page to one group.
 * "What needs you": pending result submissions, pending registrations, and teams not ready (a side of a scheduled or ready match, with a team name, that has not
 * tapped "we are ready" yet; compared case-insensitively).
 */
const GROUPS = ["live", "upcoming", "past", "undated"] as const;
type Group = (typeof GROUPS)[number];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const CURSOR_RE = /^(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\|([A-Za-z0-9._~-]{1,48})$/;
export const HOME_PAGE_DEFAULT = 20;
export const HOME_PAGE_MAX = 50;

interface EventRowOut { id: string; slug: string; name: string; game: string; date: string; starts_on: string | null; created_at: string; created_by: string | null }
interface Totals { total: number; live: number; upcoming: number; past: number; undated: number; pending_results: number; pending_regs: number; not_ready: number }
interface PerEvent { id: string; pending_results: number; pending_regs: number; not_ready: number }

export async function orgEvents(c: Ctx): Promise<Response> {
  const orgId = c.req.param("id")!;
  const m = await requireOrg(c, orgId, "org.read");
  const q = c.req.query();
  const today = q.today === undefined ? new Date().toISOString().slice(0, 10) : q.today;
  if (!DAY_RE.test(today) || Number.isNaN(Date.parse(`${today}T00:00:00Z`))) throw new HttpError(400, "today must be a date like 2026-12-01");
  const group: Group | null = q.group === undefined ? null : (GROUPS as readonly string[]).includes(q.group) ? (q.group as Group) : null;
  if (q.group !== undefined && !group) throw new HttpError(400, "group must be live, upcoming, past or undated");
  let limit = HOME_PAGE_DEFAULT;
  if (q.limit !== undefined) {
    limit = Number(q.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > HOME_PAGE_MAX) throw new HttpError(400, `limit must be a whole number from 1 to ${HOME_PAGE_MAX}`);
  }
  let afterAt: string | null = null;
  let afterId: string | null = null;
  if (q.after !== undefined) {
    const cur = CURSOR_RE.exec(q.after);
    if (!cur || !ID_RE.test(cur[2]!)) throw new HttpError(400, "after is not a valid cursor");
    afterAt = cur[1]!;
    afterId = cur[2]!;
  }
  const db = c.env.DB;
  // One batch, three statements. The third recomputes the page ids itself (same WHERE, ORDER and LIMIT as the first), so the batch needs no value from statement 1.
  const res = await db.batch([
    db
      .prepare(
        "SELECT e.id AS id, e.slug AS slug, e.name AS name, e.game AS game, e.date AS date, e.starts_on AS starts_on, e.created_at AS created_at, e.created_by AS created_by FROM events e WHERE e.org_id = ?1 AND (?2 IS NULL OR e.created_at < ?2 OR (e.created_at = ?2 AND e.id < ?3)) AND (?5 IS NULL OR (?5 = 'live' AND e.starts_on = ?6) OR (?5 = 'upcoming' AND e.starts_on > ?6) OR (?5 = 'past' AND e.starts_on < ?6) OR (?5 = 'undated' AND e.starts_on IS NULL)) ORDER BY e.created_at DESC, e.id DESC LIMIT ?4",
      )
      .bind(orgId, afterAt, afterId, limit + 1, group, today),
    db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM events WHERE org_id = ?1) AS total, (SELECT COUNT(*) FROM events WHERE org_id = ?1 AND starts_on = ?2) AS live, (SELECT COUNT(*) FROM events WHERE org_id = ?1 AND starts_on > ?2) AS upcoming, (SELECT COUNT(*) FROM events WHERE org_id = ?1 AND starts_on < ?2) AS past, (SELECT COUNT(*) FROM events WHERE org_id = ?1 AND starts_on IS NULL) AS undated, (SELECT COUNT(*) FROM result_submissions r JOIN events e ON e.id = r.event_id WHERE e.org_id = ?1 AND r.status = 'pending') AS pending_results, (SELECT COUNT(*) FROM registrations r JOIN events e ON e.id = r.event_id WHERE e.org_id = ?1 AND r.status = 'pending') AS pending_regs, (SELECT COUNT(*) FROM (SELECT x.id AS mid, x.a AS team FROM matches x JOIN events e ON e.id = x.event_id WHERE e.org_id = ?1 AND x.status IN ('scheduled', 'ready') AND x.a <> '' UNION ALL SELECT x.id, x.b FROM matches x JOIN events e ON e.id = x.event_id WHERE e.org_id = ?1 AND x.status IN ('scheduled', 'ready') AND x.b <> '') s WHERE NOT EXISTS (SELECT 1 FROM ready_checks k WHERE k.match_id = s.mid AND lower(trim(k.team)) = lower(trim(s.team)))) AS not_ready",
      )
      .bind(orgId, today),
    db
      .prepare(
        "SELECT e.id AS id, (SELECT COUNT(*) FROM result_submissions r WHERE r.event_id = e.id AND r.status = 'pending') AS pending_results, (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id AND r.status = 'pending') AS pending_regs, (SELECT COUNT(*) FROM (SELECT x.id AS mid, x.a AS team FROM matches x WHERE x.event_id = e.id AND x.status IN ('scheduled', 'ready') AND x.a <> '' UNION ALL SELECT x.id, x.b FROM matches x WHERE x.event_id = e.id AND x.status IN ('scheduled', 'ready') AND x.b <> '') s WHERE NOT EXISTS (SELECT 1 FROM ready_checks k WHERE k.match_id = s.mid AND lower(trim(k.team)) = lower(trim(s.team)))) AS not_ready FROM events e WHERE e.id IN (SELECT id FROM (SELECT p.id AS id FROM events p WHERE p.org_id = ?1 AND (?2 IS NULL OR p.created_at < ?2 OR (p.created_at = ?2 AND p.id < ?3)) AND (?5 IS NULL OR (?5 = 'live' AND p.starts_on = ?6) OR (?5 = 'upcoming' AND p.starts_on > ?6) OR (?5 = 'past' AND p.starts_on < ?6) OR (?5 = 'undated' AND p.starts_on IS NULL)) ORDER BY p.created_at DESC, p.id DESC LIMIT ?4))",
      )
      .bind(orgId, afterAt, afterId, limit, group, today),
  ]);
  const rows = (res[0]!.results as unknown as EventRowOut[]);
  const totals = (res[1]!.results as unknown as Totals[])[0]!;
  const per = new Map((res[2]!.results as unknown as PerEvent[]).map((r) => [r.id, r]));
  const more = rows.length > limit;
  const page = rows.slice(0, limit);
  const groupOf = (s: string | null): Group => (s === null ? "undated" : s === today ? "live" : s > today ? "upcoming" : "past");
  const last = page[page.length - 1];
  c.header("cache-control", "private, no-store");
  return c.json({
    org: { id: orgId, name: m.name, kind: m.kind, role: m.role },
    today,
    groups: { live: totals.live, upcoming: totals.upcoming, past: totals.past, undated: totals.undated },
    total: totals.total,
    needsYou: { pendingResults: totals.pending_results, pendingRegistrations: totals.pending_regs, teamsNotReady: totals.not_ready },
    events: page.map((e) => {
      const n = per.get(e.id);
      return {
        id: e.id,
        key: e.slug,
        name: e.name,
        game: e.game,
        date: e.date,
        startsOn: e.starts_on,
        createdAt: e.created_at,
        createdBy: e.created_by,
        group: groupOf(e.starts_on),
        needsYou: { pendingResults: n?.pending_results ?? 0, pendingRegistrations: n?.pending_regs ?? 0, teamsNotReady: n?.not_ready ?? 0 },
      };
    }),
    next: more && last ? `${last.created_at}|${last.id}` : null,
  });
}
