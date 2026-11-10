import { describe, expect, it } from "vitest";
import { call, newEvent, newGateKey, newUser } from "./helpers";

const N = 2000;
const big = () => ({
  teams: Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, name: `Team ${i}` })),
  people: Array.from({ length: N }, (_, i) => ({ id: `P-${String(i).padStart(4, "0")}`, name: `Person ${i}`, teamId: `t${i % 40}`, role: i % 9 === 0 ? "Coach" : "Player", zones: ["Main hall"], minor: i % 17 === 0 })),
});

describe("a 2000-person event", () => {
  it("saves, signs every pass, serves the gate list and checks in, within sane time", async () => {
    const u = await newUser();
    const ev = await newEvent(u.token, "Big Open");
    let t = Date.now();
    const save = await call(`/events/${ev.id}/roster`, { method: "PUT", token: u.token, body: big() });
    expect(save.status).toBe(200);
    expect(save.json.people).toBe(N);
    const saveMs = Date.now() - t;

    t = Date.now();
    const passes = await call(`/events/${ev.id}/passes`, { token: u.token });
    const passMs = Date.now() - t;
    expect(passes.json).toHaveLength(N);

    const gk = await newGateKey(u.token, ev.id);
    t = Date.now();
    const gate = await call("/gate/roster", { gate: gk.key });
    const gateMs = Date.now() - t;
    expect(gate.json.people).toHaveLength(N);

    const codes = (passes.json as { code: string }[]).slice(0, 100).map((p) => p.code);
    t = Date.now();
    const batch = await call("/gate/checkin/batch", { gate: gk.key, body: { codes } });
    const batchMs = Date.now() - t;
    expect(batch.json.results.every((r: { status: string }) => r.status === "ok")).toBe(true);

    console.log(`2000 people: save ${saveMs} ms, passes ${passMs} ms, gate roster ${gateMs} ms, 100 check-ins ${batchMs} ms`);
    expect(saveMs).toBeLessThan(15000);
    expect(passMs).toBeLessThan(8000);
  }, 60000);
});
