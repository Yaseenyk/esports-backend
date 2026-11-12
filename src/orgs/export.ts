import { HttpError, rateLimitSubject, type Ctx } from "../http";
import { myEventList } from "../routes/events";

/**
 * POST /me/export (privacy minimum, owner decision OD-Z). "Download my data" for the signed-in user. Always works, whatever the flags say.
 *
 * Contains: the account fields (never the password hash or salt), organisation memberships, the list of events the user can reach with metadata and
 * COUNTS, the user's brand kits and their team profiles.
 * Does NOT contain: rosters, people, photos, registrations, result proofs, check-ins, contact messages or invitation rows. Those hold other people's
 * data (many of them minors); an organiser exports them per event with the tools that already exist.
 * Size: the whole JSON must stay under EXPORT_MAX_BYTES (logos are the only thing that can be large and are dropped first).
 * The field set is pinned by test/orgs/export.test.ts, so a new field cannot slip in unseen.
 */
export const EXPORT_MAX_BYTES = 1_000_000;
const SOFT_LIMIT = 900_000;

export const EXPORT_NOT_INCLUDED = [
  "players and staff lists, photos and passes",
  "team registrations and captain contact details",
  "result screenshots and check-ins",
  "contact messages and invitations",
] as const;

interface Counts { id: string; teams: number; people: number; registrations: number; matches: number; checkins: number }

export async function exportMe(c: Ctx): Promise<Response> {
  const uid = c.get("userId");
  const db = c.env.DB;
  await rateLimitSubject(c, "export", uid, 5, 3600);

  const user = await db.prepare("SELECT id, email, name, created_at, email_verified_at FROM users WHERE id = ?1").bind(uid).first<{ id: string; email: string; name: string; created_at: string; email_verified_at: string | null }>();
  if (!user) throw new HttpError(401, "Authentication required");
  const [memberships, mine, viaOrg, kits, profiles, links] = await Promise.all([
    db.prepare("SELECT o.id AS id, o.name AS name, o.kind AS kind, m.role AS role, m.added_at AS added_at FROM org_members m JOIN organisations o ON o.id = m.org_id WHERE m.user_id = ?1 ORDER BY m.added_at, o.id LIMIT 20").bind(uid).all<{ id: string; name: string; kind: string; role: string; added_at: string }>(),
    myEventList(db, uid, 500),
    db
      .prepare("SELECT e.id AS id, e.slug AS slug, e.name AS name, e.game AS game, e.organiser AS organiser, e.date AS date, e.starts_on AS starts_on, e.venue AS venue, e.created_at AS created_at, e.org_id AS org_id, m.role AS org_role FROM events e JOIN org_members m ON m.org_id = e.org_id AND m.user_id = ?1 ORDER BY e.created_at DESC, e.id DESC LIMIT 500")
      .bind(uid)
      .all<{ id: string; slug: string; name: string; game: string; organiser: string; date: string; starts_on: string | null; venue: string; created_at: string; org_id: string; org_role: string }>(),
    db.prepare("SELECT scope, name, logo, primary_color, secondary_color, updated_at FROM brand_kits WHERE owner_user_id = ?1 ORDER BY scope LIMIT 100").bind(uid).all<{ scope: string; name: string; logo: string | null; primary_color: string; secondary_color: string; updated_at: string }>(),
    db.prepare("SELECT id, name, slug, published, blurb, links, consent_note, consent_at, updated_at FROM team_profiles WHERE owner_user_id = ?1 ORDER BY updated_at DESC, id LIMIT 200").bind(uid).all<{ id: string; name: string; slug: string; published: number; blurb: string; links: string; consent_note: string | null; consent_at: string | null; updated_at: string }>(),
    db.prepare("SELECT e.profile_id AS profile_id, e.event_id AS event_id, e.team_name AS team_name FROM team_profile_events e JOIN team_profiles p ON p.id = e.profile_id WHERE p.owner_user_id = ?1 ORDER BY e.profile_id, e.event_id, e.team_name LIMIT 2000").bind(uid).all<{ profile_id: string; event_id: string; team_name: string }>(),
  ]);

  // One list, no duplicates: the user's own and guest events first (they carry the event role), then club events they reach only through a club.
  type Row = { id: string; key: string; name: string; game: string; organiser: string; date: string; startsOn: string | null; venue: string; createdAt: string; orgId: string | null; role: string };
  const byId = new Map<string, Row>();
  for (const e of mine) byId.set(e.id, { id: e.id, key: e.key, name: e.name, game: e.game, organiser: e.organiser, date: e.date, startsOn: e.startsOn, venue: e.venue, createdAt: e.createdAt, orgId: e.orgId, role: e.role });
  for (const e of viaOrg.results) if (!byId.has(e.id)) byId.set(e.id, { id: e.id, key: e.slug, name: e.name, game: e.game, organiser: e.organiser, date: e.date, startsOn: e.starts_on, venue: e.venue, createdAt: e.created_at, orgId: e.org_id, role: e.org_role === "admin" ? "club_admin" : "club_member" });
  const list = [...byId.values()].sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1)).slice(0, 500);

  const counts = list.length
    ? await db
        .prepare(
          "SELECT e.id AS id, (SELECT COUNT(*) FROM teams t WHERE t.event_id = e.id) AS teams, (SELECT COUNT(*) FROM people p WHERE p.event_id = e.id) AS people, (SELECT COUNT(*) FROM registrations r WHERE r.event_id = e.id) AS registrations, (SELECT COUNT(*) FROM matches m WHERE m.event_id = e.id) AS matches, (SELECT COUNT(*) FROM checkins k WHERE k.event_id = e.id) AS checkins FROM events e WHERE e.id IN (SELECT value FROM json_each(?1))",
        )
        .bind(JSON.stringify(list.map((e) => e.id)))
        .all<Counts>()
    : { results: [] as Counts[] };
  const countOf = new Map(counts.results.map((r) => [r.id, r]));
  const linksBy = new Map<string, { eventId: string; teamName: string }[]>();
  for (const l of links.results) (linksBy.get(l.profile_id) ?? linksBy.set(l.profile_id, []).get(l.profile_id)!).push({ eventId: l.event_id, teamName: l.team_name });

  const build = (withLogos: boolean) => ({
    exportVersion: 1,
    exportedAt: new Date().toISOString(),
    account: { id: user.id, email: user.email, name: user.name, createdAt: user.created_at, emailVerified: !!user.email_verified_at },
    memberships: memberships.results.map((m) => ({ orgId: m.id, name: m.name, kind: m.kind, role: m.role, addedAt: m.added_at })),
    events: list.map((e) => {
      const n = countOf.get(e.id);
      return { ...e, counts: { teams: n?.teams ?? 0, people: n?.people ?? 0, registrations: n?.registrations ?? 0, matches: n?.matches ?? 0, checkins: n?.checkins ?? 0 } };
    }),
    brandKits: kits.results.map((k) => ({ scope: k.scope, name: k.name, primaryColor: k.primary_color, secondaryColor: k.secondary_color, hasLogo: !!k.logo, logo: withLogos ? k.logo : null, updatedAt: k.updated_at })),
    teamProfiles: profiles.results.map((p) => ({ id: p.id, name: p.name, slug: p.slug, published: !!p.published, blurb: p.blurb, links: safeJson(p.links), consentNote: p.consent_note, consentAt: p.consent_at, updatedAt: p.updated_at, events: linksBy.get(p.id) ?? [] })),
    notIncluded: EXPORT_NOT_INCLUDED,
  });
  let text = JSON.stringify(build(true));
  if (text.length > SOFT_LIMIT) text = JSON.stringify({ ...build(false), logosOmitted: true });
  if (text.length > EXPORT_MAX_BYTES) throw new HttpError(413, "Your data is too large for one download. Contact support and we will send it another way.");
  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "private, no-store", "content-disposition": 'attachment; filename="esports-hub-my-data.json"' },
  });
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return [];
  }
}
