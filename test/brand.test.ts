import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { call, newEvent, newUser, pngDataUrl, setupEvent } from "./helpers";
import { callDirect } from "./golden/direct";

vi.setConfig({ testTimeout: 120_000 });

const kit = (over: Record<string, unknown> = {}) => ({ name: "Acme Esports", logo: pngDataUrl(), primaryColor: "#0A84FF", secondaryColor: "#7c3aed", ...over });
const putAcc = (token: string, body: unknown) => call("/brand", { method: "PUT", token, body });
const putEv = (id: string, token: string, body: unknown) => call(`/events/${id}/brand`, { method: "PUT", token, body });
const getEv = (id: string, token: string) => call(`/events/${id}/brand`, { token });
async function publish(id: string, token: string, published = true) {
  const r = await call(`/events/${id}/live`, { method: "PUT", token, body: { published } });
  return r.json.slug as string;
}

describe("account kit", () => {
  it("is private to its user, normalises colours and can be deleted", async () => {
    const a = await newUser("A");
    const b = await newUser("B");
    expect((await call("/brand", { token: a.token })).json).toEqual({ brand: null, source: "none" });
    const r = await putAcc(a.token, kit());
    expect(r.status).toBe(200);
    expect(r.json.brand.primaryColor).toBe("#0a84ff");
    expect(r.json.source).toBe("account");
    expect((await call("/brand", { token: b.token })).json.brand).toBeNull();
    expect((await call("/brand")).status).toBe(401);
    expect((await call("/brand", { method: "PUT", body: kit() })).status).toBe(401);
    expect((await call("/brand", { method: "DELETE" })).status).toBe(401);
    expect((await call("/brand", { method: "DELETE", token: a.token })).json.brand).toBeNull();
    expect((await call("/brand", { token: a.token })).json.brand).toBeNull();
  });

  it("PUT replaces the kit (one row per user)", async () => {
    const a = await newUser();
    await putAcc(a.token, kit());
    const r = await putAcc(a.token, kit({ name: "Second", logo: null }));
    expect(r.json.brand.name).toBe("Second");
    expect(r.json.brand.logo).toBeNull();
  });
});

describe("validation", () => {
  const cases: [string, Record<string, unknown>, number][] = [
    ["colour without hash", { primaryColor: "0a84ff" }, 400],
    ["short colour", { primaryColor: "#fff" }, 400],
    ["css colour name", { secondaryColor: "red" }, 400],
    ["css injection", { primaryColor: "#000000;background:url(x)" }, 400],
    ["missing colour", { secondaryColor: undefined }, 400],
    ["non-string colour", { primaryColor: 5 }, 400],
    ["empty name", { name: "  " }, 400],
    ["name too long", { name: "n".repeat(61) }, 400],
    ["svg logo", { logo: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }, 415],
    ["remote logo", { logo: "https://evil.example/x.png" }, 415],
    ["logo with script", { logo: "data:image/png;base64,<script>" }, 415],
    ["logo too big", { logo: `data:image/png;base64,${"A".repeat(62_000)}` }, 413],
  ];
  it.each(cases)("rejects %s", async (_n, over, status) => {
    const o = await setupEvent();
    expect((await putAcc(o.token, kit(over))).status).toBe(status);
    expect((await putEv(o.ev.id, o.token, kit(over))).status).toBe(status);
    expect((await call("/brand", { token: o.token })).json.brand).toBeNull();
  });
  it("accepts a name of exactly 60 characters and no logo", async () => {
    const o = await setupEvent();
    expect((await putAcc(o.token, kit({ name: "n".repeat(60), logo: undefined }))).status).toBe(200);
  });
  it("rejects a non-JSON body", async () => {
    const o = await setupEvent();
    expect((await call("/brand", { method: "PUT", token: o.token, raw: "{nope", headers: { "content-type": "application/json" } })).status).toBe(400);
  });
});

describe("event kit and override order", () => {
  it("event kit beats account kit and falls back when removed", async () => {
    const o = await setupEvent();
    expect((await getEv(o.ev.id, o.token)).json).toEqual({ brand: null, source: "none" });
    await putAcc(o.token, kit({ name: "Account kit" }));
    const g = await getEv(o.ev.id, o.token);
    expect(g.json.source).toBe("account");
    expect(g.json.brand.name).toBe("Account kit");
    const p = await putEv(o.ev.id, o.token, kit({ name: "Event kit", primaryColor: "#112233" }));
    expect(p.json.source).toBe("event");
    expect(p.json.brand.primaryColor).toBe("#112233");
    expect((await call("/brand", { token: o.token })).json.brand.name).toBe("Account kit"); // account kit untouched
    const d = await call(`/events/${o.ev.id}/brand`, { method: "DELETE", token: o.token });
    expect(d.json.source).toBe("account");
    expect(d.json.brand.name).toBe("Account kit");
  });

  it("another event of the same owner is not affected by an event kit", async () => {
    const o = await setupEvent();
    const other = await newEvent(o.token, "Other");
    await putEv(o.ev.id, o.token, kit());
    expect((await getEv(other.id, o.token)).json.source).toBe("none");
  });

  it("owner and editor can change it, viewer can only read, stranger gets 404", async () => {
    const o = await setupEvent();
    const editor = await newUser("Ed");
    const viewer = await newUser("Vi");
    const stranger = await newUser("St");
    await call(`/events/${o.ev.id}/members`, { token: o.token, body: { email: editor.email, role: "editor" } });
    await call(`/events/${o.ev.id}/members`, { token: o.token, body: { email: viewer.email, role: "viewer" } });
    await putAcc(o.token, kit({ name: "Owner account" }));
    expect((await putEv(o.ev.id, editor.token, kit({ name: "By editor" }))).status).toBe(200);
    expect((await getEv(o.ev.id, o.token)).json.brand.name).toBe("By editor"); // one shared row
    expect((await getEv(o.ev.id, viewer.token)).json.brand.name).toBe("By editor");
    expect((await putEv(o.ev.id, viewer.token, kit())).status).toBe(403);
    expect((await call(`/events/${o.ev.id}/brand`, { method: "DELETE", token: viewer.token })).status).toBe(403);
    expect((await getEv(o.ev.id, stranger.token)).status).toBe(404);
    expect((await putEv(o.ev.id, stranger.token, kit())).status).toBe(404);
    expect((await call(`/events/${o.ev.id}/brand`, { method: "DELETE", token: stranger.token })).status).toBe(404);
    expect((await call(`/events/${o.ev.id}/brand`)).status).toBe(401);
    expect((await getEv(o.ev.id, o.token)).json.brand.name).toBe("By editor");
    // the editor's own account kit never leaks into the event
    await putAcc(editor.token, kit({ name: "Editor account" }));
    await call(`/events/${o.ev.id}/brand`, { method: "DELETE", token: o.token });
    expect((await getEv(o.ev.id, editor.token)).json.brand.name).toBe("Owner account");
  });

  it("deleting the event removes its kit", async () => {
    const o = await setupEvent();
    await putEv(o.ev.id, o.token, kit());
    expect((await call(`/events/${o.ev.id}`, { method: "DELETE", token: o.token })).status).toBeLessThan(300);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM brand_kits WHERE scope = ?").bind(o.ev.id).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });
});

describe("public kit by slug", () => {
  it("serves only the public fields, only for published pages, with the same 404 otherwise", async () => {
    const o = await setupEvent();
    const slug = await publish(o.ev.id, o.token);
    expect((await call(`/public/brand/${slug}`)).json).toEqual({ brand: null });
    await putAcc(o.token, kit({ name: "Acct" }));
    let r = await call(`/public/brand/${slug}`);
    expect(r.status).toBe(200);
    expect(r.json.brand).toEqual({ name: "Acct", logo: pngDataUrl(), primaryColor: "#0a84ff", secondaryColor: "#7c3aed" });
    await putEv(o.ev.id, o.token, kit({ name: "Ev", primaryColor: "#223344" }));
    r = await call(`/public/brand/${slug}`);
    expect(r.json.brand.name).toBe("Ev");
    expect(r.json.brand.primaryColor).toBe("#223344");
    for (const leak of ["owner", o.id, o.ev.id, o.email, "updatedAt", "scope"]) expect(r.text).not.toContain(leak);
    const etag = r.headers.get("etag")!;
    expect(etag).toBeTruthy();
    expect((await call(`/public/brand/${slug}`, { headers: { "if-none-match": etag } })).status).toBe(304);
    await publish(o.ev.id, o.token, false);
    const hidden = await call(`/public/brand/${slug}`);
    const unknown = await call("/public/brand/aaaaaaaaaaaa");
    const malformed = await call("/public/brand/x");
    expect(hidden.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(malformed.status).toBe(404);
    expect(hidden.text).toBe(unknown.text);
    expect(hidden.text).toBe(malformed.text);
  });

  it("is rate limited", async () => {
    const ip = "203.0.113.77";
    let last = 0;
    for (let i = 0; i < 245; i++) last = (await callDirect("/public/brand/aaaaaaaaaaaa", { ip })).status; // direct: in-memory limiter, and fast enough to stay inside one minute
    expect(last).toBe(429);
  });
});
