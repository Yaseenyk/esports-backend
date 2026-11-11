import { describe, expect, it } from "vitest";
import { call, newEvent, newUser } from "./helpers";
import { strictIsoDate } from "../src/routes/events";
// @ts-ignore plain ESM script
import { parseLooseDate } from "../scripts/backfill-starts-on.mjs";

const FORTY = "Grand Finals weekend, Mumbai, 12 and 13th, doors 5pm".slice(0, 40);

describe("starts_on parsing", () => {
  it("strict ISO (write path)", () => {
    const t: [string | null | undefined, string | null][] = [
      ["2026-12-01", "2026-12-01"], [" 2026-12-01 ", "2026-12-01"], ["2026-02-30", null], ["2026-13-01", null],
      ["2026-1-1", null], ["01/12/2026", null], ["1 Dec 2026", null], ["", null], [null, null], [undefined, null],
      [FORTY, null], ["2026-12-01 and more text padding to forty ch", null],
    ];
    for (const [i, o] of t) expect(strictIsoDate(i), String(i)).toBe(o);
    expect(FORTY.length).toBe(40);
  });
  it("tolerant parser (backfill script)", () => {
    const t: [string, string | null][] = [
      ["2026-12-01", "2026-12-01"], ["01/12/2026", "2026-12-01"], ["1.12.2026", "2026-12-01"], ["31/02/2026", null],
      ["1 Dec 2026", "2026-12-01"], ["1st December 2026", "2026-12-01"], ["12-14 Dec 2026", "2026-12-12"],
      ["Dec 5, 2026", "2026-12-05"], ["Sept 9 2026", "2026-09-09"], ["Foo 5 2026", null], ["next Saturday", null],
      ["TBD", null], ["", null], [FORTY, null], ["1 Dec 1999", null],
    ];
    for (const [i, o] of t) expect(parseLooseDate(i), i).toBe(o);
  });
});

describe("starts_on API", () => {
  it("GET /events carries startsOn; PUT recomputes only when date is sent", async () => {
    const u = await newUser();
    const a = await call("/events", { method: "POST", token: u.token, body: { name: "Dated", date: "2026-12-01" } });
    expect(a.json.startsOn).toBe("2026-12-01");
    const b = await call("/events", { method: "POST", token: u.token, body: { name: "Free", date: FORTY } });
    expect(b.json.startsOn).toBeNull();
    const list = await call("/events", { token: u.token });
    expect(Object.fromEntries(list.json.map((e: any) => [e.name, e.startsOn]))).toEqual({ Dated: "2026-12-01", Free: null });
    const p1 = await call(`/events/${a.json.id}`, { method: "PUT", token: u.token, body: { venue: "X" } });
    expect(p1.json.startsOn).toBe("2026-12-01");
    const p2 = await call(`/events/${a.json.id}`, { method: "PUT", token: u.token, body: { date: "soon" } });
    expect(p2.json.startsOn).toBeNull();
    const dup = await call(`/events/${b.json.id}/duplicate`, { method: "POST", token: u.token, body: { name: "Copy", date: "2027-01-02" } });
    expect(dup.json.startsOn).toBe("2027-01-02");
  });
  it("a creator who is also a member appears once", async () => {
    const u = await newUser();
    const e = await newEvent(u.token, "Mine");
    await env_exec(e.id, u.id);
    const list = await call("/events", { token: u.token });
    expect(list.json.filter((x: any) => x.id === e.id).length).toBe(1);
    expect(list.json.find((x: any) => x.id === e.id).role).toBe("owner");
  });
});

import { env } from "cloudflare:workers";
async function env_exec(eventId: string, userId: string) {
  await env.DB.prepare("INSERT INTO event_members (event_id, user_id, role, added_at) VALUES (?, ?, 'editor', ?)").bind(eventId, userId, new Date().toISOString()).run();
}
