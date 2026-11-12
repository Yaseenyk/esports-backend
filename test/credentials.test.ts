import { describe, expect, it } from "vitest";
import { call, newEvent, newUser, setupEvent } from "./helpers";

const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

describe("tokens die with the password", () => {
  it("change-password invalidates old tokens, returns a fresh working one, and login issues a matching one", async () => {
    const u = await newUser();
    expect((await call("/me", { token: u.token })).status).toBe(200);
    const r = await call("/auth/change-password", { token: u.token, body: { current: "correct horse", next: "battery staple 9" } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(typeof r.json.token).toBe("string");
    expect((await call("/me", { token: u.token })).status).toBe(401); // old token
    expect((await call("/me", { token: r.json.token })).status).toBe(200); // fresh token
    expect((await call("/events", { token: u.token })).status).toBe(401);
    const login = await call("/auth/login", { body: { email: u.email, password: "battery staple 9" } });
    expect((await call("/me", { token: login.json.token })).status).toBe(200);
  });

  it("a token without the password fingerprint (issued before this change) is refused", async () => {
    const u = await newUser();
    const [h, p, s] = u.token.split(".") as [string, string, string];
    const claims = JSON.parse(atob(p.replace(/-/g, "+").replace(/_/g, "/")));
    expect(typeof claims.pv).toBe("string");
    expect(JSON.stringify(claims)).not.toContain("pw_hash");
    // forged: same signature over a payload without pv fails; so does a tampered pv
    expect((await call("/me", { token: `${h}.${b64({ sub: claims.sub, exp: claims.exp })}.${s}` })).status).toBe(401);
    expect((await call("/me", { token: `${h}.${b64({ ...claims, pv: "AAAAAAAAAAAAAAAA" })}.${s}` })).status).toBe(401);
  });
});

describe("view-only members cannot read credentials", () => {
  it("invite and registration-form tokens are blank for a viewer, present for owner and editor", async () => {
    const o = await setupEvent();
    const ev = o.ev.id;
    const viewer = await newUser("Vi");
    const editor = await newUser("Ed");
    await call(`/events/${ev}/members`, { token: o.token, body: { email: viewer.email, role: "viewer" } });
    await call(`/events/${ev}/members`, { token: o.token, body: { email: editor.email, role: "editor" } });
    const inv = (await call(`/events/${ev}/invites`, { token: o.token, body: { teamId: "t1" } })).json;
    const form = (await call(`/events/${ev}/registration`, { method: "PUT", token: o.token, body: { acknowledge: true, title: "Reg" } })).json;
    expect(inv.token && form.token).toBeTruthy();

    for (const t of [o.token, editor.token]) {
      const list = await call(`/events/${ev}/invites`, { token: t });
      expect(list.json[0].token).toBe(inv.token);
      expect((await call(`/events/${ev}/registration`, { token: t })).json.form.token).toBe(form.token);
    }
    const vl = await call(`/events/${ev}/invites`, { token: viewer.token });
    expect(vl.status).toBe(200);
    expect(vl.json[0].id).toBe(inv.id);
    expect(vl.json[0].token).toBe("");
    expect(vl.text).not.toContain(inv.token);
    const vr = await call(`/events/${ev}/registration`, { token: viewer.token });
    expect(vr.status).toBe(200);
    expect(vr.json.form.title).toBe("Reg");
    expect(vr.json.form.token).toBe("");
    expect(vr.text).not.toContain(form.token);
    // gate keys list never contains the key itself; share tokens are only returned by writes (blocked for viewers)
    await call(`/events/${ev}/gate-keys`, { token: o.token, body: { label: "D" } });
    expect((await call(`/events/${ev}/gate-keys`, { token: viewer.token })).text).not.toContain("gk_");
    expect((await call(`/events/${ev}/people/ALP-001/share`, { token: viewer.token, body: {} })).status).toBe(403);
    void newEvent;
  });
});
