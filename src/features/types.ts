import type { Hono } from "hono";
import type { AppBindings } from "../types";

/**
 * Declares who may call each route of a feature module, keyed "METHOD /registered/path/:param" (exactly as Hono registers it).
 * The authz matrix test checks that every key is a registered route. It is documentation the tests can enforce; the real checks are in the handlers.
 *  - roles: who gets past authorisation ('viewer' means a view-only member; viewers can only ever call GET).
 *  - public: true for routes that need no sign-in (they must also be listed in publicRoutes of test/features/<id>.routes.ts).
 *  - limit: free text describing the rate limit, for reviewers.
 */
export interface RouteRule {
  roles?: ("owner" | "editor" | "viewer")[];
  public?: boolean;
  limit?: string;
}
export type RouteRules = Record<string, RouteRule>;

export interface FeatureModule {
  routes: Hono<AppBindings>;
  routeRules: RouteRules;
}
