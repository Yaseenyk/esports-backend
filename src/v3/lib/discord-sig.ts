/**
 * Discord interactions signature check: Ed25519 over `timestamp + rawBody`, public key and signature in hex. Web Crypto only (supported by Workers).
 * Pure: returns a boolean, never throws, never logs.
 */
const hex = (s: string): Uint8Array | null => {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(s)) return null;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Five minutes is generous for clock drift and still stops replay of an old captured request. */
export const MAX_SKEW_SEC = 300;

export async function verifyDiscordSignature(opts: {
  publicKeyHex: string | undefined;
  signatureHex: string | null | undefined;
  timestamp: string | null | undefined;
  rawBody: string;
  nowSec: number;
}): Promise<boolean> {
  const { publicKeyHex, signatureHex, timestamp, rawBody, nowSec } = opts;
  if (!publicKeyHex || !signatureHex || !timestamp) return false;
  if (!/^\d{9,12}$/.test(timestamp) || Math.abs(nowSec - Number(timestamp)) > MAX_SKEW_SEC) return false;
  const key = hex(publicKeyHex);
  const sig = hex(signatureHex);
  if (!key || key.length !== 32 || !sig || sig.length !== 64) return false;
  try {
    const k = await crypto.subtle.importKey("raw", key, { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, k, sig, new TextEncoder().encode(timestamp + rawBody));
  } catch {
    return false;
  }
}
