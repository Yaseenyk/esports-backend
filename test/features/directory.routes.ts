import type { FeatureRoutes } from "./types";

const feature: FeatureRoutes = {
  rows: [
    { method: "GET", path: (c) => `/events/${c.ev}/directory` },
    { method: "PUT", path: (c) => `/events/${c.ev}/directory`, body: { listed: false } },
  ],
  publicRoutes: [
    { method: "GET", path: "/public/directory" },
    { method: "POST", path: "/public/directory/:eventId/report" },
  ],
};
export default feature;
