/** A fake Discord REST API for tests. Nothing in the suite reaches the real Discord: every test passes `fake.fetch` (or stubs globalThis.fetch with it). */
export const GUILD = "100000000000000001";
export const CATEGORY = "200000000000000001";
export const APP_ID = "300000000000000001";
export const TOKEN = "TEST-BOT-TOKEN-do-not-leak-0123456789";

export interface Call { method: string; path: string; body: any; auth: string | null }

export class FakeDiscord {
  calls: Call[] = [];
  owner = "400000000000000001";
  botRolePerms = "268438544"; // the invite permissions: Manage Channels + Manage Roles + View + Send
  botInGuild = true;
  notInGuild = new Set<string>(); // discord user ids that are not members (PUT role answers 404)
  channelsMeta: Record<string, { id: string; type: number; guild_id: string }> = { [CATEGORY]: { id: CATEGORY, type: 4, guild_id: GUILD } };
  n = 1000;
  /** Return a Response to override the answer of a call (first matching wins). `times` limits how often it applies. */
  rules: { when: (c: Call) => boolean; res: () => Response | Promise<Response>; times: number }[] = [];

  fail(when: (c: Call) => boolean, res: () => Response, times = Infinity) { this.rules.push({ when, res, times }); }
  of(method: string, re: RegExp) { return this.calls.filter((c) => c.method === method && re.test(c.path)); }
  get creates() { return { roles: this.of("POST", /\/roles$/).length, channels: this.of("POST", /\/channels$/).length, messages: this.of("POST", /\/messages$/).length }; }

  fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    const call: Call = { method: init?.method ?? "GET", path: u.pathname.replace(/^\/api\/v10/, ""), body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init?.headers).get("authorization") };
    if (u.origin !== "https://discord.com") throw new Error(`fake discord got a call to ${u.origin}`);
    this.calls.push(call);
    for (const r of this.rules) if (r.times > 0 && r.when(call)) { r.times--; return r.res(); }
    const j = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    const p = call.path;
    let m: RegExpExecArray | null;
    if (call.method === "GET" && (m = /^\/guilds\/(\d+)$/.exec(p))) return m[1] === GUILD ? j({ id: GUILD, owner_id: this.owner }) : j({ message: "Unknown Guild", code: 10004 }, 404);
    if (call.method === "GET" && /^\/guilds\/\d+\/members\/\d+$/.test(p)) return this.botInGuild ? j({ roles: ["900"] }) : j({ message: "Unknown Member", code: 10007 }, 404);
    if (call.method === "GET" && /^\/guilds\/\d+\/roles$/.test(p)) return j([{ id: GUILD, permissions: "0" }, { id: "900", permissions: this.botRolePerms }]);
    if (call.method === "GET" && (m = /^\/channels\/(\d+)$/.exec(p))) return this.channelsMeta[m[1]!] ? j(this.channelsMeta[m[1]!]) : j({ message: "Unknown Channel", code: 10003 }, 404);
    if (call.method === "POST" && /^\/guilds\/\d+\/roles$/.test(p)) return j({ id: `5${++this.n}` });
    if (call.method === "POST" && /^\/guilds\/\d+\/channels$/.test(p)) return j({ id: `6${++this.n}` });
    if (call.method === "PUT" && (m = /^\/guilds\/\d+\/members\/(\d+)\/roles\/\d+$/.exec(p))) return this.notInGuild.has(m[1]!) ? j({ message: "Unknown Member", code: 10007 }, 404) : new Response(null, { status: 204 });
    if (call.method === "POST" && /^\/channels\/\d+\/messages$/.test(p)) return j({ id: `7${++this.n}` });
    if (call.method === "PUT" && /^\/channels\/\d+\/permissions\/\d+$/.test(p)) return new Response(null, { status: 204 });
    if (call.method === "DELETE" && /^\/channels\/\d+$/.test(p)) return j({});
    return j({ message: "unhandled in fake", code: 0 }, 404);
  };
}

export const rateLimited = (sec = 7) => new Response(JSON.stringify({ message: "You are being rate limited.", retry_after: sec, global: false }), { status: 429, headers: { "retry-after": String(sec), "content-type": "application/json" } });
export const serverError = () => new Response("oops", { status: 502 });
export const forbidden = (code = 50013) => new Response(JSON.stringify({ message: "Missing Permissions", code }), { status: 403, headers: { "content-type": "application/json" } });

// ---- interaction signing ----
const hexOf = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b as ArrayBuffer)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function keyPair() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { privateKey: kp.privateKey, publicHex: hexOf((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer) };
}
export async function sign(privateKey: CryptoKey, ts: string, body: string): Promise<string> {
  return hexOf(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, new TextEncoder().encode(ts + body)));
}
