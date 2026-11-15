import type { FeatureRoutes } from "./types";

// Feedback bot (migration 0054, flag feedback.enabled OFF by default). The /feedback routes are public on purpose: the visitor may be anyone, so they
// are rate limited (5 per hour and 20 per day per hashed address, 300 per day site wide), take an attach token for uploads and withdrawal, and never
// return personal data. With the flag off every one answers the unknown-route 404 (pinned by the golden file). The /admin/v1/feedback routes sit here
// like the other staff routes: the staff matrix proves they answer 404 to anyone without a platform staff token.
const feature: FeatureRoutes = {
  rows: [],
  publicRoutes: [
    { method: "GET", path: "/feedback/status" },
    { method: "POST", path: "/feedback" },
    { method: "POST", path: "/feedback/:id/attachments" },
    { method: "DELETE", path: "/feedback/:id" },
    { method: "GET", path: "/admin/v1/feedback" },
    { method: "GET", path: "/admin/v1/feedback/summary" },
    { method: "GET", path: "/admin/v1/feedback/:id" },
    { method: "GET", path: "/admin/v1/feedback/:id/attachments/:aid" },
    { method: "PATCH", path: "/admin/v1/feedback/:id" },
  ],
};
export default feature;
