import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { call, freshIp, newUser, setupEvent, uniq } from "../helpers";
import { api, auditRows, makeStaff } from "./helpers";

vi.setConfig({ testTimeout: 180_000 });

const db = env.DB;
const now = () => new Date().toISOString();
const slug12 = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => "abcdefghijklmnopqrstuvwxyz234567"[b & 31]).join("");

async function liveEvent() {
  const o = await setupEvent("Admin Mod Cup");
  const slug = slug12();
  await db.prepare("INSERT INTO live_pages (event_id, slug, published, snapshot, updated_at) VALUES (?, ?, 1, '{}', ?)").bind(o.ev.id, slug, now()).run();
  return { ...o, slug };
}
const fileReport = (slug: string, reason = "spam") => call("/public/report", { body: { kind: "live", key: slug, reason }, ip: freshIp() });

describe("staff report queue and decisions (/admin/v1/reports)", () => {
  it("lists a filed report as { items, next }, decides it (hide, then restore) and writes the audit rows", async () => {
    const s = await makeStaff();
    const token = (await s.login()).token;
    const l = await liveEvent();
    expect((await fileReport(l.slug)).status).toBe(202);

    const list = await api("/admin/v1/reports", { token });
    expect(list.status).toBe(200);
    expect(Object.keys(list.json).sort()).toEqual(["items", "next"]);
    const item = (list.json.items as any[]).find((i) => i.targetId === l.ev.id);
    expect(item).toMatchObject({ source: "report", targetType: "live_page", reasonCode: "spam", status: "open" });
    expect(JSON.stringify(item)).not.toMatch(/"reporter"/i);

    const noReason = await api(`/admin/v1/reports/${item.id}/decide`, { token, body: { decision: "hide" } });
    expect(noReason.status).toBe(400);
    expect(noReason.json.code).toBe("reason_required");
    expect((await api(`/admin/v1/reports/${item.id}/decide`, { token, body: { decision: "nuke", reasonCode: "spam" } })).status).toBe(400);

    // `takedown` is an alias of `hide`; no step-up needed (reversible)
    const hid = await api(`/admin/v1/reports/${item.id}/decide`, { token, body: { source: item.source, decision: "takedown", reasonCode: "spam" } });
    expect(hid.status).toBe(200);
    expect(hid.json).toMatchObject({ ok: true, decision: "hide", changed: true });
    expect((await auditRows("takedown.hidden", l.ev.id)).length).toBe(1);
    expect((await auditRows("report.decided", l.ev.id)).length).toBe(1);

    const td = await api("/admin/v1/takedowns", { token });
    expect(td.status).toBe(200);
    expect((td.json.items as any[]).some((t) => t.targetType === "live_page" && t.targetId === l.ev.id)).toBe(true);

    const lifted = await api(`/admin/v1/takedowns/live_page/${l.ev.id}/restore`, { token, body: { reasonCode: "other" } });
    expect(lifted.status).toBe(200);
    expect(lifted.json).toMatchObject({ ok: true, state: "restored", changed: true });
    expect((await auditRows("takedown.restored", l.ev.id)).length).toBe(1);
    expect((await api(`/admin/v1/takedowns/live_page/${l.ev.id}/restore`, { token, body: { reasonCode: "other" } })).status).toBe(409);
    const after = await api("/admin/v1/takedowns", { token });
    expect((after.json.items as any[]).some((t) => t.targetId === l.ev.id)).toBe(false);
  });

  it("a new takedown names a real target, derives the event itself, and is idempotent", async () => {
    const s = await makeStaff();
    const token = (await s.login()).token;
    const l = await liveEvent();
    expect((await api("/admin/v1/takedowns", { token, body: { targetType: "live_page", targetId: `nope${uniq()}`, reasonCode: "scam" } })).status).toBe(404);
    expect((await api("/admin/v1/takedowns", { token, body: { targetType: "bogus", targetId: l.ev.id, reasonCode: "scam" } })).status).toBe(400);
    const a = await api("/admin/v1/takedowns", { token, body: { targetType: "live_page", targetId: l.ev.id, reasonCode: "scam" } });
    expect(a.json).toMatchObject({ ok: true, state: "hidden", changed: true });
    const row = await db.prepare("SELECT event_id FROM takedowns WHERE target_type = 'live_page' AND target_id = ?").bind(l.ev.id).first<{ event_id: string }>();
    expect(row?.event_id).toBe(l.ev.id);
    expect((await api("/admin/v1/takedowns", { token, body: { targetType: "live_page", targetId: l.ev.id, reasonCode: "scam" } })).json.changed).toBe(false);
  });

  it("staff cannot decide a report or a takedown about their own organisation's event (403, report parked as needs_other_staff)", async () => {
    const s = await makeStaff();
    const token = (await s.login()).token;
    const l = await liveEvent();
    const org = `org${uniq()}`;
    await db.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES (?, 'Club', 'team', 'active', ?)").bind(org, now()).run();
    await db.prepare("INSERT INTO org_members (org_id, user_id, role, added_at) VALUES (?, ?, 'member', ?)").bind(org, s.id, now()).run();
    await db.prepare("UPDATE events SET org_id = ? WHERE id = ?").bind(org, l.ev.id).run();
    await fileReport(l.slug);
    const item = ((await api("/admin/v1/reports", { token })).json.items as any[]).find((i) => i.targetId === l.ev.id);
    const d = await api(`/admin/v1/reports/${item.id}/decide`, { token, body: { decision: "hide", reasonCode: "spam" } });
    expect(d.status).toBe(403);
    expect(d.json.code).toBe("conflict_of_interest");
    const st = await db.prepare("SELECT status FROM reports WHERE id = ?").bind(item.id).first<{ status: string }>();
    expect(st?.status).toBe("needs_other_staff");
    const t = await api("/admin/v1/takedowns", { token, body: { targetType: "live_page", targetId: l.ev.id, reasonCode: "spam" } });
    expect(t.status).toBe(403);
    expect(await db.prepare("SELECT 1 AS x FROM takedowns WHERE target_id = ?").bind(l.ev.id).first()).toBeNull();
    // the caller cannot dodge the guard by sending their own eventId or orgId
    const dodge = await api("/admin/v1/takedowns", { token, body: { targetType: "live_page", targetId: l.ev.id, reasonCode: "spam", eventId: "other", orgId: "other" } });
    expect(dodge.status).toBe(403);
  });

  it("an ordinary user, and a staff token without a staff row, get the plain 404", async () => {
    const u = await newUser("NotStaff");
    for (const [m, p] of [["GET", "/admin/v1/reports"], ["GET", "/admin/v1/takedowns"], ["POST", "/admin/v1/takedowns"], ["POST", "/admin/v1/reports/x1/decide"], ["POST", "/admin/v1/takedowns/live_page/x1/restore"]] as const) {
      const r = await api(p, { method: m, token: u.token, body: m === "GET" ? undefined : {} });
      expect(r.status, `${m} ${p}`).toBe(404);
      expect(r.json).toEqual({ error: "Not found" });
    }
  });
});
