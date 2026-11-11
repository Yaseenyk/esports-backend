import { describe, expect, it } from "vitest";
import { ACCESS_SQL, LEGACY_ACCESS_SQL } from "../../src/policy/access";
import { COUNTER_SQL } from "../../src/policy/shadow";

// The injection guard (test/hardening.test.ts) demands a string LITERAL inside every prepare() call, so each statement's text is
// written twice: as an exported constant (for tests and reading) and as the literal at its single call site. They must never drift.
const sources = import.meta.glob("../../src/policy/*.ts", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const all = Object.values(sources).join("\n");

describe("policy SQL: the literal at the call site equals the exported constant", () => {
  for (const [name, text] of [["ACCESS_SQL", ACCESS_SQL], ["LEGACY_ACCESS_SQL", LEGACY_ACCESS_SQL], ["COUNTER_SQL", COUNTER_SQL]] as const) {
    it(name, () => {
      expect(all).toContain(`prepare(${JSON.stringify(text)})`);
    });
  }
});
