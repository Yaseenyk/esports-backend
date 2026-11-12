import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { call, newEvent, newUser } from "./helpers";

const players = (n: number, minorAt = -1) => Array.from({ length: n }, (_, i) => ({ name: `Player ${i + 1}`, ign: `IGN${i + 1}`, minor: i === minorAt }));
const body = (name: string, n = 4) => ({ teamName: name, captainName: "Asha Captain", captainContact: "9999900000", players: players(n, 1), notes: "" });

async function setup() {
  const u = await newUser();
  const ev = await newEvent(u.token, "Spring Cup");
  const form = await call(`/events/${ev.id}/registration`, { method: "PUT", token: u.token, body: { acknowledge: true, title: "Spring Cup registration", teamSize: 4, subs: 1, maxTeams: 2 } });
  return { u, ev, form };
}

describe("registration form", () => {
  it("is created once, updated in place, and shown to the public without private details", async () => {
    const { u, ev, form } = await setup();
    expect(form.status).toBe(201);
    expect(form.json.token).toHaveLength(32);
    const again = await call(`/events/${ev.id}/registration`, { method: "PUT", token: u.token, body: { intro: "Bring your own device." } });
    expect(again.status).toBe(200);
    expect(again.json.token).toBe(form.json.token);
    expect(again.json.title).toBe("Spring Cup registration");
    const pub = await call(`/public/registration/${form.json.token}`);
    expect(pub.status).toBe(200);
    expect(pub.json.event.name).toBe("Spring Cup");
    expect(pub.json.form).toMatchObject({ teamSize: 4, subs: 1, spotsLeft: 2, status: "open", intro: "Bring your own device." });
    expect(JSON.stringify(pub.json)).not.toContain(ev.id);
    expect((await call("/public/registration/nope")).status).toBe(404);
    expect((await call(`/events/${ev.id}/registration`, { method: "PUT", body: {} })).status).toBe(401);
    expect((await call(`/events/${ev.id}/registration`, { method: "PUT", token: u.token, body: { teamSize: 0 } })).status).toBe(400);
  });

  it("takes a registration, checks the player count, refuses duplicates and fills up", async () => {
    const { form } = await setup();
    const t = form.json.token as string;
    expect((await call(`/public/registration/${t}/submit`, { body: body("Kings") })).status).toBe(201);
    expect((await call(`/public/registration/${t}/submit`, { body: body("kings") })).status).toBe(409); // same name, any case
    expect((await call(`/public/registration/${t}/submit`, { body: { ...body("Short"), players: players(3) } })).status).toBe(400);
    expect((await call(`/public/registration/${t}/submit`, { body: { ...body("Long"), players: players(6) } })).status).toBe(400);
    expect((await call(`/public/registration/${t}/submit`, { body: { ...body("NoName"), teamName: "" } })).status).toBe(400);
    expect((await call(`/public/registration/${t}/submit`, { body: body("Hawks", 5) })).status).toBe(201); // four players and one substitute
    const full = await call(`/public/registration/${t}/submit`, { body: body("Late") });
    expect(full.status).toBe(409);
    expect((await call(`/public/registration/${t}`)).json.form.status).toBe("full");
  });

  it("closes by switch and by date", async () => {
    const { u, ev, form } = await setup();
    const t = form.json.token as string;
    await call(`/events/${ev.id}/registration`, { method: "PUT", token: u.token, body: { open: false } });
    expect((await call(`/public/registration/${t}/submit`, { body: body("Alpha") })).status).toBe(409);
    await call(`/events/${ev.id}/registration`, { method: "PUT", token: u.token, body: { open: true, closesAt: new Date(Date.now() - 60_000).toISOString() } });
    expect((await call(`/public/registration/${t}`)).json.form.status).toBe("closed");
    await call(`/events/${ev.id}/registration`, { method: "PUT", token: u.token, body: { closesAt: null } });
    expect((await call(`/public/registration/${t}/submit`, { body: body("Bravo") })).status).toBe(201);
  });

  it("approving makes the team and the people; rejecting does not; others cannot see or act", async () => {
    const { u, ev, form } = await setup();
    const t = form.json.token as string;
    await call(`/public/registration/${t}/submit`, { body: body("Konkan Kings", 5) });
    await call(`/public/registration/${t}/submit`, { body: body("Spam Team") });
    const list = await call(`/events/${ev.id}/registrations?status=pending`, { token: u.token });
    expect(list.json).toHaveLength(2);
    const kings = list.json.find((r: { teamName: string }) => r.teamName === "Konkan Kings");
    expect(kings.captainContact).toBe("9999900000");

    const other = await newUser();
    expect((await call(`/events/${ev.id}/registrations`, { token: other.token })).status).toBe(404);
    expect((await call(`/events/${ev.id}/registrations/${kings.id}/approve`, { token: other.token, method: "POST", body: {} })).status).toBe(404);

    const ok = await call(`/events/${ev.id}/registrations/${kings.id}/approve`, { token: u.token, method: "POST", body: {} });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, teamId: "R1", people: 5 });
    const roster = await call(`/events/${ev.id}/roster`, { token: u.token });
    expect(roster.json.teams).toEqual([{ id: "R1", name: "Konkan Kings", logo: null }]);
    expect(roster.json.people).toHaveLength(5);
    expect(roster.json.people.map((p: { id: string }) => p.id)).toEqual(["KON-001", "KON-002", "KON-003", "KON-004", "KON-005"]);
    expect(roster.json.people.filter((p: { role: string }) => p.role === "Substitute")).toHaveLength(1);
    expect(roster.json.people.find((p: { id: string }) => p.id === "KON-002").minor).toBe(true);
    expect((await call(`/events/${ev.id}/registrations/${kings.id}/approve`, { token: u.token, method: "POST", body: {} })).status).toBe(409); // already handled

    const spam = list.json.find((r: { teamName: string }) => r.teamName === "Spam Team");
    expect((await call(`/events/${ev.id}/registrations/${spam.id}/reject`, { token: u.token, method: "POST", body: {} })).status).toBe(200);
    expect((await call(`/events/${ev.id}/registration`, { token: u.token })).json.counts).toEqual({ pending: 0, approved: 1, rejected: 1 });
    // a rejected name can register again
    expect((await call(`/public/registration/${t}/submit`, { body: body("Spam Team") })).status).toBe(201);
  });

  it("is removed with the event, and throttles one address that keeps submitting", async () => {
    const { u, ev, form } = await setup();
    const t = form.json.token as string;
    await call(`/public/registration/${t}/submit`, { body: body("Gone") });
    await call(`/events/${ev.id}`, { method: "DELETE", token: u.token });
    expect(await env.DB.prepare("SELECT (SELECT COUNT(*) FROM registrations WHERE event_id = ?1) r, (SELECT COUNT(*) FROM registration_forms WHERE event_id = ?1) f").bind(ev.id).first()).toEqual({ r: 0, f: 0 });
    const s2 = await setup();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await call(`/public/registration/${s2.form.json.token}/submit`, { ip: "198.51.100.200", body: body(`Team ${i}`, 3) })).status;
    expect(last).toBe(429);
  });
});
