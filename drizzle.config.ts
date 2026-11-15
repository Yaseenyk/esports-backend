import { defineConfig } from "drizzle-kit";

/**
 * v3 tables only. Output goes to a scratch folder (NOT migrations/) so drizzle's meta files never sit next to wrangler's migrations.
 * Run `node scripts/v3-migration.mjs`: it generates here, makes the DDL idempotent and writes migrations/0051_v3_core.sql.
 */
export default defineConfig({ dialect: "sqlite", schema: "./src/v3/db/schema.ts", out: "./src/v3/db/kit" });
