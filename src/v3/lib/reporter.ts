/** Pseudonymous reporter keys: a salted hash of the ACCOUNT id (one account counts once). Shared by the report routes and account deletion. */
import { hashKey, sha256 } from "../../crypto";

type HashEnv = { HASH_KEY?: string; JWT_SECRET: string };
export const lftReporterHash = (env: HashEnv, userId: string): Promise<string> => sha256(`${hashKey(env)}|lftReporter|${userId}`);
/** Reports on player profiles and team pages (phase 3). */
export const profileReporterHash = (env: HashEnv, userId: string): Promise<string> => sha256(`${hashKey(env)}|profileReporter|${userId}`);
/** Reports on scrim slots (phase 4). */
export const scrimReporterHash = (env: HashEnv, userId: string): Promise<string> => sha256(`${hashKey(env)}|scrimReporter|${userId}`);
