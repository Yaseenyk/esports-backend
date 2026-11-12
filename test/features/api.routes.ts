import type { FeatureRoutes } from "./types";

// Phase 6: the read-only public API. It authenticates with an API key (Bearer ehk_...), never a user token, so these sit in publicRoutes (exempt from the
// "anonymous gets 401" sweep). Their real rules (key required, revoked key, own events only, counts only, closed CORS) are proved by test/api.test.ts.
const feature: FeatureRoutes = {
  rows: [],
  publicRoutes: [
    { method: "GET", path: "/api/v1/events" },
    { method: "GET", path: "/api/v1/events/:id/summary" },
  ],
};
export default feature;
