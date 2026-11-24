import { describe, expect, it, vi } from "vitest";
import { auditRows, makeStaff } from "../admin/helpers";
import { uniq } from "../helpers";
import { CALENDAR, cleanRegistrationUrl, parseDay } from "../../src/v3/lib/community";
import { api, communityOn, day, db, org, pastTournament, user } from "./community-helpers";
import { tournament } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

const entry = (over: Record<string, unknown> = {}) => ({
  title: `Techfest Esports ${uniq()}`, game: "valorant", city: "Pune", startsOn: day(10), endsOn: day(11), registrationUrl: "https://forms.example.org/college/esports", ...over,
});
const create = (orgId: string, token: string | undefined, body: unknown) => api(`/v3/orgs/${orgId}/calendar`, { token, body });

describe("calendar rules (pure)", () => {
  it("registration links: https only, no payment pages or shorteners, and the query string and fragment are always removed", () => {
    expect(cleanRegistrationUrl("http://example.org/x")).toEqual({ ok: false, code: "url_not_https" });
    expect(cleanRegistrationUrl("https://rzp.razorpay.com/pay")).toEqual({ ok: false, code: "url_blocked_host" });
    expect(cleanRegistrationUrl("https://bit.ly/abc")).toEqual({ ok: false, code: "url_blocked_host" });
    expect(cleanRegistrationUrl("https://user:pw@example.org/")).toEqual({ ok: false, code: "url_invalid" });
    expect(cleanRegistrationUrl("https://127.0.0.1/")).toEqual({ ok: false, code: "url_invalid" });
    expect(cleanRegistrationUrl("https://esports.streamerosai.com/join/?t=SECRET#x")).toEqual({ ok: true, url: "https://esports.streamerosai.com/join/", stripped: true });
    expect(cleanRegistrationUrl("https://Docs.Google.com/forms/d/e/abc/viewform")).toEqual({ ok: true, url: "https://docs.google.com/forms/d/e/abc/viewform", stripped: false });
  });
  it("dates are real calendar days", () => {
    expect(parseDay("2026-02-30")).toBeNull();
    expect(parseDay("2026-12-01")).toBe("2026-12-01");
    expect(parseDay("01-12-2026")).toBeNull();
  });
});

describe("listing events (v3.calendar on)", () => {
  it("only a signed-in, 18+ member of a VERIFIED organisation can list; everyone else gets 404 (or 401 / adult_required)", async () => {
    await communityOn("v3.calendar");
    const admin = await user("FestLead");
    const member = await user("FestMember");
    const outsider = await user("Outsider");
    const kid = await user("NotConfirmed", false);
    const o = await org([{ u: admin }, { u: member, role: "member" }, { u: kid }]);
    const unverified = await org([{ u: admin }], { verified: false });
    const suspended = await org([{ u: admin }], { status: "suspended" });
    expect((await create(o.id, undefined, entry())).status).toBe(401);
    expect((await create(o.id, outsider.token, entry())).status).toBe(404);
    expect((await create(unverified.id, admin.token, entry())).status).toBe(404);
    expect((await create(suspended.id, admin.token, entry())).status).toBe(404);
    expect((await create(o.id, kid.token, entry())).json.code).toBe("adult_required");
    const ok = await create(o.id, admin.token, entry());
    expect(ok.status, ok.text).toBe(201);
    expect(ok.json.entry).toMatchObject({ game: "valorant", city: "Pune", status: "listed", hidden: false, organiser: { slug: o.slug, verified: true } });
    expect((await create(o.id, member.token, entry())).status).toBe(201);
    const mine = await api("/v3/me/calendar", { token: member.token });
    expect(mine.json.orgs.map((x: { id: string }) => x.id)).toEqual([o.id]);
    expect(mine.json.items).toHaveLength(2);
    expect((await api("/v3/me/calendar", { token: outsider.token })).json).toEqual({ orgs: [], items: [] });
  });

  it("validates dates, links and tournament pages; never stores a query string", async () => {
    await communityOn("v3.calendar", "v3.tournaments");
    const admin = await user("Validator");
    const o = await org([{ u: admin }]);
    const other = await org([{ u: await user("OtherAdmin") }]);
    const code = async (over: Record<string, unknown>) => (await create(o.id, admin.token, entry(over))).json.code;
    expect(await code({ startsOn: day(-5), endsOn: day(-4) })).toBe("date_past");
    expect(await code({ startsOn: day(5), endsOn: day(4) })).toBe("invalid_dates");
    expect(await code({ startsOn: "2026-02-30" })).toBe("invalid_dates");
    expect(await code({ startsOn: day(1), endsOn: day(1 + CALENDAR.MAX_SPAN_DAYS) })).toBe("span_too_long");
    expect(await code({ startsOn: day(CALENDAR.MAX_AHEAD_DAYS + 5), endsOn: day(CALENDAR.MAX_AHEAD_DAYS + 5) })).toBe("too_far_ahead");
    expect(await code({ registrationUrl: "http://insecure.example.org" })).toBe("url_not_https");
    expect(await code({ registrationUrl: "https://pages.razorpay.com/fee" })).toBe("url_blocked_host");
    expect(await code({ registrationUrl: null })).toBe("link_required");
    expect(await code({ game: "chess" })).toBe("invalid_game");
    expect(await code({ title: "<b>x</b>" })).toBe("invalid_title");
    const stripped = await create(o.id, admin.token, entry({ registrationUrl: "https://forms.example.org/reg?t=SECRETTOKEN&utm=1#top" }));
    expect(stripped.status).toBe(201);
    expect(stripped.json.urlStripped).toBe(true);
    expect(stripped.json.entry.registrationUrl).toBe("https://forms.example.org/reg");
    const raw = await db.prepare("SELECT registration_url FROM calendar_entries WHERE id = ?1").bind(stripped.json.entry.id).first<{ registration_url: string }>();
    expect(raw!.registration_url).not.toContain("SECRET");
    // the database refuses a query string even if a bug let one through
    await expect(db.prepare("UPDATE calendar_entries SET registration_url = 'https://x.example.org/?t=1' WHERE id = ?1").bind(stripped.json.entry.id).run()).rejects.toThrow();

    // tournament pages: only a PUBLIC one of the SAME organisation
    const mineT = await pastTournament(-10, "registration_open", o.id);
    const theirsT = await pastTournament(-10, "registration_open", other.id);
    const draft = await tournament();
    await db.prepare("UPDATE events SET org_id = ?1 WHERE id = ?2").bind(o.id, draft.eventId).run();
    expect(await code({ tournamentSlug: theirsT.slug })).toBe("tournament_not_found");
    expect(await code({ tournamentSlug: draft.slug })).toBe("tournament_not_found");
    const linked = await create(o.id, admin.token, entry({ registrationUrl: null, tournamentSlug: mineT.slug }));
    expect(linked.status, linked.text).toBe(201);
    expect(linked.json.entry.tournamentSlug).toBe(mineT.slug);
    const listed = (await api("/public/calendar")).json.items.find((x: { id: string }) => x.id === linked.json.entry.id);
    expect(listed).toMatchObject({ tournamentSlug: mineT.slug, registrationUrl: null });
  });

  it("edit, cancel and delete by the organisation only; the per-organisation cap", async () => {
    await communityOn("v3.calendar");
    const admin = await user("Editor");
    const stranger = await user("Stranger");
    const o = await org([{ u: admin }]);
    const e = (await create(o.id, admin.token, entry())).json.entry;
    expect((await api(`/v3/calendar/${e.id}`, { method: "PUT", token: stranger.token, body: entry() })).status).toBe(404);
    const upd = await api(`/v3/calendar/${e.id}`, { method: "PUT", token: admin.token, body: entry({ title: "Renamed Fest Cup", status: "cancelled" }) });
    expect(upd.status, upd.text).toBe(200);
    expect(upd.json.entry).toMatchObject({ title: "Renamed Fest Cup", status: "cancelled" });
    expect((await api(`/v3/calendar/${e.id}`, { method: "DELETE", token: stranger.token })).status).toBe(404);
    expect((await api(`/v3/calendar/${e.id}`, { method: "DELETE", token: admin.token })).status).toBe(200);
    expect((await api(`/v3/calendar/${e.id}`, { method: "DELETE", token: admin.token })).status).toBe(404);
    // cap: 30 listed upcoming entries per organisation
    for (let i = 0; i < CALENDAR.MAX_UPCOMING_PER_ORG; i++) {
      await db.prepare("INSERT INTO calendar_entries (id, org_id, title, game, city, starts_on, ends_on, registration_url, created_at, updated_at) VALUES (?1, ?2, 'Bulk Event', 'bgmi', 'Pune', ?3, ?3, 'https://x.example.org/r', 1, 1)").bind(`${uniq()}${"0".repeat(20)}`.slice(0, 32), o.id, day(3)).run();
    }
    expect((await create(o.id, admin.token, entry())).json.code).toBe("calendar_cap");
  });
});

describe("the public calendar", () => {
  it("lists verified organisations only, filters by game, city and dates, and counts upcoming verified events for the index rule", async () => {
    await communityOn("v3.calendar");
    const admin = await user("Lister");
    const city = `Nagpur${uniq()}`;
    const o = await org([{ u: admin }]);
    const a = (await create(o.id, admin.token, entry({ city, game: "bgmi", startsOn: day(3), endsOn: day(3) }))).json.entry;
    const b = (await create(o.id, admin.token, entry({ city, game: "valorant", startsOn: day(40), endsOn: day(41) }))).json.entry;
    const c = (await create(o.id, admin.token, entry({ city, game: "valorant", startsOn: day(5), endsOn: day(6) }))).json.entry;
    await api(`/v3/calendar/${c.id}`, { method: "PUT", token: admin.token, body: entry({ city, game: "valorant", startsOn: day(5), endsOn: day(6), status: "cancelled" }) });
    const before = (await api("/public/calendar")).json;
    expect(before.minimumForIndex).toBe(5);
    const ids = (q: string) => api(`/public/calendar${q}`).then((r) => r.json.items.map((x: { id: string }) => x.id).sort());
    expect(await ids(`?city=${city}`)).toEqual([a.id, b.id, c.id].sort());
    expect(await ids(`?city=${city.toLowerCase()}&game=bgmi`)).toEqual([a.id]);
    expect(await ids(`?city=${city}&from=${day(30)}`)).toEqual([b.id]);
    expect(await ids(`?city=${city}&to=${day(10)}`)).toEqual([a.id, c.id].sort());
    expect((await api("/public/calendar?game=chess")).status).toBe(400);
    expect((await api("/public/calendar?from=yesterday")).status).toBe(400);
    const cancelled = (await api(`/public/calendar?city=${city}`)).json.items.find((x: { id: string }) => x.id === c.id);
    expect(cancelled.status).toBe("cancelled");
    // the index count: listed (not cancelled) upcoming entries of verified organisations
    const n0 = before.upcomingVerified;
    const extra = await create(o.id, admin.token, entry({ city }));
    expect(extra.status, extra.text).toBe(201);
    expect((await api("/public/calendar")).json.upcomingVerified).toBe(n0 + 1);
    // nothing private in the public payload
    const text = JSON.stringify((await api(`/public/calendar?city=${city}`)).json);
    expect(text).not.toContain(o.id);
    expect(text).not.toContain(admin.id);
    // an organisation that loses verification disappears from the calendar at once
    await db.prepare("UPDATE organisations SET verified_at = NULL WHERE id = ?1").bind(o.id).run();
    expect(await ids(`?city=${city}`)).toEqual([]);
    expect((await api("/public/calendar")).json.upcomingVerified).toBe(n0 - 2);
  });

  it("staff hide and restore an entry with a reason (logged, audited); hidden entries leave the calendar and the count", async () => {
    await communityOn("v3.calendar", "admin.enabled");
    const admin = await user("Hidden");
    const o = await org([{ u: admin }]);
    const city = `Hubli${uniq()}`;
    const e = (await create(o.id, admin.token, entry({ city }))).json.entry;
    const staff = await makeStaff();
    const token = (await staff.login()).token;
    expect((await api(`/admin/v1/v3/calendar/${e.id}/hide`, { token: admin.token, body: { reason: "spam" } })).status).toBe(404);
    const n0 = (await api("/public/calendar")).json.upcomingVerified;
    const h = await api(`/admin/v1/v3/calendar/${e.id}/hide`, { token, body: { reason: "spam", note: "Not an esports event" } });
    expect(h.status, h.text).toBe(200);
    expect(h.json.actions[0]).toMatchObject({ action: "hidden", reason: "spam" });
    expect((await api(`/public/calendar?city=${city}`)).json.items).toHaveLength(0);
    expect((await api("/public/calendar")).json.upcomingVerified).toBe(n0 - 1);
    expect((await api("/v3/me/calendar", { token: admin.token })).json.items[0]).toMatchObject({ hidden: true, hiddenReason: "spam" });
    expect((await auditRows("calendar.hidden", e.id))[0]).toMatchObject({ actor_id: staff.id, reason_code: "spam", target_type: "calendar_entry" });
    const r = await api(`/admin/v1/v3/calendar/${e.id}/restore`, { token, body: { reason: "appeal_upheld" } });
    expect(r.status).toBe(200);
    expect((await api(`/public/calendar?city=${city}`)).json.items).toHaveLength(1);
    expect(await auditRows("calendar.restored", e.id)).toHaveLength(1);
  });

  it("v3.calendar off: the calendar routes are the unknown-route 404; the status route answers only while a community flag is on", async () => {
    await communityOn("v3.trust");
    const s = await api("/public/community/status");
    expect([s.status, s.json]).toEqual([200, { calendar: false, trust: true }]);
    expect((await api("/public/calendar")).status).toBe(404);
    await communityOn();
    expect((await api("/public/community/status")).status).toBe(404);
  });
});
