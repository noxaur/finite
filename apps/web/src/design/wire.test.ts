import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { DesignMessage, LobbyMessage } from "./schema";

// Real messages recorded by crates/server/tests/wire.rs. If the server's
// format changes, these fail before the browser starts dropping messages.
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../crates/server/fixtures/messages.json", import.meta.url),
    "utf8",
  ),
) as { readonly design: ReadonlyArray<unknown>; readonly lobby: ReadonlyArray<unknown> };

const label = (message: unknown, i: number) => `${i} ${(message as { type: string }).type}`;

describe("the schemas decode the server's messages", () => {
  it.each(fixture.design.map((m, i) => [label(m, i), m] as const))("design %s", (_, message) => {
    expect(() => Schema.decodeUnknownSync(DesignMessage)(message)).not.toThrow();
  });

  it.each(fixture.lobby.map((m, i) => [label(m, i), m] as const))("lobby %s", (_, message) => {
    expect(() => Schema.decodeUnknownSync(LobbyMessage)(message)).not.toThrow();
  });
});
