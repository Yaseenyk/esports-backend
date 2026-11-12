import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { call, club, db, joined, newEvent, newUser, teamOff, teamOn, verified } from "./helpers";
import { basicRoster } from "../helpers";

vi.setConfig({ testTimeout: 120_000 });
afterEach(teamOff);

const kit = { name: "Brand", primaryColor: "#0a84ff", secondaryColor: "#7c3aed" };

describe("POST /me/export (OD-Z)", () => {
  it("field-set snapshot: account, memberships, events with counts, brand kits, team profiles; no hash, salt, rosters, photos, registrations or contact rows", async () => {
    const u = await verified("Export Me");
    const ev = await newEvent(u.token, "Export Cup");
    await call(`/events/${ev.id}/roster`, { method: "PUT", token: u.token, body: basicRoster() });
    const form = (await call(`/events/${ev.id}/registration`, { method: "PUT", token: u.token, body: { acknowledge: true, title: "Reg", teamSize: 1, subs: 0 } })).json;
    await call(`/public/registration/${form.token}/submit`, { body: { teamName: "Secret Team Name", captainName: "Captain Hidden", captainContact: "hidden-contact@example.com", players: [{ name: "Minor Player Name", minor: true }] } });
    await call(`/events/${ev.id}/brand`, { method: "PUT", token: u.token, body: kit });
    await call("/brand", { method: "PUT", token: u.token, body: kit });
    await call("/profiles", { token: u.token, body: { name: "Alpha Wolves Page" } });
    await call("/public/contact", { body: { name: "Someone", email: "contact-row@example.com", message: "contact message body" } });

    const r = await call("/me/export", { method: "POST", token: u.token });
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    expect(r.headers.get("content-disposition")).toContain("attachment");
    const j = r.json;
    expect(Object.keys(j).sort()).toEqual(["account", "brandKits", "events", "exportVersion", "exportedAt", "memberships", "notIncluded", "teamProfiles"]);
    expect(Object.keys(j.account).sort()).toEqual(["createdAt", "email", "emailVerified", "id", "name"]);
    expect(j.account).toMatchObject({ id: u.id, email: u.email, name: "Export Me", emailVerified: true });
    expect(Object.keys(j.memberships[0]).sort()).toEqual(["addedAt", "kind", "name", "orgId", "role"]);
    expect(Object.keys(j.events[0]).sort()).toEqual(["counts", "createdAt", "game", "id", "key", "name", "orgId", "organiser", "role", "startsOn", "date", "venue"].sort());
    expect(Object.keys(j.events[0].counts).sort()).toEqual(["checkins", "matches", "people", "registrations", "teams"]);
    expect(j.events[0]).toMatchObject({ id: ev.id, role: "owner", orgId: `org-${u.id}`, counts: { teams: 2, people: 3, registrations: 1, matches: 0, checkins: 0 } });
    expect(j.brandKits.map((k: { scope: string }) => k.scope).sort()).toEqual([ev.id, "account"].sort());
    expect(Object.keys(j.brandKits[0]).sort()).toEqual(["hasLogo", "logo", "name", "primaryColor", "scope", "secondaryColor", "updatedAt"]);
    expect(Object.keys(j.teamProfiles[0]).sort()).toEqual(["blurb", "consentAt", "consentNote", "events", "id", "links", "name", "published", "slug", "updatedAt"]);

    // never in it: the hash, the salt, the secret, the signing secret, any roster, registration or contact content
    const user = await db.prepare("SELECT pw_hash, pw_salt FROM users WHERE id = ?1").bind(u.id).first<{ pw_hash: string; pw_salt: string }>();
    const evRow = await db.prepare("SELECT signing_secret FROM events WHERE id = ?1").bind(ev.id).first<{ signing_secret: string }>();
    for (const forbidden of [user!.pw_hash, user!.pw_salt, env.JWT_SECRET, evRow!.signing_secret, "pw_hash", "pw_salt", "Asha", "Ravi", "Mira", "Alpha Wolves\"", "Secret Team Name", "Captain Hidden", "hidden-contact", "Minor Player Name", "contact-row@example.com", "contact message body", "ALP-001", form.token]) {
      expect(r.text, forbidden).not.toContain(forbidden);
    }
  });

  it("holds nothing about other people: a club member's export lists the club's events as counts only and no other member", async () => {
    await teamOn();
    const a = await club("Boss");
    const m = await joined(a, "member", "Helper");
    const ev = (await call("/events", { token: a.token, body: { name: "Club cup", orgId: a.orgId } })).json;
    const r = await call("/me/export", { method: "POST", token: m.token });
    expect(r.status).toBe(200);
    expect(r.json.events.map((e: { id: string; role: string }) => [e.id, e.role])).toEqual([[ev.id, "club_member"]]);
    expect(r.json.memberships).toHaveLength(2); // personal + club
    expect(r.text).not.toContain(a.email);
    // the club id is derived from its first admin's account id (blueprint 5.1), so only the id inside organisation ids may appear
    expect(r.text.split(a.orgId).join("")).not.toContain(a.id);
    expect(r.text).not.toContain("Boss");
    const boss = await call("/me/export", { method: "POST", token: a.token });
    expect(boss.text).not.toContain(m.email);
    expect(boss.text).not.toContain(m.id);
  });

  it("is rate limited (5 an hour) and size capped", async () => {
    const u = await newUser();
    const ip = "198.51.100.9";
    let last = 0;
    for (let i = 0; i < 5; i++) last = (await call("/me/export", { method: "POST", token: u.token, ip })).status;
    expect(last).toBe(200); // five an hour per user (the limiter is keyed by the user, not the address)
    expect((await call("/me/export", { method: "POST", token: u.token })).status).toBe(429);
    const big = await newUser();
    // a 59 KB logo on each of 30 event kits: well past 1 MB if it were all included; the export drops logos and says so
    const logo = `data:image/png;base64,${"A".repeat(40_000)}`;
    for (let i = 0; i < 30; i++) {
      await db.prepare("INSERT INTO brand_kits (id, owner_user_id, scope, name, logo, primary_color, secondary_color, updated_at) VALUES (?1, ?2, ?3, 'k', ?4, '#000000', '#ffffff', 't')").bind(crypto.randomUUID(), big.id, `scope-${i}`, logo).run();
    }
    const r = await call("/me/export", { method: "POST", token: big.token });
    expect(r.status).toBe(200);
    expect(r.text.length).toBeLessThan(1_000_000);
    expect(r.json.logosOmitted).toBe(true);
    expect(r.json.brandKits).toHaveLength(30);
    expect(r.json.brandKits.every((k: { hasLogo: boolean; logo: string | null }) => k.hasLogo && k.logo === null)).toBe(true);
  });
});
