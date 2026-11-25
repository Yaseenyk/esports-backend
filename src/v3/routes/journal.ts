/**
 * Builder C routes (migration 0091). Thin: parse, call a service, respond. Both flags OFF by default: the router's own 404 before any table is read.
 *  - Personal match journal (flag v3.journal): signed in, owner only, private. Writes 120 an hour per account, "delete all" 5 an hour; bodies capped.
 *  - Badges (flag v3.achievements): the owner's badge list and the per-badge show/hide switch. Public pages get their badges from the player-page code.
 */
import { Hono } from "hono";
import { requireUser } from "../../auth";
import { rateLimitSubject, readJson, type Ctx } from "../../http";
import type { AppBindings } from "../../types";
import { addEntry, clearJournal, editEntry, myJournal, removeEntry } from "../services/journal-service";
import { setBadgeHidden } from "../services/badge-service";
import { myBadges } from "../services/showcase-service";
import { flagGate, killMw, noStore } from "./common";

export const journalRoutes = new Hono<AppBindings>();
const journal = flagGate("v3.journal");
const achievements = flagGate("v3.achievements");
const writes = killMw("kill.public_writes");
const param = (c: Ctx, k: string): string => c.req.param(k) ?? "";
const writeLimit = (c: Ctx) => rateLimitSubject(c, "v3-journal-write", c.get("userId"), 120, 3600);

// ---- journal ----
journalRoutes.get("/v3/me/journal", journal, requireUser, async (c) => {
  noStore(c);
  return c.json(await myJournal(c.env.DB, c.get("userId")));
});
journalRoutes.post("/v3/me/journal", journal, writes, requireUser, async (c) => {
  noStore(c);
  await writeLimit(c);
  return c.json(await addEntry(c.env.DB, c.get("userId"), await readJson(c, 2_000)), 201);
});
journalRoutes.post("/v3/me/journal/clear", journal, requireUser, async (c) => {
  noStore(c);
  await rateLimitSubject(c, "v3-journal-clear", c.get("userId"), 5, 3600);
  return c.json(await clearJournal(c.env.DB, c.get("userId"), await readJson(c, 256)));
});
journalRoutes.put("/v3/me/journal/:id", journal, writes, requireUser, async (c) => {
  noStore(c);
  await writeLimit(c);
  return c.json(await editEntry(c.env.DB, c.get("userId"), param(c, "id"), await readJson(c, 2_000)));
});
// Deleting is never blocked by the write kill switch (a person can always remove their own data).
journalRoutes.delete("/v3/me/journal/:id", journal, requireUser, async (c) => {
  noStore(c);
  await writeLimit(c);
  return c.json(await removeEntry(c.env.DB, c.get("userId"), param(c, "id")));
});

// ---- badges ----
journalRoutes.get("/v3/me/badges", achievements, requireUser, async (c) => {
  noStore(c);
  return c.json(await myBadges(c.env, c.get("userId")));
});
journalRoutes.put("/v3/me/badges/hidden", achievements, writes, requireUser, async (c) => {
  noStore(c);
  await rateLimitSubject(c, "v3-badge-write", c.get("userId"), 60, 3600);
  await setBadgeHidden(c.env.DB, c.get("userId"), await readJson(c, 512));
  return c.json(await myBadges(c.env, c.get("userId")));
});
