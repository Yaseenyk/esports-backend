import { Hono } from "hono";
import type { AppBindings } from "../types";
import type { RouteRules } from "./types";

export const routes = new Hono<AppBindings>();

export const routeRules: RouteRules = {};
