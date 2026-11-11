import type { Hono } from "hono";
import type { AppBindings } from "../types";
import type { FeatureModule } from "./types";
import * as matches from "./matches";
import * as leaderboard from "./leaderboard";
import * as directory from "./directory";
import * as reminders from "./reminders";
import * as profiles from "./profiles";
import * as scorer from "./scorer";
import * as results from "./results";
import * as stages from "./stages";
import * as ready from "./ready";
import * as runofshow from "./runofshow";
import * as brand from "./brand";
import * as duplicate from "./duplicate";
import * as sponsorreport from "./sponsorreport";

/** Every feature module, by id. printkits, overlay and embed have no backend module. */
export const FEATURES: Record<string, FeatureModule> = {
  matches, leaderboard, directory, reminders, profiles, scorer, results, stages, ready, runofshow, brand, duplicate, sponsorreport,
};

/** Mounts the routes of every feature module at the root. */
export function mountFeatures(app: Hono<AppBindings>): void {
  for (const mod of Object.values(FEATURES)) app.route("/", mod.routes);
}
