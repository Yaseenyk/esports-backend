/**
 * Dispute portal rules. Who may raise, read, upload, move and resolve; the status machine; the corrections; the retention dates.
 * No SQL here. Who is a "party": the raiser, and the signed-in captains of the raising and the named team (proved with the legacy captain-link token).
 */
import { HttpError } from "../../http";
import { DISPUTE_OUTCOMES, DISPUTE_STATUSES, DISPUTE_TYPES, isOneOf, type DisputeStatus } from "../lib/enums";
import { detectImage, EVIDENCE_MAX_BYTES, EVIDENCE_MAX_FILES, sha256Hex } from "../lib/image-magic";
import { newId, nowSec } from "../lib/ids";
import { validateFreeText } from "../lib/lft-text";
import { DISPUTE_FINAL, DISPUTE_MOVES, canMove } from "../lib/state-machines";
import { bad, optInt, reqEnum } from "../lib/validate";
import { loadEventAccess } from "../repositories/event-access-repo";
import * as repo from "../repositories/dispute-repo";
import type { DisputeRow } from "../repositories/dispute-repo";
import * as trepo from "../repositories/tournament-repo";
import { isOverdue, toDisputeDetail, toDisputeListItem, type Permissions } from "../adapters/dispute-adapter";
import { brRef, matchRef } from "../adapters/results-overlay";

type Body = Record<string, unknown>;
export type Actor = { kind: "user" | "staff"; userId: string };

export const DISPUTES = { DUE_SEC: 72 * 3600, EVIDENCE_RETENTION_SEC: 90 * 86_400, MAX_OPEN_PER_RAISER: 3, MAX_CORRECTIONS: 10 } as const;
const RAISE_STATES = ["registration_closed", "live", "completed"];

interface Relation {
  staff: boolean;
  organiser: boolean;
  raiser: boolean;
  captainRaising: boolean;
  captainAgainst: boolean;
}
const isParty = (r: Relation): boolean => r.raiser || r.captainRaising || r.captainAgainst;

async function relationOf(db: D1Database, actor: Actor, d: DisputeRow): Promise<Relation> {
  const staff = actor.kind === "staff";
  const [access, caps] = await Promise.all([staff ? Promise.resolve(null) : loadEventAccess(db, actor.userId, d.t_event_id), repo.captainTeams(db, d.t_event_id, actor.userId)]);
  const keys = new Set(caps.map((c) => c.team_key));
  return {
    staff,
    organiser: !!access && access.canWrite,
    raiser: d.raised_by_user_id === actor.userId,
    captainRaising: !!d.raised_by_team_key && keys.has(d.raised_by_team_key),
    captainAgainst: !!d.against_team_key && keys.has(d.against_team_key),
  };
}

const roleLabel = (r: Relation): "moderator" | "organiser" | "team" | "raiser" => (r.staff ? "moderator" : r.organiser ? "organiser" : r.raiser ? "raiser" : "team");
const isFinal = (s: string): boolean => (DISPUTE_FINAL as readonly string[]).includes(s);

/** Nobody decides a dispute they raised or are named in. A decision is the organiser's (until escalation) or a moderator's. */
function decider(r: Relation, d: DisputeRow): "organiser" | "moderator" | null {
  if (isParty(r)) return null;
  if (r.staff) return "moderator";
  if (r.organiser && d.status !== "escalated") return "organiser";
  return null;
}

function permissionsFor(r: Relation, d: DisputeRow): Permissions {
  const final = isFinal(d.status);
  const who = decider(r, d);
  const transitions: string[] = [];
  if (!final) {
    for (const to of DISPUTE_MOVES[d.status as DisputeStatus]) {
      if (to === "withdrawn") { if (r.raiser) transitions.push(to); }
      else if (to === "resolved" || to === "rejected") continue;
      else if (to === "escalated") { if (who === "organiser") transitions.push(to); }
      else if (who) transitions.push(to);
    }
  }
  return {
    canComment: !final && (r.staff || r.organiser || isParty(r)),
    canUploadEvidence: !final && (r.organiser || isParty(r)),
    canWithdraw: !final && r.raiser,
    transitions,
    canResolve: !!who && (d.status === "under_review" || d.status === "escalated"),
    role: roleLabel(r),
  };
}

/** Loads a dispute for a caller who may read it; everyone else gets the same 404 as a missing id. */
async function readable(db: D1Database, actor: Actor, id: string): Promise<{ d: DisputeRow; rel: Relation }> {
  const d = /^[0-9a-f]{32}$/.test(id) ? await repo.findDispute(db, id) : null;
  if (!d) throw new HttpError(404, "Not found");
  const rel = await relationOf(db, actor, d);
  if (!(rel.staff || rel.organiser || isParty(rel))) throw new HttpError(404, "Not found");
  return { d, rel };
}

async function detail(db: D1Database, d: DisputeRow, rel: Relation) {
  const [events, evidence, corrections] = await Promise.all([repo.listEvents(db, d.id), repo.listEvidence(db, d.id), repo.corrections(db, d.id)]);
  return toDisputeDetail(d, events, evidence, corrections, permissionsFor(rel, d), nowSec());
}

async function reload(db: D1Database, actor: Actor, id: string) {
  const { d, rel } = await readable(db, actor, id);
  return detail(db, d, rel);
}

// ---------------- captain claim ----------------
/** A signed-in user proves they captain a team by presenting that team's (legacy) captain-link token. The token is never stored. */
export async function claimCaptain(db: D1Database, userId: string, slug: string, token: unknown) {
  const t = await trepo.findBySlug(db, slug);
  if (!t || t.status === "draft" || t.status === "cancelled") throw new HttpError(404, "Not found");
  if (typeof token !== "string" || token.length > 128) throw bad("token is required", "token_required");
  const c = await repo.captainTokenTeam(db, token);
  if (!c || c.eventId !== t.eventId) throw new HttpError(404, "That captain link is not valid for this tournament", { code: "bad_token" });
  if (!(await repo.teamIsRegistered(db, t.eventId, c.team))) throw new HttpError(409, "That team is not registered in this tournament", { code: "team_not_registered" });
  await repo.claimCaptain(db, t.eventId, c.team, userId, nowSec());
  return { team: c.team, tournament: { slug: t.slug, title: t.title } };
}

// ---------------- raise ----------------
export async function raiseDispute(db: D1Database, userId: string, slug: string, b: Body) {
  const t = await trepo.findBySlug(db, slug);
  if (!t) throw new HttpError(404, "Not found");
  const access = await loadEventAccess(db, userId, t.eventId);
  const organiser = !!access && access.canWrite;
  const caps = await repo.captainTeams(db, t.eventId, userId);
  if (!organiser && caps.length === 0) throw new HttpError(404, "Not found"); // neither organiser nor a proven captain: indistinguishable from "no such tournament"
  if (!RAISE_STATES.includes(t.status)) throw new HttpError(409, "Disputes can be raised once registration has closed", { code: "tournament_not_started" });

  const type = reqEnum(b.type, DISPUTE_TYPES, "type");
  const sum = validateFreeText(b.summary, 1000, 10);
  if (!sum.ok) throw bad(sum.code === "empty" ? "summary must be at least 10 characters" : sum.code === "has_phone" ? "summary must not contain phone numbers" : "summary is not valid", `summary_${sum.code}`);

  // As a team: `team` names one of the caller's captained teams (or is implied when they captain exactly one and are not the organiser).
  // As the organiser: no `team`; a named opponent goes in `againstTeam`.
  let raisedByTeam: string | null = null;
  if (b.team !== undefined || (!organiser && caps.length > 0)) {
    const want = typeof b.team === "string" ? b.team.trim().toLowerCase() : caps.length === 1 ? caps[0]!.team_key : "";
    const mine = caps.find((c) => c.team_key === want);
    if (!mine) throw bad("team must be one of the teams you captain", "invalid_team");
    raisedByTeam = mine.team_name;
  }

  let againstTeam: string | null = null;
  if (b.againstTeam !== undefined && b.againstTeam !== null && b.againstTeam !== "") {
    if (typeof b.againstTeam !== "string" || b.againstTeam.length > 60) throw bad("againstTeam is not valid", "invalid_againstTeam");
    const name = b.againstTeam.trim();
    if (!(await repo.teamIsRegistered(db, t.eventId, name))) throw bad("againstTeam is not a registered team of this tournament", "invalid_againstTeam");
    if (raisedByTeam && raisedByTeam.toLowerCase() === name.toLowerCase()) throw bad("A team cannot raise a dispute against itself", "invalid_againstTeam");
    againstTeam = name;
  }
  let matchId: string | null = null;
  if (b.matchId !== undefined && b.matchId !== null) {
    if (typeof b.matchId !== "string" || !(await repo.legacyMatch(db, t.eventId, b.matchId))) throw bad("matchId is not a match of this tournament", "invalid_matchId");
    matchId = b.matchId;
  }
  const matchNo = optInt(b.matchNo, "matchNo", 1, 10_000) ?? null;

  if ((await repo.countOpenRaisedBy(db, userId, t.id)) >= DISPUTES.MAX_OPEN_PER_RAISER) {
    throw new HttpError(429, `You can have at most ${DISPUTES.MAX_OPEN_PER_RAISER} open disputes in one tournament`, { code: "dispute_cap" });
  }
  const at = nowSec();
  const id = newId();
  await repo.insertDispute(db, { id, tournamentId: t.id, matchId, matchNo, type, raisedByUserId: userId, raisedByTeam, againstTeam, summary: sum.text, at, dueAt: at + DISPUTES.DUE_SEC, actorRole: raisedByTeam ? "team" : "organiser" }, t.eventId);
  return reload(db, { kind: "user", userId }, id);
}

// ---------------- read ----------------
export async function getDispute(db: D1Database, actor: Actor, id: string) {
  const { d, rel } = await readable(db, actor, id);
  return detail(db, d, rel);
}

/** The organiser sees every dispute of the tournament; a captain only those they are party to; anyone else 404. */
export async function listTournamentDisputes(db: D1Database, userId: string, slug: string) {
  const t = await trepo.findBySlug(db, slug);
  if (!t) throw new HttpError(404, "Not found");
  const access = await loadEventAccess(db, userId, t.eventId);
  const now = nowSec();
  if (access && access.canWrite) return { items: (await repo.listForTournament(db, t.id, 200)).map((d) => toDisputeListItem(d, now)) };
  const mine = await repo.listForUser(db, userId, 100, t.id);
  const caps = await repo.captainTeams(db, t.eventId, userId);
  if (mine.length === 0 && caps.length === 0) throw new HttpError(404, "Not found");
  return { items: mine.map((d) => toDisputeListItem(d, now)) };
}
export async function myDisputes(db: D1Database, userId: string) {
  const now = nowSec();
  return { items: (await repo.listForUser(db, userId, 100)).map((d) => toDisputeListItem(d, now)) };
}
export async function staffQueue(db: D1Database, q: { status?: string; after?: string }) {
  if (q.status !== undefined && !isOneOf(DISPUTE_STATUSES, q.status)) throw bad("status is not valid", "invalid_status");
  const after = q.after === undefined || q.after === "" ? 0 : Number(q.after);
  if (!Number.isInteger(after) || after < 0 || after > 100_000) throw bad("after is not valid", "invalid_after");
  const rows = await repo.listQueue(db, q.status ?? null, after, 51);
  const now = nowSec();
  return { items: rows.slice(0, 50).map((d) => toDisputeListItem(d, now)), next: rows.length > 50 ? after + 50 : null };
}

// ---------------- comment ----------------
export async function commentOnDispute(db: D1Database, actor: Actor, id: string, b: Body) {
  const { d, rel } = await readable(db, actor, id);
  if (isFinal(d.status)) throw new HttpError(409, "This dispute is closed", { code: "dispute_final" });
  const txt = validateFreeText(b.note, 1000, 1);
  if (!txt.ok) throw bad(txt.code === "has_phone" ? "note must not contain phone numbers" : "note is required (at most 1000 characters)", `note_${txt.code}`);
  await repo.addComment(db, d.id, actor.userId, roleLabel(rel), txt.text, nowSec());
  return reload(db, actor, id);
}

// ---------------- evidence ----------------
export async function addEvidence(db: D1Database, actor: Actor, id: string, bytes: Uint8Array, captionRaw: string | undefined) {
  const { d, rel } = await readable(db, actor, id);
  if (!(rel.organiser || isParty(rel))) throw new HttpError(403, "Only the two teams and the organiser can add evidence", { code: "not_allowed" });
  if (isFinal(d.status)) throw new HttpError(409, "This dispute is closed", { code: "dispute_final" });
  if (bytes.length === 0) throw bad("The file is empty", "empty_file");
  if (bytes.length > EVIDENCE_MAX_BYTES) throw new HttpError(413, "Each screenshot must be at most 400 KB (the app compresses it before upload)", { code: "file_too_large" });
  const mime = detectImage(bytes);
  if (!mime) throw new HttpError(415, "Only PNG, JPEG or WebP images are accepted", { code: "bad_image" });
  let caption: string | null = null;
  if (captionRaw) {
    const c = validateFreeText(captionRaw, 200, 1);
    if (!c.ok) throw bad("caption is not valid", `caption_${c.code}`);
    caption = c.text;
  }
  const sha = await sha256Hex(bytes);
  if (await repo.evidenceHashExists(db, d.id, sha)) throw new HttpError(409, "This screenshot was already added", { code: "duplicate_evidence" });
  const evId = newId();
  const exact = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
  let ok: boolean;
  try {
    ok = await repo.insertEvidenceCapped(db, { id: evId, disputeId: d.id, userId: actor.userId, actorRole: roleLabel(rel), mime, size: bytes.length, sha, caption, at: nowSec(), bytes: exact, max: EVIDENCE_MAX_FILES });
  } catch (e) {
    if (/UNIQUE/i.test(String(e) + String((e as { cause?: unknown }).cause ?? ""))) throw new HttpError(409, "This screenshot was already added", { code: "duplicate_evidence" });
    throw e;
  }
  if (!ok) throw new HttpError(409, `A dispute can hold at most ${EVIDENCE_MAX_FILES} screenshots`, { code: "evidence_cap" });
  return { id: evId, mimeType: mime, sizeBytes: bytes.length, caption };
}

/** The bytes of one screenshot, for the two teams, the organiser and moderators only. */
export async function evidenceDownload(db: D1Database, actor: Actor, id: string, evidenceId: string) {
  const { d } = await readable(db, actor, id);
  if (!/^[0-9a-f]{32}$/.test(evidenceId)) throw new HttpError(404, "Not found");
  const f = await repo.evidenceFile(db, d.id, evidenceId);
  if (f === null) throw new HttpError(404, "Not found");
  if (f === "purged") throw new HttpError(410, "This screenshot was deleted under the retention rule", { code: "evidence_purged" });
  return f;
}

// ---------------- transitions ----------------
export async function transitionDispute(db: D1Database, actor: Actor, id: string, b: Body) {
  const { d, rel } = await readable(db, actor, id);
  const to = reqEnum(b.to, DISPUTE_STATUSES, "to");
  if (to === "resolved" || to === "rejected") throw bad("Use the resolve endpoint to decide a dispute", "use_resolve");
  if (!canMove(DISPUTE_MOVES, d.status as DisputeStatus, to)) throw new HttpError(409, `A dispute cannot go from ${d.status} to ${to}`, { code: "bad_transition", from: d.status, allowed: DISPUTE_MOVES[d.status as DisputeStatus] });
  if (!permissionsFor(rel, d).transitions.includes(to)) throw new HttpError(403, "You cannot make this change", { code: "not_allowed" });
  const note = b.note === undefined || b.note === null || b.note === "" ? null : validateFreeText(b.note, 1000, 1);
  if (note && !note.ok) throw bad("note is not valid", `note_${note.code}`);
  const at = nowSec();
  const ok = await repo.applyTransition(db, { id: d.id, from: d.status, to, actor: actor.userId, actorRole: roleLabel(rel), note: note?.ok ? note.text : null, at, purgeAfter: to === "withdrawn" ? at + DISPUTES.EVIDENCE_RETENTION_SEC : undefined });
  if (!ok) throw new HttpError(409, "The dispute changed while you were working on it. Reload it.", { code: "conflict" });
  return reload(db, actor, id);
}

interface CorrectionIn { eventId: string; matchRef: string; oldValue: string; newValue: string }

async function parseCorrections(db: D1Database, eventId: string, raw: unknown): Promise<CorrectionIn[]> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > DISPUTES.MAX_CORRECTIONS) throw bad(`corrections must be a list of at most ${DISPUTES.MAX_CORRECTIONS}`, "invalid_corrections");
  const out: CorrectionIn[] = [];
  const int = (v: unknown, lo: number, hi: number, f: string): number => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < lo || v > hi) throw bad(`${f} must be a whole number from ${lo} to ${hi}`, "invalid_corrections");
    return v;
  };
  for (const c of raw) {
    if (!c || typeof c !== "object") throw bad("each correction must be an object", "invalid_corrections");
    const x = c as Record<string, unknown>;
    if (typeof x.matchId === "string") {
      const old = await repo.legacyMatch(db, eventId, x.matchId);
      if (!old) throw bad("matchId is not a match of this tournament", "correction_target_missing");
      if (x.winner !== "a" && x.winner !== "b" && x.winner !== "draw") throw bad("winner must be a, b or draw", "invalid_corrections");
      out.push({ eventId, matchRef: matchRef(x.matchId), oldValue: JSON.stringify({ scoreA: old.score_a, scoreB: old.score_b, winner: old.winner }), newValue: JSON.stringify({ scoreA: int(x.scoreA, 0, 100_000, "scoreA"), scoreB: int(x.scoreB, 0, 100_000, "scoreB"), winner: x.winner }) });
    } else if (typeof x.team === "string") {
      const matchNo = int(x.matchNo, 1, 10_000, "matchNo");
      const old = await repo.legacyBr(db, eventId, matchNo, x.team);
      if (!old) throw bad("That battle royale result does not exist", "correction_target_missing");
      out.push({ eventId, matchRef: brRef(matchNo, x.team), oldValue: JSON.stringify({ placement: old.placement, kills: old.kills }), newValue: JSON.stringify({ placement: int(x.placement, 1, 100, "placement"), kills: int(x.kills, 0, 200, "kills") }) });
    } else throw bad("a correction names a matchId or a team and matchNo", "invalid_corrections");
  }
  return out;
}

export async function resolveDispute(db: D1Database, actor: Actor, id: string, b: Body) {
  const { d, rel } = await readable(db, actor, id);
  if (isParty(rel)) throw new HttpError(403, "You cannot decide a dispute you raised or are named in", { code: "conflict_of_interest" });
  if (!permissionsFor(rel, d).canResolve) {
    if (isFinal(d.status)) throw new HttpError(409, "This dispute is already closed", { code: "dispute_final" });
    if (d.status !== "under_review" && d.status !== "escalated") throw new HttpError(409, "Move the dispute to under_review before deciding it", { code: "bad_transition" });
    throw new HttpError(403, d.status === "escalated" ? "An escalated dispute is decided by a moderator" : "You cannot decide this dispute", { code: "not_allowed" });
  }
  const status = reqEnum(b.status ?? "resolved", ["resolved", "rejected"] as const, "status");
  if (!isOneOf(DISPUTE_OUTCOMES, b.outcome)) throw bad(`outcome must be one of: ${DISPUTE_OUTCOMES.join(", ")}`, "invalid_outcome");
  const outcome = b.outcome;
  if (status === "rejected" && outcome !== "rejected" && outcome !== "no_action") throw bad("A rejected dispute has outcome rejected or no_action", "invalid_outcome");
  if (status === "resolved" && outcome === "rejected") throw bad("A resolved dispute has outcome upheld, partially_upheld or no_action", "invalid_outcome");
  const note = validateFreeText(b.note, 1000, 10);
  if (!note.ok) throw bad("note (the reason for the decision) must be 10-1000 characters", `note_${note.code}`);
  const wantsCorrections = Array.isArray(b.corrections) && b.corrections.length > 0;
  if (wantsCorrections && !(status === "resolved" && (outcome === "upheld" || outcome === "partially_upheld"))) throw bad("Corrections can only come with an upheld or partially upheld decision", "invalid_corrections");
  const corrections = await parseCorrections(db, d.t_event_id, b.corrections);
  const at = nowSec();
  const ok = await repo.applyTransition(db, { id: d.id, from: d.status, to: status, actor: actor.userId, actorRole: roleLabel(rel), note: note.text.slice(0, 200), at, purgeAfter: at + DISPUTES.EVIDENCE_RETENTION_SEC, resolution: { outcome, note: note.text }, corrections });
  if (!ok) throw new HttpError(409, "The dispute changed while you were working on it. Reload it.", { code: "conflict" });
  return reload(db, actor, id);
}

export { isOverdue };
