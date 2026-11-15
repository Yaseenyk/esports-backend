/** The one place a drizzle client is built. Repositories only. */
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";

export const orm = (db: D1Database) => drizzle(db, { schema });
export type Orm = ReturnType<typeof orm>;
export { schema };
