import type { FeatureRoutes } from "./types";

// Stream S (Phase 1): /admin/v1 staff routes (src/admin/routes.ts). They are not event routes and take no user capability, so they sit in
// publicRoutes (exempt from the "anonymous gets 401" sweep). The staff matrix (test/admin/staff-matrix.test.ts) proves the real rule: every one
// answers 404 to anonymous, ordinary-user, expired and wrong-audience callers, and the golden baseline pins that answer.
const feature: FeatureRoutes = {
  rows: [],
  publicRoutes: [
    { method: "POST", path: "/admin/v1/session" },
    { method: "POST", path: "/admin/v1/session/enroll" },
    { method: "POST", path: "/admin/v1/session/renew" },
    { method: "POST", path: "/admin/v1/session/step-up" },
    { method: "GET", path: "/admin/v1/lookup" },
    { method: "GET", path: "/admin/v1/audit" },
    { method: "GET", path: "/admin/v1/flags" },
    { method: "PUT", path: "/admin/v1/flags/:key" },
    { method: "POST", path: "/admin/v1/users/:id/suspend" },
    { method: "POST", path: "/admin/v1/users/:id/restore" },
    { method: "POST", path: "/admin/v1/orgs/:id/suspend" },
    { method: "POST", path: "/admin/v1/orgs/:id/restore" },
    { method: "GET", path: "/admin/v1/usage" },
    { method: "GET", path: "/admin/v1/reports" },
    { method: "POST", path: "/admin/v1/reports/:id/decide" },
    { method: "GET", path: "/admin/v1/takedowns" },
    { method: "POST", path: "/admin/v1/takedowns" },
    { method: "POST", path: "/admin/v1/takedowns/:type/:id/restore" },
  ],
};
export default feature;
