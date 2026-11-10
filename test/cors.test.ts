import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const worker = (exports as unknown as { default: { fetch(r: Request): Promise<Response> } }).default;
const req = (path: string, init: RequestInit) => worker.fetch(new Request(`https://api.test${path}`, init));

describe("CORS", () => {
  it("answers preflight for allowed origins only", async () => {
    for (const origin of ["https://esports.streamerosai.com", "http://localhost:3000", "http://localhost:4173"]) {
      const r = await req("/events", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
      expect(r.status).toBe(204);
      expect(r.headers.get("access-control-allow-origin")).toBe(origin);
      expect(r.headers.get("access-control-allow-headers")).toContain("X-Gate-Key");
      expect(r.headers.get("access-control-allow-headers")).toContain("Authorization");
      expect(r.headers.get("access-control-allow-methods")).toContain("DELETE");
    }
    for (const origin of ["https://evil.example", "http://localhost:3001", "https://esports.streamerosai.com.evil.example", "null"]) {
      const r = await req("/events", { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" } });
      expect(r.status).toBe(403);
      expect(r.headers.get("access-control-allow-origin")).toBeNull();
    }
    const noOrigin = await req("/events", { method: "OPTIONS" });
    expect(noOrigin.status).toBe(403);
  });

  it("adds CORS headers to real responses only for allowed origins", async () => {
    const ok = await req("/", { headers: { origin: "http://localhost:3000" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    expect(ok.headers.get("vary")).toContain("Origin");
    const err = await req("/events", { headers: { origin: "http://localhost:3000" } });
    expect(err.status).toBe(401);
    expect(err.headers.get("access-control-allow-origin")).toBe("http://localhost:3000"); // errors are readable by the app
    const bad = await req("/", { headers: { origin: "https://evil.example" } });
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
    const none = await req("/", {});
    expect(none.headers.get("access-control-allow-origin")).toBeNull();
  });
});
