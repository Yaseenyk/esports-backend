import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, openSeed, otpauthUrl, sealSeed, totpCode, verifyTotp } from "../../src/admin/totp";

const enc = new TextEncoder();
const SEED = enc.encode("12345678901234567890"); // RFC 6238 appendix B, SHA-1

describe("RFC 6238 (SHA-1, 8 digits) vectors", () => {
  const vectors: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [t, want] of vectors) {
    it(`T=${t}`, async () => {
      expect(await totpCode(SEED, t * 1000, 8)).toBe(want);
    });
  }
  it("RFC 4226 appendix D counters give the 6-digit sequence", async () => {
    const want = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    for (let i = 0; i < want.length; i++) expect(await hotp(SEED, i)).toBe(want[i]);
  });
});

describe("base32", () => {
  it("round trips and matches the RFC 4648 vector", () => {
    expect(base32Encode(enc.encode("foobar"))).toBe("MZXW6YTBOI");
    expect(new TextDecoder().decode(base32Decode("MZXW6YTBOI======"))).toBe("foobar");
    const r = crypto.getRandomValues(new Uint8Array(20));
    expect(base32Decode(base32Encode(r))).toEqual(r);
    expect(() => base32Decode("not*base32")).toThrow();
  });
});

describe("verifyTotp", () => {
  const now = 1_700_000_000_000;
  it("accepts previous, current and next step; refuses two steps away, wrong and malformed codes", async () => {
    const s = Math.floor(now / 30000);
    expect(await verifyTotp(SEED, await hotp(SEED, s), now, 0)).toBe(s);
    expect(await verifyTotp(SEED, await hotp(SEED, s - 1), now, 0)).toBe(s - 1);
    expect(await verifyTotp(SEED, await hotp(SEED, s + 1), now, 0)).toBe(s + 1);
    expect(await verifyTotp(SEED, await hotp(SEED, s + 2), now, 0)).toBeNull();
    expect(await verifyTotp(SEED, await hotp(SEED, s - 2), now, 0)).toBeNull();
    for (const bad of ["", "12345", "1234567", "abcdef", "------", " 123456"]) expect(await verifyTotp(SEED, bad, now, 0)).toBeNull();
  });
  it("replay: a step at or below lastStep is refused", async () => {
    const s = Math.floor(now / 30000);
    const code = await hotp(SEED, s);
    expect(await verifyTotp(SEED, code, now, s - 1)).toBe(s);
    expect(await verifyTotp(SEED, code, now, s)).toBeNull();
    expect(await verifyTotp(SEED, code, now, s + 5)).toBeNull();
  });
});

describe("sealed seed", () => {
  it("opens with the same key and user, never with another key, another user or a damaged blob", async () => {
    const seed = crypto.getRandomValues(new Uint8Array(20));
    const blob = await sealSeed("kek-one", "user-1", seed);
    expect(blob).not.toContain(base32Encode(seed));
    expect(await openSeed("kek-one", "user-1", blob)).toEqual(seed);
    expect(await openSeed("kek-two", "user-1", blob)).toBeNull();
    expect(await openSeed("kek-one", "user-2", blob)).toBeNull();
    expect(await openSeed("kek-one", "user-1", blob.slice(0, -4) + "AAAA")).toBeNull();
    expect(await openSeed("kek-one", "user-1", "garbage")).toBeNull();
    expect(await sealSeed("kek-one", "user-1", seed)).not.toBe(blob); // fresh IV every time
  });
  it("otpauth URL carries the base32 secret and no email", () => {
    const u = otpauthUrl("user-1", SEED);
    expect(u).toContain(`secret=${base32Encode(SEED)}`);
    expect(u.startsWith("otpauth://totp/")).toBe(true);
  });
});
