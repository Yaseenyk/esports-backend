import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { uniq } from "../helpers";
import { addBr, addRegistration, api, captainToken, db, prodLikeOn, tournament, user, type U } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
beforeAll(() => prodLikeOn("v3.profiles"));

/** The exact key set of the public player JSON (card link and slug routes share one builder). Adding a key must be a deliberate change here. */
const PUBLIC_KEYS = ["achievements", "battleRoyale", "bio", "certificates", "city", "games", "handle", "indexable", "kind", "languages", "links", "matches", "slug", "state", "stats", "teamName", "teams", "updatedAt", "visibility"];
const TOKEN_PATH = /^\/p\/\?k=([A-Za-z0-9_-]{22})$/;

async function player(opts: { visibility?: "private" | "unlisted" | "public"; consent?: boolean; name?: string } = {}) {
  const me = await user(opts.name ?? "Card Player");
  if (opts.consent !== false) expect((await api("/v3/me/resume-consent", { token: me.token, body: { consent: true } })).status).toBe(200);
  const slug = `c-${uniq()}`.toLowerCase();
  const r = await api("/v3/me/profile", { method: "PUT", token: me.token, body: { slug, handle: "Ravi IGL", bio: "Entry fragger from Pune", city: "Pune", state: "Maharashtra", languages: ["Hindi", "English"] } });
  expect(r.status, r.text).toBe(200);
  expect((await api("/v3/me/games/bgmi", { method: "PUT", token: me.token, body: { inGameName: "RaviOP", roles: ["igl", "assaulter"] } })).status).toBe(200);
  if (opts.visibility && opts.visibility !== "private") expect((await api("/v3/me/player-page/visibility", { method: "PUT", token: me.token, body: { visibility: opts.visibility } })).status).toBe(200);
  return { me, slug };
}
const ensure = (u: U) => api("/v3/me/player-page/card-link", { token: u.token, body: {} });
const reset = (u: U) => api("/v3/me/player-page/card-link/reset", { token: u.token, body: {} });
const details = (u: U, body: Record<string, unknown>) => api("/v3/me/player-page/details", { method: "PUT", token: u.token, body });
const card = (token: string, ip?: string) => api(`/public/profiles/cards/${token}`, ip ? { ip } : {});
const tokenOf = (path: string): string => TOKEN_PATH.exec(path)![1]!;

async function cardToken(u: U): Promise<string> {
  const r = await ensure(u);
  expect(r.status, r.text).toBe(200);
  expect(r.json.page.cardPath).toMatch(TOKEN_PATH);
  return tokenOf(r.json.page.cardPath);
}

/** An env whose DB counts the statements prepared (to show a miss and a refusal cost the same work). */
function countingEnv() {
  const sql: string[] = [];
  const DB = new Proxy(env.DB, {
    get(t, p) {
      if (p === "prepare") return (s: string) => { sql.push(s); return t.prepare(s); };
      const v = (t as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
  return { env: { ...env, DB } as typeof env, sql };
}

describe("player card link: creation, format, reset", () => {
  it("never publishes: a private profile (or none) gets share_first / profile_required, and stays private", async () => {
    const { me, slug } = await player();
    const r = await ensure(me);
    expect([r.status, r.json.code]).toEqual([409, "share_first"]);
    expect((await api("/v3/me/player-page", { token: me.token })).json.page).toMatchObject({ visibility: "private", cardPath: null });
    expect((await api(`/public/profiles/players/${slug}`)).status).toBe(404);
    expect((await ensure(await user("No Profile"))).json.code).toBe("profile_required");
    // consent withdrawn = private again: still no link
    const shared = await player({ visibility: "public" });
    await api("/v3/me/resume-consent", { method: "DELETE", token: shared.me.token });
    expect((await ensure(shared.me)).json.code).toBe("share_first");
  });

  it("a Public profile gets a 128-bit link once (idempotent); it holds no user id, email or slug", async () => {
    const { me, slug } = await player({ visibility: "public" });
    const t1 = await cardToken(me);
    const t2 = await cardToken(me);
    expect(t2).toBe(t1);
    for (const needle of [me.id, me.email, slug]) expect(t1).not.toContain(needle);
    // stored as a hash and an encrypted copy only, never in clear
    const row = await db.prepare("SELECT * FROM v3_player_page_details WHERE user_id = ?1").bind(me.id).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(t1);
    expect(row!.card_token_hash).toHaveLength(43);
    const r = await card(t1);
    expect(r.status, r.text).toBe(200);
    expect(r.json).toMatchObject({ kind: "player", handle: "Ravi IGL", slug, visibility: "public" });
  });

  it("Link only: choosing it creates the link; the slug address stays a 404", async () => {
    const { me, slug } = await player({ visibility: "unlisted" });
    const page = (await api("/v3/me/player-page", { token: me.token })).json.page;
    expect(page.cardPath).toMatch(TOKEN_PATH);
    expect(page.path).toBe(page.cardPath);
    expect((await api(`/public/profiles/players/${slug}`)).status).toBe(404);
    const r = await card(tokenOf(page.cardPath));
    expect(r.status).toBe(200);
    expect(r.json.slug).toBeNull(); // a Link only page never reveals its slug
  });

  it("Reset QR link: the old token stops working at once, the new one works", async () => {
    const { me } = await player({ visibility: "public" });
    const old = await cardToken(me);
    const r = await reset(me);
    expect(r.status, r.text).toBe(200);
    const fresh = tokenOf(r.json.page.cardPath);
    expect(fresh).not.toBe(old);
    expect((await card(old)).status).toBe(404);
    expect((await card(fresh)).status).toBe(200);
    expect(await cardToken(me)).toBe(fresh); // ensure keeps the new one
  });

  it("deleting the profile deletes the details and the link", async () => {
    const { me } = await player({ visibility: "public" });
    const t = await cardToken(me);
    await api("/v3/me/profile", { method: "DELETE", token: me.token });
    expect((await card(t)).status).toBe(404);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM v3_player_page_details WHERE user_id = ?1").bind(me.id).first()).toEqual({ n: 0 });
  });
});

describe("the page a QR opens: privacy of the public JSON", () => {
  it("snapshot: exact keys, nothing private (email, ids, consent times, contact, token)", async () => {
    const { me } = await player({ visibility: "public" });
    const t = await cardToken(me);
    await details(me, { teamName: "Alpha Wolves", links: [{ kind: "youtube", url: "https://www.youtube.com/@ravi" }], achievements: [{ title: "Pune LAN finalist", year: 2026 }] });
    const r = await card(t);
    expect(Object.keys(r.json).sort()).toEqual(PUBLIC_KEYS);
    expect(r.json).toMatchObject({
      handle: "Ravi IGL", bio: "Entry fragger from Pune", city: "Pune", state: "Maharashtra", languages: ["Hindi", "English"], teamName: "Alpha Wolves",
      links: [{ kind: "youtube", url: "https://www.youtube.com/@ravi" }], achievements: [{ title: "Pune LAN finalist", year: 2026 }],
      games: [{ game: "bgmi", inGameName: "RaviOP", rankCode: null, rankOrdinal: null, roles: ["igl", "assaulter"] }],
      stats: expect.objectContaining({ source: "verified_results" }),
    });
    for (const needle of [me.id, me.email, t, "adult", "consent", "Consent", "user_id", "userId", "email", "@example"]) expect(r.text, needle).not.toContain(needle);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("verified stats and recent tournaments come from recorded results only", async () => {
    const { me } = await player({ visibility: "public" });
    const t = await tournament({}, "live");
    await addRegistration(t.eventId, "Alpha Wolves");
    await addBr(t.eventId, 1, "Alpha Wolves", 1, 12);
    expect((await api(`/v3/tournaments/${t.slug}/captain-claim`, { token: me.token, body: { token: await captainToken(t.eventId, "Alpha Wolves") } })).status).toBe(200);
    const r = await card(await cardToken(me));
    expect(r.json.stats).toMatchObject({ source: "verified_results", battleRoyale: expect.objectContaining({ matches: 1, wins: 1, kills: 12 }) });
    expect(r.json.battleRoyale).toEqual([expect.objectContaining({ team: "Alpha Wolves", placement: 1, kills: 12 })]);
    expect(r.json.teams).toEqual([expect.objectContaining({ name: "Alpha Wolves" })]);
  });

  it("every hidden field is absent from both public routes; the owner still sees it", async () => {
    const { me, slug } = await player({ visibility: "public" });
    const t = await cardToken(me);
    await details(me, { teamName: "SecretTeam", links: [{ kind: "twitch", url: "https://twitch.tv/secretchan" }], achievements: [{ title: "SecretCup winner" }] });
    const all = ["bio", "location", "languages", "games", "roles", "team", "links", "achievements", "stats", "teams", "certificates", "matches"];
    const h = await details(me, { hiddenFields: all });
    expect(h.status, h.text).toBe(200);
    expect(h.json.page.details).toMatchObject({ teamName: "SecretTeam", hiddenFields: all });
    for (const r of [await card(t), await api(`/public/profiles/players/${slug}`)]) {
      expect(r.status).toBe(200);
      expect(r.json).toMatchObject({ bio: null, city: null, state: null, languages: [], games: [], teamName: null, links: [], achievements: [], stats: null, teams: [], certificates: [], matches: [], battleRoyale: [], indexable: false });
      for (const needle of ["Entry fragger", "Pune", "Hindi", "RaviOP", "SecretTeam", "secretchan", "SecretCup"]) expect(r.text, needle).not.toContain(needle);
    }
    // roles alone: games stay, roles go
    await details(me, { hiddenFields: ["roles"] });
    expect((await card(t)).json.games).toEqual([expect.objectContaining({ inGameName: "RaviOP", roles: [] })]);
  });
});

describe("enumeration: one uniform answer for every refusal", () => {
  it("malformed, unknown, revoked, private, consent withdrawn, moderated and suspended: the same 404 body", async () => {
    const unknown = await card("A".repeat(22));
    expect(unknown.status).toBe(404);
    const same = (r: { status: number; text: string }, why: string) => expect([r.status, r.text], why).toEqual([404, unknown.text]);
    for (const bad of ["short", "x".repeat(23), "%3Cscript%3E", "A".repeat(21) + "!", "..%2F..%2Fadmin"]) same(await card(bad), bad);

    const revoked = await player({ visibility: "public" });
    const old = await cardToken(revoked.me);
    await reset(revoked.me);
    same(await card(old), "revoked");

    const priv = await player({ visibility: "public" });
    const tp = await cardToken(priv.me);
    await api("/v3/me/player-page/visibility", { method: "PUT", token: priv.me.token, body: { visibility: "private" } });
    same(await card(tp), "private");

    const wd = await player({ visibility: "public" });
    const tw = await cardToken(wd.me);
    await api("/v3/me/resume-consent", { method: "DELETE", token: wd.me.token });
    same(await card(tw), "consent withdrawn");

    const mod = await player({ visibility: "public" });
    const tm = await cardToken(mod.me);
    await db.prepare("INSERT INTO v3_profile_moderation (target_kind, target_key, hidden_at, report_count, updated_at) VALUES ('player', ?1, ?2, 3, ?2)").bind(mod.me.id, Math.floor(Date.now() / 1000)).run();
    same(await card(tm), "hidden by moderation");

    const sus = await player({ visibility: "public" });
    const ts = await cardToken(sus.me);
    await db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?1").bind(sus.me.id).run();
    same(await card(ts), "suspended");
  });

  it("an unknown token, a malformed one and a private profile's token cost the same database work", async () => {
    const priv = await player({ visibility: "public" });
    const tp = await cardToken(priv.me);
    await api("/v3/me/player-page/visibility", { method: "PUT", token: priv.me.token, body: { visibility: "private" } });
    const counts: number[] = [];
    for (const t of ["B".repeat(22), "bad", tp]) {
      const spy = countingEnv();
      expect((await api(`/public/profiles/cards/${t}`, { env: spy.env })).status).toBe(404);
      counts.push(spy.sql.filter((q) => /v3_player_page_details/.test(q)).length);
    }
    expect(counts).toEqual([1, 1, 1]);
  });

  it("is rate limited per address: 30 a minute, then 429", async () => {
    const ip = `10.77.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200)}`;
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await card(`${"C".repeat(18)}${String(i).padStart(4, "0")}`, ip)).status);
    expect(codes.slice(0, 30).every((c) => c === 404)).toBe(true);
    expect(codes[30]).toBe(429);
  });
});

describe("page details: validation (free hand, safe output)", () => {
  it("accepts allowlisted socials (normalised to https) and any public website", async () => {
    const { me } = await player({ visibility: "public" });
    const r = await details(me, { links: [{ kind: "instagram", url: "http://instagram.com/ravi" }, { kind: "x", url: "https://twitter.com/ravi#top" }, { kind: "website", url: "http://ravi.example.org/about" }] });
    expect(r.status, r.text).toBe(200);
    expect(r.json.page.details.links).toEqual([
      { kind: "instagram", url: "https://instagram.com/ravi" }, { kind: "x", url: "https://twitter.com/ravi" }, { kind: "website", url: "http://ravi.example.org/about" },
    ]);
  });

  it("refuses scripts, other schemes, wrong hosts, contact links, credentials, ports, IPs and oversize input", async () => {
    const { me } = await player({ visibility: "public" });
    const badLinks: [string, string][] = [
      ["website", "javascript:alert(1)"], ["website", "data:text/html,<script>alert(1)</script>"], ["website", "ftp://ravi.example.org"], ["website", "vbscript:x"],
      ["youtube", "https://evil.example.com/youtube.com"], ["instagram", "https://instagram.com.evil.io/x"], ["website", "https://wa.me/919999999999"],
      ["website", "https://chat.whatsapp.com/abc"], ["website", "https://user:pw@ravi.example.org"], ["website", "https://ravi.example.org:8443/"],
      ["website", "http://127.0.0.1/"], ["website", "http://localhost/"], ["website", `https://ravi.example.org/${"a".repeat(200)}`], ["myspace", "https://myspace.com/x"],
    ];
    for (const [kind, url] of badLinks) {
      const r = await details(me, { links: [{ kind, url }] });
      expect([r.status, r.json.code], `${kind} ${url}`).toEqual([400, "invalid_links"]);
    }
    expect((await details(me, { links: Array.from({ length: 7 }, (_, i) => ({ kind: "website", url: `https://s${i}.example.org` })) })).json.code).toBe("invalid_links");
    expect((await details(me, { teamName: "<script>alert(1)</script>" })).json.code).toBe("invalid_teamName");
    expect((await details(me, { teamName: "Call 98765 43210" })).json.code).toBe("invalid_teamName");
    expect((await details(me, { teamName: "x".repeat(61) })).json.code).toBe("invalid_teamName");
    expect((await details(me, { achievements: [{ title: "<img src=x onerror=alert(1)>" }] })).json.code).toBe("invalid_achievements");
    expect((await details(me, { achievements: [{ title: "visit ravi.gg now" }] })).json.code).toBe("invalid_achievements");
    expect((await details(me, { achievements: [{ title: "Winner", year: 1999 }] })).json.code).toBe("invalid_achievements");
    expect((await details(me, { achievements: Array.from({ length: 9 }, () => ({ title: "Winner" })) })).json.code).toBe("invalid_achievements");
    expect((await details(me, { hiddenFields: ["email"] })).json.code).toBe("invalid_hiddenFields");
    expect((await api("/v3/me/player-page/details", { method: "PUT", token: me.token, raw: JSON.stringify({ bio: "x".repeat(9000) }), headers: { "content-type": "application/json" } })).status).toBe(413);
    // nothing was stored by the refused calls
    expect((await api("/v3/me/player-page", { token: me.token })).json.page.details).toEqual({ teamName: null, links: [], achievements: [], hiddenFields: [], searchOptIn: false });
  });

  it("a stored link that a tightened rule now refuses is dropped on read", async () => {
    const { me } = await player({ visibility: "public" });
    const t = await cardToken(me);
    await db.prepare("UPDATE v3_player_page_details SET links = ?2 WHERE user_id = ?1").bind(me.id, JSON.stringify([{ kind: "website", url: "javascript:alert(1)" }, { kind: "kick", url: "https://kick.com/ravi" }])).run();
    expect((await card(t)).json.links).toEqual([{ kind: "kick", url: "https://kick.com/ravi" }]);
  });
});

describe("authorisation: every new route", () => {
  it("anonymous: every owner route is 401", async () => {
    expect((await api("/v3/me/player-page/details", { method: "PUT", body: { teamName: "X" } })).status).toBe(401);
    expect((await api("/v3/me/player-page/card-link", { body: {} })).status).toBe(401);
    expect((await api("/v3/me/player-page/card-link/reset", { body: {} })).status).toBe(401);
    expect((await api(`/v3/profiles/cards/${"A".repeat(22)}/report`, { body: { reason: "spam" } })).status).toBe(401);
  });

  it("a non-owner cannot edit, reset or read the hidden fields of someone else's page", async () => {
    const a = await player({ visibility: "public", name: "Owner A" });
    const ta = await cardToken(a.me);
    await details(a.me, { teamName: "A Team", hiddenFields: ["bio"] });
    const b = await player({ visibility: "public", name: "Other B" });
    // B's writes only ever touch B's own row (no route takes a target id)
    await details(b.me, { teamName: "B Team", hiddenFields: [] });
    await reset(b.me);
    expect((await card(ta)).status).toBe(200); // A's link survived B's reset
    expect((await card(ta)).json).toMatchObject({ teamName: "A Team", bio: null });
    // B's owner view is B's, never A's
    const bv = (await api("/v3/me/player-page", { token: b.me.token })).json.page;
    expect(bv.details.teamName).toBe("B Team");
    expect(JSON.stringify(bv)).not.toContain(ta);
    // the hidden bio is not in any response B can get
    for (const r of [await api(`/public/profiles/cards/${ta}`, { token: b.me.token }), await api(`/public/profiles/players/${a.slug}`, { token: b.me.token })]) expect(r.text).not.toContain("Entry fragger");
    // a body that names another user is ignored: there is no user field
    await api("/v3/me/player-page/details", { method: "PUT", token: b.me.token, body: { userId: a.me.id, teamName: "Hijack" } });
    expect((await card(ta)).json.teamName).toBe("A Team");
  });

  it("report through a card link: signed in, not your own, a listed reason, unknown token is 404", async () => {
    const { me } = await player({ visibility: "unlisted" });
    const t = tokenOf((await api("/v3/me/player-page", { token: me.token })).json.page.cardPath);
    const rep = (u: U, token: string, reason = "spam") => api(`/v3/profiles/cards/${token}/report`, { token: u.token, body: { reason } });
    expect((await rep(me, t)).json.code).toBe("own_page");
    const u = await user("Card Reporter");
    expect((await rep(u, t, "nonsense")).json.code).toBe("invalid_reason");
    expect([(await rep(u, t)).status]).toEqual([202]);
    expect((await rep(u, "Z".repeat(22))).status).toBe(404);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM v3_profile_reports WHERE target_kind = 'player' AND target_key = ?1").bind(me.id).first()).toEqual({ n: 1 });
  });

  it("with v3.profiles off every new route is the router's 404", async () => {
    await prodLikeOn();
    const { me } = { me: await user("Flag Off") };
    for (const [path, method] of [[`/public/profiles/cards/${"A".repeat(22)}`, "GET"], ["/v3/me/player-page/card-link", "POST"], ["/v3/me/player-page/card-link/reset", "POST"], ["/v3/me/player-page/details", "PUT"]] as const) {
      expect((await api(path, { method, token: me.token, body: method === "GET" ? undefined : {} })).status, path).toBe(404);
    }
    await prodLikeOn("v3.profiles");
  });
});

describe("search quality gate: which profiles get an indexable /players/<slug>/ page", () => {
  const list = async () => (await api("/public/profiles/players")).json.items.map((i: { slug: string }) => i.slug) as string[];
  const longBio = "Entry fragger and in-game leader from Pune, playing BGMI scrims every night and college LANs on weekends.";

  it("needs the opt-in (off by default), Public, a rich bio plus a game OR a verified result; hidden fields do not count", async () => {
    const { me, slug } = await player({ visibility: "public" });
    await api("/v3/me/profile", { method: "PUT", token: me.token, body: { bio: longBio } });
    expect(await list()).not.toContain(slug); // search off
    expect((await api("/v3/me/player-page", { token: me.token })).json.page.indexBlockers).toEqual(["search_off"]);
    const on = await details(me, { searchOptIn: true });
    expect(on.json.page.details.searchOptIn).toBe(true);
    expect(on.json.page.indexBlockers).toEqual([]);
    expect(await list()).toContain(slug);
    const item = (await api("/public/profiles/players")).json.items.find((i: { slug: string }) => i.slug === slug);
    expect(Object.keys(item).sort()).toEqual(["listedSince", "slug", "updatedAt"]);
    expect((await api(`/public/profiles/players/${slug}`)).json.indexable).toBe(true);
    // hiding the bio makes it thin: dropped
    await details(me, { hiddenFields: ["bio"] });
    expect(await list()).not.toContain(slug);
    expect((await api("/v3/me/player-page", { token: me.token })).json.page.indexBlockers).toEqual(["thin_content"]);
    await details(me, { hiddenFields: [] });
    // Link only, switched off, consent withdrawn, moderated, deleted: each drops it
    await api("/v3/me/player-page/visibility", { method: "PUT", token: me.token, body: { visibility: "unlisted" } });
    expect(await list()).not.toContain(slug);
    await api("/v3/me/player-page/visibility", { method: "PUT", token: me.token, body: { visibility: "public" } });
    expect(await list()).toContain(slug);
    await details(me, { searchOptIn: false });
    expect(await list()).not.toContain(slug);
    await details(me, { searchOptIn: true });
    await db.prepare("INSERT INTO v3_profile_moderation (target_kind, target_key, hidden_at, report_count, updated_at) VALUES ('player', ?1, ?2, 1, ?2)").bind(me.id, Math.floor(Date.now() / 1000)).run();
    expect(await list()).not.toContain(slug);
    await db.prepare("DELETE FROM v3_profile_moderation WHERE target_key = ?1").bind(me.id).run();
    expect(await list()).toContain(slug);
    await api("/v3/me/resume-consent", { method: "DELETE", token: me.token });
    expect(await list()).not.toContain(slug);
  });

  it("a short bio with no verified result is thin; one verified result is enough", async () => {
    const { me, slug } = await player({ visibility: "public" });
    await details(me, { searchOptIn: true });
    expect(await list()).not.toContain(slug);
    const t = await tournament({}, "live");
    await addRegistration(t.eventId, "Solo Squad");
    await addBr(t.eventId, 1, "Solo Squad", 3, 4);
    await api(`/v3/tournaments/${t.slug}/captain-claim`, { token: me.token, body: { token: await captainToken(t.eventId, "Solo Squad") } });
    expect(await list()).toContain(slug);
  });

  it("the list holds slugs only (no ids, emails or tokens); reserved route names cannot be slugs", async () => {
    const { me, slug } = await player({ visibility: "public" });
    await api("/v3/me/profile", { method: "PUT", token: me.token, body: { bio: longBio } });
    await details(me, { searchOptIn: true });
    const t = await cardToken(me);
    const r = await api("/public/profiles/players");
    expect(r.text).toContain(slug);
    for (const needle of [me.id, me.email, t]) expect(r.text).not.toContain(needle);
    for (const s of ["view", "cards", "card"]) expect((await api("/v3/me/profile", { method: "PUT", token: me.token, body: { slug: s } })).json.code, s).toBe("slug_reserved");
    expect((await details(me, { searchOptIn: "yes" })).json.code).toBe("invalid_searchOptIn");
  });
});
