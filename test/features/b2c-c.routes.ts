import type { FeatureRoutes } from "./types";

// Builder C (migration 0091): personal match journal (v3.journal) and server badges (v3.achievements). Both OFF by default and 404 to everyone; the
// account-scoped rules (owner only, uniform 404 for another account's entry, hidden badges off public JSON) are proved in test/v3/journal-badges.test.ts.
const feature: FeatureRoutes = {
  rows: [],
  publicRoutes: [
    { method: "GET", path: "/v3/me/journal" },
    { method: "POST", path: "/v3/me/journal" },
    { method: "POST", path: "/v3/me/journal/clear" },
    { method: "PUT", path: "/v3/me/journal/:id" },
    { method: "DELETE", path: "/v3/me/journal/:id" },
    { method: "GET", path: "/v3/me/badges" },
    { method: "PUT", path: "/v3/me/badges/hidden" },
  ],
};
export default feature;
