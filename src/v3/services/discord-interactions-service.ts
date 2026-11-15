/**
 * Discord slash commands over the HTTP interactions endpoint. Signature checking happens in the route (raw body); this file only maps an already
 * verified interaction to a reply. Every reply is ephemeral (flags 64: only the caller sees it) and only ever contains the CALLER's own data.
 */
import * as repo from "../repositories/discord-repo";
import { completeLink, type DiscordConfig } from "./discord-service";

const EPHEMERAL = 64;
const reply = (content: string) => ({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] as string[] } } });

interface Interaction {
  type?: number;
  data?: { name?: string; options?: { name?: string; value?: unknown }[] };
  member?: { user?: { id?: string } };
  user?: { id?: string };
}

export async function handleInteraction(db: D1Database, cfg: DiscordConfig, body: unknown): Promise<Record<string, unknown>> {
  const i = (body && typeof body === "object" ? body : {}) as Interaction;
  if (i.type === 1) return { type: 1 }; // PING -> PONG
  if (i.type !== 2 || !i.data?.name) return reply("That is not supported.");
  const who = i.member?.user?.id ?? i.user?.id;
  if (typeof who !== "string" || !/^\d{17,20}$/.test(who)) return reply("That is not supported.");

  switch (i.data.name) {
    case "link": {
      const code = i.data.options?.find((o) => o.name === "code")?.value;
      if (typeof code !== "string" || code.length > 40) return reply("Use /link with the code from the Esports Hub app.");
      const r = await completeLink(db, who, code);
      if (r === "linked") return reply("Linked. Your Discord account is now connected to your Esports Hub account.");
      if (r === "taken") return reply("This Discord account is already linked to another Esports Hub account.");
      return reply("That code is not valid or has expired. Get a new one in the app (codes last 10 minutes and work once).");
    }
    case "team": {
      const userId = await repo.findUserIdByDiscord(db, who);
      if (!userId) return reply("Link your account first: get a code in the Esports Hub app, then use /link.");
      const chans = await repo.channelsOfCaptain(db, userId);
      if (chans.length === 0) return reply("No team channel found for you yet.");
      return reply(chans.slice(0, 5).map((c) => `${c.title} (${c.teamName}): https://discord.com/channels/${c.guildId}/${c.channelId}`).join("\n"));
    }
    case "dispute":
      return reply(`Raise or follow a dispute in the app: ${cfg.appUrl.replace(/\/$/, "")}/app/disputes/`);
    default:
      return reply("That command is not supported.");
  }
}
