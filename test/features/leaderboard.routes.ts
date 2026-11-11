import type { FeatureRoutes } from "./types";

const feature: FeatureRoutes = {
  rows: [
    { method: "GET", path: (c) => `/events/${c.ev}/league` },
    { method: "PUT", path: (c) => `/events/${c.ev}/league`, body: { title: "Season" } },
  ],
  publicRoutes: [{ method: "GET", path: "/public/league/:slug" }],
};
export default feature;
