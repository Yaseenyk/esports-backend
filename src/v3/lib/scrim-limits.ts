/** Scrim finder limits shared by the finder and the manager services (no import cycle between them). Pure. */
export const SCRIM_LIMITS = { MIN_LEAD_SEC: 15 * 60, MAX_AHEAD_SEC: 30 * 86_400, SLOTS_MAX: 24, NOTE_MAX: 200, SERVER_MAX: 40, MESSAGE_MAX: 300 } as const;
