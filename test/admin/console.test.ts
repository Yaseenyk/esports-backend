import { describe, expect, it, vi } from "vitest";
import { newEvent, newUser, uniq } from "../helpers";
import { maskEmail } from "../../src/admin/console";
import { api, auditRows, db, forge, makeStaff, nowSec } from "./helpers";

vi.setConfig({ testTimeout: 180_000 });

const staffToken = async () => { const s = await makeStaff(); return { s, token: (await s.login()).token }; };

async function teamOrg(owner: { id: string }, o: { verified?: boolean; slug?: string | null; name?: string; status?: string } = {}) {
  const id = `org${uniq()}`;
  await db.prepare("INSERT INTO organisations (id, name, kind, status, created_at, slug, verified_at) VALUES (?1, ?2, 'team', ?3, ?4, ?5, ?6)")
    .bind(id, o.name ?? `Approval College ${uniq()}`, o.status ?? "active", new Date().toISOString(), o.slug ?? null, o.verified ? nowSec() : null).run();
  await db.prepare("INSERT INTO org_members (org_id, user_id, role, added_at) VALUES (?1, ?2, 'admin', ?3)").bind(id, owner.id, new Date().toISOString()).run();
  return id;
}

describe("maskEmail", () => {
  it("keeps the first letters and the last domain label only", () => {
    expect(maskEmail("yaseen@gmail.com")).toBe("y***@g***.com");
    expect(maskEmail("a@b")).toBe("a***@b***");
    expect(maskEmail("")).toBe("");
    expect(maskEmail("broken")).toBe("***");
  });
});

describe("console routes are staff only", () => {
  it("anonymous, an ordinary user and a forged token without a staff row get the plain 404, and nothing is audited", async () => {
    const u = await newUser("Plain");
    const forged = await forge(u.id);
    const before = (await auditRows("admin.email_revealed")).length;
    for (const [m, p] of [["GET", "/admin/v1/overview"], ["GET", "/admin/v1/orgs"], ["GET", "/admin/v1/users"], ["POST", `/admin/v1/users/${u.id}/reveal`], ["POST", "/admin/v1/orgs/x1/verify"], ["GET", "/admin/v1/content?kind=scrims"], ["POST", "/admin/v1/content/scrims/x1/hide"]] as const) {
      for (const token of [undefined, u.token, forged]) {
        const r = await api(p, { method: m, token, body: m === "GET" ? undefined : { reasonCode: "other" } });
        expect(r.status, `${m} ${p}`).toBe(404);
        expect(r.json).toEqual({ error: "Not found" });
      }
    }
    expect((await auditRows("admin.email_revealed")).length).toBe(before);
  });
});

describe("GET /admin/v1/overview", () => {
  it("counts every queue and lists recent audit entries without an actor id", async () => {
    const { token } = await staffToken();
    const owner = await newUser("Owner");
    await teamOrg(owner);
    const r = await api("/admin/v1/overview", { token });
    expect(r.status).toBe(200);
    const c = r.json.counts;
    for (const k of ["users", "usersVerified", "orgs", "orgsPending", "orgsVerified", "events", "openReports", "tournaments", "feedbackNew", "scrims", "lft", "directory", "calendar", "ratings", "openRatingReports"]) expect(typeof c[k], k).toBe("number");
    expect(c.orgsPending).toBeGreaterThan(0);
    expect(Array.isArray(r.json.recent)).toBe(true);
    for (const e of r.json.recent) expect(e).not.toHaveProperty("actorId");
    expect(r.text).not.toContain(owner.email);
  });
});

describe("organisation approvals", () => {
  it("the queue lists unverified team organisations with a MASKED owner email and counts; personal workspaces never appear", async () => {
    const { s, token } = await staffToken();
    const owner = await newUser("Club Owner");
    const name = `Queue College ${uniq()}`;
    const id = await teamOrg(owner, { name });
    const ev = await newEvent(owner.token);
    await db.prepare("UPDATE events SET org_id = ?1 WHERE id = ?2").bind(id, ev.id).run();
    const r = await api(`/admin/v1/orgs?status=pending&q=${encodeURIComponent(name)}`, { token });
    expect(r.status).toBe(200);
    expect(r.json.items).toHaveLength(1);
    const o = r.json.items[0];
    expect(o).toMatchObject({ id, name, kind: "team", slug: null, verifiedAt: null, members: 1, events: 1 });
    expect(o.owner.id).toBe(owner.id);
    expect(o.owner.email).toBe(maskEmail(owner.email));
    expect(r.text).not.toContain(owner.email);
    expect(r.json.items.every((x: { kind: string }) => x.kind === "team")).toBe(true);
    const a = (await auditRows("admin.lookup")).filter((x) => x.actor_id === s.id && x.target_type === "orgs");
    expect(a.length).toBe(1);
    expect((await api("/admin/v1/orgs?status=nope", { token })).status).toBe(400);
  });

  it("approve sets verified_at and a unique slug from the name, revoke clears it; both audited with the reason; repeats change nothing", async () => {
    const { s, token } = await staffToken();
    const owner = await newUser("Owner");
    const base = `Slug College ${uniq()}`;
    const taken = await teamOrg(owner, { slug: base.toLowerCase().replace(/ /g, "-"), verified: true });
    const id = await teamOrg(owner, { name: base });
    expect((await api(`/admin/v1/orgs/${id}/verify`, { token, body: {} })).status).toBe(400); // reason required
    const v = await api(`/admin/v1/orgs/${id}/verify`, { token, body: { reasonCode: "other" } });
    expect(v.status, v.text).toBe(200);
    expect(v.json.changed).toBe(true);
    expect(v.json.slug).toBe(`${base.toLowerCase().replace(/ /g, "-")}-2`); // the plain one belongs to `taken`
    const row = await db.prepare("SELECT verified_at, slug FROM organisations WHERE id = ?1").bind(id).first<{ verified_at: number | null; slug: string }>();
    expect(row!.verified_at).toBeGreaterThan(0);
    expect((await api(`/admin/v1/orgs/${id}/verify`, { token, body: { reasonCode: "other" } })).json.changed).toBe(false);
    const va = await auditRows("org.verified", id);
    expect(va).toHaveLength(1);
    expect(va[0]).toMatchObject({ actor_type: "staff", actor_id: s.id, org_id: id, target_type: "org", reason_code: "other" });

    const u = await api(`/admin/v1/orgs/${id}/unverify`, { token, body: { reasonCode: "security" } });
    expect(u.json).toMatchObject({ ok: true, verifiedAt: null, changed: true });
    const after = await db.prepare("SELECT verified_at, slug FROM organisations WHERE id = ?1").bind(id).first<{ verified_at: number | null; slug: string }>();
    expect(after).toEqual({ verified_at: null, slug: row!.slug }); // the slug stays
    expect(await auditRows("org.unverified", id)).toHaveLength(1);
    expect((await api(`/admin/v1/orgs/${id}/unverify`, { token, body: { reasonCode: "security" } })).json.changed).toBe(false);
    expect(await auditRows("org.unverified", id)).toHaveLength(1);
    expect(taken).toBeTruthy();
  });

  it("a typed slug is validated and must be unique; personal and suspended organisations cannot be verified", async () => {
    const { token } = await staffToken();
    const owner = await newUser("Owner");
    const used = `used-${uniq()}`.toLowerCase();
    await teamOrg(owner, { slug: used, verified: true });
    const id = await teamOrg(owner);
    expect((await api(`/admin/v1/orgs/${id}/verify`, { token, body: { reasonCode: "other", slug: "admin" } })).json.code).toBe("invalid_slug");
    expect((await api(`/admin/v1/orgs/${id}/verify`, { token, body: { reasonCode: "other", slug: used } })).json.code).toBe("slug_taken");
    const mine = `mine-${uniq()}`.toLowerCase();
    expect((await api(`/admin/v1/orgs/${id}/verify`, { token, body: { reasonCode: "other", slug: mine } })).json.slug).toBe(mine);
    const personal = await db.prepare("SELECT o.id AS id FROM org_members m JOIN organisations o ON o.id = m.org_id WHERE m.user_id = ?1 AND o.kind = 'personal'").bind(owner.id).first<{ id: string }>();
    expect((await api(`/admin/v1/orgs/${personal!.id}/verify`, { token, body: { reasonCode: "other" } })).json.code).toBe("not_a_club");
    const sus = await teamOrg(owner, { status: "suspended" });
    expect((await api(`/admin/v1/orgs/${sus}/verify`, { token, body: { reasonCode: "other" } })).json.code).toBe("org_not_active");
    expect((await api("/admin/v1/orgs/nope123/verify", { token, body: { reasonCode: "other" } })).status).toBe(404);
  });
});

describe("users", () => {
  it("the list masks emails, searches by part of an email, shows organisations and is audited", async () => {
    const { s, token } = await staffToken();
    const u = await newUser("Searchable");
    const r = await api(`/admin/v1/users?q=${encodeURIComponent(u.email.slice(0, 8))}`, { token });
    expect(r.status).toBe(200);
    const hit = r.json.items.find((x: { id: string }) => x.id === u.id);
    expect(hit).toMatchObject({ id: u.id, email: maskEmail(u.email), status: "active", staff: false });
    expect(hit.orgs[0]).toMatchObject({ kind: "personal", role: "admin" });
    expect(r.text).not.toContain(u.email);
    const newest = await api("/admin/v1/users", { token });
    expect(newest.status).toBe(200);
    expect(newest.text).not.toMatch(/@example\.com/);
    const a = (await auditRows("admin.lookup")).filter((x) => x.actor_id === s.id);
    expect(a.map((x) => x.target_type)).toEqual(expect.arrayContaining(["user_search", "users"]));
    expect((await api("/admin/v1/users?q=a", { token })).status).toBe(400);
  });

  it("reveal returns the full email only with a reason and writes one audit row", async () => {
    const { s, token } = await staffToken();
    const u = await newUser("Reveal Me");
    expect((await api(`/admin/v1/users/${u.id}/reveal`, { token, body: {} })).status).toBe(400);
    expect(await auditRows("admin.email_revealed", u.id)).toHaveLength(0);
    const r = await api(`/admin/v1/users/${u.id}/reveal`, { token, body: { reasonCode: "user_request" } });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ id: u.id, email: u.email });
    const a = await auditRows("admin.email_revealed", u.id);
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ actor_type: "staff", actor_id: s.id, target_type: "user", reason_code: "user_request" });
    expect(String(a[0]!.meta)).not.toContain("@");
    expect((await api("/admin/v1/users/nobody1/reveal", { token, body: { reasonCode: "other" } })).status).toBe(404);
  });
});
