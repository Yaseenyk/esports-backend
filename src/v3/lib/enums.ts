/** Closed vocabularies of the v3 layer. Dependency-free: shared by schema, services and tests. */
export const GAMES = ["bgmi", "free_fire", "valorant", "cod_mobile", "cs2", "other"] as const;
export type Game = (typeof GAMES)[number];
export const PLAYER_ROLES = ["igl", "assaulter", "support", "sniper", "scout", "entry", "flex", "controller", "duelist", "initiator", "sentinel", "coach", "manager", "substitute"] as const;
export type PlayerRole = (typeof PLAYER_ROLES)[number];
export const VISIBILITIES = ["private", "unlisted", "public"] as const;
export type Visibility = (typeof VISIBILITIES)[number];
export const TOURNAMENT_FORMATS = ["battle_royale_points", "single_elimination", "double_elimination", "round_robin", "swiss"] as const;
export type TournamentFormat = (typeof TOURNAMENT_FORMATS)[number];
export const TOURNAMENT_STATUSES = ["draft", "published", "registration_open", "registration_closed", "live", "completed", "cancelled"] as const;
export type TournamentStatus = (typeof TOURNAMENT_STATUSES)[number];
export const VENUES = ["online", "offline", "hybrid"] as const;
export type Venue = (typeof VENUES)[number];
export const LFT_KINDS = ["looking_for_team", "looking_for_player"] as const;
export type LftKind = (typeof LFT_KINDS)[number];
export const LFT_STATUSES = ["open", "filled", "closed", "expired", "removed"] as const;
export type LftStatus = (typeof LFT_STATUSES)[number];
export const APPLICATION_STATUSES = ["sent", "accepted", "declined", "withdrawn"] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];
export const DISPUTE_TYPES = ["tie_breaker", "wrong_score", "cheating_claim", "no_show", "roster_violation", "other"] as const;
export type DisputeType = (typeof DISPUTE_TYPES)[number];
export const DISPUTE_STATUSES = ["open", "evidence_requested", "under_review", "resolved", "rejected", "escalated", "withdrawn"] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export const DISPUTE_OUTCOMES = ["upheld", "partially_upheld", "rejected", "no_action"] as const;
export type DisputeOutcome = (typeof DISPUTE_OUTCOMES)[number];
export const EVIDENCE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export type EvidenceMime = (typeof EVIDENCE_MIMES)[number];
export const OUTBOX_KINDS = ["create_team_channel", "assign_team_role", "ping_lobby", "post_result", "archive_channels"] as const;
export type OutboxKind = (typeof OUTBOX_KINDS)[number];
export const OUTBOX_STATUSES = ["pending", "running", "done", "failed", "dead"] as const;

export const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

// Phase 4: scrim finder (migration 0056)
export const SCRIM_REGIONS = ["india", "south_asia", "asia_pacific", "middle_east", "europe", "americas", "other"] as const;
export type ScrimRegion = (typeof SCRIM_REGIONS)[number];
export const SCRIM_STATUSES = ["open", "full", "cancelled", "removed"] as const;
export type ScrimStatus = (typeof SCRIM_STATUSES)[number];
export const SCRIM_REQUEST_STATUSES = ["sent", "accepted", "declined", "withdrawn"] as const;
export type ScrimRequestStatus = (typeof SCRIM_REQUEST_STATUSES)[number];
