/**
 * TOTP (RFC 6238, HMAC-SHA1, WebCrypto) and the sealed seed (blueprint 4.3).
 *
 *  - `hotp` / `totpCode`: RFC 4226 / 6238. Default 6 digits, 30 s steps. The RFC vectors use 8 digits (see test/admin/totp.test.ts).
 *  - `verifyTotp`: accepts the previous, current and next step, refuses any step <= lastStep (replay), compares every candidate (no early exit).
 *  - `sealSeed` / `openSeed`: AES-GCM, key = SHA-256(TOTP_KEK), additional data binds the blob to the staff user id so it cannot be moved to another row.
 *  - Pure WebCrypto: no `cloudflare:*` imports.
 */
import { b64url, fromB64url, timingSafeEqual } from "../crypto";

const enc = new TextEncoder();
export const TOTP_STEP_SECONDS = 30;
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("bad base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Uint8Array.from(out);
}

/** 20 random bytes (the SHA-1 block-friendly size most authenticator apps expect). */
export const newSeed = (): Uint8Array => crypto.getRandomValues(new Uint8Array(20));

/** RFC 4226 HOTP. `counter` is an integer below 2^53. */
export async function hotp(seed: Uint8Array, counter: number, digits = 6): Promise<string> {
  const msg = new Uint8Array(8);
  const view = new DataView(msg.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey("raw", seed, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const o = mac[mac.length - 1]! & 15;
  const bin = ((mac[o]! & 0x7f) << 24) | (mac[o + 1]! << 16) | (mac[o + 2]! << 8) | mac[o + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export const stepOf = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

export const totpCode = (seed: Uint8Array, nowMs: number, digits = 6): Promise<string> => hotp(seed, stepOf(nowMs), digits);

/** The accepted step (previous, current or next) when `code` matches and the step is above `lastStep`; otherwise null. All candidates are always computed. */
export async function verifyTotp(seed: Uint8Array, code: string, nowMs: number, lastStep: number): Promise<number | null> {
  const given = /^\d{6}$/.test(code) ? code : "------";
  const now = stepOf(nowMs);
  let hit: number | null = null;
  for (const step of [now - 1, now, now + 1]) {
    const want = await hotp(seed, step);
    const same = timingSafeEqual(want, given);
    if (same && step > lastStep && (hit === null || step > hit)) hit = step;
  }
  return hit;
}

/** otpauth:// URI for authenticator apps. The label is the staff user id (never an email). */
export function otpauthUrl(label: string, seed: Uint8Array, issuer = "Esports Hub Staff"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${base32Encode(seed)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${TOTP_STEP_SECONDS}`;
}

async function kekKey(kek: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`totp-kek|${kek}`));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** `v1.<iv>.<ciphertext>` (base64url). */
export async function sealSeed(kek: string, userId: string, seed: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode(`totp|${userId}`) }, await kekKey(kek), seed);
  return `v1.${b64url(iv)}.${b64url(ct)}`;
}

/** The seed, or null for any blob that is malformed, was sealed for another user or another key. Never throws. */
export async function openSeed(kek: string, userId: string, blob: string): Promise<Uint8Array | null> {
  try {
    const [v, iv, ct] = blob.split(".");
    if (v !== "v1" || !iv || !ct) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(iv), additionalData: enc.encode(`totp|${userId}`) }, await kekKey(kek), fromB64url(ct));
    return new Uint8Array(pt);
  } catch {
    return null;
  }
}
