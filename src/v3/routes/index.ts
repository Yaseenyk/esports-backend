/** Mounts every v3 router. ONE line in src/index.ts. Each router gates itself by flag BEFORE sign-in and before any v3 table is read. */
import { Hono } from "hono";
import type { AppBindings } from "../../types";
import { discordRoutes } from "./discord";
import { feedbackRoutes } from "./feedback";
import { directoryRoutes } from "./directory";
import { disputeRoutes } from "./disputes";
import { lftRoutes } from "./lft";
import { organiserToolRoutes } from "./organiser-tools";
import { profileRoutes } from "./profiles";
import { resumeRoutes } from "./resume";
import { scrimRoutes } from "./scrims";
import { tournamentRoutes } from "./tournaments";

export const v3 = new Hono<AppBindings>();
v3.route("/", tournamentRoutes);
v3.route("/", resumeRoutes);
v3.route("/", lftRoutes);
v3.route("/", disputeRoutes);
v3.route("/", discordRoutes);
v3.route("/", feedbackRoutes);
// Phases 3-5 (24 Nov 2026): own flags v3.profiles, v3.scrims, v3.directory, all OFF by default.
v3.route("/", profileRoutes);
v3.route("/", scrimRoutes);
v3.route("/", directoryRoutes);
// Organiser match tools (24 Nov 2026): flags v3.rooms, v3.recaps, v3.screenshots, all OFF by default.
v3.route("/", organiserToolRoutes);
