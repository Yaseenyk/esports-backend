# Feature route rules for the authorisation matrix

`test/authz-matrix.test.ts` discovers every `test/features/*.routes.ts` with `import.meta.glob` and treats its rows exactly like the built-in ones.
Each file default-exports a `FeatureRoutes` (see `types.ts`):

```ts
import type { FeatureRoutes } from "./types";

const feature: FeatureRoutes = {
  rows: [
    // method, path built from the context, optional body, and flags
    { method: "GET", path: (c) => `/events/${c.ev}/leaderboard` },
    { method: "PUT", path: (c) => `/events/${c.ev}/ready`, body: { teams: [] } },
    { method: "DELETE", path: (c) => `/events/${c.ev}/ready/nope`, owner: true },   // owner-only
    { method: "GET", path: (c) => `/events/${c.ev}/sponsor-report/export`, viewerBlocked: true }, // viewer gets 403 even on GET
  ],
  // routes that need no sign-in: method + path pattern exactly as registered in Hono
  publicRoutes: [{ method: "GET", path: "/public/league/:slug" }],
};
export default feature;
```

## What the matrix checks for every row

- **Anonymous, garbage token, gate key, Basic scheme:** 401.
- **Stranger** (signed in, not a member): 404 with `{ error: "Event not found" }`, identical to a non-existent event. So authorise with `ownedEvent`/`ownerEvent` BEFORE reading the body or the child id.
- **Viewer:** GET rows give 200 (unless `owner` or `viewerBlocked`, then 403); every non-GET row gives 403.
- **Editor:** everything except `owner: true` rows must not be 401/403, must not say "Event not found" and must not 500 (400 and 404 for a dummy child id are fine). The row really runs, so use bodies that are harmless; put destructive rows last in the list.
- **Owner-only** (`owner: true`): editor gets 403.
- **Inventory:** every route registered on the app must be in this matrix (compared by method and path shape, `:param` names ignored) or in a `publicRoutes` list. A public route is exempt from the anonymous-401 check, so it must rate limit and never return personal data, passes, keys or tokens.
- Every key of a module's `routeRules` (src/features/<id>.ts) must be a registered route.

## The context `c`

`ev` event id, `mid` a real match id (stage `main`, round 1, teams "Alpha Wolves" v "Beta Hawks"), `pid` a person id, `kid` gate key id, `iid` invite id, `sid` submission id, `rid` registration id, `uid` another member's user id.
Use a literal `nope` as the final segment for a child that must not exist (`/events/${c.ev}/ready/nope`); the inventory normalises it to a parameter. If a feature needs another real id in the context, ask the lead to add it to `world()` in the matrix and to `Ctx` in `types.ts`.

Behaviour tests (what the routes actually do) live in `test/<id>.test.ts`, not here.
