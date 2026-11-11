import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

/**
 * The migration project. Unlike vitest.config.ts it does NOT apply any migration globally (no setupFiles): each test applies migration files itself,
 * up to N-1, seeds a world, then applies the rest, so the schema step can be tested on data.
 *
 * Run only with:   npx vitest run --config vitest.migrations.config.ts            (package.json script: "test:migrations")
 * Its files are named *.mig.ts, which the default config's include pattern (*.test.ts) does not match, so the normal suite never picks them up.
 *
 * Bindings: TEST_MIGRATIONS = every file in migrations/, TEST_DEFERRED = every file in migrations-deferred/ (the gated data steps, 0042 among them).
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  const deferred = await readD1Migrations(path.join(import.meta.dirname, "migrations-deferred"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            JWT_SECRET: "test-secret-test-secret-test-secret",
            PBKDF2_ITERATIONS: "1000",
            LINK_KEY: "test-link-key-test-link-key-test-link-key",
            TEST_MIGRATIONS: migrations,
            TEST_DEFERRED: deferred,
          },
        },
      }),
    ],
    test: {
      include: ["test/migrations/**/*.mig.ts"],
      testTimeout: 120_000,
    },
  };
});
