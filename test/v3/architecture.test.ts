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
