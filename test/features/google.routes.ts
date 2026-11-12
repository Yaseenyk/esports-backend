import type { FeatureRoutes } from "./types";

// Sign in with Google (src/routes/google.ts). Public by design: the Google ID token in the body is the credential, it is verified against
// Google's keys, and the route is rate limited like /auth/login. It answers 404 until GOOGLE_CLIENT_ID is set.
const feature: FeatureRoutes = {
  rows: [],
  publicRoutes: [{ method: "POST", path: "/auth/google" }],
};
export default feature;
