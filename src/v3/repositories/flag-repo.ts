/** Flag reads for services (the flags table is legacy; this wrapper keeps services free of SQL and of the flags module). */
import { getFlag } from "../../flags";

export const takedownEnforced = (db: D1Database): Promise<boolean> => getFlag(db, "takedown.enforce");
