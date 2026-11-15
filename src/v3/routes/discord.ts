/** Discord routes (flag v3.discord). Thin: parse, call a service, respond. The interactions endpoint is the only unauthenticated one and checks Discord's signature itself. */
import { Hono } from "hono";
import { requireUser } from "../../auth";
import { HttpError, rateLimit, rateLimitSubject, readJson, type Ctx } from "../../http";
import type { AppBindings } from "../../types";
import { verifyDiscordSignature } from "../lib/discord-sig";
import { nowSec } from "../lib/ids";
import { handleInteraction } from "../services/discord-interactions-service";
import {
  createLinkCode, discordConfigFromEnv, getEventDiscord, guildStatus, linkStatus, putSettings, queueLobbyPing, queueResults, registerGuild, reverifyGuild, setCategory, syncApproved,
  unlinkDiscord, type DiscordConfig,
} from "../services/discord-service";
import { flagGate, killMw, noStore } from "./common";

export const discordRoutes = new Hono<AppBindings>();
const gate = flagGate("v3.discord");
const writes = killMw("kill.public_writes");

const discordConfig = (c: Ctx): DiscordConfig => discordConfigFromEnv(c.env);
const eventId = (c: Ctx): string => {
  const id = c.req.param("eventId") ?? "";
  if (!/^[A-Za-z0-9._~-]{1,48}$/.test(id)) throw new HttpError(404, "Event not found");
  return id;
};

// ---- Discord calls this one (signature, not a bearer token) ----
discordRoutes.post("/v3/discord/interactions", gate, async (c) => {
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > 100_000) throw new HttpError(413, "Body too large");
  const raw = await c.req.text(); // the RAW bytes as text: the signature covers exactly these
  if (raw.length > 100_000) throw new HttpError(413, "Body too large");
  const cfg = discordConfig(c);
  const ok = await verifyDiscordSignature({
    publicKeyHex: cfg.publicKey, signatureHex: c.req.header("x-signature-ed25519"), timestamp: c.req.header("x-signature-timestamp"), rawBody: raw, nowSec: nowSec(),
  });
  if (!ok) return c.json({ error: "invalid request signature" }, 401);
  let body: unknown;
  try { body = JSON.parse(raw); } catch { return c.json({ error: "Body is not valid JSON" }, 400); }
  noStore(c);
  return c.json(await handleInteraction(c.env.DB, cfg, body));
});

// ---- the signed-in person links their own Discord id ----
discordRoutes.post("/v3/discord/link-code", gate, writes, requireUser, async (c) => {
  noStore(c);
  const uid = c.get("userId");
  await rateLimitSubject(c, "v3-discord-code", uid, 10, 3600);
  return c.json(await createLinkCode(c.env.DB, uid), 201);
});
discordRoutes.get("/v3/discord/link", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await linkStatus(c.env.DB, c.get("userId")));
});
discordRoutes.delete("/v3/discord/link", gate, writes, requireUser, async (c) => {
  noStore(c);
  return c.json(await unlinkDiscord(c.env.DB, c.get("userId")));
});

// ---- organiser: install and status ----
discordRoutes.post("/v3/discord/guilds", gate, writes, requireUser, async (c) => {
  noStore(c);
  const uid = c.get("userId");
  await rateLimitSubject(c, "v3-discord-guild", uid, 20, 3600);
  return c.json(await registerGuild(c.env.DB, discordConfig(c), uid, await readJson(c, 2048)), 201);
});
discordRoutes.get("/v3/discord/guilds/:id", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await guildStatus(c.env.DB, discordConfig(c), c.get("userId"), c.req.param("id") ?? ""));
});
discordRoutes.post("/v3/discord/guilds/:id/verify", gate, writes, requireUser, async (c) => {
  noStore(c);
  const uid = c.get("userId");
  await rateLimitSubject(c, "v3-discord-guild", uid, 20, 3600);
  return c.json(await reverifyGuild(c.env.DB, discordConfig(c), uid, c.req.param("id") ?? ""));
});

// ---- organiser: per tournament ----
discordRoutes.get("/v3/events/:eventId/discord", gate, requireUser, async (c) => {
  noStore(c);
  return c.json(await getEventDiscord(c.env.DB, discordConfig(c), c.get("userId"), eventId(c)));
});
discordRoutes.put("/v3/events/:eventId/discord/category", gate, writes, requireUser, async (c) => {
  noStore(c);
  return c.json(await setCategory(c.env.DB, discordConfig(c), c.get("userId"), eventId(c), await readJson(c, 1024)));
});
discordRoutes.put("/v3/events/:eventId/discord/settings", gate, writes, requireUser, async (c) => {
  noStore(c);
  return c.json(await putSettings(c.env.DB, c.get("userId"), eventId(c), await readJson(c, 1024)));
});
discordRoutes.post("/v3/events/:eventId/discord/sync", gate, writes, requireUser, async (c) => {
  noStore(c);
  await rateLimit(c, "v3-discord-queue", 20, 3600);
  return c.json(await syncApproved(c.env.DB, c.get("userId"), eventId(c)));
});
discordRoutes.post("/v3/events/:eventId/discord/lobby-ping", gate, writes, requireUser, async (c) => {
  noStore(c);
  await rateLimit(c, "v3-discord-queue", 20, 3600);
  return c.json(await queueLobbyPing(c.env.DB, c.get("userId"), eventId(c), await readJson(c, 1024)));
});
discordRoutes.post("/v3/events/:eventId/discord/results", gate, writes, requireUser, async (c) => {
  noStore(c);
  await rateLimit(c, "v3-discord-queue", 20, 3600);
  return c.json(await queueResults(c.env.DB, c.get("userId"), eventId(c)));
});
