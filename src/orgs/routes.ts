import { Hono, type MiddlewareHandler } from "hono";
import type { AppBindings } from "../types";
import { requireUser } from "../auth";
import { teamOrgsOn } from "./access";
import { deletionPreview, meContext } from "./context";
import { exportMe } from "./export";
import { convertOrg, convertPreview } from "./convert";
import { acceptInvitation, createOrgInvitation, listOrgInvitations, revokeOrgInvitation } from "./invitations";
import { changeRole, getOrg, listMembers, removeMember } from "./people";
import { orgEvents } from "./home";
import { orgAudit } from "./audit-view";
import { orgAnalytics } from "../api/analytics";

/**
 * Organisation and account-data routes (Phase 2a-i). Mounted by ONE line in src/index.ts.
 *
 *  - /me/context, /me/export and /me/deletion-preview always work for a signed-in user.
 *  - EVERY other route here is gated by flag orgs.team BEFORE sign-in: with the flag off the answer is the router's own notFound, byte for byte the
 *    answer of an unknown route, for anonymous and signed-in callers alike (test/orgs/flag-off.test.ts compares them).
 *  - Authorisation inside a route: not a member is the same 404 as a missing id; a member without the capability gets 403 (they already know it exists).
 */
export const orgs = new Hono<AppBindings>();

const gate: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (!(await teamOrgsOn(c.env.DB))) return c.notFound();
  await next();
};

// ---- always on (user token) ----
orgs.get("/me/context", requireUser, meContext);
orgs.post("/me/export", requireUser, exportMe);
orgs.get("/me/deletion-preview", requireUser, deletionPreview);

// ---- behind orgs.team ----
orgs.post("/me/invitations/accept", gate, requireUser, acceptInvitation);
orgs.get("/orgs/convert/preview", gate, requireUser, convertPreview);
orgs.post("/orgs/convert", gate, requireUser, convertOrg);
orgs.get("/orgs/:id", gate, requireUser, getOrg);
orgs.get("/orgs/:id/members", gate, requireUser, listMembers);
orgs.put("/orgs/:id/members/:userId", gate, requireUser, changeRole);
orgs.delete("/orgs/:id/members/:userId", gate, requireUser, removeMember);
orgs.post("/orgs/:id/invitations", gate, requireUser, createOrgInvitation);
orgs.get("/orgs/:id/invitations", gate, requireUser, listOrgInvitations);
orgs.delete("/orgs/:id/invitations/:iid", gate, requireUser, revokeOrgInvitation);
orgs.get("/orgs/:id/events", gate, requireUser, orgEvents);
orgs.get("/orgs/:id/audit", gate, requireUser, orgAudit);
orgs.get("/orgs/:id/analytics", gate, requireUser, orgAnalytics);
