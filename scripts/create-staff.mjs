// Prints the SQL that makes an existing user a platform staff member. Run the output with wrangler; this script never touches a database.
//   node scripts/create-staff.mjs <user-id> <added-by>            -> SQL to insert the staff row (authenticator is set up later in the staff console)
//   node scripts/create-staff.mjs --enable-console <owner-id>     -> SQL that turns the console on (flag admin.enabled)
//   node scripts/create-staff.mjs --reset-totp <user-id>          -> break-glass SQL for a lost authenticator (the user enrols again)
//   node scripts/create-staff.mjs --sign-out <user-id>            -> SQL that revokes every staff token of that person
//   node scripts/create-staff.mjs --remove <user-id>              -> SQL that removes staff access (the row stays, removed_at is set)
// Then:  npx wrangler d1 execute esports-db --remote --command "<the printed SQL>"   (staging first). There is no public signup for staff.
// Find the user id with:  SELECT id FROM users WHERE email = '...'   (the person registers a normal account first).
const ID = /^[A-Za-z0-9._~-]{1,48}$/;
const [a, b, c] = process.argv.slice(2);
const fail = (m) => { console.error(m); process.exit(1); };
const now = new Date().toISOString();

if (a === "--enable-console") {
  if (!ID.test(b ?? "")) fail("usage: --enable-console <owner-id>");
  console.log(`INSERT INTO flags (key, value, updated_by, updated_at, note) VALUES ('admin.enabled', 'true', '${b}', '${now}', 'enable staff console') ON CONFLICT (key) DO UPDATE SET value = 'true', updated_by = excluded.updated_by, updated_at = excluded.updated_at;`);
} else if (a === "--reset-totp") {
  if (!ID.test(b ?? "")) fail("usage: --reset-totp <user-id>");
  console.log(`UPDATE platform_staff SET totp_secret_enc = NULL, totp_enabled_at = NULL, token_valid_after = CAST(strftime('%s','now') AS INTEGER) WHERE user_id = '${b}' AND removed_at IS NULL;`);
} else if (a === "--sign-out") {
  if (!ID.test(b ?? "")) fail("usage: --sign-out <user-id>");
  console.log(`UPDATE platform_staff SET token_valid_after = CAST(strftime('%s','now') AS INTEGER) WHERE user_id = '${b}';`);
} else if (a === "--remove") {
  if (!ID.test(b ?? "")) fail("usage: --remove <user-id>");
  console.log(`UPDATE platform_staff SET removed_at = '${now}', token_valid_after = CAST(strftime('%s','now') AS INTEGER) WHERE user_id = '${b}' AND removed_at IS NULL;`);
} else {
  if (!ID.test(a ?? "") || a.startsWith("--") || !ID.test(b ?? "")) fail("usage: node scripts/create-staff.mjs <user-id> <added-by>   (see the header of this file for the other modes)");
  // role admin is the only role in Phase 1. No seed here: the person enrols the authenticator through POST /admin/v1/session/enroll.
  console.log(`INSERT INTO platform_staff (user_id, role, added_by, added_at) SELECT id, 'admin', '${b}', '${now}' FROM users WHERE id = '${a}';`);
}
void c;
