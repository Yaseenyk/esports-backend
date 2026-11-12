import { HttpError, type Ctx } from "./http";

/**
 * New email-and-password accounts must confirm their email before they create online events (users.verify_required, set at sign-up while flag
 * auth.verify_required is on). Accounts made before the rule, and Google accounts (already verified), are never blocked.
 */
export async function requireVerifiedEmail(c: Ctx): Promise<void> {
  const u = await c.env.DB.prepare("SELECT verify_required, email_verified_at FROM users WHERE id = ?1").bind(c.get("userId")).first<{ verify_required: number; email_verified_at: string | null }>();
  if (u && u.verify_required === 1 && !u.email_verified_at) {
    throw new HttpError(403, "Confirm your email address first. Open the link we emailed you, or ask for a new one on the Check your email screen", { code: "email_unverified" });
  }
}
