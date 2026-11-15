/** Public college pages: a VERIFIED organisation with at least one real (public) tournament. Anything else is the same 404. No SQL here. */
import { HttpError } from "../../http";
import * as colleges from "../repositories/college-repo";
import { toCollegeListItem, toPublicCollege } from "../adapters/college-adapter";

const COLLEGE_TOURNAMENTS_MAX = 50;
const COLLEGE_LIST_MAX = 500;

export async function publicCollege(db: D1Database, slug: string) {
  if (!/^[a-z0-9-]{3,60}$/.test(slug)) throw new HttpError(404, "Not found");
  const c = await colleges.findVerifiedBySlug(db, slug);
  if (!c) throw new HttpError(404, "Not found");
  const rows = await colleges.publicTournamentsOf(db, c.id, COLLEGE_TOURNAMENTS_MAX);
  if (rows.length === 0) throw new HttpError(404, "Not found");
  return toPublicCollege(c, rows);
}

/** For the sitemap and the college index: same rules as the detail endpoint, so every listed slug resolves. */
export async function listPublicColleges(db: D1Database) {
  return { items: (await colleges.listWithTournaments(db, COLLEGE_LIST_MAX)).map(toCollegeListItem) };
}
