/// <reference types="vite/client" />
import { expect } from "vitest";

/**
 * Golden files: committed JSON that records what the API does today. A change that alters one must say why in its PR.
 * The tests run inside the Workers runtime, which cannot write to disk, so regenerating goes through a node script:
 *     node test/golden/update.mjs          (runs the golden tests with VITE_UPDATE_GOLDEN=1 and writes test/golden/*.golden.json)
 * In update mode a test "fails" with the new content in its message (console output does not leave the Workers runtime) and the script saves it.
 */
const files = import.meta.glob("./*.golden.json", { eager: true, import: "default" }) as Record<string, unknown>;
const UPDATE = import.meta.env.VITE_UPDATE_GOLDEN === "1";

const b64 = (s: string) => {
  let bin = "";
  for (const b of new TextEncoder().encode(s)) bin += String.fromCharCode(b);
  return btoa(bin);
};

/** Compares a flat record with the committed one and reports every differing key (so a failure lists what changed, not a 900-line diff). */
export function expectGolden(name: string, actual: Record<string, unknown>): void {
  if (UPDATE) {
    throw new Error(`@@GOLDEN ${name} ${b64(JSON.stringify(actual))}`); // the only channel out of the Workers runtime that vitest reports
  }
  const expected = files[`./${name}.golden.json`] as Record<string, unknown> | undefined;
  expect(expected, `test/golden/${name}.golden.json is missing: run node test/golden/update.mjs and commit it`).toBeDefined();
  const diffs: string[] = [];
  for (const k of Object.keys(actual)) {
    if (!(k in expected!)) diffs.push(`new   ${k} = ${JSON.stringify(actual[k])}`);
    else if (JSON.stringify(actual[k]) !== JSON.stringify(expected![k])) diffs.push(`changed ${k}: ${JSON.stringify(expected![k])} -> ${JSON.stringify(actual[k])}`);
  }
  for (const k of Object.keys(expected!)) if (!(k in actual)) diffs.push(`gone  ${k}`);
  expect(diffs, `golden ${name} differs; if intended, run node test/golden/update.mjs and explain why in the PR`).toEqual([]);
}

/** Type-only shape of a JSON value: object keys sorted with the type of each value, arrays by their first element. Values are never recorded. */
export function shapeOf(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0])] : [];
  if (typeof v === "object") return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, shapeOf((v as Record<string, unknown>)[k])]));
  return typeof v;
}
