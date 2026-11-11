import type { FeatureRoutes } from "./types";

const feature: FeatureRoutes = {
  rows: [
    { method: "GET", path: (c) => `/events/${c.ev}/ready`, viewerBlocked: true },
    { method: "PUT", path: (c) => `/events/${c.ev}/ready/settings`, body: { graceMinutes: 10 } },
    // "Nobody" is not in the match, so the editor pass gets a 400 and the match is never really forfeited.
    { method: "POST", path: (c) => `/events/${c.ev}/ready/${c.mid}/forfeit`, body: { team: "Nobody" } },
    { method: "POST", path: (c) => `/events/${c.ev}/ready/${c.mid}/clear`, body: {} },
  ],
  publicRoutes: [
    { method: "GET", path: "/public/ready/:token" },
    { method: "POST", path: "/public/ready/:token/matches/:mid" },
  ],
};
export default feature;
