/** Magic-byte detection for evidence screenshots. The client's MIME type is never trusted. Pure. */
import type { EvidenceMime } from "./enums";

export const EVIDENCE_MAX_BYTES = 400 * 1024;
export const EVIDENCE_MAX_FILES = 4;

export function detectImage(b: Uint8Array): EvidenceMime | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  // RIFF....WEBP
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  return null;
}

export async function sha256Hex(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b));
  let s = "";
  for (const x of d) s += x.toString(16).padStart(2, "0");
  return s;
}
