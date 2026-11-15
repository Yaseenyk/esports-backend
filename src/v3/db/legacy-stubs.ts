/**
 * Read-only stubs of LEGACY tables, used only so v3 tables can declare foreign keys. They are imported but never re-exported by schema.ts, so
 * drizzle-kit does not see them and never generates DDL for them. The real tables come from migrations 0001-0050.
 */
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", { id: text("id").primaryKey() });
export const events = sqliteTable("events", { id: text("id").primaryKey() });
export const teamProfiles = sqliteTable("team_profiles", { id: text("id").primaryKey() });
