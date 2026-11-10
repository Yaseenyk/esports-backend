import { Hono } from "hono";
import type { AppBindings } from "./types";
import { HttpError } from "./http";
import { auth } from "./routes/auth";
import { events } from "./routes/events";
import { roster } from "./routes/roster";
import { gate } from "./routes/gate";
import { share } from "./routes/share";
import { invites } from "./routes/invites";

const app = new Hono<AppBindings>();

const DEFAULT_ORIGINS = "https://esports.streamerosai.com,http://localhost:3000,http://localhost:4173";

app.use("*", async (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS ?? DEFAULT_ORIGINS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = c.req.header("origin");
  const originOk = !!origin && allowed.includes(origin);
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

app.notFound((c) => c.json({ error: "Not found" }, 404));
app.onError((err, c) => {
  const headers = { "x-content-type-options": "nosniff" };
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status, headers);
  console.error("unhandled error"); // deliberately no details: they could contain personal data
  return c.json({ error: "Internal server error" }, 500, headers);
});

export default app;
