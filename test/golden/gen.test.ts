/// <reference types="vite/client" />
import { describe, it, vi } from "vitest";
import { call, newUser, newEvent } from "../helpers";
import { callDirect } from "./direct";
import { ACCOUNT, GATE, PUBLIC, ROUTES, world, type R } from "./rows";
import { expectGolden, shapeOf } from "./golden";

// G1: authorisation golden. Every route x principal {anon, garbage token, gate key, stranger, viewer, editor, owner}
// records "status | error text | sorted body keys". The rows are the ones the authorisation matrix uses.
// G2: shape golden for /me, the events routes and members (type of every field, never the values).
// Regenerate with: node test/golden/update.mjs  (and say why in the PR).
vi.setConfig({ testTimeout: 180_000 });

type W = Awaited<ReturnType<typeof world>>;
const D = "nope";

function describeBody(json: any, text: string): string {
  if (json === null) return text === "" ? "empty" : "not-json";
  if (Array.isArray(json)) return `[] ${json.length && typeof json[0] === "object" && json[0] ? Object.keys(json[0]).sort().join(",") : ""}`.trim();
  if (typeof json === "object") return Object.keys(json).filter((k) => k !== "error").sort().join(",");
  return typeof json;
}

const PRINCIPALS = ["anon", "garbage", "gate", "stranger", "viewer", "editor", "owner"] as const;
type P = (typeof PRINCIPALS)[number];

const placeholders = { ev: ":ev", pid: ":pid", kid: ":kid", iid: ":iid", sid: ":sid", rid: ":rid", uid: ":uid", mid: ":mid" };

function auth(p: P, w: W, gateKey: string): { token?: string; gate?: string } {
  switch (p) {
    case "anon": return {};
    case "garbage": return { token: "garbage" };
    case "gate": return { gate: gateKey };
    case "stranger": return { token: w.stranger.token };
    case "viewer": return { token: w.viewer.token };
    case "editor": return { token: w.editor.token };
    case "owner": return { token: w.o.token };
  }
}

async function record(out: Record<string, string>, p: P, w: W, rows: R[]) {
  const a = auth(p, w, w.key.key);
  for (const r of rows) {
    const path = r.path(w.ctx);
    const res = await callDirect(path, { method: r.method, body: r.body ?? (r.method === "GET" ? undefined : {}), ...a });
    out[`${p} ${r.method} ${r.path(placeholders as never)}`] = `${res.status} | ${typeof res.json?.error === "string" ? res.json.error : "-"} | ${describeBody(res.json, res.text)}`;
  }
  for (const r of ACCOUNT) {
    const res = await callDirect(r.path, { method: r.method, body: r.body ?? (r.method === "GET" ? undefined : {}), ...a });
    out[`${p} ${r.method} ${r.path}`] = `${res.status} | ${typeof res.json?.error === "string" ? res.json.error : "-"} | ${describeBody(res.json, res.text)}`;
  }
  for (const r of GATE) {
    const res = await callDirect(r.path, { method: r.method, body: r.body ?? (r.method === "GET" ? undefined : {}), ...a });
    out[`${p} ${r.method} ${r.path}`] = `${res.status} | ${typeof res.json?.error === "string" ? res.json.error : "-"} | ${describeBody(res.json, res.text)}`;
  }
}

describe("golden: authorisation, every route x principal", () => {
  it("records and compares", async () => {
    const out: Record<string, string> = {};
    // anon, garbage, gate, stranger and viewer never change anything, so they share one world.
    const shared = await world();
    for (const p of ["anon", "garbage", "gate", "stranger", "viewer"] as const) await record(out, p, shared, ROUTES);
    // The editor and the owner really execute their rows: each gets a fresh world. The owner's event delete goes last.
    await record(out, "editor", await world(), ROUTES);
    const isEventDelete = (r: R) => r.method === "DELETE" && r.path({ ev: ":ev", pid: "", kid: "", iid: "", sid: "", rid: "", uid: "", mid: "" }) === "/events/:ev";
    await record(out, "owner", await world(), [...ROUTES.filter((r) => !isEventDelete(r)), ...ROUTES.filter(isEventDelete)]);
    // Public routes (no sign-in): called once anonymously with a dummy token or slug.
    for (const k of [...PUBLIC].sort()) {
      const [method, pattern] = k.split(" ") as [string, string];
      const res = await callDirect(pattern.replace(/:[A-Za-z]+/g, "x1"), { method, body: method === "GET" ? undefined : {} });
      out[`public ${k}`] = `${res.status} | ${typeof res.json?.error === "string" ? res.json.error : "-"} | ${describeBody(res.json, res.text)}`;
    }
    expectGolden("authz", out);
  });
});

describe("golden: response shapes", () => {
  it("records and compares /me, the events routes and members", async () => {
    const w = await world();
    const t = w.o.token;
    const ev = w.ctx.ev;
    const created = await call("/events", { token: t, body: { name: "Shape Cup", game: "BGMI", date: "2026-12-01", settings: { a: 1 } } });
    const out: Record<string, unknown> = {
      "GET /me": shapeOf((await call("/me", { token: t })).json),
      "GET /events": shapeOf((await call("/events", { token: t })).json),
      "GET /events/:id": shapeOf((await call(`/events/${ev}`, { token: t })).json),
      "POST /events": shapeOf(created.json),
      "POST /events status": created.status,
      "PUT /events/:id": shapeOf((await call(`/events/${ev}`, { method: "PUT", token: t, body: { name: "Renamed" } })).json),
      "GET /events/:id/members": shapeOf((await call(`/events/${ev}/members`, { token: t })).json),
      "POST /events/:id/members": shapeOf((await call(`/events/${ev}/members`, { token: t, body: { email: (await newUser()).email, role: "editor" } })).json),
      "DELETE /events/:id/members/:uid": shapeOf((await call(`/events/${ev}/members/${w.ctx.uid}`, { method: "DELETE", token: t })).json),
      "GET /events (viewer sees role)": shapeOf((await call("/events", { token: w.viewer.token })).json),
      "POST /auth/register": shapeOf((await call("/auth/register", { body: { email: `shape${Date.now()}@example.com`, password: "correct horse", name: "S" } })).json),
      "POST /auth/login": shapeOf((await call("/auth/login", { body: { email: w.o.email, password: "correct horse" } })).json),
    };
    void newEvent;
    void D;
    expectGolden("shapes", out);
  });
});
