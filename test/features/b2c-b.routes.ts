import type { FeatureRoutes } from "./types";

// Builder B (migration 0090): planner (v3.planner), tournament alerts (v3.alerts), LFT matching (v3.lft_match). All OFF by default and 404 to everyone;
// the real rules (token secrecy, uniform 404, owner-only, double opt-in) are proved in test/v3/planner.test.ts, alerts.test.ts and lft-match.test.ts.
const feature: FeatureRoutes = {
  rows: [],
  publicRoutes: [
    { method: "POST", path: "/public/planner" },
    { method: "POST", path: "/public/planner/open" },
    { method: "POST", path: "/public/planner/vote" },
    { method: "POST", path: "/public/planner/unvote" },
    { method: "POST", path: "/public/planner/delete" },
    { method: "GET", path: "/v3/me/alerts" },
    { method: "PUT", path: "/v3/me/alerts" },
    { method: "POST", path: "/v3/me/alerts/confirm-email" },
    { method: "POST", path: "/v3/me/alerts/stop" },
    { method: "DELETE", path: "/v3/me/alerts" },
    { method: "POST", path: "/public/alerts/confirm" },
    { method: "POST", path: "/public/alerts/unsubscribe" },
    { method: "POST", path: "/public/alerts/one-click/:token" },
    { method: "POST", path: "/v3/lft-applications/:id/block" },
    { method: "GET", path: "/v3/me/lft-blocks" },
    { method: "DELETE", path: "/v3/me/lft-blocks/:id" },
    { method: "POST", path: "/v3/lft-applications/:id/report" },
    { method: "GET", path: "/admin/v1/v3/lft/request-reports" },
  ],
};
export default feature;
