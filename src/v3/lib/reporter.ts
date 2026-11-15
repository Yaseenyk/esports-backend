/** The pseudonymous reporter key of an LFT report: a salted hash of the ACCOUNT id (one account counts once). Shared by the report route and account deletion. */
import { hashKey, sha256 } from "../../crypto";

export const lftReporterHash = (env: { HASH_KEY?: string; JWT_SECRET: string }, userId: string): Promise<string> => sha256(`${hashKey(env)}|lftReporter|${userId}`);
