import type { FeatureRoutes } from "./types";

// Phase 2a-i: organisation routes (src/orgs/routes.ts). They take no event capability, so they sit in publicRoutes (exempt from the "anonymous gets 401" sweep):
// with flag orgs.team off (the default) every one answers the same 404 as an unknown route to EVERYONE, anonymous or signed in, and the golden baseline pins that.
// The real rules (not a member = 404, member without the capability = 403, escalation, last admin, uniform invitation answers) are proved by test/orgs/*.test.ts.
// /me/context, /me/export and /me/deletion-preview are NOT here: they always work and need a user token, so they are in ACCOUNT (test/golden/rows.ts).
const feature: FeatureRoutes = {
  rows: [],
  publicRoutes: [
    { method: "POST", path: "/me/invitations/accept" },
    { method: "GET", path: "/orgs/convert/preview" },
    { method: "POST", path: "/orgs/convert" },
    { method: "GET", path: "/orgs/:id" },
    { method: "GET", path: "/orgs/:id/members" },
    { method: "PUT", path: "/orgs/:id/members/:userId" },
    { method: "DELETE", path: "/orgs/:id/members/:userId" },
    { method: "POST", path: "/orgs/:id/invitations" },
    { method: "GET", path: "/orgs/:id/invitations" },
    { method: "DELETE", path: "/orgs/:id/invitations/:iid" },
    { method: "GET", path: "/orgs/:id/events" },
    { method: "GET", path: "/orgs/:id/audit" },
    { method: "GET", path: "/orgs/:id/analytics" },
  ],
};
export default feature;
