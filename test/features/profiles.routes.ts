import type { FeatureRoutes } from "./types";

// The /profiles routes are account-level (a signed-in user's own pages, not event-scoped), so the event matrix cannot exercise them:
// they are listed here only so the route inventory passes. test/profiles.test.ts checks 401 for anonymous callers, ownership (404 for another user's page) and the event access rule of /link.
const feature: FeatureRoutes = {
  rows: [],
  publicRoutes: [
    { method: "GET", path: "/public/team/:slug" },
  ],
};
export default feature;
