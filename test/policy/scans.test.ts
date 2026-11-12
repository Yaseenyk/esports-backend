import { describe, expect, it } from "vitest";

/**
 * Source scans (blueprint 6.3 item 6). The files are read as text at build time, so this runs without HTTP or D1.
 * Update a baseline only DOWNWARD, in the PR that converts the module to a named capability (src/policy/access.ts).
 */
const files = import.meta.glob("../../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const src = Object.entries(files).map(([p, text]) => ({ path: p.replace("../../", ""), text }));
const outsidePolicy = src.filter((f) => !f.path.startsWith("src/policy/"));

const count = (text: string, re: RegExp) => text.split("\n").filter((l) => re.test(l)).length;

/** Lines mentioning `my_role` outside src/policy, per file. auth.ts is already at zero: it only delegates. */
export const MY_ROLE_BASELINE: Record<string, number> = {
  "src/features/duplicate.ts": 2,
  "src/features/profiles.ts": 1,
  "src/features/ready.ts": 1,
  "src/features/reminders.ts": 2,
  "src/features/results.ts": 1,
  "src/features/scorer.ts": 3,
  "src/routes/events.ts": 2,
  "src/routes/invites.ts": 1,
  "src/routes/registration.ts": 1,
  "src/routes/roster.ts": 1,
};

/** Lines mentioning `owner_id` outside src/policy, per file (types.ts is the column definition; housekeeping is the invariants SQL). */
export const OWNER_ID_BASELINE: Record<string, number> = {
  "src/ownership.ts": 4,
  "src/types.ts": 1,
  "src/features/brand.ts": 8,
  "src/features/duplicate.ts": 3,
  "src/features/housekeeping.ts": 1,
  "src/features/reminders.ts": 1,
  "src/routes/events.ts": 9,
  "src/routes/members.ts": 2,
  // Staff tooling, not an access decision: a metadata lookup (counts and ids) and the conflict-of-interest check that stops staff ruling on their own events.
  "src/admin/lookup.ts": 3,
  "src/moderation/takedown.ts": 1,
};

function ratchet(re: RegExp, baseline: Record<string, number>) {
  const over: string[] = [];
  for (const f of outsidePolicy) {
    const n = count(f.text, re);
    const allowed = baseline[f.path] ?? 0;
    if (n > allowed) over.push(`${f.path}: ${n} (allowed ${allowed})`);
  }
  return over;
}

describe("ratchet: direct role and creator checks may only shrink", () => {
  it("my_role is read only in the allow-listed files, never more often than the baseline", () => {
    expect(ratchet(/\bmy_role\b/, MY_ROLE_BASELINE)).toEqual([]);
  });
  it("owner_id is read only in the allow-listed files, never more often than the baseline", () => {
    expect(ratchet(/\bowner_id\b/, OWNER_ID_BASELINE)).toEqual([]);
  });
  it("src/auth.ts holds neither: it only delegates to src/policy", () => {
    const a = src.find((f) => f.path === "src/auth.ts")!;
    expect(count(a.text, /\bmy_role\b|\bowner_id\b/)).toBe(0);
  });
  it("the baselines are not stale: a file converted to capabilities must be removed or lowered", () => {
    for (const [base, re] of [[MY_ROLE_BASELINE, /\bmy_role\b/], [OWNER_ID_BASELINE, /\bowner_id\b/]] as const) {
      for (const [path, allowed] of Object.entries(base)) {
        const f = src.find((x) => x.path === path);
        expect(f, `${path} no longer exists: delete its baseline`).toBeDefined();
        expect(count(f!.text, re), `${path}: lower the baseline to the real count`).toBe(allowed);
      }
    }
  });
});

describe("source scans", () => {
  it("no code builds an organisation id ('org-' prefix) outside src/policy, the ownership hand-over and the housekeeping invariants", () => {
    const allowed = new Set(["src/ownership.ts", "src/features/housekeeping.ts"]);
    const bad = outsidePolicy.filter((f) => !allowed.has(f.path) && /['"`]org-['"`$]/.test(f.text)).map((f) => f.path);
    expect(bad).toEqual([]);
  });

  it("src/policy: every prepare() takes a constant string (no template, no concatenation, no variable)", () => {
    const policy = src.filter((f) => f.path.startsWith("src/policy/"));
    expect(policy.length).toBeGreaterThanOrEqual(5);
    for (const f of policy) {
      const total = [...f.text.matchAll(/[.]prepare[(]/g)].length;
      const literal = [...f.text.matchAll(/[.]prepare[(]\s*"/g)].length;
      expect(literal, `${f.path}: every prepare() starts with a string literal`).toBe(total);
      expect(f.text, `${f.path}: SQL by template or concatenation`).not.toMatch(/[.]prepare[(][^)]*(`|[+])/);
    }
  });

  it("src/policy: SQL constants are single string literals", () => {
    const f = src.find((x) => x.path === "src/policy/access.ts")!;
    for (const m of f.text.matchAll(/export const (LEGACY_ACCESS_SQL|ACCESS_SQL) =\s*\n?\s*(.*)/g)) {
      expect(m[2], m[1]).toMatch(/^"[^"]*";$/);
    }
  });

  it("src/policy never writes organisation, membership or event rows (healing is the backfill, never a read path)", () => {
    for (const f of src.filter((x) => x.path.startsWith("src/policy/"))) {
      expect(f.text, f.path).not.toMatch(/\b(UPDATE|DELETE FROM|INSERT INTO|REPLACE INTO)\s+(events|organisations|org_members|event_members)\b/i);
      expect(f.text, f.path).not.toMatch(/SET org_id/i);
    }
  });
});
