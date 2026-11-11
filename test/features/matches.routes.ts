import type { FeatureRoutes } from "./types";

// DELETE last: the editor pass really executes every row, and deleting the matches first would make later rows run against nothing.
const feature: FeatureRoutes = {
  rows: [
    { method: "GET", path: (c) => `/events/${c.ev}/matches` },
    { method: "PUT", path: (c) => `/events/${c.ev}/matches`, body: { matches: [] } },
    { method: "POST", path: (c) => `/events/${c.ev}/matches/${c.mid}/result`, body: { scoreA: 1, scoreB: 0 } },
    { method: "GET", path: (c) => `/events/${c.ev}/br-results` },
    { method: "PUT", path: (c) => `/events/${c.ev}/br-results`, body: { results: [] } },
    { method: "DELETE", path: (c) => `/events/${c.ev}/matches` },
  ],
  publicRoutes: [],
};
export default feature;
