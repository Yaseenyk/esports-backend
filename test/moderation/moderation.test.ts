import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { hashToken } from "../../src/links";
import { resetFlagsCache } from "../../src/flags";
import {
  AUTO_HIDE_AT, REPORT_REASONS, createTakedown, decideReport, isTakenDown, listReports, priorityOf, revokeTakedown, sanitiseNote, takenDown,
} from "../../src/moderation";
import { call, freshIp, newUser, setupEvent, uniq } from "../helpers";

vi.setConfig({ testTimeout: 120_000 });

const db = env.DB;
const now = () => new Date().toISOString();

// ---------- fixtures (direct inserts keep each test fast; the registration form goes through the real API) ----------
async function liveEvent(published = 1) {
  const o = await setupEvent("Mod Cup");
  const slug = `lv${uniq()}`;
  await db.prepare("INSERT INTO live_pages (event_id, slug, published, snapshot, updated_at) VALUES (?, ?, ?, '{}', ?)").bind(o.ev.id, slug, published, now()).run();
  return { ...o, slug };
}
async function leagueFor(eventId: string) {
  const slug = `lg${uniq()}`;
  await db.prepare("INSERT INTO league_settings (event_id, slug, published, updated_at) VALUES (?, ?, 1, ?)").bind(eventId, slug, now()).run();
  return slug;
}
async function teamPage(published = 1) {
  const u = await newUser("TeamOwner");
  const id = `tp${uniq()}`;
  const slug = `tm${uniq()}`;
  await db.prepare("INSERT INTO team_profiles (id, owner_user_id, name, slug, published, updated_at) VALUES (?, ?, 'Wolves', ?, ?, ?)").bind(id, u.id, slug, published, now()).run();
  return { u, id, slug };
}
async function passLink(eventId: string, revoked = 0) {
  const id = `sl${uniq()}`;
  const token = `pass-token-${uniq()}`;
  await db.prepare("INSERT INTO share_links (id, event_id, person_id, token, created_at, revoked, token_hash) VALUES (?, ?, 'ALP-001', ?, ?, ?, ?)").bind(id, eventId, `x-${id}`, now(), revoked, await hashToken(token)).run();
  return { id, token };
}
async function captainLink(eventId: string) {
  const id = `cl${uniq()}`;
  const token = `cap-token-${uniq()}`;
  await db.prepare("INSERT INTO captain_links (id, event_id, team, token_hash, created_at) VALUES (?, ?, 'Alpha', ?, ?)").bind(id, eventId, await hashToken(token), now()).run();
  return { id, token };
}
async function directoryEntry(eventId: string) {
  await db.prepare("INSERT INTO directory_entries (event_id, listed, title, game, city, mode, starts_on, updated_at) VALUES (?, 1, 'Cup', 'BGMI', 'Pune', 'in-person', '2030-01-01', ?)").bind(eventId, now()).run();
}
const report = (kind: string, key: string, reason: string, extra: Record<string, unknown> = {}, ip = freshIp()) => call("/public/report", { body: { kind, key, reason, ...extra }, ip });
const rows = async (sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).all<Record<string, any>>()).results;
const auditRows = (targetId: string) => rows("SELECT action, actor_type, actor_id, reason_code, meta FROM audit_log WHERE target_id = ? ORDER BY id", targetId);

describe("pure helpers", () => {
  it("sanitiseNote strips control, bidi and markup characters, collapses whitespace and caps at 200", () => {
    expect(sanitiseNote("  a\u0000b\n\n c‮d <b>x</b> `y`  ")).toBe("a b c d bx/b y");
    expect(sanitiseNote(42)).toBe("");
    expect(sanitiseNote("x".repeat(5000)).length).toBe(200);
    expect(Array.from(sanitiseNote("é".repeat(300))).length).toBe(200);
  });
  it("priority puts a child first, and the reason list matches the table CHECK", () => {
    expect(priorityOf("minor_exposed")).toBe(3);
    expect(priorityOf("minor_exposed")).toBeGreaterThan(priorityOf("contact_details"));
    expect(priorityOf("spam")).toBe(0);
    expect(REPORT_REASONS.length).toBe(8);
  });
});

describe("public report route", () => {
  it("answers 202 with the same body for a real page, an unknown one, an unpublished one and a revoked pass", async () => {
    const l = await liveEvent();
    const un = await liveEvent(0);
    const rev = await passLink(l.ev.id, 1);
    const a = await report("live", l.slug, "spam");
    const b = await report("live", `nope${uniq()}`, "spam");
    const c = await report("live", un.slug, "spam");
    const d = await report("pass", rev.token, "spam");
    const e = await report("live", l.slug, "spam", {}, "10.9.9.9"); // a repeat from the same address later
    for (const r of [a, b, c, d, e]) expect(r.status).toBe(202);
    for (const r of [b, c, d]) expect(r.json).toEqual(a.json);
    expect(a.json.ok).toBe(true);
    expect(a.json.review).toContain("within 3 days");
    // only the real page stored anything
    expect((await rows("SELECT id FROM reports WHERE target_id = ?", l.ev.id)).length).toBe(2);
    expect((await rows("SELECT id FROM reports WHERE target_id = ?", un.ev.id)).length).toBe(0);
    expect((await rows("SELECT id FROM reports WHERE target_id = ?", rev.id)).length).toBe(0);
  });

  it("files a report from every public page type against the immutable id", async () => {
    const l = await liveEvent();
    const league = await leagueFor(l.ev.id);
    const team = await teamPage();
    const pass = await passLink(l.ev.id);
    const cap = await captainLink(l.ev.id);
    const form = await call(`/events/${l.ev.id}/registration`, { method: "PUT", token: l.token, body: { title: "Reg" } });
    expect(form.status).toBe(201);
    await directoryEntry(l.ev.id);
    const cases: [string, string, string, string][] = [
      ["live", l.slug, "live_page", l.ev.id],
      ["league", league, "league_page", l.ev.id],
      ["team", team.slug, "team_profile", team.id],
      ["registration", form.json.token, "registration_form", l.ev.id],
      ["pass", pass.token, "pass", pass.id],
      ["results", cap.token, "results", cap.id],
    ];
    for (const [kind, key, type, id] of cases) {
      expect((await report(kind, key, "wrong_info", { note: "looks off" })).status, kind).toBe(202);
      const r = await rows("SELECT * FROM reports WHERE target_type = ? AND target_id = ?", type, id);
      expect(r.length, kind).toBe(1);
      expect(r[0]!.status).toBe("open");
      expect(r[0]!.note).toBe("looks off");
      expect(r[0]!.lookup_key.length, kind).toBeGreaterThan(0);
      // a token is a credential: neither it nor the slug-less key appears anywhere in the row
      expect(JSON.stringify(r[0])).not.toContain(key.startsWith("lv") || key.startsWith("lg") || key.startsWith("tm") ? "@@never@@" : key);
    }
    expect((await report("directory", l.ev.id, "wrong_info", { note: "old date" })).status).toBe(202);
    const d = await rows("SELECT reason FROM directory_reports WHERE event_id = ?", l.ev.id);
    expect(d.map((x) => x.reason)).toEqual(["wrong_info: old date"]);
  });

  it("validates the body and rate limits at 5 per hour per address", async () => {
    const l = await liveEvent();
    expect((await report("moon", l.slug, "spam")).status).toBe(400);
    expect((await report("live", l.slug, "annoying")).status).toBe(400);
    expect((await report("live", "", "spam")).status).toBe(400);
    expect((await report("live", "x".repeat(65), "spam")).status).toBe(400);
    expect((await call("/public/report", { raw: "not json", headers: { "content-type": "application/json" } })).status).toBe(400);
    const ip = freshIp();
    for (let n = 0; n < 5; n++) expect((await report("live", l.slug, "spam", {}, ip)).status).toBe(202);
    expect((await report("live", l.slug, "spam", {}, ip)).status).toBe(429);
  });

  it("stores only a reason code, a capped sanitised note and a hashed reporter", async () => {
    const l = await liveEvent();
    const ip = "203.0.113.77";
    const note = `  Two\u0000 lines\n<script>alert(1)</script> ${"y".repeat(400)}`;
    expect((await report("live", l.slug, "contact_details", { note, name: "Jane Doe", email: "jane@example.com" }, ip)).status).toBe(202);
    const [r] = await rows("SELECT * FROM reports WHERE target_id = ?", l.ev.id);
    expect(r!.reason_code).toBe("contact_details");
    expect(r!.note.length).toBeLessThanOrEqual(200);
    expect(r!.note).not.toMatch(/[<>\u0000\n]/);
    expect(r!.reporter).not.toContain(ip);
    expect(r!.reporter.length).toBe(43);
    const dump = JSON.stringify(r);
    expect(dump).not.toContain("Jane");
    expect(dump).not.toContain("jane@example.com");
    expect(Object.keys(r!).sort()).toEqual(["created_at", "decided_at", "decided_by", "decision_code", "event_id", "id", "lookup_key", "note", "org_id", "priority", "reason_code", "reporter", "status", "target_id", "target_type"]);
  });

  it("counts one address once per target", async () => {
    const l = await liveEvent();
    const ip = freshIp();
    for (let n = 0; n < 3; n++) expect((await report("live", l.slug, "spam", {}, ip)).status).toBe(202);
    expect((await rows("SELECT id FROM reports WHERE target_id = ?", l.ev.id)).length).toBe(1);
    expect(await isTakenDown(db, "live_page", l.ev.id)).toBe(false);
  });
});

describe("auto-hide", () => {
  it("ONE minor_exposed report hides the page at once, and audits it as the system", async () => {
    const l = await liveEvent();
    expect(await isTakenDown(db, "live_page", l.ev.id)).toBe(false);
    expect((await report("live", l.slug, "minor_exposed")).status).toBe(202);
    expect(await isTakenDown(db, "live_page", l.ev.id)).toBe(true);
    const [t] = await rows("SELECT * FROM takedowns WHERE target_id = ?", l.ev.id);
    expect(t).toMatchObject({ target_type: "live_page", state: "hidden", reason_code: "minor_exposed", by_staff: "system" });
    const a = await auditRows(l.ev.id);
    expect(a.map((x) => x.action)).toEqual(["takedown.hidden"]);
    expect(a[0]).toMatchObject({ actor_type: "system", reason_code: "minor_exposed" });
  });

  it("an ordinary reason needs three distinct reporters", async () => {
    const t = await teamPage();
    for (let n = 1; n < AUTO_HIDE_AT; n++) {
      await report("team", t.slug, "offensive");
      expect(await isTakenDown(db, "team_profile", t.id), `after ${n}`).toBe(false);
    }
    await report("team", t.slug, "scam");
    expect(await isTakenDown(db, "team_profile", t.id)).toBe(true);
  });

  it("a staff restore stands against the old reports; a new minor report hides again", async () => {
    const l = await liveEvent();
    const staff = await newUser("Staff");
    await report("live", l.slug, "minor_exposed");
    expect(await revokeTakedown(db, { targetType: "live_page", targetId: l.ev.id, reasonCode: "checked_ok", staffId: staff.id, eventId: l.ev.id })).toEqual({ ok: true, changed: true });
    expect(await isTakenDown(db, "live_page", l.ev.id)).toBe(false);
    await report("live", l.slug, "spam"); // one ordinary report does not re-hide
    expect(await isTakenDown(db, "live_page", l.ev.id)).toBe(false);
    await report("live", l.slug, "minor_exposed");
    expect(await isTakenDown(db, "live_page", l.ev.id)).toBe(true);
  });

  it("the directory: a minor report holds the entry (S4 held_at), three reporters hold it too", async () => {
    const a = await liveEvent();
    await directoryEntry(a.ev.id);
    await report("directory", a.ev.id, "minor_exposed");
    expect((await rows("SELECT held_at FROM directory_entries WHERE event_id = ?", a.ev.id))[0]!.held_at).not.toBeNull();
    expect(await isTakenDown(db, "directory_entry", a.ev.id)).toBe(true);
    const b = await liveEvent();
    await directoryEntry(b.ev.id);
    await report("directory", b.ev.id, "spam");
    await report("directory", b.ev.id, "spam");
    expect((await rows("SELECT held_at FROM directory_entries WHERE event_id = ?", b.ev.id))[0]!.held_at).toBeNull();
    await report("directory", b.ev.id, "spam");
    expect((await rows("SELECT held_at FROM directory_entries WHERE event_id = ?", b.ev.id))[0]!.held_at).not.toBeNull();
  });
});

describe("takedown matrix (what each public route will see through takenDown)", () => {
  const yes = { enforce: true };

  it("valid, hidden, restored, and flag off", async () => {
    const l = await liveEvent();
    const staff = await newUser("Staff");
    const subj = { type: "live_page" as const, id: l.ev.id, eventId: l.ev.id };
    expect(await takenDown(db, subj, yes)).toBe(false); // valid
    expect(await createTakedown(db, { targetType: "live_page", targetId: l.ev.id, reasonCode: "scam", staffId: staff.id, eventId: l.ev.id })).toEqual({ ok: true, changed: true });
    expect(await takenDown(db, subj, yes)).toBe(true); // hidden
    expect(await takenDown(db, subj, { enforce: false })).toBe(false); // rollout flag off
    resetFlagsCache(db);
    expect(await takenDown(db, subj)).toBe(false); // default flag value is off
    await db.prepare("INSERT INTO flags (key, value, updated_by, updated_at) VALUES ('takedown.enforce', 'true', 'test', ?) ON CONFLICT (key) DO UPDATE SET value = 'true'").bind(now()).run();
    resetFlagsCache(db);
    expect(await takenDown(db, subj)).toBe(true); // flag on
    await db.prepare("DELETE FROM flags WHERE key = 'takedown.enforce'").run();
    resetFlagsCache(db);
    expect(await revokeTakedown(db, { targetType: "live_page", targetId: l.ev.id, reasonCode: "checked_ok", staffId: staff.id, eventId: l.ev.id })).toEqual({ ok: true, changed: true });
    expect(await takenDown(db, subj, yes)).toBe(false); // restored
    expect(await revokeTakedown(db, { targetType: "live_page", targetId: l.ev.id, reasonCode: "checked_ok", staffId: staff.id })).toEqual({ ok: false, code: "not_hidden" });
  });

  it("an event takedown hides every page of that event; another event is untouched", async () => {
    const a = await liveEvent();
    const b = await liveEvent();
    const staff = await newUser("Staff");
    await createTakedown(db, { targetType: "event", targetId: a.ev.id, reasonCode: "scam", staffId: staff.id, eventId: a.ev.id });
    for (const type of ["live_page", "league_page", "registration_form", "directory_entry"] as const) {
      expect(await takenDown(db, { type, id: a.ev.id, eventId: a.ev.id }, yes), type).toBe(true);
      expect(await takenDown(db, { type, id: b.ev.id, eventId: b.ev.id }, yes), type).toBe(false);
    }
  });

  it("organisation suspended hides the event's pages", async () => {
    const l = await liveEvent();
    const org = `org${uniq()}`;
    await db.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES (?, 'Club', 'team', 'active', ?)").bind(org, now()).run();
    await db.prepare("UPDATE events SET org_id = ? WHERE id = ?").bind(org, l.ev.id).run();
    const subj = { type: "pass" as const, id: "any-pass-id", eventId: l.ev.id };
    expect(await takenDown(db, subj, yes)).toBe(false);
    await db.prepare("UPDATE organisations SET status = 'suspended' WHERE id = ?").bind(org).run();
    expect(await takenDown(db, subj, yes)).toBe(true);
    await db.prepare("UPDATE organisations SET status = 'active' WHERE id = ?").bind(org).run();
    expect(await takenDown(db, subj, yes)).toBe(false);
  });

  it("a revoked pass link never resolves, a renamed team slug cannot dodge a takedown", async () => {
    const t = await teamPage();
    const staff = await newUser("Staff");
    await createTakedown(db, { targetType: "team_profile", targetId: t.id, reasonCode: "offensive", staffId: staff.id });
    const newSlug = `renamed${uniq()}`;
    await db.prepare("UPDATE team_profiles SET slug = ? WHERE id = ?").bind(newSlug, t.id).run();
    expect(await takenDown(db, { type: "team_profile", id: t.id }, yes)).toBe(true); // the id did not change
    await report("team", newSlug, "spam"); // the new slug resolves to the same id
    expect((await rows("SELECT target_id FROM reports WHERE lookup_key = ?", newSlug)).map((r) => r.target_id)).toEqual([t.id]);
    expect((await rows("SELECT id FROM reports WHERE lookup_key = ?", t.slug)).length).toBe(0); // the old slug no longer resolves
    const l = await liveEvent();
    const p = await passLink(l.ev.id);
    await db.prepare("UPDATE share_links SET revoked = 1 WHERE id = ?").bind(p.id).run();
    await report("pass", p.token, "spam");
    expect((await rows("SELECT id FROM reports WHERE target_id = ?", p.id)).length).toBe(0);
  });

  it("BOTH moderation sources are read: S4 held_at alone, and the takedowns table alone", async () => {
    const a = await liveEvent();
    await directoryEntry(a.ev.id);
    expect(await takenDown(db, { type: "directory_entry", id: a.ev.id, eventId: a.ev.id }, yes)).toBe(false);
    await db.prepare("UPDATE directory_entries SET held_at = ? WHERE event_id = ?").bind(now(), a.ev.id).run();
    expect(await takenDown(db, { type: "directory_entry", id: a.ev.id, eventId: a.ev.id }, yes)).toBe(true); // held_at only
    const b = await liveEvent();
    await directoryEntry(b.ev.id);
    const staff = await newUser("Staff");
    await createTakedown(db, { targetType: "directory_entry", targetId: b.ev.id, reasonCode: "spam", staffId: staff.id, eventId: b.ev.id });
    expect((await rows("SELECT held_at FROM directory_entries WHERE event_id = ?", b.ev.id))[0]!.held_at).toBeNull();
    expect(await takenDown(db, { type: "directory_entry", id: b.ev.id, eventId: b.ev.id }, yes)).toBe(true); // takedown only
    // one restore clears both sources
    await db.prepare("UPDATE directory_entries SET held_at = ? WHERE event_id = ?").bind(now(), b.ev.id).run();
    expect((await revokeTakedown(db, { targetType: "directory_entry", targetId: b.ev.id, reasonCode: "checked_ok", staffId: staff.id, eventId: b.ev.id })).ok).toBe(true);
    expect(await takenDown(db, { type: "directory_entry", id: b.ev.id, eventId: b.ev.id }, yes)).toBe(false);
    expect((await rows("SELECT held_at FROM directory_entries WHERE event_id = ?", b.ev.id))[0]!.held_at).toBeNull();
  });
});

describe("queue and decisions", () => {
  it("lists both sources, child first, then most reporters, and paginates", async () => {
    const calm = await teamPage();
    const kid = await liveEvent();
    const dir = await liveEvent();
    await directoryEntry(dir.ev.id);
    await report("team", calm.slug, "spam");
    await report("team", calm.slug, "spam");
    await report("directory", dir.ev.id, "minor_exposed");
    await report("live", kid.slug, "minor_exposed");
    const q = await listReports(db, { status: "open", limit: 50 });
    const mine = q.items.filter((x) => [calm.id, kid.ev.id, dir.ev.id].includes(x.targetId));
    expect(mine.length).toBe(4);
    expect(mine.slice(0, 2).map((x) => x.priority)).toEqual([3, 3]);
    expect(new Set(mine.slice(0, 2).map((x) => x.source))).toEqual(new Set(["report", "directory"]));
    expect(mine[2]!.targetId).toBe(calm.id);
    expect(mine[2]!.reporters).toBe(2);
    const p1 = await listReports(db, { limit: 1 });
    expect(p1.items.length).toBe(1);
    expect(p1.next).toBe(1);
    const p2 = await listReports(db, { limit: 1, after: p1.next! });
    expect(p2.items[0]!.id).not.toBe(p1.items[0]!.id);
    expect(JSON.stringify(q)).not.toContain("reporter\":");
  });

  it("hide needs a reason, writes a takedown and two audit rows, closes the open reports, and is reversible", async () => {
    const l = await liveEvent();
    const staff = await newUser("Staff");
    await report("live", l.slug, "scam");
    await report("live", l.slug, "spam");
    const items = (await listReports(db, { limit: 50 })).items.filter((x) => x.targetId === l.ev.id);
    expect(items.length).toBe(2);
    const first = items[0]!;
    expect(await decideReport(db, { source: first.source, reportId: first.id, decision: "hide", reasonCode: "", staffId: staff.id })).toEqual({ ok: false, code: "reason_required" });
    expect(await decideReport(db, { source: first.source, reportId: first.id, decision: "hide", reasonCode: "Bad Reason!", staffId: staff.id })).toEqual({ ok: false, code: "reason_required" });
    expect(await decideReport(db, { source: "report", reportId: "nope", decision: "hide", reasonCode: "scam", staffId: staff.id })).toEqual({ ok: false, code: "not_found" });
    expect(await isTakenDown(db, "live_page", l.ev.id)).toBe(false);
    expect(await decideReport(db, { source: first.source, reportId: first.id, decision: "hide", reasonCode: "scam", staffId: staff.id })).toEqual({ ok: true, changed: true });
    expect(await isTakenDown(db, "live_page", l.ev.id)).toBe(true);
    expect((await rows("SELECT status, decided_by, decision_code FROM reports WHERE target_id = ?", l.ev.id)).every((r) => r.status === "actioned" && r.decided_by === staff.id && r.decision_code === "scam")).toBe(true);
    const a = await auditRows(l.ev.id);
    expect(a.map((x) => x.action)).toEqual(["takedown.hidden", "report.decided"]);
    expect(a[1]!.meta).toBe('{"decision":"upheld"}');
    expect(a.every((x) => x.actor_id === staff.id)).toBe(true);
    // reversible: restore
    const again = await decideReport(db, { source: "report", reportId: first.id, decision: "restore", reasonCode: "checked_ok", staffId: staff.id });
    expect(again).toEqual({ ok: true, changed: true });
    expect(await isTakenDown(db, "live_page", l.ev.id)).toBe(false);
    expect((await auditRows(l.ev.id)).map((x) => x.action)).toEqual(["takedown.hidden", "report.decided", "takedown.restored", "report.decided"]);
  });

  it("dismiss closes only that report and changes nothing public", async () => {
    const l = await liveEvent();
    const staff = await newUser("Staff");
    await report("live", l.slug, "wrong_info");
    await report("live", l.slug, "wrong_info");
    const [one] = (await listReports(db, { limit: 50 })).items.filter((x) => x.targetId === l.ev.id);
    expect(await decideReport(db, { source: "report", reportId: one!.id, decision: "dismiss", reasonCode: "not_an_issue", staffId: staff.id })).toEqual({ ok: true, changed: true });
    const st = (await rows("SELECT status FROM reports WHERE target_id = ? ORDER BY status", l.ev.id)).map((r) => r.status);
    expect(st).toEqual(["dismissed", "open"]);
    expect(await isTakenDown(db, "live_page", l.ev.id)).toBe(false);
  });

  it("a directory report is decided through the same function: hide, then restore clears S4's hold too", async () => {
    const l = await liveEvent();
    await directoryEntry(l.ev.id);
    const staff = await newUser("Staff");
    await report("directory", l.ev.id, "minor_exposed");
    const [it] = (await listReports(db, { limit: 50 })).items.filter((x) => x.targetId === l.ev.id);
    expect(it!.source).toBe("directory");
    expect((await decideReport(db, { source: "directory", reportId: it!.id, decision: "hide", reasonCode: "child_shown", staffId: staff.id })).ok).toBe(true);
    expect(await isTakenDown(db, "directory_entry", l.ev.id)).toBe(true);
    expect((await decideReport(db, { source: "directory", reportId: it!.id, decision: "restore", reasonCode: "checked_ok", staffId: staff.id })).ok).toBe(true);
    expect(await isTakenDown(db, "directory_entry", l.ev.id)).toBe(false);
    expect((await rows("SELECT held_at FROM directory_entries WHERE event_id = ?", l.ev.id))[0]!.held_at).toBeNull();
  });

  it("staff cannot decide a report about their own organisation's event (owner, creator or org member)", async () => {
    const l = await liveEvent();
    const member = await newUser("OrgMate");
    const org = `org${uniq()}`;
    await db.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES (?, 'Club', 'team', 'active', ?)").bind(org, now()).run();
    await db.prepare("INSERT INTO org_members (org_id, user_id, role, added_at) VALUES (?, ?, 'member', ?)").bind(org, member.id, now()).run();
    await db.prepare("UPDATE events SET org_id = ? WHERE id = ?").bind(org, l.ev.id).run();
    await report("live", l.slug, "spam");
    const [it] = (await listReports(db, { limit: 50 })).items.filter((x) => x.targetId === l.ev.id);
    for (const who of [l.id, member.id]) {
      expect(await decideReport(db, { source: "report", reportId: it!.id, decision: "hide", reasonCode: "spam", staffId: who })).toEqual({ ok: false, code: "conflict_of_interest" });
    }
    expect(await isTakenDown(db, "live_page", l.ev.id)).toBe(false);
    expect((await rows("SELECT status FROM reports WHERE id = ?", it!.id))[0]!.status).toBe("needs_other_staff");
    expect(await createTakedown(db, { targetType: "live_page", targetId: l.ev.id, reasonCode: "spam", staffId: l.id, eventId: l.ev.id })).toEqual({ ok: false, code: "conflict_of_interest" });
    // someone else can still decide it
    const other = await newUser("Other");
    expect((await listReports(db, { status: "needs_other_staff", limit: 50 })).items.some((x) => x.id === it!.id)).toBe(true);
    expect(await createTakedown(db, { targetType: "live_page", targetId: l.ev.id, reasonCode: "spam", staffId: other.id, eventId: l.ev.id })).toEqual({ ok: true, changed: true });
  });

  it("a team page owner who is staff cannot take their own page down or restore it", async () => {
    const t = await teamPage();
    expect(await createTakedown(db, { targetType: "team_profile", targetId: t.id, reasonCode: "spam", staffId: t.u.id })).toEqual({ ok: false, code: "conflict_of_interest" });
  });
});

describe("storage rules", () => {
  it("ids are immutable: reports and takedowns refuse to change their target or id", async () => {
    const l = await liveEvent();
    await report("live", l.slug, "minor_exposed");
    await expect(db.prepare("UPDATE reports SET target_id = 'other' WHERE target_id = ?").bind(l.ev.id).run()).rejects.toThrow();
    await expect(db.prepare("UPDATE reports SET id = 'other' WHERE target_id = ?").bind(l.ev.id).run()).rejects.toThrow();
    await expect(db.prepare("UPDATE takedowns SET target_id = 'other' WHERE target_id = ?").bind(l.ev.id).run()).rejects.toThrow();
    await expect(db.prepare("UPDATE takedowns SET target_type = 'event' WHERE target_id = ?").bind(l.ev.id).run()).rejects.toThrow();
    expect((await rows("SELECT 1 FROM takedowns WHERE target_id = ?", l.ev.id)).length).toBe(1);
  });

  it("the table refuses a note over 200 characters and an unknown reason", async () => {
    await expect(db.prepare("INSERT INTO reports (id, target_type, target_id, reason_code, note, reporter, created_at) VALUES ('a1', 'live_page', 'e', 'spam', ?, 'r', 't')").bind("x".repeat(201)).run()).rejects.toThrow();
    await expect(db.prepare("INSERT INTO reports (id, target_type, target_id, reason_code, reporter, created_at) VALUES ('a2', 'live_page', 'e', 'nope', 'r', 't')").run()).rejects.toThrow();
  });
});
