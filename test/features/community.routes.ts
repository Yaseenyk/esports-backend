import type { FeatureRoutes } from "./types";

// Community features (src/v3/routes/community.ts and community-admin.ts; migration 0080). Flags v3.calendar and v3.trust are OFF by default, and then every
// route answers the unknown-route 404 to everyone (pinned by test/v3/community-flags.test.ts and the golden file). With a flag on, the real rules (sign-in,
// 18+, verified organisation membership, proof of participation, one rating per event, the window, staff only) are proved by test/v3/calendar.test.ts and
// test/v3/trust.test.ts. The public reads are rate limited and never carry an account id, a reporter, a proof reference or an organisation id.
const feature: FeatureRoutes = {
  rows: [],
  publicRoutes: [
    { method: "GET", path: "/public/community/status" },
    { method: "GET", path: "/public/calendar" },
    { method: "GET", path: "/v3/me/calendar" },
    { method: "POST", path: "/v3/orgs/:orgId/calendar" },
    { method: "PUT", path: "/v3/calendar/:id" },
    { method: "DELETE", path: "/v3/calendar/:id" },
    { method: "GET", path: "/public/tournaments/:slug/trust" },
    { method: "GET", path: "/v3/tournaments/:slug/trust/me" },
    { method: "POST", path: "/v3/tournaments/:slug/trust/ratings" },
    { method: "GET", path: "/v3/me/trust/ratings" },
    { method: "DELETE", path: "/v3/trust/ratings/:id" },
    { method: "POST", path: "/v3/trust/ratings/:id/reply" },
    { method: "POST", path: "/v3/trust/ratings/:id/report" },
    { method: "GET", path: "/admin/v1/v3/trust/reports" },
    { method: "GET", path: "/admin/v1/v3/trust/ratings/:id" },
    { method: "POST", path: "/admin/v1/v3/trust/ratings/:id/hide" },
    { method: "POST", path: "/admin/v1/v3/trust/ratings/:id/restore" },
    { method: "POST", path: "/admin/v1/v3/trust/reports/:id/dismiss" },
    { method: "GET", path: "/admin/v1/v3/calendar/:id" },
    { method: "POST", path: "/admin/v1/v3/calendar/:id/hide" },
    { method: "POST", path: "/admin/v1/v3/calendar/:id/restore" },
  ],
};
export default feature;
