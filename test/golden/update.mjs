// Regenerates test/golden/*.golden.json. Usage (from the repo root):  node test/golden/update.mjs
// The golden tests run inside the Workers runtime and cannot write files, so in update mode they fail with the new content in the
// message; this script reads it from the JSON report and saves it.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const report = join(tmpdir(), `golden-report-${process.pid}.json`);
const r = spawnSync("npx", ["vitest", "run", "test/golden/gen.test.ts", "--reporter=json", `--outputFile=${report}`], {
  cwd: root,
  shell: true,
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  env: { ...process.env, VITE_UPDATE_GOLDEN: "1" },
});
let out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
try { out += readFileSync(report, "utf8"); } catch { /* no report written */ }
let n = 0;
mkdirSync(here, { recursive: true });
for (const m of out.matchAll(/@@GOLDEN (\S+) (\S+)/g)) {
  const data = JSON.parse(Buffer.from(m[2], "base64").toString("utf8"));
  const sorted = Object.fromEntries(Object.keys(data).sort().map((k) => [k, data[k]]));
  const lines = Object.entries(sorted).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
  writeFileSync(join(here, `${m[1]}.golden.json`), `{\n${lines.join(",\n")}\n}\n`);
  console.log(`wrote test/golden/${m[1]}.golden.json (${Object.keys(sorted).length} entries)`);
  n++;
}
if (!n) {
  console.error(out.slice(-4000));
  process.exit(1);
}
