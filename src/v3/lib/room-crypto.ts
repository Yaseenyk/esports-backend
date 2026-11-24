/**
 * Encryption at rest for match-room credentials (flag v3.rooms). Pure WebCrypto, no layer imports.
 *
 *  - Key: SHA-256 of "eh-rooms-v1|" + the Worker secret ROOM_CREDENTIALS_KEY (at least 32 characters; set with `wrangler secret put ROOM_CREDENTIALS_KEY`).
 *    No key, or a short one, means the feature is "not configured": nothing is encrypted with a weak or default key.
 *  - Cipher: AES-256-GCM, a fresh random 96-bit IV per encryption, additional data "room:<roomId>:<eventId>" so a ciphertext copied to another row
 *    (or another event) does not decrypt.
 *  - Stored form: "v1.<iv base64url>.<ciphertext base64url>". The plaintext is JSON {"r": roomId, "p": password}.
 *  - Nothing here logs, and an error never carries the plaintext or the key.
 */
export const ROOM_KEY_MIN = 32;

export interface RoomSecret { roomId: string; password: string }

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u: Uint8Array): string => {
  let s = "";
  for (const x of u) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unb64 = (s: string): Uint8Array => {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};

export const roomKeyConfigured = (secret: string | undefined): secret is string => typeof secret === "string" && secret.length >= ROOM_KEY_MIN;

async function key(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(`eh-rooms-v1|${secret}`));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
const aad = (roomId: string, eventId: string): Uint8Array => enc.encode(`room:${roomId}:${eventId}`);

export async function sealRoomSecret(secret: string, ids: { roomId: string; eventId: string }, value: RoomSecret): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = enc.encode(JSON.stringify({ r: value.roomId, p: value.password }));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(ids.roomId, ids.eventId) }, await key(secret), pt));
  return `v1.${b64(iv)}.${b64(ct)}`;
}

/** The credentials, or null when the text is not a ciphertext of this key for this room (tampered, moved or another key). Never throws. */
export async function openRoomSecret(secret: string, ids: { roomId: string; eventId: string }, sealed: string): Promise<RoomSecret | null> {
  try {
    const [v, ivS, ctS] = sealed.split(".");
    if (v !== "v1" || !ivS || !ctS) return null;
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivS), additionalData: aad(ids.roomId, ids.eventId) }, await key(secret), unb64(ctS));
    const o = JSON.parse(dec.decode(pt)) as { r?: unknown; p?: unknown };
    return typeof o.r === "string" && typeof o.p === "string" ? { roomId: o.r, password: o.p } : null;
  } catch {
    return null;
  }
}
