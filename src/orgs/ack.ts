/**
 * Organiser acknowledgement for registration forms (privacy minimum, blueprint 17.4, pm-review-r2 Q-arch-r2-26). The text exists HERE and nowhere else;
 * the frontend reads it from GET /events/:id/registration (`acknowledgement`) and shows it next to the tick box.
 *
 * ACK_VERSION is stored in registration_forms.ack_version with the time in ack_at. Changing the text means a new version string, so every
 * stored version still names the words that were agreed to. [LEGAL] interim wording, to be replaced by counsel's text in Phase 3.
 */
export const ACK_VERSION = "interim-1";

export const ACK_TEXT =
  "Before you open this form: you are responsible for having permission to collect these details, including permission from a parent or guardian where a player is under 18. Ask only for what you need. Do not publish the names or photos of players under 18. Remove players' details when you no longer need them. Esports Hub does not collect entry fees or hold prize money.";

/** Shape returned to the frontend. */
export const acknowledgementOffer = (): { version: string; text: string } => ({ version: ACK_VERSION, text: ACK_TEXT });
