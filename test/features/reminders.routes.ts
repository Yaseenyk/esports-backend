import type { FeatureRoutes } from "./types";

const feature: FeatureRoutes = {
  rows: [
    { method: "GET", path: (c) => `/events/${c.ev}/reminders`, viewerBlocked: true },
    { method: "GET", path: (c) => `/events/${c.ev}/reminders/recipients` },
    { method: "POST", path: (c) => `/events/${c.ev}/reminders`, body: {} },
    { method: "POST", path: (c) => `/events/${c.ev}/reminders/test` },
    { method: "DELETE", path: (c) => `/events/${c.ev}/reminders/nope` },
  ],
  publicRoutes: [
    { method: "GET", path: "/public/unsubscribe/:token" },
    { method: "POST", path: "/public/unsubscribe/:token" },
  ],
};
export default feature;
