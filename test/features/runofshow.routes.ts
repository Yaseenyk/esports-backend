import type { FeatureRoutes } from "./types";

const feature: FeatureRoutes = {
  rows: [
    { method: "GET", path: (c) => `/events/${c.ev}/runofshow` },
    { method: "PUT", path: (c) => `/events/${c.ev}/runofshow`, body: { items: [{ atTime: "09:00", title: "Doors open" }] } },
    { method: "POST", path: (c) => `/events/${c.ev}/runofshow/nope/status`, body: { status: "done" } },
    { method: "POST", path: (c) => `/events/${c.ev}/runofshow/link`, body: { showNotes: false } },
    { method: "DELETE", path: (c) => `/events/${c.ev}/runofshow/link` },
  ],
  publicRoutes: [{ method: "GET", path: "/public/run/:token" }],
};
export default feature;
