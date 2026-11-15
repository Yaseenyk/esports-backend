/** Mounts every v3 router. ONE line in src/index.ts. Each router gates itself by flag BEFORE sign-in and before any v3 table is read. */
import { Hono } from "hono";
import type { AppBindings } from "../../types";
import { discordRoutes } from "./discord";
import { feedbackRoutes } from "./feedback";
import { disputeRoutes } from "./disputes";
import { lftRoutes } from "./lft";
import { resumeRoutes } from "./resume";
import { tournamentRoutes } from "./tournaments";

export const v3 = new Hono<AppBindings>();
v3.route("/", tournamentRoutes);
v3.route("/", resumeRoutes);
v3.route("/", lftRoutes);
v3.route("/", disputeRoutes);
v3.route("/", discordRoutes);
v3.route("/", feedbackRoutes);
