import type { FeatureRoutes } from "./types";

const feature: FeatureRoutes = {
  rows: [
    // Owner and editor may copy; a viewer is refused by the non-GET rule; a stranger gets the same 404 as a missing event.
    { method: "POST", path: (c) => `/events/${c.ev}/duplicate`, body: { name: "Matrix copy", include: {} } },
  ],
  publicRoutes: [],
};
export default feature;
