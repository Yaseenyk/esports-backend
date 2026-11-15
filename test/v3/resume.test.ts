import { beforeAll, describe, expect, it, vi } from "vitest";
import { uniq } from "../helpers";
import { allV3On, api, db, user } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
beforeAll(allV3On);

const slugOf = () => `player-${uniq()}`.toLowerCase();
const put = (u: { token: string }, body: Record<string, unknown>) => api("/v3/me/profile", { method: "PUT", token: u.token, body });

async function publicPlayer(slug: string) {
  const u = await user("Pub");
  await api("/v3/me/adult-confirmation", { token: u.token, body: { adult: true } });
  await api("/v3/me/resume-consent", { token: u.token, body: { consent: true } });
  const r = await put(u, { slug, handle: "RaviIGL", bio: "IGL from Pune", city: "Pune", state: "Maharashtra", languages: ["Hindi", "English"], visibility: "public" });
  expect(r.status, r.text).toBe(200);
  return u;
}

describe("18+ confirmation and consent", () => {
  it("status starts empty, adult confirmation stores a timestamp once", async () => {
    const u = await user("New", false);
    expect((await api("/v3/me/status", { token: u.token })).json).toEqual({ adultConfirmedAt: null, resumeConsentAt: null });
    expect((await api("/v3/me/adult-confirmation", { token: u.token, body: { adult: false } })).json.code).toBe("adult_required");
    expect((await api("/v3/me/adult-confirmation", { token: u.token, body: {} })).status).toBe(400);
    const a = await api("/v3/me/adult-confirmation", { token: u.token, body: { adult: true } });
    expect(a.status).toBe(200);
    const first = a.json.adultConfirmedAt;
    expect(first).toMatch(/^20/);
    const b = await api("/v3/me/adult-confirmation", { token: u.token, body: { adult: true } });
    expect(b.json.adultConfirmedAt).toBe(first);
  });
  it("needs sign-in", async () => {
    expect((await api("/v3/me/status")).status).toBe(401);
    expect((await api("/v3/me/adult-confirmation", { body: { adult: true } })).status).toBe(401);
  });
  it("consent needs 18+ first and an explicit true", async () => {
    const u = await user("NoAdult", false);
    expect((await api("/v3/me/resume-consent", { token: u.token, body: { consent: true } })).json.code).toBe("adult_required");
    await api("/v3/me/adult-confirmation", { token: u.token, body: { adult: true } });
    expect((await api("/v3/me/resume-consent", { token: u.token, body: { consent: "yes" } })).json.code).toBe("consent_required");
    const ok = await api("/v3/me/resume-consent", { token: u.token, body: { consent: true } });
    expect([ok.status, ok.json.resumeConsentAt]).toEqual([200, expect.stringMatching(/^20/)]);
  });
});

describe("profile", () => {
  it("create needs slug and handle; private by default; owner view", async () => {
    const u = await user("P1", false);
    expect((await api("/v3/me/profile", { token: u.token })).json.profile).toBeNull();
    expect((await put(u, { handle: "NoSlug" })).json.code).toBe("slug_and_handle_required");
    const slug = slugOf();
    const r = await put(u, { slug, handle: "Ravi", languages: ["Hindi", "hindi", "English"] });
    expect(r.status, r.text).toBe(200);
    expect(r.json.profile).toMatchObject({ slug, handle: "Ravi", visibility: "private", languages: ["Hindi", "English"], games: [], resumeConsentAt: null });
    const upd = await put(u, { bio: "Updated" });
    expect([upd.json.profile.bio, upd.json.profile.slug]).toEqual(["Updated", slug]);
  });
  it("slug rules: format, reserved, unique across users, own slug re-save is fine", async () => {
    const a = await user("A");
    const b = await user("B");
    const slug = slugOf();
    for (const [s, code] of [["ab", "slug_format"], ["admin", "slug_reserved"], ["a--b", "slug_double_hyphen"], ["Has Space", "slug_format"]] as const) expect((await put(a, { slug: s, handle: "Hh" })).json.code, s).toBe(code);
    expect((await put(a, { slug, handle: "Aa" })).status).toBe(200);
    const clash = await put(b, { slug, handle: "Bb" });
    expect([clash.status, clash.json.code]).toEqual([409, "slug_taken"]);
    expect((await put(a, { slug, handle: "Aa2" })).status).toBe(200);
    const taken = await put(b, { slug: slugOf(), handle: "Bb" });
    expect(taken.status).toBe(200);
    expect((await put(b, { slug })).json.code).toBe("slug_taken");
  });
  it("validates handle, bio, languages, visibility", async () => {
    const u = await user();
    await put(u, { slug: slugOf(), handle: "Okay" });
    for (const [body, code] of [[{ handle: "x" }, "invalid_handle"], [{ bio: "a".repeat(401) }, "invalid_bio"], [{ bio: "<b>x</b>" }, "invalid_bio"], [{ languages: "Hindi" }, "invalid_languages"], [{ languages: ["a", "b", "c", "d", "e", "f", "g"] }, "invalid_languages"], [{ visibility: "everyone" }, "invalid_visibility"]] as const) {
      const r = await put(u, body);
      expect([r.status, r.json.code], JSON.stringify(body)).toEqual([400, code]);
    }
  });
  it("public needs 18+ AND consent", async () => {
    const u = await user("NoConsent", false);
    await put(u, { slug: slugOf(), handle: "Nc" });
    expect((await put(u, { visibility: "public" })).json.code).toBe("adult_required");
    await api("/v3/me/adult-confirmation", { token: u.token, body: { adult: true } });
    expect((await put(u, { visibility: "public" })).json.code).toBe("consent_required");
    await api("/v3/me/resume-consent", { token: u.token, body: { consent: true } });
    const ok = await put(u, { visibility: "public" });
    expect([ok.status, ok.json.profile.visibility]).toEqual([200, "public"]);
    expect((await put(u, { visibility: "unlisted" })).json.profile.visibility).toBe("unlisted");
  });
  it("games: upsert, validate, remove; needs a profile", async () => {
    const u = await user();
    const noProfile = await api("/v3/me/games/bgmi", { method: "PUT", token: u.token, body: { inGameName: "Ravi" } });
    expect([noProfile.status, noProfile.json.code]).toEqual([409, "profile_required"]);
    await put(u, { slug: slugOf(), handle: "Gg" });
    const g = (game: string, body: Record<string, unknown>) => api(`/v3/me/games/${game}`, { method: "PUT", token: u.token, body });
    const ok = await g("bgmi", { inGameName: "Ravi", rankCode: "diamond_3", rankOrdinal: 17, roles: ["igl", "support", "igl"] });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.profile.games).toEqual([{ game: "bgmi", inGameName: "Ravi", rankCode: "diamond_3", rankOrdinal: 17, roles: ["igl", "support"] }]);
    const upd = await g("bgmi", { inGameName: "RaviV2", roles: [] });
    expect(upd.json.profile.games[0]).toMatchObject({ inGameName: "RaviV2", rankCode: null, roles: [] });
    expect((await g("valorant", { inGameName: "R", roles: ["duelist"] })).json.profile.games).toHaveLength(2);
    for (const [game, body, code] of [["chess", { inGameName: "x" }, "invalid_game"], ["bgmi", {}, "invalid_inGameName"], ["bgmi", { inGameName: "x", rankCode: "Diamond 3" }, "invalid_rankCode"],
      ["bgmi", { inGameName: "x", rankOrdinal: 101 }, "invalid_rankOrdinal"], ["bgmi", { inGameName: "x", roles: ["wizard"] }, "invalid_roles"], ["bgmi", { inGameName: "x", roles: ["igl", "support", "sniper", "scout", "flex"] }, "invalid_roles"]] as const) {
      const r = await g(game, body);
      expect([r.status, r.json.code], `${game} ${JSON.stringify(body)}`).toEqual([400, code]);
    }
    const del = await api("/v3/me/games/valorant", { method: "DELETE", token: u.token });
    expect([del.status, del.json.profile.games.length]).toEqual([200, 1]);
    expect((await api("/v3/me/games/valorant", { method: "DELETE", token: u.token })).status).toBe(404);
  });
  it("delete removes profile and games", async () => {
    const u = await user();
    await put(u, { slug: slugOf(), handle: "Dd" });
    await api("/v3/me/games/bgmi", { method: "PUT", token: u.token, body: { inGameName: "x" } });
    expect((await api("/v3/me/profile", { method: "DELETE", token: u.token })).status).toBe(200);
    expect((await api("/v3/me/profile", { token: u.token })).json.profile).toBeNull();
    expect((await db.prepare("SELECT COUNT(*) AS n FROM player_games WHERE user_id = ?1").bind(u.id).first<{ n: number }>())!.n).toBe(0);
  });
});

describe("public read", () => {
  it("serves a public consented profile with exactly the public fields", async () => {
    const slug = slugOf();
    const u = await publicPlayer(slug);
    await api("/v3/me/games/bgmi", { method: "PUT", token: u.token, body: { inGameName: "Ravi", rankCode: "ace", rankOrdinal: 20, roles: ["igl"] } });
    const r = await api(`/public/players/${slug}`);
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(["bio", "city", "games", "handle", "languages", "slug", "state", "updatedAt"]);
    expect(r.json.games).toEqual([{ game: "bgmi", inGameName: "Ravi", rankCode: "ace", rankOrdinal: 20, roles: ["igl"] }]);
    for (const secret of [u.id, u.email, "discord"]) expect(r.text).not.toContain(secret);
    expect(r.headers.get("cache-control")).toBe("public, max-age=0");
    const tag = r.headers.get("etag")!;
    expect((await api(`/public/players/${slug}`, { headers: { "if-none-match": tag } })).status).toBe(304);
  });
  it("private, unlisted, unknown and malformed slugs are the same 404", async () => {
    const u = await user();
    const slug = slugOf();
    await put(u, { slug, handle: "Priv" });
    const miss = await api("/public/players/nobody-here-1");
    expect(miss.status).toBe(404);
    expect((await api(`/public/players/${slug}`)).json).toEqual(miss.json);
    await api("/v3/me/adult-confirmation", { token: u.token, body: { adult: true } });
    await api("/v3/me/resume-consent", { token: u.token, body: { consent: true } });
    await put(u, { visibility: "unlisted" });
    expect((await api(`/public/players/${slug}`)).status).toBe(404);
    expect((await api("/public/players/X")).status).toBe(404);
  });
  it("withdrawing consent makes the profile private immediately", async () => {
    const slug = slugOf();
    const u = await publicPlayer(slug);
    expect((await api(`/public/players/${slug}`)).status).toBe(200);
    const w = await api("/v3/me/resume-consent", { method: "DELETE", token: u.token });
    expect(w.json.resumeConsentAt).toBeNull();
    expect((await api(`/public/players/${slug}`)).status).toBe(404);
    expect((await api("/v3/me/profile", { token: u.token })).json.profile.visibility).toBe("private");
    expect((await put(u, { visibility: "public" })).json.code).toBe("consent_required");
  });
  it("a public profile whose consent column was cleared elsewhere is still not served (defence in depth)", async () => {
    const slug = slugOf();
    const u = await publicPlayer(slug);
    await db.prepare("UPDATE users SET resume_consent_at = NULL WHERE id = ?1").bind(u.id).run();
    expect((await api(`/public/players/${slug}`)).status).toBe(404);
    await db.prepare("UPDATE users SET resume_consent_at = 1, adult_confirmed_at = NULL WHERE id = ?1").bind(u.id).run();
    expect((await api(`/public/players/${slug}`)).status).toBe(404);
    await db.prepare("UPDATE users SET resume_consent_at = 1, adult_confirmed_at = 1, status = 'suspended' WHERE id = ?1").bind(u.id).run();
    expect((await api(`/public/players/${slug}`)).status).toBe(404);
  });
  it("account deletion removes the public profile", async () => {
    const slug = slugOf();
    const u = await publicPlayer(slug);
    const del = await api("/auth/delete-account", { token: u.token, body: { password: "correct horse" } });
    expect(del.status, del.text).toBe(200);
    expect((await api(`/public/players/${slug}`)).status).toBe(404);
  });
});
