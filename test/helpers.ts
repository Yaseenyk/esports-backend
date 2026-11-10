import { exports } from "cloudflare:workers";

const worker = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;

let counter = 0;
export const uniq = () => `${Date.now().toString(36)}${(counter++).toString(36)}`;
/** Unique fake client IP, so tests never share a rate-limit bucket. */
export const freshIp = () => {
  counter++;
  return `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${counter & 255}`;
};

export interface Opts {
  method?: string;
  token?: string;
  gate?: string;
  body?: unknown;
  raw?: BodyInit;
  headers?: Record<string, string>;
  ip?: string;
}

export async function call(path: string, o: Opts = {}) {
  const headers: Record<string, string> = { "cf-connecting-ip": o.ip ?? freshIp(), ...(o.headers ?? {}) };
  if (o.token) headers.authorization = `Bearer ${o.token}`;
  if (o.gate) headers["x-gate-key"] = o.gate;
  let body: BodyInit | undefined = o.raw;
  if (o.body !== undefined) {
    body = JSON.stringify(o.body);
    headers["content-type"] = "application/json";
  }
  const res = await worker.fetch(new Request(`https://api.test${path}`, { method: o.method ?? (body !== undefined ? "POST" : "GET"), headers, body }));
  const bytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder().decode(bytes);
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, json, text, bytes, headers: res.headers };
}

export async function newUser(name = "Tester") {
  const email = `${uniq()}@example.com`;
  const r = await call("/auth/register", { body: { email, password: "correct horse", name } });
  if (r.status !== 201) throw new Error(`register failed ${r.status} ${r.text}`);
  return { email, token: r.json.token as string, id: r.json.user.id as string };
}

export async function newEvent(token: string, name = "Summer Cup") {
  const r = await call("/events", { token, body: { name, game: "BGMI", organiser: "Org", date: "2026-12-01", venue: "Hall 1", emergency: "112", rules: "Be nice", settings: { a: 1 } } });
  if (r.status !== 201) throw new Error(`event failed ${r.status} ${r.text}`);
  return r.json as { id: string; key: string };
}

// A tiny byte sequence with a valid PNG signature (content is not a decodable image, only the magic is checked).
export function pngBytes(size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return b;
}
export function toB64(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}
export const pngDataUrl = (size = 64) => `data:image/png;base64,${toB64(pngBytes(size))}`;

export const basicRoster = () => ({
  teams: [
    { id: "t1", name: "Alpha Wolves" },
    { id: "t2", name: "Beta Hawks" },
  ],
  people: [
    { id: "ALP-001", name: "Asha", teamId: "t1", role: "Player", zones: ["Stage"], minor: false },
    { id: "ALP-002", name: "Ravi", teamId: "t1", role: "Coach", minor: true, guardian: true, photo: pngDataUrl() },
    { id: "BET-001", name: "Mira", teamId: "t2", role: "Player" },
  ],
});

export async function setupEvent(name = "Summer Cup") {
  const u = await newUser();
  const ev = await newEvent(u.token, name);
  const r = await call(`/events/${ev.id}/roster`, { method: "PUT", token: u.token, body: basicRoster() });
  if (r.status !== 200) throw new Error(`roster failed ${r.status} ${r.text}`);
  return { ...u, ev };
}

export async function newGateKey(token: string, eventId: string) {
  const r = await call(`/events/${eventId}/gate-keys`, { token, body: { label: "Door 1" } });
  return r.json as { id: string; key: string };
}

// ---- independent implementation of the pass signature (NOT the Worker's code path) ----
export async function refSig(secret: string, eventKey: string, personId: string, role: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${eventKey}|${personId}|${role}`)));
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, 16);
}
