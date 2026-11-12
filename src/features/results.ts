import { Hono } from "hono";
import type { AppBindings, Env } from "../types";
import type { RouteRules } from "./types";
import { HttpError, idStr, nowIso, optBool, optStr, rateLimit, rateLimitSubject, readJson, type Ctx } from "../http";
import { ownedEvent, requireUser } from "../auth";
import { createCaptainLink, listCaptainLinks, resolveCaptainToken, revokeCaptainLink } from "../captains";
import { imageResponse, parsePhotoDataUrl } from "../images";
import { applyResult, listMatches, type Match } from "../matches";
import { takenDown } from "../moderation/takedown";
import { killGate } from "../admin/kill";

/**
 * Captain result submission. A captain opens their team's link, reports the score of one of their matches (with an optional screenshot),
 * and the organiser approves or rejects it. Approving applies the result through applyResult (the only way results are written).
 */
export const routes = new Hono<AppBindings>();

const EDIT = ["owner", "editor"] as const;
const READ = ["owner", "editor", "viewer"] as const;

export const routeRules: RouteRules = {
  "POST /events/:id/captain-links": { roles: [...EDIT], limit: "60/hour/user" },
  "GET /events/:id/captain-links": { roles: [...READ] },
  "DELETE /events/:id/captain-links/:linkId": { roles: [...EDIT], limit: "120/hour/user" },
  "GET /events/:id/result-submissions": { roles: [...READ] },
  "GET /events/:id/result-submissions/:sid/proof": { roles: [...EDIT] },
  "POST /events/:id/result-submissions/:sid/approve": { roles: [...EDIT], limit: "600/hour/user" },
  "POST /events/:id/result-submissions/:sid/reject": { roles: [...EDIT], limit: "600/hour/user" },
  "GET /events/:id/result-settings": { roles: [...READ] },
  "PUT /events/:id/result-settings": { roles: [...EDIT], limit: "60/hour/user" },
  "GET /public/report/:token": { public: true, limit: "120/hour/token+IP, 400/hour/token" },
  "POST /public/report/:token/matches/:mid": { public: true, limit: "30/hour/token+IP, 90/hour/token" },
};

export const MAX_PROOF_CHARS = 200_000;
const MAX_SCORE = 999;
const MAX_LINKS_PER_CALL = 128;
const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

interface SubRow {
  id: string; event_id: string; match_id: string; team: string; score_a: number; score_b: number; note: string; has_proof: number;
  status: "pending" | "approved" | "rejected"; reject_reason: string | null; created_at: string; decided_at: string | null; decided_by: string | null;
}
// the column list is written out in each query on purpose: SQL is never built from variables (see test/hardening.test.ts)

async function autoApprove(env: Env, eventId: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT auto_approve FROM result_settings WHERE event_id = ?").bind(eventId).first<{ auto_approve: number }>();
  return !!r?.auto_approve;
}

function teamsOf(matches: Match[]): string[] {
  const seen = new Map<string, string>();
  for (const m of matches) for (const t of [m.a, m.b]) if (t.trim() && !seen.has(norm(t))) seen.set(norm(t), t.replace(/\s+/g, " ").trim());
  return [...seen.values()].sort((x, y) => x.localeCompare(y));
}

// ---------------- organiser: captain links ----------------
routes.post("/events/:id/captain-links", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "captainLinksPost", c.get("userId"), 60, 3600);
  const b = await readJson(c, 4_000);
  const all = optBool(b.all, "all");
  const renew = optBool(b.renew, "renew");
  let teams: string[];
  if (all) {
    teams = teamsOf(await listMatches(c.env, ev.id)).slice(0, MAX_LINKS_PER_CALL);
    if (!teams.length) throw new HttpError(400, "Add matches with team names first, then make the links");
  } else {
    if (typeof b.team !== "string" || !b.team.trim() || b.team.trim().length > 60) throw new HttpError(400, "team must be 1-60 characters, or send all: true");
    teams = [b.team.replace(/\s+/g, " ").trim()];
  }
  // "all" never silently kills a link a captain already has: it only fills the gaps unless renew is true. One named team always gets a fresh link.
  const active = new Set((await listCaptainLinks(c.env, ev.id)).filter((l) => !l.revokedAt).map((l) => norm(l.team)));
  const links: { id: string; team: string; token: string; createdAt: string }[] = [];
  const skipped: string[] = [];
  for (const team of teams) {
    if (all && !renew && active.has(norm(team))) { skipped.push(team); continue; }
    const { link, token } = await createCaptainLink(c.env, ev.id, team);
    links.push({ id: link.id, team: link.team, token, createdAt: link.createdAt });
  }
  c.header("cache-control", "no-store");
  const first = links[0];
  return c.json({ links, skipped, ...(!all && first ? { id: first.id, team: first.team, token: first.token } : {}) }, 201);
});

routes.get("/events/:id/captain-links", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const links = await listCaptainLinks(c.env, ev.id);
  return c.json({ links: links.map((l) => ({ id: l.id, team: l.team, createdAt: l.createdAt, revokedAt: l.revokedAt, active: !l.revokedAt })) });
});

routes.delete("/events/:id/captain-links/:linkId", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "captainLinksDel", c.get("userId"), 120, 3600);
  if (!(await revokeCaptainLink(c.env, ev.id, c.req.param("linkId")))) throw new HttpError(404, "Link not found");
  return c.json({ ok: true });
});

// ---------------- organiser: submissions ----------------
routes.get("/events/:id/result-submissions", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  const status = c.req.query("status");
  if (status !== undefined && !["pending", "approved", "rejected"].includes(status)) throw new HttpError(400, "status must be pending, approved or rejected");
  const rows = await c.env.DB.prepare("SELECT id, event_id, match_id, team, score_a, score_b, note, (proof IS NOT NULL) AS has_proof, status, reject_reason, created_at, decided_at, decided_by FROM result_submissions WHERE event_id = ?1 AND (?2 IS NULL OR status = ?2) ORDER BY created_at DESC LIMIT 500")
    .bind(ev.id, status ?? null)
    .all<SubRow>();
  const pend = await c.env.DB.prepare("SELECT id, event_id, match_id, team, score_a, score_b, note, (proof IS NOT NULL) AS has_proof, status, reject_reason, created_at, decided_at, decided_by FROM result_submissions WHERE event_id = ? AND status = 'pending' LIMIT 1000").bind(ev.id).all<SubRow>();
  const pendingByMatch = new Map<string, SubRow[]>();
  for (const p of pend.results ?? []) pendingByMatch.set(p.match_id, [...(pendingByMatch.get(p.match_id) ?? []), p]);
  const matches = new Map((await listMatches(c.env, ev.id)).map((m) => [m.id, m]));
  const submissions = (rows.results ?? []).map((r) => {
    const m = matches.get(r.match_id);
    const rivals = r.status === "pending" ? (pendingByMatch.get(r.match_id) ?? []).filter((o) => o.id !== r.id) : [];
    const differing = rivals.filter((o) => o.score_a !== r.score_a || o.score_b !== r.score_b);
    return {
      id: r.id, matchId: r.match_id, team: r.team, scoreA: r.score_a, scoreB: r.score_b, note: r.note, hasProof: !!r.has_proof,
      proofUrl: r.has_proof ? `/events/${ev.id}/result-submissions/${r.id}/proof` : null,
      status: r.status, rejectReason: r.reject_reason, createdAt: r.created_at, decidedAt: r.decided_at, decidedBy: r.decided_by,
      disputed: differing.length > 0,
      rivals: rivals.map((o) => ({ id: o.id, team: o.team, scoreA: o.score_a, scoreB: o.score_b, note: o.note, hasProof: !!o.has_proof, proofUrl: o.has_proof ? `/events/${ev.id}/result-submissions/${o.id}/proof` : null })),
      match: m ? { a: m.a, b: m.b, stage: m.stage, round: m.round, slot: m.slot, status: m.status, scoreA: m.scoreA, scoreB: m.scoreB } : null,
    };
  });
  return c.json({ submissions, autoApprove: await autoApprove(c.env, ev.id) });
});

routes.get("/events/:id/result-submissions/:sid/proof", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  if (ev.my_role === "viewer") throw new HttpError(403, "Only the owner or an editor can see proof screenshots");
  const r = await c.env.DB.prepare("SELECT proof FROM result_submissions WHERE id = ? AND event_id = ? AND proof IS NOT NULL").bind(c.req.param("sid"), ev.id).first<{ proof: string }>();
  if (!r) throw new HttpError(404, "Proof not found");
  const img = parsePhotoDataUrl(r.proof, "proof");
  return imageResponse(img.type, img.bytes);
});

async function pendingOf(env: Env, eventId: string, sid: string): Promise<SubRow> {
  const s = await env.DB.prepare("SELECT id, event_id, match_id, team, score_a, score_b, note, (proof IS NOT NULL) AS has_proof, status, reject_reason, created_at, decided_at, decided_by FROM result_submissions WHERE id = ? AND event_id = ?").bind(sid, eventId).first<SubRow>();
  if (!s) throw new HttpError(404, "Submission not found");
  if (s.status !== "pending") throw new HttpError(409, `This submission is already ${s.status}`);
  return s;
}

routes.post("/events/:id/result-submissions/:sid/approve", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "resultDecide", c.get("userId"), 600, 3600);
  const s = await pendingOf(c.env, ev.id, c.req.param("sid"));
  const m = (await listMatches(c.env, ev.id)).find((x) => x.id === s.match_id);
  if (!m) throw new HttpError(409, "That match no longer exists");
  if (norm(m.a) !== norm(s.team) && norm(m.b) !== norm(s.team)) throw new HttpError(409, "That team is no longer in this match");
  const out = await applyResult(c.env, ev.id, s.match_id, { scoreA: s.score_a, scoreB: s.score_b }, `captain:${s.team}, approved by organiser`);
  const now = nowIso();
  const by = c.get("userId");
  // The approved claim is approved; another pending claim for the same match is approved if it says the same, otherwise it is closed with a reason.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE result_submissions SET status = 'approved', decided_at = ?, decided_by = ? WHERE id = ? AND event_id = ? AND status = 'pending'").bind(now, by, s.id, ev.id),
    c.env.DB.prepare("UPDATE result_submissions SET status = 'approved', decided_at = ?, decided_by = ? WHERE event_id = ? AND match_id = ? AND status = 'pending' AND score_a = ? AND score_b = ?").bind(now, by, ev.id, s.match_id, s.score_a, s.score_b),
    c.env.DB.prepare("UPDATE result_submissions SET status = 'rejected', proof = NULL, reject_reason = ?, decided_at = ?, decided_by = ? WHERE event_id = ? AND match_id = ? AND status = 'pending'")
      .bind("The organiser approved a different score for this match", now, by, ev.id, s.match_id),
  ]);
  return c.json({ ok: true, match: out.match, changed: out.changed });
});

routes.post("/events/:id/result-submissions/:sid/reject", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "resultDecide", c.get("userId"), 600, 3600);
  const s = await pendingOf(c.env, ev.id, c.req.param("sid"));
  const raw = c.req.header("content-length") === "0" ? {} : await readJson(c, 4_000).catch(() => ({}) as Record<string, unknown>);
  const reason = optStr(raw.reason, "reason", 200);
  await c.env.DB.prepare("UPDATE result_submissions SET status = 'rejected', proof = NULL, reject_reason = ?, decided_at = ?, decided_by = ? WHERE id = ? AND event_id = ? AND status = 'pending'")
    .bind(reason || null, nowIso(), c.get("userId"), s.id, ev.id)
    .run();
  return c.json({ ok: true });
});

routes.get("/events/:id/result-settings", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  return c.json({ autoApprove: await autoApprove(c.env, ev.id) });
});

routes.put("/events/:id/result-settings", requireUser, async (c) => {
  const ev = await ownedEvent(c, c.req.param("id"));
  await rateLimitSubject(c, "resultSettings", c.get("userId"), 60, 3600);
  const b = await readJson(c, 2_000);
  if (typeof b.autoApprove !== "boolean") throw new HttpError(400, "autoApprove must be true or false");
  await c.env.DB.prepare("INSERT INTO result_settings (event_id, auto_approve, updated_at) VALUES (?, ?, ?) ON CONFLICT (event_id) DO UPDATE SET auto_approve = excluded.auto_approve, updated_at = excluded.updated_at")
    .bind(ev.id, b.autoApprove ? 1 : 0, nowIso())
    .run();
  return c.json({ autoApprove: b.autoApprove });
});

// ---------------- public: the captain's side ----------------
async function captain(c: Ctx, token: string, scope: string, perTokenIp: number, perToken: number) {
  if (token.length > 64) throw new HttpError(404, "This link is not valid any more. Ask the organiser for a new one.");
  await rateLimit(c, scope, perTokenIp, 3600, token);
  await rateLimitSubject(c, `${scope}-token`, token, perToken, 3600);
  const ctx = await resolveCaptainToken(c.env, token);
  if (!ctx) {
    await rateLimit(c, "reportfail", 20, 600); // guessing tokens is throttled per address
    throw new HttpError(404, "This link is not valid any more. Ask the organiser for a new one.");
  }
  if (await takenDown(c.env.DB, { type: "results", id: ctx.linkId, eventId: ctx.eventId })) throw new HttpError(404, "This link is not valid any more. Ask the organiser for a new one.");
  return ctx;
}

const involves = (m: Match, team: string) => norm(m.a) === norm(team) || norm(m.b) === norm(team);

routes.get("/public/report/:token", async (c) => {
  const ctx = await captain(c, c.req.param("token"), "reportGet", 120, 400);
  const ev = await c.env.DB.prepare("SELECT name, date FROM events WHERE id = ?").bind(ctx.eventId).first<{ name: string; date: string }>();
  if (!ev) throw new HttpError(404, "This link is not valid any more. Ask the organiser for a new one.");
  const mine = (await listMatches(c.env, ctx.eventId)).filter((m) => involves(m, ctx.team));
  const subs = await c.env.DB.prepare("SELECT id, event_id, match_id, team, score_a, score_b, note, (proof IS NOT NULL) AS has_proof, status, reject_reason, created_at, decided_at, decided_by FROM result_submissions WHERE event_id = ? AND team = ? ORDER BY created_at DESC LIMIT 200").bind(ctx.eventId, ctx.team).all<SubRow>();
  const pend = await c.env.DB.prepare("SELECT match_id, team, score_a, score_b FROM result_submissions WHERE event_id = ? AND status = 'pending' LIMIT 1000").bind(ctx.eventId).all<{ match_id: string; team: string; score_a: number; score_b: number }>();
  const latest = new Map<string, SubRow>();
  for (const s of subs.results ?? []) if (!latest.has(s.match_id)) latest.set(s.match_id, s);
  const open = mine.filter((m) => m.status !== "finished" && m.status !== "forfeit");
  const done = mine.filter((m) => m.status === "finished" || m.status === "forfeit").slice(-10);
  const rank = (m: Match) => `${m.startsAt ?? "~"}|${String(m.round).padStart(5, "0")}|${String(m.slot).padStart(5, "0")}`;
  open.sort((x, y) => rank(x).localeCompare(rank(y)));
  const shape = (m: Match) => {
    const side = norm(m.a) === norm(ctx.team) ? "a" : "b";
    const opponent = side === "a" ? m.b : m.a;
    const s = latest.get(m.id);
    const rival = (pend.results ?? []).find((p) => p.match_id === m.id && p.team !== ctx.team);
    const own = (pend.results ?? []).find((p) => p.match_id === m.id && p.team === ctx.team);
    return {
      id: m.id, stage: m.stage, round: m.round, slot: m.slot, side, a: m.a, b: m.b, opponent, status: m.status, scoreA: m.scoreA, scoreB: m.scoreB, startsAt: m.startsAt,
      canReport: !!opponent.trim() && m.status !== "finished" && m.status !== "forfeit",
      disputed: !!rival && !!own && (rival.score_a !== own.score_a || rival.score_b !== own.score_b),
      submission: s ? { id: s.id, status: s.status, scoreA: s.score_a, scoreB: s.score_b, note: s.note, rejectReason: s.reject_reason, createdAt: s.created_at, decidedAt: s.decided_at, hasProof: !!s.has_proof } : null,
    };
  };
  c.header("cache-control", "no-store");
  return c.json({ event: { name: ev.name, date: ev.date }, team: ctx.team, matches: [...open, ...done].map(shape) });
});

const PROOF_RE = /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

function score(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > MAX_SCORE) throw new HttpError(400, `${field} must be a whole number from 0 to ${MAX_SCORE}`);
  return v;
}

routes.post("/public/report/:token/matches/:mid", async (c) => {
  const off = await killGate(c, "kill.public_writes");
  if (off) return off;
  const token = c.req.param("token");
  const ctx = await captain(c, token, "reportPost", 30, 90);
  const b = await readJson(c, MAX_PROOF_CHARS + 20_000);
  const mid = idStr(c.req.param("mid"), "match id");
  const sa = score(b.scoreA, "scoreA");
  const sb = score(b.scoreB, "scoreB");
  const note = optStr(b.note, "note", 200);
  let proof: string | null = null;
  if (b.proof !== undefined && b.proof !== null && b.proof !== "") {
    if (typeof b.proof !== "string") throw new HttpError(400, "proof must be a data URL string");
    if (b.proof.length > MAX_PROOF_CHARS) throw new HttpError(413, "The screenshot is too big (200 KB at most)");
    if (!PROOF_RE.test(b.proof)) throw new HttpError(415, "The screenshot must be a png, jpeg or webp image");
    parsePhotoDataUrl(b.proof, "proof"); // decodes and checks the file signature
    proof = b.proof;
  }
  const m = (await listMatches(c.env, ctx.eventId)).find((x) => x.id === mid);
  if (!m || !involves(m, ctx.team)) throw new HttpError(404, "That match is not one of your team's matches");
  if (!m.a.trim() || !m.b.trim()) throw new HttpError(409, "The other team is not decided yet");
  if (m.status === "finished" || m.status === "forfeit") throw new HttpError(409, "This match already has a result. Ask the organiser if it is wrong.");

  const db = c.env.DB;
  const id = crypto.randomUUID();
  const now = nowIso();
  await db.batch([
    db.prepare("DELETE FROM result_submissions WHERE event_id = ? AND match_id = ? AND team = ? AND status = 'pending'").bind(ctx.eventId, mid, ctx.team),
    db.prepare("INSERT INTO result_submissions (id, event_id, match_id, team, score_a, score_b, note, proof, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)").bind(id, ctx.eventId, mid, ctx.team, sa, sb, note, proof, now),
  ]);

  const other = await db.prepare("SELECT id, score_a, score_b FROM result_submissions WHERE event_id = ? AND match_id = ? AND status = 'pending' AND team != ?").bind(ctx.eventId, mid, ctx.team).first<{ id: string; score_a: number; score_b: number }>();
  let status: "pending" | "approved" = "pending";
  let disputed = false;
  if (other) {
    if (other.score_a === sa && other.score_b === sb) {
      if (await autoApprove(c.env, ctx.eventId)) {
        await applyResult(c.env, ctx.eventId, mid, { scoreA: sa, scoreB: sb }, `captain:${ctx.team}, both captains agree`);
        await db.prepare("UPDATE result_submissions SET status = 'approved', decided_at = ?, decided_by = 'auto' WHERE event_id = ? AND match_id = ? AND status = 'pending'").bind(nowIso(), ctx.eventId, mid).run();
        status = "approved";
      }
    } else disputed = true;
  }
  return c.json({ ok: true, id, status, disputed }, 201);
});
