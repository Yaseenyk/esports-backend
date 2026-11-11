// S7 phase A: fills token_hash and token_enc for links issued before S7. The clear `token` is left untouched here;
// the deferred phase B script (migrations-deferred/S7-phase-B-null-clear-tokens.sql) is what removes it.
// Runs as a cron step: at most 40 rows per tick (CPU and write budget, dev-review-r2 N-2) on the ticks between 00:15 and 06:00 UTC,
// and does nothing once no legacy row is left (one cheap indexed-miss read per table).
import type { Env } from "../types";
import { encryptToken, hashToken, type LinkKind } from "../links";

export const BACKFILL_BATCH = 40;

/** True for the 15-minute ticks from 00:15 up to (not including) 06:00 UTC. */
export const isBackfillTick = (scheduledTime: number): boolean => {
  const d = new Date(scheduledTime);
  const h = d.getUTCHours();
  return (h === 0 && d.getUTCMinutes() >= 15) || (h >= 1 && h < 6);
};

interface Legacy { id: string; token: string }

async function fill(env: Env, kind: LinkKind, rows: Legacy[]): Promise<number> {
  if (rows.length === 0) return 0;
  const db = env.DB;
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    const hash = await hashToken(r.token);
    const encd = await encryptToken(env, kind, r.id, r.token);
    // Guarded on token_hash IS NULL and on the clear token still being what was read: a concurrent change makes the update a no-op.
    if (kind === "share") stmts.push(db.prepare("UPDATE share_links SET token_hash = ?, token_enc = ? WHERE id = ? AND token = ? AND token_hash IS NULL").bind(hash, encd, r.id, r.token));
    else if (kind === "invite") stmts.push(db.prepare("UPDATE invites SET token_hash = ?, token_enc = ? WHERE id = ? AND token = ? AND token_hash IS NULL").bind(hash, encd, r.id, r.token));
    else stmts.push(db.prepare("UPDATE registration_forms SET token_hash = ?, token_enc = ? WHERE event_id = ? AND token = ? AND token_hash IS NULL").bind(hash, encd, r.id, r.token));
  }
  await db.batch(stmts);
  return rows.length;
}

/** Backfills up to `limit` legacy rows across the three tables. Returns how many were filled per table. */
export async function backfillLinks(env: Env, limit = BACKFILL_BATCH): Promise<{ share: number; invite: number; regform: number }> {
  const out = { share: 0, invite: 0, regform: 0 };
  let left = limit;
  // Rows whose token is already the x- placeholder have no recoverable clear value; they are excluded so they cannot stall the queue.
  const s = await env.DB.prepare("SELECT id, token FROM share_links WHERE token_hash IS NULL AND token <> 'x-' || id LIMIT ?").bind(left).all<Legacy>();
  out.share = await fill(env, "share", s.results);
  left -= out.share;
  if (left > 0) {
    const i = await env.DB.prepare("SELECT id, token FROM invites WHERE token_hash IS NULL AND token <> 'x-' || id LIMIT ?").bind(left).all<Legacy>();
    out.invite = await fill(env, "invite", i.results);
    left -= out.invite;
  }
  if (left > 0) {
    const r = await env.DB.prepare("SELECT event_id AS id, token FROM registration_forms WHERE token_hash IS NULL AND token <> 'x-' || event_id LIMIT ?").bind(left).all<Legacy>();
    out.regform = await fill(env, "regform", r.results);
  }
  return out;
}

/** Cron hook: call from the scheduled handler on every tick. Never throws. */
export async function linksBackfillTick(scheduledTime: number, env: Env): Promise<void> {
  if (!isBackfillTick(scheduledTime)) return;
  try {
    await backfillLinks(env);
  } catch {
    console.error("links backfill failed");
  }
}
