import type { FeatureRoutes } from "./types";

const feature: FeatureRoutes = {
  rows: [{ method: "GET", path: (c) => `/events/${c.ev}/sponsor-report` }],
  publicRoutes: [{ method: "POST", path: "/public/hit/:slug" }],
};
export default feature;
