import type { FeatureRoutes } from "./types";

// The account routes (GET/PUT/DELETE /brand) have no event, so the matrix cannot hold them as rows: the lead adds them to ACCOUNT in authz-matrix.test.ts.
// test/brand.test.ts covers them (anonymous 401, per-user isolation).
const kit = { name: "Matrix kit", primaryColor: "#0a84ff", secondaryColor: "#7c3aed" };

const feature: FeatureRoutes = {
  rows: [
    { method: "GET", path: (c) => `/events/${c.ev}/brand` },
    { method: "PUT", path: (c) => `/events/${c.ev}/brand`, body: kit },
    { method: "DELETE", path: (c) => `/events/${c.ev}/brand` },
  ],
  publicRoutes: [{ method: "GET", path: "/public/brand/:slug" }],
};
export default feature;
