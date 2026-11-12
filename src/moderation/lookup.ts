/**
 * Public key -> immutable target (dev-review-r2 N-12). The public routes resolve a slug or token; moderation stores the id the page row carries, so a
 * slug rename or a token rotation cannot bypass a takedown. `lookupKey` is the snapshot staff search by: the slug itself for slug pages (public anyway),
 * the event id for the directory, and a short hash prefix for token pages (a token is a credential and is never stored).
 */
import { hashToken } from "../links";
import { sha256, hashKey } from "../crypto";
import { ID_RE, type PublicKind, type TargetType } from "./codes";

export interface Target {
  type: TargetType;
  id: string;
  eventId: string | null;
  orgId: string | null;
  lookupKey: string;
}

type Row = { id: string; event_id: string | null; org_id: string | null };

/** Snapshot key for a token page: `h:` plus 12 characters of the SHA-256 (enough to find the row, useless as a credential). */
export const tokenLookupKey = (hash: string): string => `h:${hash.slice(0, 12)}`;

/**
 * Resolves what a visitor reported. Returns null when the page does not exist, is not published, or its link is revoked (the caller answers the same
 * way either way). Constant SQL; at most two reads.
 */
export async function resolveTarget(db: D1Database, kind: PublicKind, key: string): Promise<Target | null> {
  if (!ID_RE.test(key)) return null;
  switch (kind) {
    case "live": {
      const r = await db.prepare("SELECT l.event_id AS id, l.event_id AS event_id, e.org_id AS org_id FROM live_pages l JOIN events e ON e.id = l.event_id WHERE l.slug = ?1 AND l.published = 1").bind(key).first<Row>();
      return r ? { type: "live_page", id: r.id, eventId: r.event_id, orgId: r.org_id, lookupKey: key } : null;
    }
    case "league": {
      const r = await db.prepare("SELECT l.event_id AS id, l.event_id AS event_id, e.org_id AS org_id FROM league_settings l JOIN events e ON e.id = l.event_id WHERE l.slug = ?1 AND l.published = 1").bind(key).first<Row>();
      return r ? { type: "league_page", id: r.id, eventId: r.event_id, orgId: r.org_id, lookupKey: key } : null;
    }
    case "team": {
      const r = await db.prepare("SELECT id, NULL AS event_id, NULL AS org_id FROM team_profiles WHERE slug = ?1 AND published = 1").bind(key).first<Row>();
      return r ? { type: "team_profile", id: r.id, eventId: null, orgId: null, lookupKey: key } : null;
    }
    case "directory": {
      const r = await db.prepare("SELECT d.event_id AS id, d.event_id AS event_id, e.org_id AS org_id FROM directory_entries d JOIN events e ON e.id = d.event_id WHERE d.event_id = ?1 AND d.listed = 1").bind(key).first<Row>();
      return r ? { type: "directory_entry", id: r.id, eventId: r.event_id, orgId: r.org_id, lookupKey: key } : null;
    }
    case "registration": {
      const h = await hashToken(key);
      const r =
        (await db.prepare("SELECT f.event_id AS id, f.event_id AS event_id, e.org_id AS org_id FROM registration_forms f JOIN events e ON e.id = f.event_id WHERE f.token_hash = ?1").bind(h).first<Row>()) ??
        (await db.prepare("SELECT f.event_id AS id, f.event_id AS event_id, e.org_id AS org_id FROM registration_forms f JOIN events e ON e.id = f.event_id WHERE f.token = ?1 AND f.token_hash IS NULL").bind(key).first<Row>());
      return r ? { type: "registration_form", id: r.id, eventId: r.event_id, orgId: r.org_id, lookupKey: tokenLookupKey(h) } : null;
    }
    case "pass": {
      const h = await hashToken(key);
      const r =
        (await db.prepare("SELECT s.id AS id, s.event_id AS event_id, e.org_id AS org_id FROM share_links s JOIN events e ON e.id = s.event_id WHERE s.token_hash = ?1 AND s.revoked = 0").bind(h).first<Row>()) ??
        (await db.prepare("SELECT s.id AS id, s.event_id AS event_id, e.org_id AS org_id FROM share_links s JOIN events e ON e.id = s.event_id WHERE s.token = ?1 AND s.token_hash IS NULL AND s.revoked = 0").bind(key).first<Row>());
      return r ? { type: "pass", id: r.id, eventId: r.event_id, orgId: r.org_id, lookupKey: tokenLookupKey(h) } : null;
    }
    case "results": {
      const h = await hashToken(key);
      const r = await db.prepare("SELECT c.id AS id, c.event_id AS event_id, e.org_id AS org_id FROM captain_links c JOIN events e ON e.id = c.event_id WHERE c.token_hash = ?1 AND c.revoked_at IS NULL").bind(h).first<Row>();
      return r ? { type: "results", id: r.id, eventId: r.event_id, orgId: r.org_id, lookupKey: tokenLookupKey(h) } : null;
    }
  }
}

/** The reporter's identity for counting: a salted hash of the address. Never the address, never an account. Same address, same target counts once. */
export const reporterHash = (env: { HASH_KEY?: string; JWT_SECRET: string }, ip: string): Promise<string> => sha256(`${hashKey(env)}|publicReporter|${ip}`);
