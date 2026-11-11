/**
 * Internal helper for the Phase 1 admin. There is deliberately NO public route for this.
 * A listing that was hidden by reports is held (directory_entries.held_at) after its owner edits it; a person restores it here.
 * Reports are never deleted: restoring resolves any still-open ones and clears the hold.
 * Returns true when a listing existed.
 */
export async function restoreDirectoryListing(db: D1Database, eventId: string, nowMs = Date.now()): Promise<boolean> {
  const at = new Date(nowMs).toISOString();
  const [, , res] = await db.batch([
    db.prepare("UPDATE directory_reports SET resolved_at = ?2 WHERE event_id = ?1 AND resolved_at IS NULL").bind(eventId, at),
    db.prepare("UPDATE directory_entries SET held_at = NULL WHERE event_id = ?1").bind(eventId),
    db.prepare("SELECT 1 AS x FROM directory_entries WHERE event_id = ?1").bind(eventId),
  ]);
  return (res as D1Result).results.length > 0;
}
