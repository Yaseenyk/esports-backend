/**
 * Staff flag routes (blueprint 9.3, 11.3).
 *
 *  GET /admin/v1/flags           every known flag with its effective value, default, whether staff may set it, and who/when last changed it.
 *  PUT /admin/v1/flags/:key      { value: boolean, reasonCode } for the settable keys. `kill.*` needs a step-up code; every change is audited in the
 *                                same batch as the write (`admin.flag_set`, one row per CHANGE; setting the value a key already has writes nothing).
 *
 * Settable by staff: the seven `kill.*`, `shed.tracking`, `takedown.enforce`. NOT settable here (runbook SQL only): `authz.mode`, `orgs.team`,
 * `audit.off`, `admin.enabled` (a staff API that can switch itself off or the audit log off is not a safe design).
 */
import { Hono } from "hono";
import { auditStmts } from "../audit";
import { FLAG_DEFAULTS, getFlagFresh, resetFlagsCache, type FlagKey } from "../flags";
import { HttpError, readJson } from "../http";
import { KILL_KEYS } from "./kill";
import { requireStepUp, type AdminBindings } from "./session";

export const REASON_CODES = ["spam", "scam", "minor_exposed", "contact_details", "abuse", "legal_request", "user_request", "security", "other"] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export function reasonCodeOf(body: Record<string, unknown>): ReasonCode {
  const v = body.reasonCode;
  if (typeof v !== "string" || !(REASON_CODES as readonly string[]).includes(v)) throw new HttpError(400, "reasonCode is required", { code: "reason_required", allowed: REASON_CODES });
  return v as ReasonCode;
}

export const SETTABLE_FLAGS: readonly FlagKey[] = [...KILL_KEYS, "shed.tracking", "takedown.enforce"];
const isStepUpKey = (k: string): boolean => (KILL_KEYS as readonly string[]).includes(k);

export const flagRoutes = new Hono<AdminBindings>();

flagRoutes.get("/flags", async (c) => {
  const r = await c.env.DB.prepare("SELECT key, value, updated_by, updated_at, note FROM flags").all<{ key: string; value: string; updated_by: string; updated_at: string; note: string }>();
  const stored = new Map(r.results.map((x) => [x.key, x]));
  const out = [];
  for (const key of Object.keys(FLAG_DEFAULTS) as FlagKey[]) {
    const row = stored.get(key);
    out.push({
      key,
      value: await getFlagFresh(c.env.DB, key),
      default: FLAG_DEFAULTS[key],
      settable: SETTABLE_FLAGS.includes(key),
      stepUp: isStepUpKey(key),
      updatedAt: row ? row.updated_at : null,
      updatedBy: row ? row.updated_by : null,
      reasonCode: row ? row.note : null,
    });
  }
  return c.json({ flags: out });
});

flagRoutes.put("/flags/:key", async (c) => {
  const key = c.req.param("key");
  if (!(SETTABLE_FLAGS as readonly string[]).includes(key)) throw new HttpError(404, "Not found");
  const staff = isStepUpKey(key) ? requireStepUp(c) : c.get("staff");
  const body = await readJson(c as never, 2048);
  if (typeof body.value !== "boolean") throw new HttpError(400, "value must be true or false");
  const reasonCode = reasonCodeOf(body);
  const before = await getFlagFresh(c.env.DB, key as FlagKey);
  if (before === body.value) return c.json({ ok: true, key, value: body.value, changed: false });
  const off = (await getFlagFresh(c.env.DB, "audit.off")) === true;
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO flags (key, value, updated_by, updated_at, note) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at, note = excluded.note",
    ).bind(key, JSON.stringify(body.value), staff.id, new Date().toISOString(), reasonCode),
    ...auditStmts(c.env.DB, { action: "admin.flag_set", actorType: "staff", actorId: staff.id, targetType: "flag", targetId: key, reasonCode, meta: { flag: key, value: body.value } }, off),
  ]);
  resetFlagsCache(c.env.DB);
  return c.json({ ok: true, key, value: body.value, changed: before !== body.value });
});
