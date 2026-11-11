import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMailerForTests, type Mail } from "../src/mailer";
import { DAY_LIMIT, EVENT_DAY_LIMIT, REMINDER_DAY_LIMIT, syncRecipients, buildReminderMail, dayOf, maskEmail, processDueJobs } from "../src/features/reminders";
import { call, newEvent, newUser, uniq } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });

type Sent = Mail & { headers?: Record<string, string> };
let sent: Sent[] = [];
beforeEach(() => {
  sent = [];
  setMailerForTests({ async send(m) { sent.push(m as Sent); } });
});
afterEach(() => setMailerForTests(null));

const players = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `Player ${i + 1}`, ign: `I${i}`, minor: false }));

async function setup() {
  const u = await newUser();
  const ev = await newEvent(u.token, "Spring Cup");
  const form = await call(`/events/${ev.id}/registration`, { method: "PUT", token: u.token, body: { title: "Spring", teamSize: 4, subs: 0, maxTeams: 100 } });
  return { u, ev, token: form.json.token as string };
}
const register = (token: string, name: string, extra: Record<string, unknown> = {}) =>
  call(`/public/registration/${token}/submit`, { body: { teamName: name, captainName: "Asha Captain", captainContact: "9999900000", players: players(4), notes: "", ...extra } });
const addCaptain = async (token: string, name: string, email: string) => (await register(token, name, { captainEmail: email, emailConsent: true })).status;
const schedule = (s: { u: { token: string }; ev: { id: string } }, body: Record<string, unknown> = {}) =>
  call(`/events/${s.ev.id}/reminders`, { token: s.u.token, body: { kind: "custom", subject: "Hello team", body: "Doors open at 9.\n\nBring your ID.", ...body } });
const unsubToken = (m: Sent) => /unsubscribe\/\?t=([A-Za-z0-9_-]{32})/.exec(m.text)![1]!;
const jobs = async (s: { u: { token: string }; ev: { id: string } }) => (await call(`/events/${s.ev.id}/reminders`, { token: s.u.token })).json;

describe("registration consent", () => {
  it("stores an address only with consent and records the wording and time", async () => {
    const s = await setup();
    expect((await register(s.token, "NoEmail")).status).toBe(201);
    expect((await register(s.token, "NoTick", { captainEmail: "a@example.com" })).status).toBe(400);
    expect((await register(s.token, "TickOnly", { emailConsent: true })).status).toBe(400);
    expect((await register(s.token, "BadMail", { captainEmail: "nope", emailConsent: true })).status).toBe(400);
    expect((await register(s.token, "Good", { captainEmail: "Asha@Example.com", emailConsent: true, emailConsentText: "I agree to emails" })).status).toBe(201);
    const row = await env.DB.prepare("SELECT captain_email, email_consent_text, email_consent_at FROM registrations WHERE team_name = 'Good'").first<{ captain_email: string; email_consent_text: string; email_consent_at: string }>();
    expect(row).toMatchObject({ captain_email: "asha@example.com", email_consent_text: "I agree to emails" });
    expect(Number.isNaN(Date.parse(row!.email_consent_at))).toBe(false);
    const none = await env.DB.prepare("SELECT captain_email, email_consent_at FROM registrations WHERE team_name = 'NoEmail'").first<{ captain_email: string | null; email_consent_at: string | null }>();
    expect(none).toEqual({ captain_email: null, email_consent_at: null });
  });
});

describe("recipients", () => {
  it("counts only consenting captains and organisers, masks emails, and hides the list from viewers", async () => {
    const s = await setup();
    await register(s.token, "Silent");
    expect(await addCaptain(s.token, "Kings", "kings.captain@gmail.com")).toBe(201);
    const v = await newUser();
    await call(`/events/${s.ev.id}/members`, { token: s.u.token, body: { email: v.email, role: "viewer" } });
    const r = await call(`/events/${s.ev.id}/reminders/recipients`, { token: s.u.token });
    expect(r.status).toBe(200);
    expect(r.json.captains.count).toBe(1);
    expect(r.json.organisers.count).toBe(1); // the viewer is not an organiser recipient
    expect(r.json.items.map((i: { email: string }) => i.email)).toContain("k***@gmail.com");
    expect(r.text).not.toContain("kings.captain@gmail.com");
    const vr = await call(`/events/${s.ev.id}/reminders/recipients`, { token: v.token });
    expect(vr.status).toBe(200);
    expect(vr.json.captains.count).toBe(1);
    expect(vr.json.items).toBeUndefined();
    expect(vr.text).not.toContain("@gmail.com");
    expect((await call(`/events/${s.ev.id}/reminders`, { token: v.token })).status).toBe(403);
  });
  it("masks addresses", () => {
    expect(maskEmail("abc@gmail.com")).toBe("a***@gmail.com");
    expect(maskEmail("weird")).toBe("***");
  });
});

describe("scheduling", () => {
  it("validates, schedules, lists and cancels", async () => {
    const s = await setup();
    expect((await schedule(s, { kind: "nope" })).status).toBe(400);
    expect((await schedule(s, { subject: "x" })).status).toBe(400);
    expect((await schedule(s, { body: "see https://evil.example" })).status).toBe(400);
    expect((await schedule(s, { sendAt: "2020-01-01T00:00:00Z" })).status).toBe(400);
    expect((await schedule(s, { audience: "captain" })).status).toBe(400); // no consenting captain yet
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const made = await schedule(s, { sendAt: future, audience: "organiser" });
    expect(made.status).toBe(201);
    expect(made.json).toMatchObject({ status: "pending", recipientsSnapshotCount: 1, audience: "organiser" });
    const list = await jobs(s);
    expect(list.jobs).toHaveLength(1);
    expect(list.limits).toMatchObject({ dayLimit: REMINDER_DAY_LIMIT, eventDayLimit: EVENT_DAY_LIMIT });
    expect((await call(`/events/${s.ev.id}/reminders/${made.json.id}`, { method: "DELETE", token: s.u.token })).status).toBe(200);
    expect((await call(`/events/${s.ev.id}/reminders/${made.json.id}`, { method: "DELETE", token: s.u.token })).status).toBe(200);
    expect((await call(`/events/${s.ev.id}/reminders/nope`, { method: "DELETE", token: s.u.token })).status).toBe(404);
    expect((await jobs(s)).jobs[0].status).toBe("cancelled");
    expect(sent).toHaveLength(0);
  });
  it("a future job waits and a cancelled job is never sent", async () => {
    const s = await setup();
    const a = await schedule(s, { sendAt: new Date(Date.now() + 3600_000).toISOString() });
    await processDueJobs(env, { eventId: s.ev.id });
    expect(sent).toHaveLength(0);
    await call(`/events/${s.ev.id}/reminders/${a.json.id}`, { method: "DELETE", token: s.u.token });
    await processDueJobs(env, { eventId: s.ev.id, now: new Date(Date.now() + 7200_000) });
    expect(sent).toHaveLength(0);
  });
});

describe("sending", () => {
  it("sends once to organisers and consenting captains, with footer and List-Unsubscribe, and never twice", async () => {
    const s = await setup();
    await addCaptain(s.token, "Kings", "kings@example.com");
    await register(s.token, "Silent"); // no email: gets nothing
    const made = await schedule(s, { body: "Bring <b>ID</b> & water." });
    expect(made.status).toBe(201);
    expect(made.json.recipientsSnapshotCount).toBe(2);
    const r1 = await processDueJobs(env, { eventId: s.ev.id });
    expect(r1.attempted).toBe(2);
    expect(sent).toHaveLength(2);
    expect(sent.map((m) => m.to).sort()).toEqual(["kings@example.com", s.u.email].sort());
    for (const m of sent) {
      expect(m.subject).toBe("Hello team");
      expect(m.text).toContain("Unsubscribe from this event: https://esports.streamerosai.com/unsubscribe/?t=");
      expect(m.html).toContain("Bring &lt;b&gt;ID&lt;/b&gt; &amp; water.");
      expect(m.html).not.toContain("<b>");
      expect(m.html).not.toMatch(/<img/i);
      expect(m.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/esports\.streamerosai\.com\/unsubscribe\/\?t=/);
      expect([...m.html.matchAll(/href="([^"]+)"/g)].every((x) => x[1]!.startsWith("https://esports.streamerosai.com/unsubscribe/"))).toBe(true);
    }
    await processDueJobs(env, { eventId: s.ev.id });
    await Promise.all([processDueJobs(env, { eventId: s.ev.id }), processDueJobs(env, { eventId: s.ev.id })]);
    expect(sent).toHaveLength(2);
    const job = (await jobs(s)).jobs[0];
    expect(job).toMatchObject({ status: "sent", sentCount: 2 });
    expect(job.note).toContain("Sent to 2 people");
  });

  it("concurrent runners never double send", async () => {
    const s = await setup();
    for (let i = 0; i < 5; i++) await addCaptain(s.token, `Team ${i}`, `c${i}-${uniq()}@example.com`);
    await schedule(s);
    await Promise.all([processDueJobs(env, { eventId: s.ev.id, batch: 20 }), processDueJobs(env, { eventId: s.ev.id, batch: 20 })]);
    const tos = sent.map((m) => m.to);
    expect(new Set(tos).size).toBe(tos.length);
    expect(tos).toHaveLength(6);
  });

  it("goes out in small batches across runs", async () => {
    const s = await setup();
    for (let i = 0; i < 4; i++) await addCaptain(s.token, `Team ${i}`, `b${i}-${uniq()}@example.com`);
    await schedule(s);
    expect((await processDueJobs(env, { eventId: s.ev.id, batch: 2 })).attempted).toBe(2);
    expect((await jobs(s)).jobs[0].status).toBe("sending");
    await processDueJobs(env, { eventId: s.ev.id, batch: 2 });
    await processDueJobs(env, { eventId: s.ev.id, batch: 2 });
    expect(sent).toHaveLength(5);
    expect((await jobs(s)).jobs[0].status).toBe("sent");
  });

  it("stops at the daily budget, says so, and carries on when the budget is back", async () => {
    const s = await setup();
    for (let i = 0; i < 3; i++) await addCaptain(s.token, `Team ${i}`, `d${i}-${uniq()}@example.com`);
    await schedule(s);
    await env.DB.prepare("INSERT INTO mail_budget (day, sent) VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET sent = excluded.sent").bind(dayOf(), REMINDER_DAY_LIMIT - 2).run();
    await processDueJobs(env, { eventId: s.ev.id });
    expect(sent).toHaveLength(2);
    const j = await jobs(s);
    expect(j.jobs[0].status).toBe("sending");
    expect(j.jobs[0].note).toContain("daily email limit");
    expect(j.limits.sentToday).toBe(REMINDER_DAY_LIMIT);
    expect(j.limits.remainingToday).toBe(0);
    await processDueJobs(env, { eventId: s.ev.id });
    expect(sent).toHaveLength(2); // nothing more today
    await env.DB.prepare("UPDATE mail_budget SET sent = 0 WHERE day = ?").bind(dayOf()).run(); // what midnight UTC does
    await processDueJobs(env, { eventId: s.ev.id });
    expect(sent).toHaveLength(4);
    expect((await jobs(s)).jobs[0].status).toBe("sent");
  });

  it("a reminder that would reach more people than one event may email a day is refused", async () => {
    const s = await setup();
    for (let i = 0; i < EVENT_DAY_LIMIT; i++) {
      await env.DB.prepare("INSERT INTO registrations (id, event_id, team_name, captain_name, captain_contact, players, notes, status, created_at, captain_email, email_consent_text, email_consent_at) VALUES (?, ?, ?, 'c', '12345', '[]', '', 'pending', ?, ?, 't', ?)")
        .bind(crypto.randomUUID(), s.ev.id, `T${i}`, new Date().toISOString(), `e${i}@example.com`, new Date().toISOString()).run();
    }
    const r = await schedule(s);
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("at most");
  });

  it("a provider failure is recorded, not retried, and leaks nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setMailerForTests({ async send() { throw new Error("boom secret-detail"); } });
    const s = await setup();
    await schedule(s);
    await processDueJobs(env, { eventId: s.ev.id });
    expect((await jobs(s)).jobs[0].status).toBe("failed");
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/secret-detail|@example\.com|Doors open/);
    warn.mockRestore();
  });

  it("does nothing, and loses nothing, when no mailer is configured", async () => {
    const s = await setup();
    await schedule(s);
    setMailerForTests(null);
    expect((await processDueJobs(env, { eventId: s.ev.id })).skipped).toBe("no_mailer");
    expect((await jobs(s)).jobs[0].status).toBe("pending");
  });
});

describe("unsubscribe", () => {
  it("is one tap, idempotent, per event, and stops further emails", async () => {
    const s = await setup();
    await addCaptain(s.token, "Kings", "kings@example.com");
    await schedule(s);
    await processDueJobs(env, { eventId: s.ev.id });
    const mail = sent.find((m) => m.to === "kings@example.com")!;
    const t = unsubToken(mail);
    const peek = await call(`/public/unsubscribe/${t}`);
    expect(peek.status).toBe(200);
    expect(peek.json).toEqual({ event: "Spring Cup", email: "k***@example.com", unsubscribed: false }); // a GET changes nothing
    const a = await call(`/public/unsubscribe/${t}`, { method: "POST" });
    const b = await call(`/public/unsubscribe/${t}`, { method: "POST" });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.json.unsubscribed).toBe(true);
    expect((await call(`/public/unsubscribe/${t}`)).json.unsubscribed).toBe(true);
    sent = [];
    await schedule(s);
    await processDueJobs(env, { eventId: s.ev.id });
    expect(sent.map((m) => m.to)).toEqual([s.u.email]);
    const rec = await call(`/events/${s.ev.id}/reminders/recipients`, { token: s.u.token });
    expect(rec.json.captains).toEqual({ count: 0, unsubscribed: 1 });
    expect((await call("/public/unsubscribe/short")).status).toBe(404);
    expect((await call(`/public/unsubscribe/${"A".repeat(32)}`, { method: "POST" })).status).toBe(404);
  });

  it("is rate limited", async () => {
    const ip = "10.9.9.9";
    let last = 0;
    for (let i = 0; i < 25; i++) last = (await call(`/public/unsubscribe/${"B".repeat(32)}`, { method: "POST", ip })).status;
    expect(last).toBe(429);
  });

  it("the token is stored only as a hash", async () => {
    const s = await setup();
    await schedule(s);
    await processDueJobs(env, { eventId: s.ev.id });
    const t = unsubToken(sent[0]!);
    expect(JSON.stringify((await env.DB.prepare("SELECT * FROM reminder_recipients").all()).results)).not.toContain(t);
  });
});

describe("mail pool reserve and key split (S6, S10)", () => {
  it("reminders stop 10 short of the daily pool", () => {
    expect(DAY_LIMIT).toBe(90);
    expect(REMINDER_DAY_LIMIT).toBe(80);
  });

  it("rotating JWT_SECRET: a link mailed before the split still opens, and the next mail to that person carries a working one", async () => {
    const s = await setup();
    await addCaptain(s.token, "Kings", "kings@example.com");
    await syncRecipients(env, s.ev.id); // stored hash comes from the JWT_SECRET-keyed token (before the split)
    await schedule(s);
    await processDueJobs(env, { eventId: s.ev.id });
    const old = unsubToken(sent.find((m) => m.to === "kings@example.com")!);
    const rotated = { ...env, JWT_SECRET: "rotated-secret-rotated-secret-rotated", HASH_KEY: "hash-key-one-hash-key-one-hash-key-one" };
    // Lookup is by stored hash, so the 30-day-old link opens whatever the secrets are now.
    expect((await call(`/public/unsubscribe/${old}`)).status).toBe(200);
    sent = [];
    await schedule(s);
    await processDueJobs(rotated, { eventId: s.ev.id });
    const fresh = unsubToken(sent.find((m) => m.to === "kings@example.com")!);
    expect((await call(`/public/unsubscribe/${fresh}`)).status).toBe(200);
  });

  it("a recipient created under HASH_KEY keeps its link when JWT_SECRET changes", async () => {
    const s = await setup();
    await addCaptain(s.token, "Rooks", "rooks@example.com");
    const e1 = { ...env, HASH_KEY: "hash-key-two-hash-key-two-hash-key-two" };
    await syncRecipients(e1, s.ev.id);
    await schedule(s);
    await processDueJobs(e1, { eventId: s.ev.id });
    const link = unsubToken(sent.find((m) => m.to === "rooks@example.com")!);
    expect((await call(`/public/unsubscribe/${link}`)).status).toBe(200);
    sent = [];
    await schedule(s);
    await processDueJobs({ ...e1, JWT_SECRET: "another-secret-another-secret-another" }, { eventId: s.ev.id });
    expect(unsubToken(sent.find((m) => m.to === "rooks@example.com")!)).toBe(link);
  });
});

describe("test email and permissions", () => {
  it("sends a test only to the signed-in organiser, marked as a test, and counts toward the budget", async () => {
    const s = await setup();
    const before = (await jobs(s)).limits.sentToday;
    const r = await call(`/events/${s.ev.id}/reminders/test`, { token: s.u.token, body: { subject: "Hello", body: "Plain body" } });
    expect(r.status).toBe(200);
    expect(r.json.sentTo).toMatch(/\*\*\*@example\.com$/);
    expect(r.text).not.toContain(s.u.email);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(s.u.email);
    expect(sent[0]!.subject).toBe("[Test] Hello");
    expect((await jobs(s)).limits.sentToday).toBe(before + 1);
  });
  it("only owners and editors; strangers get 404; viewers cannot write; no sign-in is 401", async () => {
    const s = await setup();
    const stranger = await newUser();
    const viewer = await newUser();
    await call(`/events/${s.ev.id}/members`, { token: s.u.token, body: { email: viewer.email, role: "viewer" } });
    expect((await call(`/events/${s.ev.id}/reminders`, { token: stranger.token })).status).toBe(404);
    expect((await schedule({ u: viewer, ev: s.ev })).status).toBe(403);
    expect((await call(`/events/${s.ev.id}/reminders/test`, { token: viewer.token, method: "POST" })).status).toBe(403);
    expect((await call(`/events/${s.ev.id}/reminders`)).status).toBe(401);
  });
  it("no leak: lists and public responses never contain full addresses of others", async () => {
    const s = await setup();
    await addCaptain(s.token, "Kings", "secret.captain@example.com");
    await schedule(s);
    await processDueJobs(env, { eventId: s.ev.id });
    const t = unsubToken(sent.find((m) => m.to === "secret.captain@example.com")!);
    const all = [await call(`/events/${s.ev.id}/reminders`, { token: s.u.token }), await call(`/events/${s.ev.id}/reminders/recipients`, { token: s.u.token }), await call(`/public/unsubscribe/${t}`), await call(`/public/registration/${s.token}`)];
    for (const r of all) expect(r.text).not.toContain("secret.captain@example.com");
  });
});

describe("mail building", () => {
  it("escapes html, strips newlines from the subject and adds only our link", () => {
    const m = buildReminderMail("Hi\r\nBcc: x@y.z", "<script>alert(1)</script>\n\nSecond", "Cup & Co", "https://esports.streamerosai.com/unsubscribe/?t=abc");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("Cup &amp; Co");
    expect(m.html.match(/<a /g)).toHaveLength(1);
    expect(m.text).toContain("Unsubscribe from this event: https://esports.streamerosai.com/unsubscribe/?t=abc");
  });
});
