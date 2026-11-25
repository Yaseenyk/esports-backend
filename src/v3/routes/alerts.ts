/**
 * Tournament alert routes (flag v3.alerts, OFF by default). Signed-in settings under /v3/me/alerts; the confirm and unsubscribe links need no sign-in and
 * carry their token in the JSON body (the page reads it from the URL fragment), except the RFC 8058 one-click POST that mail apps send to the
 * List-Unsubscribe address. Limits: rules 30/hour, confirm email 3/day per account and 10/hour per address, token links 30/hour per address.
 */
import { Hono } from "hono";
import { requireUser } from "../../auth";
import { rateLimit, rateLimitSubject, readJson } from "../../http";
import type { AppBindings } from "../../types";
import { confirmByToken, deleteMine, myAlerts, requestConfirm, saveRules, stopMine, unsubscribeByToken } from "../services/alert-service";
import { flagGate, killMw, noStore } from "./common";

export const alertRoutes = new Hono<AppBindings>();
const gate = flagGate("v3.alerts");
const writes = killMw("kill.public_writes");

alertRoutes.get("/v3/me/alerts", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await myAlerts(c.env, c.get("userId")));
});
alertRoutes.put("/v3/me/alerts", gate, writes, requireUser, async (c) => {
  noStore(c);
  await rateLimitSubject(c, "alerts-rules", c.get("userId"), 30, 3600);
  return c.json(await saveRules(c.env, c.get("userId"), await readJson(c, 4_000)));
});
alertRoutes.post("/v3/me/alerts/confirm-email", gate, writes, requireUser, async (c) => {
  noStore(c);
  await rateLimit(c, "alerts-confirm-ip", 10, 3600);
  await rateLimitSubject(c, "alerts-confirm", c.get("userId"), 3, 86_400);
  return c.json(await requestConfirm(c.env, c.get("userId")));
});
alertRoutes.post("/v3/me/alerts/stop", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await stopMine(c.env, c.get("userId")));
});
alertRoutes.delete("/v3/me/alerts", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await deleteMine(c.env, c.get("userId")));
});

// ---- token links (no sign-in). Stopping mail is never blocked by a kill switch. ----
alertRoutes.post("/public/alerts/confirm", gate, writes, async (c) => {
  noStore(c);
  await rateLimit(c, "alerts-token", 30, 3600);
  return c.json(await confirmByToken(c.env, await readJson(c, 1_024)));
});
alertRoutes.post("/public/alerts/unsubscribe", gate, async (c) => {
  noStore(c);
  await rateLimit(c, "alerts-token", 30, 3600);
  const b = await readJson(c, 1_024);
  return c.json(await unsubscribeByToken(c.env, b.token));
});
/** RFC 8058 one-click: the mail app POSTs "List-Unsubscribe=One-Click" (form encoded) to the address in the List-Unsubscribe header. */
alertRoutes.post("/public/alerts/one-click/:token", gate, async (c) => {
  noStore(c);
  await rateLimit(c, "alerts-token", 30, 3600);
  return c.json(await unsubscribeByToken(c.env, c.req.param("token")));
});
