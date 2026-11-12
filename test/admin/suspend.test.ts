import { describe, expect, it, vi } from "vitest";
import { call, newUser } from "../helpers";
import { api, auditRows, db, forge, makeStaff, nowSec } from "./helpers";

vi.setConfig({ testTimeout: 180_000 });

async function staffToken() {
  const s = await makeStaff();
  return { s, token: (await s.login()).token };
}
const post = (token: string, path: string, body: unknown) => api(path, { token, body });

describe("user suspend and restore", () => {
  it("suspend needs step-up and a reason, blocks the user at once, restore reverses it, one audit row each", async () => {
    const { s, token } = await staffToken();
    const u = await newUser("Target");
    expect((await call("/events", { token: u.token })).status).toBe(200);

    const stale = await forge(s.id, { su: nowSec() - 3600, cs: nowSec() - 3600 });
    const noStep = await post(stale, `/admin/v1/users/${u.id}/suspend`, { reasonCode: "spam" });
    expect(noStep.status).toBe(403);
    expect(noStep.json.code).toBe("step_up_required");
    expect((await post(token, `/admin/v1/users/${u.id}/suspend`, {})).status).toBe(400);
    expect((await post(token, `/admin/v1/users/${u.id}/suspend`, { reasonCode: "because" })).status).toBe(400);
    expect((await call("/events", { token: u.token })).status).toBe(200);

    const r = await post(token, `/admin/v1/users/${u.id}/suspend`, { reasonCode: "spam" });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ ok: true, id: u.id, status: "suspended", changed: true });
    expect((await call("/events", { token: u.token })).status).toBe(401);
    const me = await call("/me", { token: u.token });
    expect(me.status).toBe(403);
    expect(me.json.code).toBe("account_suspended");

    expect((await post(token, `/admin/v1/users/${u.id}/suspend`, { reasonCode: "spam" })).json.changed).toBe(false); // idempotent, no second row
    expect((await auditRows("account.suspended", u.id)).length).toBe(1);

    const back = await post(token, `/admin/v1/users/${u.id}/restore`, { reasonCode: "other" });
    expect(back.json).toEqual({ ok: true, id: u.id, status: "active", changed: true });
    expect((await call("/events", { token: u.token })).status).toBe(200);
    expect((await post(token, `/admin/v1/users/${u.id}/restore`, { reasonCode: "other" })).json.changed).toBe(false);
    const rows = await auditRows("account.restored", u.id);
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ actor_type: "staff", actor_id: s.id, reason_code: "other", target_type: "user" });
  });

  it("restore never touches pending_deletion; unknown user is 404; staff cannot suspend themselves or another staff member", async () => {
    const { s, token } = await staffToken();
    const gone = await newUser("Leaving");
    await db.prepare("UPDATE users SET status = 'pending_deletion' WHERE id = ?1").bind(gone.id).run();
    expect((await post(token, `/admin/v1/users/${gone.id}/restore`, { reasonCode: "other" })).json).toEqual({ ok: true, id: gone.id, status: "pending_deletion", changed: false });
    expect((await post(token, "/admin/v1/users/nope/suspend", { reasonCode: "spam" })).status).toBe(404);
    const self = await post(token, `/admin/v1/users/${s.id}/suspend`, { reasonCode: "spam" });
    expect(self.status).toBe(403);
    expect(self.json.code).toBe("protected_account");
    const other = await makeStaff();
    const o = await post(token, `/admin/v1/users/${other.id}/suspend`, { reasonCode: "spam" });
    expect(o.status).toBe(403);
    const st = await db.prepare("SELECT status FROM users WHERE id = ?1").bind(other.id).first<{ status: string }>();
    expect(st!.status).toBe("active");
  });
});

describe("organisation suspend and restore", () => {
  it("moves organisations.status both ways with step-up, reason and one audit row each", async () => {
    const { s, token } = await staffToken();
    await db.prepare("INSERT INTO organisations (id, name, kind, status, created_at) VALUES ('org-sp1', 'Susp Club', 'team', 'active', ?1)").bind(new Date().toISOString()).run();
    const stale = await forge(s.id, { su: nowSec() - 3600, cs: nowSec() - 3600 });
    expect((await post(stale, "/admin/v1/orgs/org-sp1/suspend", { reasonCode: "scam" })).status).toBe(403);
    expect((await post(token, "/admin/v1/orgs/org-sp1/suspend", {})).status).toBe(400);
    expect((await post(token, "/admin/v1/orgs/org-sp1/suspend", { reasonCode: "scam" })).json).toEqual({ ok: true, id: "org-sp1", status: "suspended", changed: true });
    expect((await post(token, "/admin/v1/orgs/org-sp1/suspend", { reasonCode: "scam" })).json.changed).toBe(false);
    expect((await db.prepare("SELECT status FROM organisations WHERE id = 'org-sp1'").first<{ status: string }>())!.status).toBe("suspended");
    expect((await post(token, "/admin/v1/orgs/org-sp1/restore", { reasonCode: "other" })).json).toEqual({ ok: true, id: "org-sp1", status: "active", changed: true });
    expect((await auditRows("org.suspended", "org-sp1")).length).toBe(1);
    const restored = await auditRows("org.restored", "org-sp1");
    expect(restored.length).toBe(1);
    expect(restored[0]).toMatchObject({ org_id: "org-sp1", actor_type: "staff", reason_code: "other" });
    expect((await post(token, "/admin/v1/orgs/nope/suspend", { reasonCode: "scam" })).status).toBe(404);
  });
});

describe("usage", () => {
  it("answers four items with source labels and the unverified-limits note", async () => {
    const { token } = await staffToken();
    await db.prepare("INSERT INTO mail_budget (day, sent) VALUES (?1, 7) ON CONFLICT (day) DO UPDATE SET sent = 7").bind(new Date().toISOString().slice(0, 10)).run();
    const r = await api("/admin/v1/usage", { token });
    expect(r.status).toBe(200);
    expect(Object.keys(r.json).sort()).toEqual(["day", "items", "note"]);
    expect(r.json.note).toBe("limits not verified, check Cloudflare");
    expect(r.json.items.map((i: { id: string }) => i.id)).toEqual(["d1_rows_written_today", "worker_requests_today", "mail_sent_today", "db_size_bytes"]);
    for (const i of r.json.items) expect(Object.keys(i).sort()).toEqual(["available", "exact", "id", "label", "limit", "source", "value"]);
    const mail = r.json.items[2];
    expect(mail).toMatchObject({ value: 7, limit: 90, exact: true, available: true });
    expect(r.json.items[0]).toMatchObject({ value: null, available: false });
    expect(r.json.items[1]).toMatchObject({ value: null, available: false });
  });
});
