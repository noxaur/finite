import { describe, expect, it } from "vite-plus/test";
import { allowedHosts, allows, refuse } from "./guard.ts";

describe("guard", () => {
  const allowed = [...allowedHosts("10.0.0.2:4100")];

  it("matches hosts with or without their port", () => {
    for (const ok of [
      "localhost:5310",
      "127.0.0.1:4100",
      "[::1]:4100",
      "10.0.0.2:4100",
      "LOCALHOST",
    ]) {
      expect(allows(allowed, ok), ok).toBe(true);
    }
    for (const bad of [
      "evil.example",
      "evil.example:4100",
      "10.0.0.2:9999",
      "127.0.0.1.evil.example",
      "null",
    ]) {
      expect(allows(allowed, bad), bad).toBe(false);
    }
  });

  it("refuses a foreign origin or host", () => {
    expect(
      refuse(allowed, { host: "127.0.0.1:4100", origin: "http://localhost:5310" }),
    ).toBeUndefined();
    expect(refuse(allowed, { host: "127.0.0.1:4100", origin: "https://evil.example" })).toBe(
      'requests from "https://evil.example" aren\'t allowed',
    );
    expect(refuse(allowed, { host: "127.0.0.1:4100", origin: "null" })).toMatch(/aren't allowed/);
    expect(refuse(allowed, { host: "rebound.example:4100" })).toMatch(/unknown host/);
  });
});
