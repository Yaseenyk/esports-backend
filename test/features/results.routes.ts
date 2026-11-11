import type { FeatureRoutes } from "./types";

// DELETE last: the editor pass really executes every row. Captain-link creation uses a harmless team name.
const feature: FeatureRoutes = {
  rows: [
    { method: "POST", path: (c) => `/events/${c.ev}/captain-links`, body: { team: "Alpha Wolves" } },
    { method: "GET", path: (c) => `/events/${c.ev}/captain-links` },
    { method: "GET", path: (c) => `/events/${c.ev}/result-submissions` },
    { method: "GET", path: (c) => `/events/${c.ev}/result-submissions/nope/proof`, viewerBlocked: true },
    { method: "POST", path: (c) => `/events/${c.ev}/result-submissions/nope/approve`, body: {} },
    { method: "POST", path: (c) => `/events/${c.ev}/result-submissions/nope/reject`, body: { reason: "x" } },
    { method: "GET", path: (c) => `/events/${c.ev}/result-settings` },
    { method: "PUT", path: (c) => `/events/${c.ev}/result-settings`, body: { autoApprove: false } },
    { method: "DELETE", path: (c) => `/events/${c.ev}/captain-links/nope` },
  ],
  publicRoutes: [
    { method: "GET", path: "/public/report/:token" },
    { method: "POST", path: "/public/report/:token/matches/:mid" },
  ],
};
export default feature;
