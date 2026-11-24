/**
 * Match recap facts (flag v3.recaps). The recap TEXT and picture are made in the browser from deterministic templates; this only hands over the
 * results the organiser entered (points tables, brackets), with dispute corrections applied, and the organiser's own scoring when they saved one.
 * Who: anyone with a role on the event (owner, editor, org admin, view-only guest). No access: 404. No SQL here.
 */
import { HttpError } from "../../http";
import { toRecapFacts } from "../adapters/recap-adapter";
import { loadEventAccess } from "../repositories/event-access-repo";
import { organiserToolFlags } from "../repositories/flag-repo";
import { leagueScoring } from "../repositories/recap-repo";
import { PUBLIC_STATUSES, correctionsFor, eventHidden, findByEventId, legacyBrResults, legacyMatches } from "../repositories/tournament-repo";

export async function recapFacts(db: D1Database, userId: string, eventId: string) {
  const a = await loadEventAccess(db, userId, eventId);
  if (!a) throw new HttpError(404, "Event not found");
  const [t, scoring, matches, br, corrections] = await Promise.all([findByEventId(db, eventId), leagueScoring(db, eventId), legacyMatches(db, eventId), legacyBrResults(db, eventId), correctionsFor(db, eventId)]);
  // The recap links to the public tournament page only when there is one to open; otherwise the site's home page.
  const isPublic = !!t && (PUBLIC_STATUSES as readonly string[]).includes(t.status) && !(await eventHidden(db, eventId));
  return toRecapFacts({ event: { id: a.eventId, name: a.name, game: a.game }, publicPath: isPublic ? `/tournaments/${t!.slug}/` : null, scoring, matches, br, corrections });
}

/** Which organiser tools are switched on, for one event the caller has a role on (the event page shows links only for these). No access: 404. */
export async function organiserTools(db: D1Database, userId: string, eventId: string) {
  const a = await loadEventAccess(db, userId, eventId);
  if (!a) throw new HttpError(404, "Event not found");
  return { ...(await organiserToolFlags(db)), canEdit: a.canWrite };
}
