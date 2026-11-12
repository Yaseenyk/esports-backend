import { Hono } from "hono";
import type { AppBindings } from "./types";
import { HttpError } from "./http";
import { auth } from "./routes/auth";
import { events } from "./routes/events";
import { roster } from "./routes/roster";
import { gate } from "./routes/gate";
import { share } from "./routes/share";
import { invites } from "./routes/invites";
import { contact } from "./routes/contact";
import { registration } from "./routes/registration";
import { members } from "./routes/members";
import { live } from "./routes/live";
import { scheduled } from "./features/reminders-cron";
import { linksBackfillTick } from "./features/links-backfill";
import { mountFeatures } from "./features";
import { verify } from "./routes/verify";
import { track } from "./routes/track";
import { google } from "./routes/google";
import { admin } from "./admin/routes";
import { publicReports } from "./moderation/public-reports";
import { orgs } from "./orgs/routes";
import { api } from "./api/routes";

const app = new Hono<AppBindings>();

const DEFAULT_ORIGINS = "https://esports.streamerosai.com,http://localhost:3000,http://localhost:4173";

app.use("*", async (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = c.req.header("origin");
  // The public API (/api/v1) is for servers: CORS stays closed there, so no browser page on any origin can read it.
  const originOk = !!origin && allowed.includes(origin) && !c.req.path.startsWith("/api/v1/");
  if (c.req.method === "OPTIONS") {
    if (!originOk) return c.json({ error: "Origin not allowed" }, 403);
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": origin!,
        "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        "access-control-allow-headers": "Authorization,Content-Type,X-Gate-Key",
        "access-control-max-age": "86400",
        vary: "Origin",
      },
    });
  }
  await next();
  c.res.headers.set("x-content-type-options", "nosniff");
  c.res.headers.append("vary", "Origin");
  if (originOk) c.res.headers.set("access-control-allow-origin", origin!);
});

app.get("/", (c) => c.json({ ok: true, name: "esports-api" }));
app.route("/", auth);
app.route("/", events);
app.route("/", roster);
app.route("/", gate);
app.route("/", share);
app.route("/", invites);
app.route("/", contact);
app.route("/", registration);
app.route("/", members);
app.route("/", live);
app.route("/", verify);
app.route("/", track);
app.route("/", google);
app.route("/", admin); // Phase 1: /admin/v1 (staff; 404 for everyone else)
app.route("/", publicReports);
app.route("/", api); // Phases 4, 6, 7: /me/analytics, /me/api-keys, /me/entitlements (always on) and the read-only /api/v1
app.route("/", orgs); // Phase 2a-i: /me/context, /me/export, and the /orgs routes (404 unless flag orgs.team is on)
mountFeatures(app);

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  const headers = { "x-content-type-options": "nosniff" };
  if (err instanceof HttpError) return c.json({ ...err.extra, error: err.message }, err.status, headers);
  console.error("unhandled error"); // deliberately no details: they could contain personal data
  return c.json({ error: "Internal server error" }, 500, headers);
});

// The Workers runtime reads `scheduled` from the default export (the reminder sender runs on the cron trigger in wrangler.toml).
Object.assign(app, {
  scheduled: (c: ScheduledController, e: AppBindings["Bindings"], x: ExecutionContext) => {
    scheduled(c, e, x);
    x.waitUntil(linksBackfillTick(c.scheduledTime, e)); // S7 phase A: hash old clear tokens a few rows at a time
  },
});

export default app;
