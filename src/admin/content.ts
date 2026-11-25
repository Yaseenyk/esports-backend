/**
 * Content moderation hub (mounted after requireStaff in src/admin/routes.ts). ONE place for the newest public content of every kind, each with
 * hide / restore and a reason. It reuses the mechanism each kind already has, so the public pages need no change:
 *
 *   kind       table                 hide / restore                                                    audit row
 *   scrims     scrim_slots           hidden_at (restore = scrim-service decideSlot "restore")           content.hidden / content.restored {kind: scrim}
 *   lft        lft_listings          hidden_at (restore = lft-service decideListing "restore")          content.hidden / content.restored {kind: lft}
 *   directory  directory_entries     takedown 'directory_entry' (restore also clears held_at)           takedown.hidden / takedown.restored
 *   calendar   calendar_entries      calendar-service staffSetEntryHidden (reason + moderation log)     calendar.hidden / calendar.restored
 *   ratings    organiser_ratings     trust-service staffSetHidden, target review or reply               trust.hidden / trust.restored
 *   results    br_results + matches  takedown 'event': recaps and screenshot results are shown on the event's public pages, so hiding the event
 *                                    hides them (a recap links to the public page only while it is not taken down)  takedown.hidden / takedown.restored
 *
 *  GET  /admin/v1/content?kind=&state=all|hidden&id=&after=   newest first, 25 a page, with the reasons that kind accepts
 *  POST /admin/v1/content/:kind/:id/hide      { reasonCode, target?, note? }
 *  POST /admin/v1/content/:kind/:id/restore   { reasonCode, target?, note? }
 *
 * Contact fields (scrim contact, LFT contact, registration links) are never selected. A kind whose table is not migrated answers available: false.
 * Reversible actions only; no step-up (like takedowns). Constant SQL only.
 */
import { Hono } from "hono";
import { audit, auditOff, auditStmts } from "../audit";
import { HttpError, readJson } from "../http";
import { createTakedown, revokeTakedown, type TakedownResult } from "../moderation";
import { MODERATION_REASONS } from "../v3/lib/community";
import { ID32_RE } from "../v3/lib/ids";
import { staffSetEntryHidden } from "../v3/services/calendar-service";
import { decideListing } from "../v3/services/lft-service";
import { decideSlot } from "../v3/services/scrim-service";
import { staffSetHidden } from "../v3/services/trust-service";
import { existing } from "./console";
import { REASON_CODES, reasonCodeOf } from "./flags";
import { cursor, derive, failure } from "./moderation";
import type { ACtx, AdminBindings } from "./session";

export const contentRoutes = new Hono<AdminBindings>();

export const CONTENT_KINDS = ["scrims", "lft", "directory", "calendar", "ratings", "results"] as const;
export type ContentKind = (typeof CONTENT_KINDS)[number];
const TABLE: Record<ContentKind, string> = { scrims: "scrim_slots", lft: "lft_listings", directory: "directory_entries", calendar: "calendar_entries", ratings: "organiser_ratings", results: "events" };
/** Calendar entries and ratings keep their own reason list (stored in their moderation logs); everything else uses the staff reason codes. */
export const reasonsFor = (k: ContentKind): readonly string[] => (k === "calendar" || k === "ratings" ? MODERATION_REASONS : REASON_CODES);

const NO_STORE = { "cache-control": "no-store" };
const PAGE = 25;
const isKind = (v: unknown): v is ContentKind => typeof v === "string" && (CONTENT_KINDS as readonly string[]).includes(v);
const iso = (s: number | null | undefined): string | null => (typeof s === "number" ? new Date(s * 1000).toISOString() : null);

export interface ContentItem {
  kind: ContentKind; id: string; title: string; body: string | null; meta: string[]; status: string;
  hidden: boolean; hiddenReason: string | null; reports: number; createdAt: string | null; link: string | null;
  /** ratings only: the organiser's reply and whether it is hidden on its own */
  reply?: string | null; replyHidden?: boolean;
}

type R = Record<string, unknown>;
const s = (v: unknown): string => (typeof v === "string" ? v : v === null || v === undefined ? "" : String(v));
const n = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0) || 0);

async function list(db: D1Database, kind: ContentKind, id: string | null, hiddenOnly: boolean, after: number): Promise<{ rows: R[]; more: boolean }> {
  const h = hiddenOnly ? 1 : 0;
  let r: D1Result<R>;
  switch (kind) {
    case "scrims":
      r = await db.prepare("SELECT s.id AS id, s.game AS game, s.starts_at AS starts_at, s.status AS status, s.skill_note AS skill_note, s.hidden_at AS hidden_at, s.report_count AS reports, s.created_at AS created_at, tp.name AS team_name FROM scrim_slots s LEFT JOIN team_profiles tp ON tp.id = s.team_profile_id WHERE (?1 IS NULL OR s.id = ?1) AND (?2 = 0 OR s.hidden_at IS NOT NULL) ORDER BY s.created_at DESC, s.id DESC LIMIT ?3 OFFSET ?4").bind(id, h, PAGE + 1, after).all<R>();
      break;
    case "lft":
      r = await db.prepare("SELECT id, kind, game, substr(message, 1, 400) AS message, status, hidden_at, report_count AS reports, created_at FROM lft_listings WHERE (?1 IS NULL OR id = ?1) AND (?2 = 0 OR hidden_at IS NOT NULL) ORDER BY created_at DESC, id DESC LIMIT ?3 OFFSET ?4").bind(id, h, PAGE + 1, after).all<R>();
      break;
    case "directory":
      r = await db.prepare("SELECT * FROM (SELECT d.event_id AS id, d.title AS title, d.game AS game, d.city AS city, d.mode AS mode, d.starts_on AS starts_on, substr(d.blurb, 1, 300) AS blurb, d.listed AS listed, d.held_at AS held_at, d.updated_at AS updated_at, (SELECT k.reason_code FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'directory_entry' AND k.target_id = d.event_id) AS takedown_reason, (SELECT COUNT(*) FROM directory_reports x WHERE x.event_id = d.event_id AND x.resolved_at IS NULL) AS reports FROM directory_entries d WHERE (?1 IS NULL OR d.event_id = ?1)) WHERE (listed = 1 OR held_at IS NOT NULL OR takedown_reason IS NOT NULL OR ?1 IS NOT NULL) AND (?2 = 0 OR held_at IS NOT NULL OR takedown_reason IS NOT NULL) ORDER BY updated_at DESC, id DESC LIMIT ?3 OFFSET ?4").bind(id, h, PAGE + 1, after).all<R>();
      break;
    case "calendar":
      r = await db.prepare("SELECT c.id AS id, c.title AS title, c.game AS game, c.city AS city, c.online AS online, c.starts_on AS starts_on, c.ends_on AS ends_on, c.status AS status, c.hidden_at AS hidden_at, c.hidden_reason AS hidden_reason, c.created_at AS created_at, o.name AS org_name FROM calendar_entries c JOIN organisations o ON o.id = c.org_id WHERE (?1 IS NULL OR c.id = ?1) AND (?2 = 0 OR c.hidden_at IS NOT NULL) ORDER BY c.created_at DESC, c.id DESC LIMIT ?3 OFFSET ?4").bind(id, h, PAGE + 1, after).all<R>();
      break;
    case "ratings":
      r = await db.prepare("SELECT r.id AS id, r.display_name AS display_name, r.stars AS stars, r.review AS review, r.reply AS reply, r.hidden_at AS hidden_at, r.hidden_reason AS hidden_reason, r.reply_hidden_at AS reply_hidden_at, r.created_at AS created_at, e.name AS event_name, (SELECT COUNT(*) FROM organiser_rating_reports p WHERE p.rating_id = r.id AND p.status = 'open') AS reports FROM organiser_ratings r LEFT JOIN events e ON e.id = r.event_id WHERE (?1 IS NULL OR r.id = ?1) AND (?2 = 0 OR r.hidden_at IS NOT NULL OR r.reply_hidden_at IS NOT NULL) ORDER BY r.created_at DESC, r.id DESC LIMIT ?3 OFFSET ?4").bind(id, h, PAGE + 1, after).all<R>();
      break;
    case "results":
      r = await db.prepare("SELECT e.id AS id, e.name AS name, e.game AS game, x.last_at AS last_at, x.br_rows AS br_rows, x.matches_done AS matches_done, t.slug AS tournament_slug, t.status AS tournament_status, (SELECT k.reason_code FROM takedowns k WHERE k.state = 'hidden' AND k.target_type = 'event' AND k.target_id = e.id) AS takedown_reason, (SELECT COUNT(*) FROM reports p WHERE p.event_id = e.id AND p.status IN ('open','needs_other_staff')) AS reports FROM (SELECT event_id, MAX(at) AS last_at, SUM(br) AS br_rows, SUM(m) AS matches_done FROM (SELECT event_id, updated_at AS at, 1 AS br, 0 AS m FROM br_results UNION ALL SELECT event_id, updated_at AS at, 0 AS br, 1 AS m FROM matches WHERE status IN ('finished','forfeit')) GROUP BY event_id) x JOIN events e ON e.id = x.event_id LEFT JOIN tournaments t ON t.event_id = e.id WHERE (?1 IS NULL OR e.id = ?1) AND (?2 = 0 OR EXISTS (SELECT 1 FROM takedowns k2 WHERE k2.state = 'hidden' AND k2.target_type = 'event' AND k2.target_id = e.id)) ORDER BY x.last_at DESC, e.id DESC LIMIT ?3 OFFSET ?4").bind(id, h, PAGE + 1, after).all<R>();
      break;
  }
  return { rows: r.results.slice(0, PAGE), more: r.results.length > PAGE };
}

export function toItem(kind: ContentKind, x: R): ContentItem {
  switch (kind) {
    case "scrims":
      return { kind, id: s(x.id), title: s(x.team_name) || "Scrim slot", body: s(x.skill_note) || null, meta: [s(x.game), `starts ${iso(n(x.starts_at)) ?? ""}`], status: s(x.status), hidden: x.hidden_at !== null, hiddenReason: null, reports: n(x.reports), createdAt: iso(n(x.created_at)), link: null };
    case "lft":
      return { kind, id: s(x.id), title: s(x.kind) === "looking_for_player" ? "Team looking for a player" : "Player looking for a team", body: s(x.message), meta: [s(x.game)], status: s(x.status), hidden: x.hidden_at !== null, hiddenReason: null, reports: n(x.reports), createdAt: iso(n(x.created_at)), link: null };
    case "directory":
      return { kind, id: s(x.id), title: s(x.title) || "Directory listing", body: s(x.blurb) || null, meta: [s(x.game), s(x.city), s(x.mode), s(x.starts_on)].filter(Boolean), status: n(x.listed) === 1 ? "listed" : "not listed", hidden: x.held_at !== null || x.takedown_reason !== null, hiddenReason: x.takedown_reason === null ? (x.held_at !== null ? "held_by_reports" : null) : s(x.takedown_reason), reports: n(x.reports), createdAt: s(x.updated_at) || null, link: null };
    case "calendar":
      return { kind, id: s(x.id), title: s(x.title), body: null, meta: [s(x.org_name), s(x.game), n(x.online) === 1 ? "online" : s(x.city), `${s(x.starts_on)} to ${s(x.ends_on)}`], status: s(x.status), hidden: x.hidden_at !== null, hiddenReason: x.hidden_reason === null ? null : s(x.hidden_reason), reports: 0, createdAt: iso(n(x.created_at)), link: null };
    case "ratings":
      return { kind, id: s(x.id), title: `${n(x.stars)} of 5 from ${s(x.display_name)}`, body: x.review === null ? null : s(x.review), meta: [s(x.event_name)].filter(Boolean), status: x.hidden_at !== null ? "hidden" : "visible", hidden: x.hidden_at !== null, hiddenReason: x.hidden_reason === null ? null : s(x.hidden_reason), reports: n(x.reports), createdAt: iso(n(x.created_at)), link: null, reply: x.reply === null ? null : s(x.reply), replyHidden: x.reply_hidden_at !== null };
    case "results": {
      const slug = s(x.tournament_slug);
      const parts = [s(x.game), n(x.br_rows) ? `${n(x.br_rows)} battle royale rows` : "", n(x.matches_done) ? `${n(x.matches_done)} finished matches` : ""].filter(Boolean);
      return { kind, id: s(x.id), title: s(x.name) || "Event", body: null, meta: parts, status: s(x.tournament_status) || "event", hidden: x.takedown_reason !== null, hiddenReason: x.takedown_reason === null ? null : s(x.takedown_reason), reports: n(x.reports), createdAt: s(x.last_at) || null, link: slug && /^[a-z0-9-]{1,80}$/.test(slug) ? `/tournaments/${slug}/` : null };
    }
  }
}

contentRoutes.get("/content", async (c) => {
  const kind = c.req.query("kind");
  if (!isKind(kind)) throw new HttpError(400, `kind must be one of ${CONTENT_KINDS.join(", ")}`);
  const state = c.req.query("state") ?? "all";
  if (state !== "all" && state !== "hidden") throw new HttpError(400, "state must be all or hidden");
  const idQ = c.req.query("id");
  const id = idQ === undefined || idQ === "" ? null : idQ;
  if (id !== null && !/^[A-Za-z0-9._~-]{1,64}$/.test(id)) throw new HttpError(400, "id is not valid");
  const after = cursor(c.req.query("after"));
  const db = c.env.DB;
  const reasons = reasonsFor(kind);
  if (!(await existing(db, [TABLE[kind]])).has(TABLE[kind])) return c.json({ kind, available: false, reasons, items: [], next: null }, 200, NO_STORE);
  const { rows, more } = await list(db, kind, id, state === "hidden", after);
  return c.json({ kind, available: true, reasons, items: rows.map((x) => toItem(kind, x)), next: more ? after + PAGE : null }, 200, NO_STORE);
});

async function takedownFor(c: ACtx, type: "directory_entry" | "event", id: string, reasonCode: string, hide: boolean): Promise<void> {
  const d = await derive(c.env.DB, type, id);
  if (!d && hide) throw new HttpError(404, "Not found");
  if (type === "directory_entry" && hide && !(await c.env.DB.prepare("SELECT 1 AS x FROM directory_entries WHERE event_id = ?1").bind(id).first())) throw new HttpError(404, "Not found");
  const input = { targetType: type, targetId: id, reasonCode, staffId: c.get("staff").id, eventId: d?.eventId ?? null, orgId: d?.orgId ?? null };
  const r: TakedownResult = hide ? await createTakedown(c.env.DB, input) : await revokeTakedown(c.env.DB, input);
  if (!r.ok) throw failure(r.code);
  if (hide && !r.changed) throw new HttpError(409, "Already hidden", { code: "already_hidden" });
}

async function act(c: ACtx, hide: boolean) {
  const kind = c.req.param("kind");
  const id = c.req.param("id") ?? "";
  if (!isKind(kind)) throw new HttpError(404, "Not found");
  const db = c.env.DB;
  if (!(await existing(db, [TABLE[kind]])).has(TABLE[kind])) throw new HttpError(404, "Not found");
  const b = await readJson(c as never, 2048);
  const staffId = c.get("staff").id;
  const at = Math.floor(Date.now() / 1000);
  switch (kind) {
    case "scrims":
    case "lft": {
      if (!ID32_RE.test(id)) throw new HttpError(404, "Not found");
      const row = kind === "scrims"
        ? await db.prepare("SELECT hidden_at FROM scrim_slots WHERE id = ?1").bind(id).first<{ hidden_at: number | null }>()
        : await db.prepare("SELECT hidden_at FROM lft_listings WHERE id = ?1").bind(id).first<{ hidden_at: number | null }>();
      if (!row) throw new HttpError(404, "Not found");
      const reasonCode = reasonCodeOf(b);
      const meta = { kind: kind === "scrims" ? "scrim" : "lft" };
      if (hide) {
        if (row.hidden_at !== null) throw new HttpError(409, "Already hidden", { code: "already_hidden" });
        const stmt = kind === "scrims"
          ? db.prepare("UPDATE scrim_slots SET hidden_at = ?2, updated_at = ?2 WHERE id = ?1 AND hidden_at IS NULL").bind(id, at)
          : db.prepare("UPDATE lft_listings SET hidden_at = ?2, updated_at = ?2 WHERE id = ?1 AND hidden_at IS NULL").bind(id, at);
        await db.batch([stmt, ...auditStmts(db, { action: "content.hidden", actorType: "staff", actorId: staffId, targetType: kind === "scrims" ? "scrim_slot" : "lft_listing", targetId: id, reasonCode, meta }, await auditOff(db))]);
      } else {
        if (row.hidden_at === null) throw new HttpError(409, "Not hidden", { code: "not_hidden" });
        // the service restore is its own batch (it also clears the reports, 409 not_hidden when nothing is hidden); the audit row follows the committed change
        if (kind === "scrims") await decideSlot(db, id, "restore");
        else await decideListing(db, id, "restore");
        await audit(db, { action: "content.restored", actorType: "staff", actorId: staffId, targetType: kind === "scrims" ? "scrim_slot" : "lft_listing", targetId: id, reasonCode, meta });
      }
      break;
    }
    case "calendar":
      await staffSetEntryHidden(db, staffId, id, hide, { reason: b.reasonCode, note: b.note });
      break;
    case "ratings":
      await staffSetHidden(db, staffId, id, hide, { reason: b.reasonCode, note: b.note, target: b.target ?? "review" });
      break;
    case "directory":
      if (!/^[A-Za-z0-9._~-]{1,64}$/.test(id)) throw new HttpError(404, "Not found");
      await takedownFor(c, "directory_entry", id, reasonCodeOf(b), hide);
      break;
    case "results":
      if (!/^[A-Za-z0-9._~-]{1,64}$/.test(id)) throw new HttpError(404, "Not found");
      await takedownFor(c, "event", id, reasonCodeOf(b), hide);
      break;
  }
  const { rows } = await list(db, kind, id, false, 0);
  return c.json({ ok: true, item: rows[0] ? toItem(kind, rows[0]) : null }, 200, NO_STORE);
}

contentRoutes.post("/content/:kind/:id/hide", (c) => act(c, true));
contentRoutes.post("/content/:kind/:id/restore", (c) => act(c, false));

export const CONTENT_ROUTES: readonly { method: string; path: string }[] = [
  { method: "GET", path: "/admin/v1/content" },
  { method: "POST", path: "/admin/v1/content/:kind/:id/hide" },
  { method: "POST", path: "/admin/v1/content/:kind/:id/restore" },
];
