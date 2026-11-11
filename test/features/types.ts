/** Shared by test/authz-matrix.test.ts and every test/features/<id>.routes.ts. See README.md in this folder. */
export interface Ctx {
  ev: string; // event id (owner: o, editor, viewer and third are members; stranger is not)
  pid: string; // a real person id
  kid: string; // a real gate key id
  iid: string; // a real invite id
  sid: string; // a real submission id
  rid: string; // a real registration id
  uid: string; // another member's user id
  mid: string; // a real match id of this event (in stage "main", round 1)
}

export interface FeatureRow {
  method: string;
  path: (c: Ctx) => string;
  body?: unknown;
  owner?: boolean; // owner-only: editors and viewers get 403
  viewerBlocked?: boolean; // a GET that a viewer still may not do (403)
}

export interface FeatureRoutes {
  rows: FeatureRow[];
  /** Routes that need no sign-in: method plus the path pattern exactly as registered, for example { method: "GET", path: "/public/league/:slug" }. */
  publicRoutes: { method: string; path: string }[];
}
