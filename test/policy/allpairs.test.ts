import { describe, expect, it } from "vitest";
import { decide, type AccessFacts } from "../../src/policy/decide";

/**
 * Pure all-pairs test (blueprint 6.3 item 3): a fixture world is built once in memory, the access query's join is reproduced here in plain code, and
 * decide(legacy) is compared with decide(org) for EVERY (user, event) pair. No HTTP, no D1.
 */
interface World {
  users: string[];
  events: { id: string; owner: string; orgId: string | null }[];
  orgs: Map<string, string>; // id -> status
  orgMembers: Map<string, "admin" | "member">; // `${org}|${user}`
  guests: Map<string, "editor" | "viewer">; // `${event}|${user}`
}

function factsFor(w: World, user: string, ev: World["events"][number]): AccessFacts {
  const status = ev.orgId ? w.orgs.get(ev.orgId) ?? null : null;
  return {
    is_creator: ev.owner === user ? 1 : 0,
    org_id: ev.orgId,
    org_status: status,
    org_role: ev.orgId ? w.orgMembers.get(`${ev.orgId}|${user}`) ?? null : null,
    guest_role: w.guests.get(`${ev.id}|${user}`) ?? null,
  };
}

/** The world as it is after the personal-organisation backfill: every user has org-<id>, admin of it; every event is in its creator's organisation. */
function backfilledWorld(withNullOrgEvents: boolean): World {
  const users = Array.from({ length: 8 }, (_, i) => `u${i}`);
  const w: World = { users, events: [], orgs: new Map(), orgMembers: new Map(), guests: new Map() };
  for (const u of users) {
    w.orgs.set(`org-${u}`, "active");
    w.orgMembers.set(`org-${u}|${u}`, "admin");
  }
  let n = 0;
  for (const u of users) {
    for (let k = 0; k < 3; k++) {
      const id = `e${n++}`;
      w.events.push({ id, owner: u, orgId: withNullOrgEvents && k === 2 ? null : `org-${u}` });
      // deterministic guests: the next two users are editor and viewer on the first event of each owner
      if (k === 0) {
        const i = users.indexOf(u);
        w.guests.set(`${id}|${users[(i + 1) % users.length]}`, "editor");
        w.guests.set(`${id}|${users[(i + 2) % users.length]}`, "viewer");
      }
    }
  }
  return w;
}

describe("decide(legacy) equals decide(org) for every pair before the cut-over", () => {
  for (const withNull of [false, true]) {
    it(`personal-organisation world${withNull ? " with events that still have org_id NULL" : ""}`, () => {
      const w = backfilledWorld(withNull);
      let pairs = 0;
      let owners = 0;
      const mismatches: string[] = [];
      for (const u of w.users) {
        for (const ev of w.events) {
          pairs++;
          const f = factsFor(w, u, ev);
          const a = decide("legacy", f);
          const b = decide("org", f);
          if (a === "owner") owners++;
          if (a !== b) mismatches.push(`${u} on ${ev.id}: legacy ${a} org ${b}`);
        }
      }
      expect(pairs).toBe(8 * 24);
      expect(owners).toBe(24); // every event has exactly its creator as owner
      expect(mismatches).toEqual([]);
    });
  }

  it("a dangling org_id (organisation row missing) also agrees", () => {
    const w = backfilledWorld(false);
    w.orgs.delete("org-u0");
    w.orgMembers.delete("org-u0|u0");
    for (const u of w.users) for (const ev of w.events) {
      const f = factsFor(w, u, ev);
      expect(decide("org", f), `${u} ${ev.id}`).toBe(decide("legacy", f));
    }
  });

  it("the pairs that SHOULD differ after a team organisation exists are exactly the intended ones", () => {
    const w = backfilledWorld(false);
    // u0 hands the club over: team org with u1 admin, u2 member; u0 created e0..e2 there and was removed from it; u3 is a guest editor on e0
    w.orgs.set("org-team", "active");
    w.orgMembers.set("org-team|u1", "admin");
    w.orgMembers.set("org-team|u2", "member");
    for (const ev of w.events.filter((e) => e.owner === "u0")) ev.orgId = "org-team";
    const diffs: string[] = [];
    for (const u of w.users) for (const ev of w.events.filter((e) => e.owner === "u0")) {
      const f = factsFor(w, u, ev);
      const a = decide("legacy", f);
      const b = decide("org", f);
      if (a !== b) diffs.push(`${u}:${ev.id}:${a}->${b}`);
    }
    // u0 (creator, removed) owner -> none; u1 (admin) gains owner (was editor on e0 only: editor -> owner; u1 had no access to e1, e2: none -> owner);
    // u2 (member) none -> editor, except e0 where u2 is a guest viewer: viewer -> editor
    expect(diffs.filter((d) => d.startsWith("u0:")).every((d) => d.endsWith("owner->null"))).toBe(true);
    expect(diffs.filter((d) => d.startsWith("u0:")).length).toBe(3);
    expect(diffs.filter((d) => d.startsWith("u1:")).every((d) => d.endsWith("->owner"))).toBe(true);
    expect(diffs.filter((d) => d.startsWith("u2:")).every((d) => d.endsWith("->editor"))).toBe(true);
    // nobody else is affected
    expect(diffs.filter((d) => !/^u[012]:/.test(d))).toEqual([]);
  });
});
