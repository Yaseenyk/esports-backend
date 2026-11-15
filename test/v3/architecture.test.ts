import { describe, expect, it } from "vitest";

/**
 * Trinity, enforced (esports-hub CLAUDE.md): routes -> services -> repositories (+ adapters). A route never imports a repository or the db layer; a service
 * never writes SQL; only repositories import the schema or drizzle; nothing outside src/v3 reaches into repositories or db.
 */
const files = import.meta.glob("../../src/**/*.ts", { eager: true, query: "?raw", import: "default" }) as Record<string, string>;
const all = Object.entries(files).map(([p, text]) => ({ path: p.replace("../../", ""), text }));
const v3 = all.filter((f) => f.path.startsWith("src/v3/"));
const layer = (l: string) => v3.filter((f) => f.path.startsWith(`src/v3/${l}/`));
const importsOf = (text: string): string[] => [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]!);
const valueImportsOf = (text: string): string[] => [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/g)].map((m) => m[1]!);

describe("v3 Trinity layering", () => {
  it("finds the layers", () => {
    for (const l of ["routes", "services", "repositories", "adapters", "lib", "db"]) expect(layer(l).length, l).toBeGreaterThan(0);
  });

  it("a route never imports a repository, the db layer, drizzle or a schema", () => {
    for (const f of layer("routes")) {
      for (const i of importsOf(f.text)) {
        expect(i, `${f.path} imports ${i}`).not.toMatch(/repositories\/|\/db\/|\/db$|drizzle|schema/);
      }
    }
  });

  it("a route holds no SQL and no role check", () => {
    for (const f of layer("routes")) {
      expect(f.text, f.path).not.toMatch(/\.prepare\(|\bSELECT\s|\bINSERT\s+INTO|\bUPDATE\s+\w+\s+SET|\bDELETE\s+FROM/);
      expect(f.text, f.path).not.toMatch(/\brole\s*[=!]==|my_role|\.role\b/);
    }
  });

  it("a service never imports drizzle, the schema or the db layer, and never writes SQL", () => {
    for (const f of layer("services")) {
      for (const i of importsOf(f.text)) expect(i, `${f.path} imports ${i}`).not.toMatch(/drizzle|\/db\/|\/db$|schema|routes\//);
      expect(f.text, f.path).not.toMatch(/\.prepare\(|\.batch\(|\bSELECT\s+\S|\bINSERT\s+INTO|\bUPDATE\s+\w+\s+SET|\bDELETE\s+FROM/);
    }
  });

  it("an adapter builds payloads only: no SQL, and repositories only as type imports", () => {
    for (const f of layer("adapters")) {
      expect(f.text, f.path).not.toMatch(/\.prepare\(|\bSELECT\s+\S|\bINSERT\s+INTO/);
      for (const i of valueImportsOf(f.text)) expect(i, `${f.path} imports ${i}`).not.toMatch(/repositories\/|drizzle|schema|\/db\//);
    }
  });

  it("a repository never imports a service, a route or an adapter and decides nothing about who may see a row", () => {
    for (const f of layer("repositories")) {
      for (const i of importsOf(f.text)) expect(i, `${f.path} imports ${i}`).not.toMatch(/services\/|routes\/|adapters\//);
      expect(f.text, f.path).not.toMatch(/\bHttpError\b/);
    }
  });

  it("the Discord REST client and budget helper are leaf modules: no layer imports, no drizzle, no schema", () => {
    const d = v3.filter((f) => f.path.startsWith("src/v3/discord/"));
    expect(d.length).toBeGreaterThan(0);
    for (const f of d) {
      for (const i of importsOf(f.text)) expect(i, `${f.path} imports ${i}`).not.toMatch(/repositories\/|services\/|routes\/|adapters\/|drizzle|schema|\/db\//);
    }
  });

  it("lib stays pure: no layer imports, no database", () => {
    for (const f of layer("lib")) {
      for (const i of importsOf(f.text)) expect(i, `${f.path} imports ${i}`).not.toMatch(/repositories\/|services\/|routes\/|adapters\/|drizzle|\/db\//);
    }
  });

  it("the seo guard is dependency-free (it is shared with the frontend build)", () => {
    const g = v3.find((f) => f.path === "src/v3/lib/seo-guard.ts")!;
    expect(importsOf(g.text)).toEqual([]);
  });

  it("only repositories import the schema or drizzle", () => {
    for (const f of v3.filter((x) => !x.path.startsWith("src/v3/repositories/") && !x.path.startsWith("src/v3/db/"))) {
      for (const i of importsOf(f.text)) expect(i, `${f.path} imports ${i}`).not.toMatch(/drizzle|db\/schema/);
    }
  });

  it("code outside src/v3 reaches v3 only through routes and services (never repositories or db)", () => {
    for (const f of all.filter((x) => !x.path.startsWith("src/v3/"))) {
      for (const i of importsOf(f.text)) expect(i, `${f.path} imports ${i}`).not.toMatch(/v3\/(repositories|db|adapters)/);
    }
  });
});

describe("feedback bot module layering", () => {
  const f = (p: string) => v3.find((x) => x.path === p);
  const FILES = [
    "src/v3/routes/feedback.ts", "src/v3/routes/feedback-admin.ts", "src/v3/services/feedback-service.ts", "src/v3/services/feedback-admin-service.ts",
    "src/v3/repositories/feedback-repo.ts", "src/v3/adapters/feedback-adapter.ts", "src/v3/lib/feedback.ts",
  ];
  it("has one file per layer", () => {
    for (const p of FILES) expect(f(p), p).toBeDefined();
  });
  it("routes reach data only through services; services reach SQL only through the repository", () => {
    for (const p of ["src/v3/routes/feedback.ts", "src/v3/routes/feedback-admin.ts"]) {
      for (const i of importsOf(f(p)!.text)) expect(i, `${p} imports ${i}`).not.toMatch(/repositories\/|adapters\/|drizzle|schema|\/db\/|images/);
    }
    for (const p of ["src/v3/services/feedback-service.ts", "src/v3/services/feedback-admin-service.ts"]) {
      expect(importsOf(f(p)!.text).some((i) => /repositories\/feedback-repo/.test(i)), p).toBe(true);
      expect(f(p)!.text, p).not.toMatch(/\.prepare\(|\.batch\(/);
    }
  });
  it("only the feedback and retention/account services and the repository name the feedback tables", () => {
    for (const x of all) {
      if (/^src\/v3\/repositories\/feedback-repo\.ts$/.test(x.path) || x.path === "src/v3/db/schema.ts" || x.path === "src/v3/lib/personal-tables.ts") continue; // the shared deletion/export table list names tables, nothing more
      expect(x.text, x.path).not.toMatch(/\bfeedback_(reports|attachments|attachment_blobs)\b/);
    }
  });
  it("the pure lib and the adapter hold no SQL and import no layer; the adapter never mentions ip_hash or bytes", () => {
    for (const p of ["src/v3/lib/feedback.ts", "src/v3/adapters/feedback-adapter.ts"]) {
      expect(f(p)!.text, p).not.toMatch(/\.prepare\(|\bSELECT\s+\S|\bINSERT\s+INTO/);
      expect(f(p)!.text, p).not.toMatch(/\br\.ip_hash|\br\.attach_token|\.data\b/);
    }
  });
  it("the staff routes live behind the /admin/v1 door (mounted in src/admin/routes.ts) and the public routes in v3/routes/index.ts", () => {
    expect(all.find((x) => x.path === "src/admin/routes.ts")!.text).toContain("feedbackAdminRoutes");
    expect(f("src/v3/routes/index.ts")!.text).toContain("feedbackRoutes");
  });
});

describe("Download my data (v3 export) layering", () => {
  const f = (p: string) => all.find((x) => x.path === p)!;
  it("the export route reaches v3 only through the export service and names no v3 table", () => {
    const t = f("src/orgs/export.ts").text;
    expect(importsOf(t).filter((i) => /v3\//.test(i))).toEqual(["../v3/services/export-service"]);
    for (const table of ["player_profiles", "player_games", "lft_listings", "lft_applications", "disputes", "dispute_evidence", "v3_team_captains", "feedback_reports"]) expect(t, table).not.toMatch(new RegExp(`\b${table}\b`));
  });
  it("the service goes through repositories, the adapter holds no SQL, and neither names a secret column", () => {
    expect(importsOf(f("src/v3/services/export-service.ts").text).some((i) => /repositories\/export-repo/.test(i))).toBe(true);
    for (const p of ["src/v3/adapters/export-adapter.ts", "src/v3/services/export-service.ts", "src/v3/repositories/export-repo.ts"]) {
      expect(f(p).text, p).not.toMatch(/ip_hash|attach_token|token_hash|pw_hash|data\s+FROM|dispute_evidence_blobs|feedback_attachment_blobs/);
    }
  });
});
