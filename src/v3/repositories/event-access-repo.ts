/**
 * Bridge to the EXISTING event access layer (src/policy/access.ts: owner / editor / viewer, org admins act as owner, flag authz.mode).
 * v3 never re-implements "who may touch this event": it asks the same function the legacy routes use and gets the same answer.
 */
import { isViewer, resolveEvent } from "../../policy/access";
import type { Ctx } from "../../http";

export interface EventAccessRow {
  eventId: string;
  name: string;
  game: string;
  startsOn: string | null;
  /** Owner, editor or an organisation admin/member acting as one: may change the event. A view-only guest is false. */
  canWrite: boolean;
}

/** The caller's role on an event, or null when there is none (not found and no access are indistinguishable, like everywhere else). */
export async function loadEventAccess(db: D1Database, userId: string, eventId: string): Promise<EventAccessRow | null> {
  const fake = { env: { DB: db }, get: (k: string) => (k === "userId" ? userId : undefined) } as unknown as Ctx;
  try {
    const ev = await resolveEvent(fake, eventId);
    return { eventId: ev.id, name: ev.name, game: ev.game, startsOn: ev.starts_on ?? null, canWrite: !isViewer(ev) };
  } catch (e) {
    if (e && typeof e === "object" && "status" in e && (e as { status: number }).status === 404) return null;
    throw e;
  }
}
