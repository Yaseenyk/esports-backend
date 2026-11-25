import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/index";
import { setMailerForTests, type Mail } from "../../src/mailer";
import { ALERTS, buildDigestMail, checkRules, inDigestWindow } from "../../src/v3/lib/alerts";
import { purgeAlerts, runDigestTick } from "../../src/v3/services/alert-service";
import { uniq } from "../helpers";
import { api, db, flagsOn, nowSec, tournament, user, type U } from "./helpers";

vi.setConfig({ testTimeout: 120_000 });
type Sent = Mail & { headers?: Record<string, string> };
let sent: Sent[] = [];
beforeEach(() => {
  sent = [];
  setMailerForTests({ async send(m) { sent.push(m as Sent); } });
});
afterEach(() => setMailerForTests(null));

const on = (...extra: string[]) => flagsOn(...(["v3.alerts", "v3.tournaments", ...extra] as never[]));
const city = () => `Alertcity${uniq().replace(/[0-9]/g, "x")}`;
const fragToken = (text: string, path: string) => new RegExp(`${path}/#t=([A-Za-z0-9_-]{32})`).exec(text)?.[1] ?? "";
const today = () => new Date().toISOString().slice(0, 10);
const resetBudget = () => db.batch([db.prepare("DELETE FROM alert_day_budget"), db.prepare("DELETE FROM mail_budget")]);

async function subscribed(rules: Record<string, unknown>[]): Promise<U> {
  const u = await user("Alerted");
  expect((await api("/v3/me/alerts", { method: "PUT", token: u.token, body: { rules } })).status).toBe(200);
  const r = await api("/v3/me/alerts/confirm-email", { token: u.token, body: {} });
  expect(r.status, r.text).toBe(200);
  const mail = sent.pop()!;
  expect(mail.to).toBe(u.email);
  const token = fragToken(mail.text, "/alerts/confirm");
  expect((await api("/public/alerts/confirm", { body: { token } })).json).toEqual({ ok: true, status: "active" });
  return u;
}
const tick = () => runDigestTick(env, { force: true });

describe("alerts: pure rules", () => {
  it("checks rules and builds an email with a plain-text part and the unsubscribe footer", () => {
    expect(checkRules([{ game: "bgmi", place: "Pune", kind: "tournament" }])).toEqual({ ok: true, rules: [{ game: "bgmi", place: "pune", kind: "tournament" }] });
    expect(checkRules([{}, {}]).ok && (checkRules([{}, {}]) as { rules: unknown[] }).rules.length).toBe(1);
    expect(checkRules(Array.from({ length: 6 }, (_, i) => ({ place: `City${"x".repeat(i)}` })))).toEqual({ ok: false, code: "too_many_rules" });
    expect(checkRules([{ game: "chess" }])).toEqual({ ok: false, code: "invalid_game" });
    expect(checkRules([{ place: "<script>" }])).toEqual({ ok: false, code: "invalid_place" });
    const m = buildDigestMail([{ key: "t:1", kind: "tournament", title: "Cup <b>", game: "bgmi", where: "Pune", when: "Sat 20 Dec", link: "https://x/t", status: "registration_open" }], "https://x/u", "https://x/s");
    expect(m.text).toContain("Unsubscribe in one click: https://x/u");
    expect(m.html).toContain("Cup &lt;b&gt;");
    expect(m.html).not.toContain("<b>");
    expect(m.subject).toBe("Registration open: Cup <b>");
    expect(inDigestWindow(Date.UTC(2026, 10, 25, 3, 5))).toBe(false); // housekeeping tick
    expect(inDigestWindow(Date.UTC(2026, 10, 25, 4, 0))).toBe(true);
    expect(inDigestWindow(Date.UTC(2026, 10, 25, 12, 0))).toBe(false);
  });
});

describe("alerts: flag off", () => {
  it("every alert route is the unknown-route 404, and the digest sends nothing", async () => {
    await flagsOn();
    const u = await user();
    const unknown = await api("/v3/definitely-not-a-route");
    const routes = [...new Map(app.routes.filter((r) => r.method !== "ALL" && /^\/(v3\/me\/alerts|public\/alerts)/.test(r.path)).map((r) => [`${r.method} ${r.path}`, r])).values()];
    expect(routes.length).toBe(8);
    for (const r of routes) for (const token of [undefined, u.token]) {
      const res = await api(r.path.replace(/:[A-Za-z]+/g, "x1"), { method: r.method, token, body: r.method === "GET" || r.method === "DELETE" ? undefined : {} });
      expect(res.status, r.path).toBe(404);
      expect(res.json).toEqual(unknown.json);
    }
    expect((await tick()).reason).toBe("flag");
  });
});

describe("alerts: settings and double opt-in", () => {
  it("needs sign-in and 18+, and keeps settings private to the account", async () => {
    await on();
    expect((await api("/v3/me/alerts")).status).toBe(401);
    const minor = await user("Young", false);
    const r = await api("/v3/me/alerts", { method: "PUT", token: minor.token, body: { rules: [{ game: "bgmi" }] } });
    expect([r.status, r.json.code]).toEqual([403, "adult_required"]);
    const a = await user("A"), b = await user("B");
    await api("/v3/me/alerts", { method: "PUT", token: a.token, body: { rules: [{ game: "valorant", place: "online" }] } });
    expect((await api("/v3/me/alerts", { token: b.token })).json.rules).toEqual([]);
    const mine = await api("/v3/me/alerts", { token: a.token });
    expect(mine.json).toMatchObject({ status: "off", rules: [{ game: "valorant", place: "online", kind: "any" }] });
    expect(mine.json.email).toMatch(/^.\*\*\*@example\.com$/);
    expect(mine.headers.get("cache-control")).toBe("no-store");
  });

  it("sends the confirm email to the ACCOUNT address only, and nothing is sent before the click", async () => {
    await on();
    await resetBudget();
    const u = await user();
    expect((await api("/v3/me/alerts/confirm-email", { token: u.token, body: {} })).json.code).toBe("no_rules");
    await api("/v3/me/alerts", { method: "PUT", token: u.token, body: { rules: [{ game: "bgmi" }] } });
    const r = await api("/v3/me/alerts/confirm-email", { token: u.token, body: { email: "attacker@evil.test" } });
    expect(r.json.status).toBe("pending");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(u.email);
    expect(sent[0]!.text.length).toBeGreaterThan(50);
    const tok = fragToken(sent[0]!.text, "/alerts/confirm");
    expect(tok).toHaveLength(32);
    // pending is never emailed by the digest
    const t = await tournament({ city: "Pune" }, "published");
    expect(t.slug).toBeTruthy();
    sent = [];
    await tick();
    expect(sent.filter((m) => m.to === u.email)).toHaveLength(0);
    // the token is stored only as a hash
    const row = await db.prepare("SELECT * FROM alert_subscriptions WHERE user_id = ?1").bind(u.id).first<Record<string, unknown>>();
    expect(JSON.stringify(row)).not.toContain(tok);
  });

  it("a wrong, reused or expired confirm token is the same 404", async () => {
    await on();
    await resetBudget();
    const u = await user();
    await api("/v3/me/alerts", { method: "PUT", token: u.token, body: { rules: [{ game: "bgmi" }] } });
    await api("/v3/me/alerts/confirm-email", { token: u.token, body: {} });
    const token = fragToken(sent[0]!.text, "/alerts/confirm");
    for (const bad of ["A".repeat(32), "short", 42, undefined]) expect((await api("/public/alerts/confirm", { body: { token: bad } })).json).toEqual({ error: "Not found" });
    expect((await api("/public/alerts/confirm", { body: { token } })).status).toBe(200);
    expect((await api("/public/alerts/confirm", { body: { token } })).status).toBe(404); // used
    await api("/v3/me/alerts/stop", { token: u.token, body: {} });
    await api("/v3/me/alerts/confirm-email", { token: u.token, body: {} });
    const t2 = fragToken(sent[sent.length - 1]!.text, "/alerts/confirm");
    await db.prepare("UPDATE alert_subscriptions SET confirm_expires_at = ?1 WHERE user_id = ?2").bind(nowSec() - 1, u.id).run();
    expect((await api("/public/alerts/confirm", { body: { token: t2 } })).status).toBe(404); // expired
    expect((await api("/v3/me/alerts", { token: u.token })).json.status).toBe("expired");
  });

  it("limits confirm emails to 3 a day per account", async () => {
    await on();
    await resetBudget();
    const u = await user();
    await api("/v3/me/alerts", { method: "PUT", token: u.token, body: { rules: [{ game: "bgmi" }] } });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) {
      await db.prepare("UPDATE alert_subscriptions SET status = 'pending' WHERE user_id = ?1").bind(u.id).run();
      codes.push((await api("/v3/me/alerts/confirm-email", { token: u.token, body: {} })).status);
    }
    expect(codes).toEqual([200, 200, 200, 429]);
  });

  it("honours kill.mail", async () => {
    await on("kill.mail");
    const u = await user();
    await api("/v3/me/alerts", { method: "PUT", token: u.token, body: { rules: [{ game: "bgmi" }] } });
    expect((await api("/v3/me/alerts/confirm-email", { token: u.token, body: {} })).status).toBe(503);
    expect((await tick()).reason).toBe("kill");
    await db.prepare("DELETE FROM flags WHERE key = 'kill.mail'").run();
  });
});

describe("alerts: the daily digest", () => {
  it("sends ONE email a day listing new matching tournaments, never the same one twice, with a one-click unsubscribe", async () => {
    await on();
    await resetBudget();
    const c = city();
    const u = await subscribed([{ game: "bgmi", place: c, kind: "tournament" }]);
    const t1 = await tournament({ city: c, title: `Match One ${uniq()}` }, "published");
    const t2 = await tournament({ city: c, title: `Match Two ${uniq()}` }, "registration_open");
    await tournament({ city: c, game: "valorant", format: "single_elimination", title: `Other game ${uniq()}` }, "published");
    await tournament({ city: "Elsewhere", title: `Other city ${uniq()}` }, "published");
    await tournament({ city: c, title: `Draft ${uniq()}` }); // draft: never
    sent = [];
    const r = await tick();
    expect(r.ran).toBe(true);
    const mine = sent.filter((m) => m.to === u.email);
    expect(mine).toHaveLength(1);
    const m = mine[0]!;
    expect(m.text).toContain("Match One");
    expect(m.text).toContain("Match Two");
    expect(m.text).not.toMatch(/Other game|Other city|Draft/);
    expect(m.text).toContain("Unsubscribe in one click");
    expect(m.headers?.["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(m.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/.+\/public\/alerts\/one-click\/[A-Za-z0-9_-]{32}>$/);
    expect(m.text).not.toMatch(/secret-contact|organiser@|@example\.com/);
    expect(t1.slug && t2.slug).toBeTruthy();
    // the same day: no second email, even with a new match
    await tournament({ city: c, title: `Match Three ${uniq()}` }, "published");
    sent = [];
    await tick();
    expect(sent.filter((x) => x.to === u.email)).toHaveLength(0);
    // the next day: only the new one
    await db.prepare("UPDATE alert_subscriptions SET last_digest_day = '2000-01-01' WHERE user_id = ?1").bind(u.id).run();
    await tick();
    const next = sent.filter((x) => x.to === u.email);
    expect(next).toHaveLength(1);
    expect(next[0]!.text).toContain("Match Three");
    expect(next[0]!.text).not.toContain("Match One");
    // one-click unsubscribe from the email link (no sign-in), then nothing more
    const token = fragToken(next[0]!.text, "/alerts/unsubscribe");
    expect((await api("/public/alerts/unsubscribe", { body: { token } })).json).toEqual({ ok: true, status: "stopped" });
    expect((await api("/public/alerts/unsubscribe", { body: { token } })).status).toBe(200); // a second click still works
    expect((await api("/public/alerts/unsubscribe", { body: { token: "B".repeat(32) } })).status).toBe(404);
    await tournament({ city: c, title: `Match Four ${uniq()}` }, "published");
    await db.prepare("UPDATE alert_subscriptions SET last_digest_day = '2000-01-01' WHERE user_id = ?1").bind(u.id).run();
    sent = [];
    await tick();
    expect(sent.filter((x) => x.to === u.email)).toHaveLength(0);
  });

  it("the RFC 8058 one-click address unsubscribes too", async () => {
    await on();
    await resetBudget();
    const c = city();
    const u = await subscribed([{ place: c }]);
    await tournament({ city: c }, "published");
    sent = [];
    await tick();
    const header = sent.find((x) => x.to === u.email)!.headers!["List-Unsubscribe"]!;
    const token = /one-click\/([A-Za-z0-9_-]{32})>/.exec(header)![1]!;
    const r = await api(`/public/alerts/one-click/${token}`, { raw: "List-Unsubscribe=One-Click", headers: { "content-type": "application/x-www-form-urlencoded" } });
    expect(r.json).toEqual({ ok: true, status: "stopped" });
  });

  it("stops at the global daily cap, logs once and never sends past it", async () => {
    await on();
    await resetBudget();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const c = city();
    const a = await subscribed([{ place: c }]);
    const b = await subscribed([{ place: c }]);
    await tournament({ city: c }, "published");
    await db.prepare("INSERT INTO alert_day_budget (day, sent) VALUES (?1, ?2) ON CONFLICT (day) DO UPDATE SET sent = ?2").bind(today(), ALERTS.DAY_CAP).run();
    sent = [];
    const r = await tick();
    expect(r.capped).toBe(true);
    expect(sent.filter((x) => x.to === a.email || x.to === b.email)).toHaveLength(0);
    expect((await tick()).reason).toBe("capped");
    expect(warn.mock.calls.filter((x) => String(x[0]).includes("daily email cap"))).toHaveLength(1);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/@example\.com/);
    warn.mockRestore();
  });

  it("a provider failure refunds the budget and the items are tried again later", async () => {
    await on();
    await resetBudget();
    const c = city();
    const u = await subscribed([{ place: c }]);
    await tournament({ city: c, title: `Retry ${uniq()}` }, "published");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const before = (await db.prepare("SELECT sent FROM alert_day_budget WHERE day = ?1").bind(today()).first<{ sent: number }>())?.sent ?? 0;
    setMailerForTests({ async send() { throw new Error("boom"); } });
    await tick();
    expect((await db.prepare("SELECT COUNT(*) AS n FROM alert_sent_items WHERE user_id = ?1").bind(u.id).first<{ n: number }>())!.n).toBe(0);
    expect((await db.prepare("SELECT sent FROM alert_day_budget WHERE day = ?1").bind(today()).first<{ sent: number }>())?.sent ?? 0).toBe(before);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/@example\.com|boom/);
    warn.mockRestore();
  });

  it("delete my alerts removes every row; account deletion cascades; purge drops stale rows", async () => {
    await on();
    await resetBudget();
    const u = await subscribed([{ game: "bgmi" }]);
    expect((await api("/v3/me/alerts", { method: "DELETE", token: u.token })).json).toEqual({ ok: true, deleted: true });
    for (const t of ["alert_subscriptions", "alert_rules", "alert_sent_items"]) {
      expect((await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE user_id = ?1`).bind(u.id).first<{ n: number }>())!.n, t).toBe(0);
    }
    await purgeAlerts(db);
  });
});
