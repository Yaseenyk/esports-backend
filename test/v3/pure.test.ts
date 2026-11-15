import { describe, expect, it } from "vitest";
import { overlayBr, overlayMatches } from "../../src/v3/adapters/results-overlay";
import { detectImage } from "../../src/v3/lib/image-magic";
import { cleanText, hasLink, hasPhoneNumber, validateApplicationMessage, validateContact, validateLftMessage } from "../../src/v3/lib/lft-text";
import { seoVerdict, type SeoGuardInput } from "../../src/v3/lib/seo-guard";
import { checkSlug, slugify } from "../../src/v3/lib/slug";
import { APPLICATION_MOVES, DISPUTE_MOVES, TOURNAMENT_MOVES, canMove } from "../../src/v3/lib/state-machines";

const good: SeoGuardInput = {
  title: "Gokte Cup 2026", titleIsUnique: true, summary: "s".repeat(80), description: "d".repeat(200), startsAt: 1_800_000_000, venue: "offline", city: "Pune",
  status: "registration_open", hasVerifiedResults: false, publishedAt: 1_790_000_000,
};

describe("thin-page guard", () => {
  it("passes when every line holds", () => expect(seoVerdict(good)).toEqual({ ready: true, failures: [] }));
  it.each([
    ["title_unique", { titleIsUnique: false }],
    ["title_unique", { title: "Cup" }],
    ["summary_80", { summary: "s".repeat(79) }],
    ["description_200", { description: "d".repeat(199) }],
    ["description_200", { description: null }],
    ["start_date", { startsAt: null }],
    ["venue", { venue: "offline" as const, city: " " }],
    ["registration_or_results", { status: "registration_closed" }],
    ["published", { publishedAt: null }],
    ["published", { status: "draft" }],
    ["published", { status: "cancelled" }],
  ] as const)("fails %s", (name, over) => {
    const v = seoVerdict({ ...good, ...over });
    expect(v.ready).toBe(false);
    expect(v.failures).toContain(name);
  });
  it("online needs no city; verified results replace open registration", () => {
    expect(seoVerdict({ ...good, venue: "online", city: null }).ready).toBe(true);
    expect(seoVerdict({ ...good, status: "completed", hasVerifiedResults: true }).ready).toBe(true);
    expect(seoVerdict({ ...good, status: "completed", hasVerifiedResults: false }).failures).toContain("registration_or_results");
  });
});

describe("slugs", () => {
  it("accepts good slugs and lowers case", () => {
    expect(checkSlug("Gokte-Cup-2026")).toEqual({ ok: true, slug: "gokte-cup-2026" });
    expect(checkSlug("abc")).toEqual({ ok: true, slug: "abc" });
  });
  it.each(["ab", "-abc", "abc-", "a b c", "a_b_c", "abc/def", "x".repeat(61), "café-cup", ""])("rejects %j", (s) => expect(checkSlug(s).ok).toBe(false));
  it("rejects double hyphens and reserved names", () => {
    expect(checkSlug("a--b")).toEqual({ ok: false, reason: "double_hyphen" });
    for (const r of ["admin", "api", "tournaments", "lft", "app"]) expect(checkSlug(r)).toEqual({ ok: false, reason: "reserved" });
    expect(checkSlug(42).ok).toBe(false);
  });
  it("slugify strips accents and symbols", () => {
    expect(slugify("Gokte  Cup: 2026!")).toBe("gokte-cup-2026");
    expect(slugify("Café – Cup")).toBe("cafe-cup");
  });
});

describe("LFT text validator", () => {
  const ok = (s: string) => expect(validateLftMessage(s).ok, s).toBe(true);
  const no = (s: string, code: string) => {
    const r = validateLftMessage(s);
    expect(r.ok, s).toBe(false);
    if (!r.ok) expect(r.code, s).toBe(code);
  };
  it("accepts plain text", () => {
    ok("IGL looking for a serious BGMI squad, evenings IST, diamond+");
    ok("Rank 17, 4.2 KD, scrims at 9pm");
    ok("Need an assaulter and a sniper. Practice Mon-Fri after 8.");
  });
  it.each([
    "join https://discord.gg/abc123", "see http://x.co", "www.example.com", "visit example.com now", "my site: foo.in", "discord.gg/abc", "discord . gg / abc",
    "check out my yt dot com", "t.me/mychannel", "wa.me/919812345678", "bit.ly/xyz", "go to FTP://host", "clips on youtube。com", "ping me at example․io",
  ])("rejects link %j", (s) => no(`IGL looking for team. ${s}`, "has_link"));
  it.each([
    "call 9876543210", "whatsapp +91 98765 43210", "ph: 98765-43210", "(022) 2345 6789", "98765 4321 0", "9 8 7 6 5 4 3 2 1 0", "+91-9876543210",
  ])("rejects phone %j", (s) => no(`IGL looking for team. ${s}`, "has_phone"));
  it("rejects length, empty, markup", () => {
    no("a".repeat(601), "too_long");
    no("short", "empty");
    no("   ", "empty");
    no("looking <b>now</b> for a team", "has_markup");
    expect(validateLftMessage(42).ok).toBe(false);
    expect(validateLftMessage("a".repeat(600)).ok).toBe(true);
  });
  it("counts characters, not bytes, and strips control and bidi characters", () => {
    expect(validateLftMessage("ह".repeat(600)).ok).toBe(true);
    expect(cleanText("a‮b​c\u0000d")).toBe("a b c d");
  });
  it.each([
    "DM me on insta @rohan_igl", "dm me", "DM   me for scrims", "Message me on discord", "contact me on telegram", "ping me on snap", "add me on steam", "call me anytime",
    "text me after 8", "reach me on whatsapp", "whatsapp me", "msg me", "hit me up on discord", "my id @rohan.igl", "insta: rohan_igl", "Instagram - rohan_igl",
    "discord rohan#1234", "Rohan_IGL#0420 on the server", "telegram: rohan99", "snapchat rohan_igl", "discord is rohan_igl", "mail rohan@gmail",
  ])("rejects outside contact %j", (s) => no(`IGL looking for team. ${s}`, "contact_outside"));
  it.each([
    "I stream on insta sometimes", "My IGN is rohan", "Ace rank, 3 years of scrims", "Scrims @9pm IST every day", "Discord voice required, mic is a must", "Discord: required",
    "I use WhatsApp for my family only", "Our team plays on Telegram groups often", "Looking for a dm player, not a sniper", "Call of Duty Mobile veteran, rank 17", "Add some heart: serious grind",
    "email is not needed here", "Rank #1 in my city last season", "My KD is 4.2 @ ranked",
  ])("accepts ordinary words %j", (s) => ok(`IGL looking for team. ${s}`));
  it("applications stay lenient: a handle is fine, links and phones are not", () => {
    expect(validateApplicationMessage("DM me on insta @rohan_igl").ok).toBe(true);
    expect(validateApplicationMessage("insta.com/rohan").ok).toBe(false);
  });
  it("application message may be empty; contact is a short handle", () => {
    expect(validateApplicationMessage(undefined)).toEqual({ ok: true, text: "" });
    expect(validateApplicationMessage("see me at x.com").ok).toBe(false);
    expect(validateContact("raviigl#1234").ok).toBe(true);
    expect(validateContact("ravi_igl").ok).toBe(true);
    for (const bad of ["x", "http://x.co", "9876543210", "a".repeat(41), "ravi<script>", "ravi.com"]) expect(validateContact(bad).ok, bad).toBe(false);
  });
  it("helpers", () => {
    expect(hasLink("no links here, 5 players, rank 3")).toBe(false);
    expect(hasPhoneNumber("scrims 6 matches, 2 hours, rank 17")).toBe(false);
  });
});

describe("evidence magic bytes", () => {
  it("detects png, jpeg, webp and refuses the rest", () => {
    expect(detectImage(Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe("image/png");
    expect(detectImage(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(detectImage(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]))).toBe("image/webp");
    expect(detectImage(new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"))).toBeNull();
    expect(detectImage(new TextEncoder().encode("GIF89a"))).toBeNull();
    expect(detectImage(new Uint8Array(0))).toBeNull();
    expect(detectImage(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45]))).toBeNull(); // RIFF WAVE
  });
});

describe("state machines", () => {
  it("tournament moves", () => {
    expect(canMove(TOURNAMENT_MOVES, "draft", "published")).toBe(true);
    expect(canMove(TOURNAMENT_MOVES, "draft", "live")).toBe(false);
    expect(canMove(TOURNAMENT_MOVES, "live", "cancelled")).toBe(true);
    expect(canMove(TOURNAMENT_MOVES, "completed", "cancelled")).toBe(false);
    expect(TOURNAMENT_MOVES.cancelled).toEqual([]);
  });
  it("dispute moves: final states are final, escalation leads only on", () => {
    for (const s of ["resolved", "rejected", "withdrawn"] as const) expect(DISPUTE_MOVES[s]).toEqual([]);
    expect(canMove(DISPUTE_MOVES, "open", "resolved")).toBe(false);
    expect(canMove(DISPUTE_MOVES, "under_review", "evidence_requested")).toBe(true);
    expect(canMove(DISPUTE_MOVES, "evidence_requested", "under_review")).toBe(true);
    expect(canMove(DISPUTE_MOVES, "escalated", "resolved")).toBe(true);
    expect(canMove(DISPUTE_MOVES, "escalated", "withdrawn")).toBe(false);
  });
  it("application moves", () => {
    expect(canMove(APPLICATION_MOVES, "sent", "accepted")).toBe(true);
    expect(canMove(APPLICATION_MOVES, "accepted", "declined")).toBe(false);
  });
});

describe("results overlay (the documented correction hook)", () => {
  const m = { matchRef: "match:m1", stage: "main", round: 1, slot: 1, teamA: "A", teamB: "B", status: "finished", scoreA: 5, scoreB: 7, winner: "b", corrected: false };
  it("marks corrected rows, keeps the original, latest correction wins, leaves others alone", () => {
    const out = overlayMatches([m, { ...m, matchRef: "match:m2" }], [
      { match_ref: "match:m1", old_value: "{}", new_value: JSON.stringify({ scoreA: 9, scoreB: 7, winner: "a" }), created_at: 10 },
      { match_ref: "match:m1", old_value: "{}", new_value: JSON.stringify({ scoreA: 10, scoreB: 7, winner: "a" }), created_at: 20 },
    ]);
    expect(out[0]).toMatchObject({ scoreA: 10, scoreB: 7, winner: "a", corrected: true, original: { scoreA: 5, scoreB: 7, winner: "b" } });
    expect(out[1]).toEqual({ ...m, matchRef: "match:m2" });
  });
  it("battle royale rows and bad JSON", () => {
    const r = { matchRef: "br:1:T", matchNo: 1, team: "T", placement: 2, kills: 5, corrected: false };
    expect(overlayBr([r], [{ match_ref: "br:1:T", old_value: "{}", new_value: JSON.stringify({ placement: 1, kills: 6 }), created_at: 1 }])[0]).toMatchObject({ placement: 1, kills: 6, corrected: true, original: { placement: 2, kills: 5 } });
    expect(overlayBr([r], [{ match_ref: "br:1:T", old_value: "{}", new_value: "not json", created_at: 1 }])[0]).toEqual(r);
  });
});
