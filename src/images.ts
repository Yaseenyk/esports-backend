import { HttpError } from "./http";

export const MAX_PHOTO_BYTES = 400 * 1024;
export const MAX_LOGO_CHARS = 60 * 1024;
const DATA_URL = /^data:image\/(webp|png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;

export interface Image {
  type: string;
  bytes: Uint8Array;
}

function magicOk(type: string, b: Uint8Array): boolean {
  if (type === "image/png") return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
  if (type === "image/jpeg") return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  // webp: "RIFF" .... "WEBP"
  return b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50;
}

export function checkImage(type: string, bytes: Uint8Array, field: string): Image {
  if (!["image/webp", "image/png", "image/jpeg"].includes(type)) throw new HttpError(415, `${field}: only webp, png or jpeg images are allowed`);
  if (bytes.length === 0 || bytes.length > MAX_PHOTO_BYTES) throw new HttpError(413, `${field} must be at most 400 KB`);
  if (!magicOk(type, bytes)) throw new HttpError(415, `${field}: file content does not match its image type`);
  return { type, bytes };
}

export function parsePhotoDataUrl(v: unknown, field: string): Image {
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a data URL string`);
  if (v.length > 600_000) throw new HttpError(413, `${field} must be at most 400 KB`);
  const m = DATA_URL.exec(v);
  if (!m) throw new HttpError(415, `${field} must be a data:image/(webp|png|jpeg);base64 URL`);
  const b64 = m[2]!;
  if (Math.floor((b64.length * 3) / 4) > MAX_PHOTO_BYTES + 2) throw new HttpError(413, `${field} must be at most 400 KB`);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return checkImage(`image/${m[1]}`, bytes, field);
}

export function validateLogo(v: unknown, field: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || v.length > MAX_LOGO_CHARS) throw new HttpError(413, `${field} must be a data URL of at most 60 KB`);
  if (!/^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(v)) throw new HttpError(415, `${field} must be a webp, png or jpeg data URL`);
  return v;
}

export function imageResponse(type: string, bytes: ArrayBuffer | Uint8Array, cache = "private, max-age=300"): Response {
  return new Response(bytes as BodyInit, {
    headers: { "content-type": type, "x-content-type-options": "nosniff", "cache-control": cache, "content-disposition": "inline" },
  });
}
