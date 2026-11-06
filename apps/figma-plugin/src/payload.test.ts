import { describe, expect, it } from "vite-plus/test";
import {
  decodePayload,
  encodePayload,
  KIND,
  PAYLOAD_VERSION,
  type FigNode,
  type Payload,
} from "./payload.ts";
import { fixture } from "./fixtures.ts";

const node = (overrides: Partial<FigNode> = {}): FigNode => ({
  id: "1:2",
  type: "FRAME",
  name: "Card",
  x: 0,
  y: 0,
  width: 100,
  height: 50,
  ...overrides,
});

const payload = (overrides: Partial<Payload> = {}): Payload => ({
  kind: KIND,
  file: { name: "Design" },
  nodes: [node()],
  ...overrides,
});

describe("encodePayload", () => {
  it("starts with the version, as Schema::encode does", () => {
    const json = encodePayload(payload());
    expect(json.startsWith(`{"v":1,"kind":"${KIND}"`)).toBe(true);
    expect(PAYLOAD_VERSION).toBe(1);
    expect(JSON.parse(json)).toEqual({ v: 1, ...payload() });
  });

  it("keeps the version first whatever order the payload's keys are in", () => {
    const reordered = { nodes: [], file: { name: "x" }, kind: KIND } as Payload;
    expect(encodePayload(reordered).startsWith('{"v":1,"nodes":[]')).toBe(true);
  });
});

describe("decodePayload", () => {
  it("reads what encodePayload wrote", () => {
    expect(decodePayload(encodePayload(payload()))).toEqual({ v: 1, ...payload() });
  });

  it("counts a file with no version as version 1", () => {
    expect(decodePayload(JSON.stringify(payload())).nodes).toHaveLength(1);
  });

  it("refuses a newer version instead of guessing", () => {
    const newer = JSON.stringify({ v: 2, ...payload() });
    expect(() => decodePayload(newer)).toThrow("version 2");
  });

  it("refuses files that aren't Figma payloads", () => {
    expect(() => decodePayload("not json")).toThrow("isn't JSON");
    expect(() => decodePayload("[]")).toThrow("isn't a Finite export");
    expect(() => decodePayload(JSON.stringify({ v: 1, kind: "finite-bundle" }))).toThrow(
      "isn't a Finite export for Figma",
    );
    expect(() => decodePayload(JSON.stringify({ v: 1, kind: KIND, nodes: "x" }))).toThrow(
      "no layers",
    );
  });
});

describe("the Rust fixture", () => {
  it("decodes, and encodes back to the same payload", () => {
    const decoded = decodePayload(fixture("basic"));
    expect(decoded.nodes.length).toBeGreaterThan(0);
    expect(JSON.parse(encodePayload(decoded))).toEqual({ v: PAYLOAD_VERSION, ...decoded });
  });
});
