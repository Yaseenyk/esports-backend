import { audit } from "../audit";
import { HttpError, readJson, str, type Ctx } from "../http";
import { emitStmt } from "../metrics";

/**
 * Personal organisation to club (blueprint 5.4, "conversion, not transfer"). One UPDATE flips kind and name; events, slugs, passes and every link are untouched.
 * The caller must be the sole member (and admin) of their personal organisation. Behind flag orgs.team (the router's gate).
 */

/** PM review r2 N1, verbatim (the word "space" is deliberately absent; invited people CAN see players' details, so it says so). */
export function conversionSentence(eventCount: number): string {
  const events = eventCount === 1 ? "1 event" : `${eventCount} events`;
  return `Everything you have made so far (${events}, with their teams and players' details) will be shared with the people you invite to your club. Invited helpers can edit; only admins can delete or invite. Continue?`;
}
export const CONVERT_PRIMARY = "Create my club";
export const CONVERT_SECONDARY = "Not now";

interface Candidate { id: string; name: string; status: string; members: number; events: number }

/** The caller's personal organisation (found through their membership, never by building an id) with the counts the confirmation needs. */
async function candidate(c: Ctx): Promise<Candidate | null> {
  return c.env.DB
    .prepare(
      "SELECT o.id AS id, o.name AS name, o.status AS status, (SELECT COUNT(*) FROM org_members x WHERE x.org_id = o.id) AS members, (SELECT COUNT(*) FROM events e WHERE e.org_id = o.id) AS events FROM org_members m JOIN organisations o ON o.id = m.org_id WHERE m.user_id = ?1 AND m.role = 'admin' AND o.kind = 'personal' LIMIT 1",
    )
    .bind(c.get("userId"))
    .first<Candidate>();
}

async function mustBeConvertible(c: Ctx): Promise<Candidate> {
  const p = await candidate(c);
  if (!p) {
    const has = await c.env.DB.prepare("SELECT 1 AS x FROM org_members m JOIN organisations o ON o.id = m.org_id WHERE m.user_id = ?1 AND m.role = 'admin' AND o.kind = 'team' LIMIT 1").bind(c.get("userId")).first();
    if (has) throw new HttpError(409, "You already have a club.", { code: "already_club" });
    throw new HttpError(404, "Not found");
  }
  if (p.status !== "active") throw new HttpError(403, "Your account space is paused, so it cannot be turned into a club right now", { code: "org_suspended" });
  if (p.members !== 1) throw new HttpError(409, "Your space is shared already, so it cannot be turned into a club again.", { code: "not_sole_member" });
  return p;
}

/** GET /orgs/convert/preview: what the confirmation shows. */
export async function convertPreview(c: Ctx): Promise<Response> {
  const p = await mustBeConvertible(c);
  c.header("cache-control", "private, no-store");
  return c.json({ orgId: p.id, eventCount: p.events, sentence: conversionSentence(p.events), primaryButton: CONVERT_PRIMARY, secondaryButton: CONVERT_SECONDARY });
}

/** POST /orgs/convert { name }: the caller must be the sole member of a personal organisation (capability org.people.manage on it, as its only admin). */
export async function convertOrg(c: Ctx): Promise<Response> {
  const body = await readJson(c);
  const name = str(body.name, "name", 1, 80);
  const p = await mustBeConvertible(c);
  const r = await c.env.DB.prepare("UPDATE organisations SET kind = 'team', name = ?1 WHERE id = ?2 AND kind = 'personal' AND status = 'active' AND (SELECT COUNT(*) FROM org_members WHERE org_id = ?2) = 1").bind(name, p.id).run();
  if ((r.meta.changes ?? 0) !== 1) throw new HttpError(409, "Your space could not be turned into a club. Reload and try again.", { code: "not_sole_member" });
  // The change is committed; the audit row and the counter follow it (a lost race can never log a conversion that did not happen).
  await audit(c.env.DB, { action: "org.converted", actorType: "user", actorId: c.get("userId"), orgId: p.id, targetType: "org", targetId: p.id });
  try {
    await emitStmt(c.env.DB, "club_created").run();
  } catch {
    /* counts only, never blocks the product */
  }
  return c.json({ id: p.id, name, kind: "team", role: "admin", eventCount: p.events }, 200);
}
