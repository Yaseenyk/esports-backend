import type { FeatureRoutes } from "./types";

const feature: FeatureRoutes = {
  rows: [
    { method: "GET", path: (c) => `/events/${c.ev}/scorer-links`, viewerBlocked: true },
    { method: "POST", path: (c) => `/events/${c.ev}/scorer-links`, body: { label: "Matrix referee", hours: 1 } },
    { method: "DELETE", path: (c) => `/events/${c.ev}/scorer-links/nope` },
  ],
  publicRoutes: [
    { method: "GET", path: "/public/score/:token" },
    { method: "POST", path: "/public/score/:token/matches/:mid/result" },
    { method: "POST", path: "/public/score/:token/br" },
  ],
};
export default feature;
