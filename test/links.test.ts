import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import phaseB from "../migrations-deferred/S7-phase-B-null-clear-tokens.sql?raw";
import { backfillLinks, isBackfillTick } from "../src/features/links-backfill";
import { constantTimeEqual, decryptToken, encryptToken, hashToken, newLink } from "../src/links";
import { call, newEvent, newUser, setupEvent } from "./helpers";

const nowIso = () => new Date().toISOString();

async function legacyShare(eventId: string, personId: string, token: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO share_links (id, event_id, person_id, token, created_at, revoked) VALUES (?, ?, ?, ?, ?, 0)").bind(id, eventId, personId, token, nowIso()).run();
  return id;
}
async function legacyInvite(eventId: string, token: string) {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO invites (id, event_id, team_id, token, label, uses, revoked, created_at) VALUES (?, ?, 't1', ?, 'old', 0, 0, ?)").bind(id, eventId, token, nowIso()).run();
  return id;
}
async function legacyForm(eventId: string, token: string) {
  await env.DB.prepare("INSERT INTO registration_forms (event_id, token, title, created_at) VALUES (?, ?, 'Old form', ?)").bind(eventId, token, nowIso()).run();
}
const tok = () => `legacy${crypto.randomUUID().replace(/-/g, "")}`.slice(0, 32);

/** Runs the deferred phase B script statement by statement (comments stripped). */
async function runPhaseB() {
  const sql = phaseB.split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
  for (const stmt of sql.split(";").map((s) => s.trim()).filter(Boolean)) await env.DB.prepare(stmt).run();
}

describe("links.ts primitives", () => {
  it("hashes, compares in constant time and round-trips AES-GCM bound to kind and row", async () => {
    expect(await hashToken("abc")).toBe(await hashToken("abc"));
    expect(await hashToken("abc")).not.toBe(await hashToken("abd"));
    expect(constantTimeEqual("same", "same")).toBe(true);
    expect(constantTimeEqual("same", "sama")).toBe(false);
    expect(constantTimeEqual("same", "sam")).toBe(false);
    const blob = await encryptToken(env, "share", "row1", "secret-token");
    expect(blob).not.toContain("secret-token");
    expect(await decryptToken(env, "share", "row1", blob)).toBe("secret-token");
    expect(await decryptToken(env, "share", "row2", blob)).toBeNull(); // moved to another row
    expect(await decryptToken(env, "invite", "row1", blob)).toBeNull(); // moved to another kind
    expect(await decryptToken(env, "share", "row1", `${blob}x`)).toBeNull(); // tampered
    expect(await decryptToken({ LINK_KEY: "another-key-another-key-another" }, "share", "row1", blob)).toBeNull();
    const l = await newLink(env, "invite", "r9");
    expect(l.cols.token).toBe("x-r9");
    expect(l.cols.token_hash).toBe(await hashToken(l.token));
  });

  it("the backfill window is 00:15 to 06:00 UTC", () => {
    const at = (h: number, m: number) => Date.UTC(2026, 10, 12, h, m);
    expect(isBackfillTick(at(0, 0))).toBe(false);
    expect(isBackfillTick(at(0, 15))).toBe(true);
    expect(isBackfillTick(at(5, 45))).toBe(true);
    expect(isBackfillTick(at(6, 0))).toBe(false);
    expect(isBackfillTick(at(12, 0))).toBe(false);
  });
});

describe("new links are stored hashed and encrypted", () => {
  it("share, invite and registration: no clear token in the row, re-display equals the original, lookups work", async () => {
    const s = await setupEvent("Hash Cup");
    const sh = await call(`/events/${s.ev.id}/people/ALP-001/share`, { token: s.token, method: "POST" });
    const inv = await call(`/events/${s.ev.id}/invites`, { token: s.token, body: { teamId: "t1" } });
    const reg = await call(`/events/${s.ev.id}/registration`, { method: "PUT", token: s.token, body: { title: "T" } });
    const tokens = { share: sh.json.token as string, invite: inv.json.token as string, reg: reg.json.token as string };

    const rows = [
      await env.DB.prepare("SELECT token, token_hash, token_enc, id AS rid FROM share_links WHERE event_id = ?").bind(s.ev.id).first<Record<string, string>>(),
      await env.DB.prepare("SELECT token, token_hash, token_enc, id AS rid FROM invites WHERE event_id = ?").bind(s.ev.id).first<Record<string, string>>(),
      await env.DB.prepare("SELECT token, token_hash, token_enc, event_id AS rid FROM registration_forms WHERE event_id = ?").bind(s.ev.id).first<Record<string, string>>(),
    ];
    for (const [i, t] of [tokens.share, tokens.invite, tokens.reg].entries()) {
      const r = rows[i]!;
      expect(r.token).toBe(`x-${r.rid}`);
      expect(r.token_hash).toBe(await hashToken(t));
      expect(r.token_enc).toMatch(/^v1\./);
      expect(JSON.stringify(r)).not.toContain(t);
    }

    // re-display equals the original
    expect((await call(`/events/${s.ev.id}/people/ALP-001/share`, { token: s.token, method: "POST" })).json.token).toBe(tokens.share);
    expect((await call(`/events/${s.ev.id}/invites`, { token: s.token })).json[0].token).toBe(tokens.invite);
    expect((await call(`/events/${s.ev.id}/registration`, { token: s.token })).json.form.token).toBe(tokens.reg);
    expect((await call(`/events/${s.ev.id}/registration`, { method: "PUT", token: s.token, body: { intro: "x" } })).json.token).toBe(tokens.reg);

    // public lookups
    expect((await call(`/public/pass/${tokens.share}`)).status).toBe(200);
    expect((await call(`/public/invite/${tokens.invite}`)).status).toBe(200);
    expect((await call(`/public/registration/${tokens.reg}`)).status).toBe(200);

    // the placeholder in the legacy column is not a credential
    expect((await call(`/public/pass/${rows[0]!.token}`)).status).toBe(404);
    expect((await call(`/public/invite/${rows[1]!.token}`)).status).toBe(404);
    expect((await call(`/public/registration/${rows[2]!.token}`)).status).toBe(404);
    expect((await call(`/public/pass/${tokens.share}x`)).status).toBe(404);

    // revoke still works
    await call(`/events/${s.ev.id}/people/ALP-001/share`, { token: s.token, method: "DELETE" });
    expect((await call(`/public/pass/${tokens.share}`)).status).toBe(404);
  });
});

describe("legacy links across phase A, backfill and phase B", () => {
  it("resolve before and after the backfill and after phase B; re-display equals the original; no clear token after B", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token, "Legacy Cup");
    await call(`/events/${ev.id}/roster`, { method: "PUT", token: u.token, body: { teams: [{ id: "t1", name: "A" }], people: [{ id: "P-1", name: "p", teamId: "t1" }] } });
    const [t1, t2, t3] = [tok(), tok(), tok()] as [string, string, string];
    const shareId = await legacyShare(ev.id, "P-1", t1);
    const inviteId = await legacyInvite(ev.id, t2);
    await legacyForm(ev.id, t3);

    const resolves = async () => {
      expect((await call(`/public/pass/${t1}`)).status).toBe(200);
      expect((await call(`/public/invite/${t2}`)).status).toBe(200);
      expect((await call(`/public/registration/${t3}`)).status).toBe(200);
    };
    const redisplay = async () => {
      expect((await call(`/events/${ev.id}/people/P-1/share`, { token: u.token, method: "POST" })).json.token).toBe(t1);
      expect((await call(`/events/${ev.id}/invites`, { token: u.token })).json[0].token).toBe(t2);
      expect((await call(`/events/${ev.id}/registration`, { token: u.token })).json.form.token).toBe(t3);
    };

    // phase A, before the backfill: legacy path
    await resolves();
    await redisplay();
    expect(await env.DB.prepare("SELECT token_hash FROM share_links WHERE id = ?").bind(shareId).first()).toEqual({ token_hash: null });

    // backfill
    const done = await backfillLinks(env as never, 1000);
    expect(done.share).toBeGreaterThanOrEqual(1);
    const row = await env.DB.prepare("SELECT token, token_hash, token_enc FROM invites WHERE id = ?").bind(inviteId).first<{ token: string; token_hash: string; token_enc: string }>();
    expect(row!.token).toBe(t2); // untouched in phase A
    expect(row!.token_hash).toBe(await hashToken(t2));
    expect(await decryptToken(env, "invite", inviteId, row!.token_enc)).toBe(t2);
    await resolves();
    await redisplay();
    expect(await backfillLinks(env as never, 1000)).toEqual({ share: 0, invite: 0, regform: 0 }); // idempotent

    // phase B
    await runPhaseB();
    for (const [table, key] of [["share_links", "id"], ["invites", "id"], ["registration_forms", "event_id"]] as const) {
      const bad = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE token <> 'x-' || ${key}`).first<{ n: number }>();
      expect(bad!.n, table).toBe(0);
    }
    const dump = JSON.stringify([
      (await env.DB.prepare("SELECT * FROM share_links").all()).results,
      (await env.DB.prepare("SELECT * FROM invites").all()).results,
      (await env.DB.prepare("SELECT * FROM registration_forms").all()).results,
    ]);
    for (const t of [t1, t2, t3]) expect(dump).not.toContain(t);
    await resolves();
    await redisplay();
  });

  it("phase B leaves a row that has no recoverable copy alone, and a not-yet-hashed legacy token cannot be forged from a placeholder", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token, "Unfilled Cup");
    const t = tok();
    await legacyForm(ev.id, t);
    await runPhaseB(); // no hash/enc yet: must not destroy the token
    expect((await env.DB.prepare("SELECT token FROM registration_forms WHERE event_id = ?").bind(ev.id).first<{ token: string }>())!.token).toBe(t);
    expect((await call(`/public/registration/${t}`)).status).toBe(200);
  });
});

describe("lookup uses the unique index", () => {
  it("EXPLAIN QUERY PLAN names idx_*_token_hash for all three tables", async () => {
    const plans: Record<string, string> = {};
    for (const [name, sql] of [
      ["share", "EXPLAIN QUERY PLAN SELECT token, token_hash, person_id, event_id FROM share_links WHERE token_hash = ? AND revoked = 0"],
      ["invite", "EXPLAIN QUERY PLAN SELECT i.id FROM invites i JOIN events e ON e.id = i.event_id WHERE i.token_hash = ? AND i.revoked = 0"],
      ["regform", "EXPLAIN QUERY PLAN SELECT f.* FROM registration_forms f JOIN events e ON e.id = f.event_id WHERE f.token_hash = ?"],
    ] as const) {
      const r = await env.DB.prepare(sql).bind("x").all<{ detail: string }>();
      plans[name] = r.results.map((x) => x.detail).join(" | ");
    }
    console.log(JSON.stringify(plans));
    expect(plans.share).toMatch(/USING INDEX idx_share_token_hash/);
    expect(plans.invite).toMatch(/USING INDEX idx_invites_token_hash/);
    expect(plans.regform).toMatch(/USING INDEX idx_regform_token_hash/);
  });
});
