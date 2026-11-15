/** users.adult_confirmed_at / resume_consent_at (migration 0052). A repository never decides who may see a row. */
export interface UserV3Row {
  id: string;
  adultConfirmedAt: number | null;
  resumeConsentAt: number | null;
  status: string;
}

export async function getUserV3(db: D1Database, userId: string): Promise<UserV3Row | null> {
  const r = await db
    .prepare("SELECT id, adult_confirmed_at, resume_consent_at, status FROM users WHERE id = ?1")
    .bind(userId)
    .first<{ id: string; adult_confirmed_at: number | null; resume_consent_at: number | null; status: string }>();
  return r ? { id: r.id, adultConfirmedAt: r.adult_confirmed_at, resumeConsentAt: r.resume_consent_at, status: r.status } : null;
}

/** Sets the 18+ confirmation once (an existing timestamp is kept). */
export async function setAdultConfirmed(db: D1Database, userId: string, at: number): Promise<void> {
  await db.prepare("UPDATE users SET adult_confirmed_at = ?2 WHERE id = ?1 AND adult_confirmed_at IS NULL").bind(userId, at).run();
}

export async function setResumeConsent(db: D1Database, userId: string, at: number): Promise<void> {
  await db.prepare("UPDATE users SET resume_consent_at = ?2 WHERE id = ?1").bind(userId, at).run();
}

/** Withdraws consent AND makes the profile private in ONE batch: the profile is never public without consent, not even for a moment. */
export async function withdrawResumeConsent(db: D1Database, userId: string, at: number): Promise<void> {
  await db.batch([
    db.prepare("UPDATE player_profiles SET visibility = 'private', updated_at = ?2 WHERE user_id = ?1").bind(userId, at),
    db.prepare("UPDATE users SET resume_consent_at = NULL WHERE id = ?1").bind(userId),
  ]);
}
