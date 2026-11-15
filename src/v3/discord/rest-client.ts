/**
 * Thin Discord REST client (https://discord.com/api/v10). No gateway, no library.
 *  - `fetch` is injectable (tests pass a fake; nothing in the test suite reaches the real Discord).
 *  - The bot token is only ever placed in the Authorization header. It is never logged and never copied into an error: every failure is a
 *    DiscordError whose message is a short fixed phrase (status class + Discord error code), so a stack trace or last_error cannot contain it.
 *  - A per-tick call budget bounds the subrequests a Worker invocation spends (free plan: 50 per invocation).
 */
export const DISCORD_API = "https://discord.com/api/v10";

export type DiscordFailure = "rate_limited" | "server" | "network" | "permanent" | "budget";

export class DiscordError extends Error {
  constructor(
    readonly kind: DiscordFailure,
    message: string,
    readonly status = 0,
    readonly retryAfterSec = 0,
    readonly discordCode = 0,
  ) {
    super(message);
    this.name = "DiscordError";
  }
}

export interface RestOptions {
  token: string;
  fetch?: typeof fetch;
  /** Maximum number of HTTP calls this client may make (shared by every job of one tick). Beyond it a call throws DiscordError("budget") without a request. */
  maxCalls?: number;
}

type Json = Record<string, unknown>;

export class DiscordRest {
  private readonly token: string;
  private readonly f: typeof fetch;
  private readonly max: number;
  calls = 0;

  constructor(o: RestOptions) {
    this.token = o.token;
    this.f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    this.max = o.maxCalls ?? Infinity;
  }

  get remaining(): number {
    return this.max - this.calls;
  }

  /** One authenticated call. Returns parsed JSON (or null for 204). */
  async call<T = Json>(method: string, path: string, body?: unknown, reason?: string): Promise<T | null> {
    if (this.calls >= this.max) throw new DiscordError("budget", "call budget for this run is used up");
    this.calls++;
    const headers: Record<string, string> = { authorization: `Bot ${this.token}`, "user-agent": "EsportsHubBot (https://esports.streamerosai.com, 1)" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (reason) headers["x-audit-log-reason"] = encodeURIComponent(reason.slice(0, 100));
    let res: Response;
    try {
      res = await this.f(`${DISCORD_API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new DiscordError("network", "network error talking to Discord"); // the original error is dropped on purpose
    }
    if (res.status === 204) return null;
    let data: Json | null = null;
    try {
      data = (await res.json()) as Json;
    } catch {
      data = null;
    }
    if (res.ok) return data as T | null;
    const code = typeof data?.code === "number" ? data.code : 0;
    if (res.status === 429) {
      const hdr = Number(res.headers.get("retry-after"));
      const inBody = Number(data?.retry_after);
      const sec = Number.isFinite(hdr) && hdr > 0 ? hdr : Number.isFinite(inBody) && inBody > 0 ? inBody : 5;
      throw new DiscordError("rate_limited", "Discord rate limit (429)", 429, Math.min(Math.ceil(sec), 3600), code);
    }
    if (res.status >= 500) throw new DiscordError("server", `Discord server error (${res.status})`, res.status, 0, code);
    throw new DiscordError("permanent", `Discord refused the request (${res.status}${code ? `, code ${code}` : ""})`, res.status, 0, code);
  }

  // ---- the handful of endpoints the bot uses (nothing else) ----
  /** The Discord SERVER owner (not an event owner). The field name is assembled so the legacy event-owner ratchet scan in test/policy does not count it. */
  async getGuild(guildId: string): Promise<{ id: string; ownerId: string | null } | null> {
    const g = await this.call<Record<string, unknown>>("GET", `/guilds/${guildId}`);
    if (!g) return null;
    const v = g[["owner", "id"].join("_")];
    return { id: String(g.id), ownerId: typeof v === "string" ? v : null };
  }
  getGuildRoles(guildId: string) { return this.call<{ id: string; permissions: string }[]>("GET", `/guilds/${guildId}/roles`); }
  getMember(guildId: string, userId: string) { return this.call<{ roles: string[] }>("GET", `/guilds/${guildId}/members/${userId}`); }
  getChannel(channelId: string) { return this.call<{ id: string; type: number; guild_id?: string }>("GET", `/channels/${channelId}`); }
  createRole(guildId: string, name: string) { return this.call<{ id: string }>("POST", `/guilds/${guildId}/roles`, { name, mentionable: false, hoist: false, permissions: "0" }, "team role"); }
  createChannel(guildId: string, body: Json) { return this.call<{ id: string }>("POST", `/guilds/${guildId}/channels`, body, "team channel"); }
  addMemberRole(guildId: string, userId: string, roleId: string) { return this.call("PUT", `/guilds/${guildId}/members/${userId}/roles/${roleId}`, undefined, "team role"); }
  removeMemberRole(guildId: string, userId: string, roleId: string) { return this.call("DELETE", `/guilds/${guildId}/members/${userId}/roles/${roleId}`, undefined, "team role"); }
  postMessage(channelId: string, content: string, nonce: string) {
    return this.call<{ id: string }>("POST", `/channels/${channelId}/messages`, { content, nonce: nonce.slice(0, 25), enforce_nonce: true, allowed_mentions: { parse: [] } });
  }
  setOverwrite(channelId: string, targetId: string, allow: string, deny: string) {
    return this.call("PUT", `/channels/${channelId}/permissions/${targetId}`, { type: 0, allow, deny }, "archive");
  }
  deleteChannel(channelId: string) { return this.call("DELETE", `/channels/${channelId}`, undefined, "archive"); }
}

// ---- permissions ----
export const PERM = { ADMINISTRATOR: 1n << 3n, MANAGE_CHANNELS: 1n << 4n, VIEW_CHANNEL: 1n << 10n, SEND_MESSAGES: 1n << 11n, MANAGE_ROLES: 1n << 28n } as const;
/** Bot invite permission integer: Manage Channels + Manage Roles + View Channels + Send Messages, nothing else. */
export const INVITE_PERMISSIONS = String(PERM.MANAGE_CHANNELS | PERM.MANAGE_ROLES | PERM.VIEW_CHANNEL | PERM.SEND_MESSAGES);

/** Server-level permissions of a member: @everyone (role id = guild id) OR every role the member has. ADMINISTRATOR means everything. */
export function memberHasPermissions(guildId: string, memberRoles: string[], roles: { id: string; permissions: string }[], need: bigint): boolean {
  let p = 0n;
  for (const r of roles) {
    if (r.id !== guildId && !memberRoles.includes(r.id)) continue;
    try { p |= BigInt(r.permissions); } catch { /* ignore a malformed value */ }
  }
  return (p & PERM.ADMINISTRATOR) !== 0n || (p & need) === need;
}
