import type { FeatureRoutes } from "./types";

// Stream R: the one public report route (src/moderation/public-reports.ts). No event-scoped rows: the staff decision routes live under /admin/v1 (stream S).
const feature: FeatureRoutes = {
  rows: [],
  publicRoutes: [{ method: "POST", path: "/public/report" }],
};
export default feature;
