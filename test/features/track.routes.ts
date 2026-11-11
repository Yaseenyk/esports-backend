import type { FeatureRoutes } from "./types";

// Stream A: the unauthenticated tracking beacon (src/routes/track.ts). It has no event rows; it is public by design and always answers 204.
const feature: FeatureRoutes = {
  rows: [],
  publicRoutes: [{ method: "POST", path: "/public/t" }],
};
export default feature;
