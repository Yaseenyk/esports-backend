/// <reference types="vite/client" />
// Route and principal definitions shared by test/authz-matrix.test.ts and the golden baseline (test/golden/*).
// The rows themselves are unchanged; they used to live inside the matrix file.
import { expect } from "vitest";
import type { Ctx, FeatureRoutes, FeatureRow } from "../features/types";
import { call, newGateKey, newUser, pngDataUrl, setupEvent, uniq } from "../helpers";

export type R = FeatureRow;
export const D = "nope"; // dummy child id: never exists, so a state-changing call by an allowed role can only 404 on the child

export const CORE_ROUTES: R[] = [
  { method: "GET", path: () => "/events" },
  { method: "POST", path: () => "/events", body: { name: "x" } },
  { method: "GET", path: (c) => `/events/${c.ev}` },
  { method: "PUT", path: (c) => `/events/${c.ev}`, body: {} },
  { method: "DELETE", path: (c) => `/events/${c.ev}`, owner: true },
  { method: "GET", path: (c) => `/events/${c.ev}/roster` },
  { method: "PUT", path: (c) => `/events/${c.ev}/roster`, body: {} },
  { method: "GET", path: (c) => `/events/${c.ev}/photos/${c.pid}` },
  { method: "PUT", path: (c) => `/events/${c.ev}/photos/${D}`, body: {} },
  { method: "DELETE", path: (c) => `/events/${c.ev}/photos/${D}` },
  { method: "GET", path: (c) => `/events/${c.ev}/passes`, viewerBlocked: true },
  { method: "POST", path: (c) => `/events/${c.ev}/gate-keys`, body: { label: "" } },
  { method: "GET", path: (c) => `/events/${c.ev}/gate-keys` },
  { method: "DELETE", path: (c) => `/events/${c.ev}/gate-keys/${D}` },
  { method: "GET", path: (c) => `/events/${c.ev}/checkins` },
  { method: "DELETE", path: (c) => `/events/${c.ev}/checkins` },
  { method: "POST", path: (c) => `/events/${c.ev}/people/${D}/share`, body: {} },
  { method: "DELETE", path: (c) => `/events/${c.ev}/people/${D}/share` },
  { method: "POST", path: (c) => `/events/${c.ev}/invites`, body: {} },
  { method: "GET", path: (c) => `/events/${c.ev}/invites` },
  { method: "DELETE", path: (c) => `/events/${c.ev}/invites/${D}` },
  { method: "GET", path: (c) => `/events/${c.ev}/submissions` },
  { method: "GET", path: (c) => `/events/${c.ev}/submissions/${c.sid}/photo` },
  { method: "POST", path: (c) => `/events/${c.ev}/submissions/${D}/approve`, body: {} },
  { method: "POST", path: (c) => `/events/${c.ev}/submissions/${D}/reject`, body: {} },
  { method: "PUT", path: (c) => `/events/${c.ev}/registration`, body: { title: "t" } },
  { method: "GET", path: (c) => `/events/${c.ev}/registration` },
  { method: "GET", path: (c) => `/events/${c.ev}/registrations` },
  { method: "POST", path: (c) => `/events/${c.ev}/registrations/${D}/approve`, body: {} },
  { method: "POST", path: (c) => `/events/${c.ev}/registrations/${D}/reject`, body: {} },
  { method: "GET", path: (c) => `/events/${c.ev}/members`, owner: true },
  { method: "POST", path: (c) => `/events/${c.ev}/members`, body: { email: "x@example.com", role: "viewer" }, owner: true },
  { method: "DELETE", path: (c) => `/events/${c.ev}/members/${c.uid}`, owner: true },
  { method: "GET", path: (c) => `/events/${c.ev}/live` },
  { method: "PUT", path: (c) => `/events/${c.ev}/live`, body: {} },
];

export const featureFiles = import.meta.glob("../features/*.routes.ts", { eager: true }) as Record<string, { default: FeatureRoutes }>;
export const FEATURES = Object.entries(featureFiles).sort(([x], [y]) => x.localeCompare(y)).map(([file, m]) => ({ file, ...m.default }));
export const ROUTES: R[] = [...CORE_ROUTES, ...FEATURES.flatMap((f) => f.rows)];

// Account-level routes: need a user token, have no event.
export const ACCOUNT: { method: string; path: string; body?: unknown }[] = [
  { method: "GET", path: "/me" },
  { method: "POST", path: "/auth/change-password", body: { current: "x", next: "yyyyyyyy" } },
  { method: "POST", path: "/auth/delete-account", body: { password: "x" } },
  // brand kit and team profiles belong to the signed-in user, not to an event
  { method: "GET", path: "/brand" },
  { method: "PUT", path: "/brand", body: { name: "x", primaryColor: "#0a84ff", secondaryColor: "#7c3aed" } },
  { method: "DELETE", path: "/brand" },
  { method: "GET", path: "/profiles" },
  { method: "POST", path: "/profiles", body: { name: "x" } },
  { method: "PUT", path: "/profiles/:id", body: { name: "x" } },
  { method: "DELETE", path: "/profiles/:id" },
  { method: "POST", path: "/profiles/:id/link", body: { eventId: "x", teamName: "x" } },
  { method: "POST", path: "/profiles/:id/unlink", body: { eventId: "x", teamName: "x" } },
];

export const GATE: { method: string; path: string; body?: unknown }[] = [
  { method: "GET", path: "/gate/roster" },
  { method: "GET", path: "/gate/photos/ALP-002" },
  { method: "POST", path: "/gate/checkin", body: { code: "x" } },
  { method: "POST", path: "/gate/checkin/batch", body: { codes: ["x"] } },
];


// Intentionally unauthenticated (rate limited and token-gated where they expose anything).
export const PUBLIC = new Set([
  "GET /",
  "POST /auth/register",
  "POST /auth/login",
  "POST /auth/forgot",
  "POST /auth/reset",
  "GET /public/pass/:token",
  "GET /public/pass/:token/photo",
  "GET /public/invite/:token",
  "POST /public/invite/:token/submit",
  "GET /public/registration/:token",
  "POST /public/registration/:token/submit",
  "POST /public/contact",
  "GET /public/live/:slug",
  ...FEATURES.flatMap((f) => f.publicRoutes.map((r) => `${r.method} ${r.path}`)),
]);

export async function world() {
  const o = await setupEvent();
  const ev = o.ev.id;
  const key = await newGateKey(o.token, ev);
  const inv = (await call(`/events/${ev}/invites`, { token: o.token, body: { teamId: "t1" } })).json;
  const sub = await call(`/public/invite/${inv.token}/submit`, { body: { name: "Sub Mitter", photo: pngDataUrl() } });
  const sid = sub.json.id as string;
  const form = (await call(`/events/${ev}/registration`, { method: "PUT", token: o.token, body: { title: "Reg", teamSize: 1, subs: 0 } })).json;
  const reg = await call(`/public/registration/${form.token}/submit`, { body: { teamName: `Team ${uniq()}`, captainName: "Cap Tain", captainContact: "cap@example.com", players: [{ name: "P One" }] } });
  const editor = await newUser("Ed");
  const viewer = await newUser("Vi");
  const stranger = await newUser("Str");
  const third = await newUser("Third");
  expect((await call(`/events/${ev}/members`, { token: o.token, body: { email: third.email, role: "viewer" } })).status).toBe(201);
  expect((await call(`/events/${ev}/members`, { token: o.token, body: { email: editor.email, role: "editor" } })).status).toBe(201);
  expect((await call(`/events/${ev}/members`, { token: o.token, body: { email: viewer.email, role: "viewer" } })).status).toBe(201);
  const made = await call(`/events/${ev}/matches`, { method: "PUT", token: o.token, body: { matches: [{ stage: "main", round: 1, slot: 1, a: "Alpha Wolves", b: "Beta Hawks" }] } });
  expect(made.status).toBe(200);
  const ctx: Ctx = { ev, pid: "ALP-002", kid: key.id, iid: inv.id, sid, rid: reg.json.id, uid: third.id, mid: made.json.matches[0].id };
  return { o, key, inv, editor, viewer, stranger, ctx, form };
}

