import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";
import { ClientMessage, DesignMessage, LobbyMessage, UserEdit } from "./schema";
import { ANSWER_WITHIN, PING, PING_EVERY, PONG } from "./socket";

// Real messages recorded by crates/server/tests/wire.rs. If the server's
// format changes, these fail before the browser starts dropping messages.
const fixture = JSON.parse(
  readFileSync(
    new URL("../../../../crates/server/fixtures/messages.json", import.meta.url),
    "utf8",
  ),
) as {
  readonly design: ReadonlyArray<unknown>;
  readonly lobby: ReadonlyArray<unknown>;
  readonly client: ReadonlyArray<unknown>;
  readonly heartbeat: {
    readonly ping: string;
    readonly pong: string;
    readonly pingEveryMs: number;
    readonly silentForMs: number;
  };
};

const label = (message: unknown, i: number) => `${i} ${(message as { type: string }).type}`;

/**
 * Decodes with excess keys as errors, so a field the schema doesn't know
 * fails, then encodes again: what comes out must be what went in, so a
 * field the schema drops or changes fails too.
 */
function roundTrips<S extends Schema.Top>(schema: S, message: unknown) {
  const decoded = Schema.decodeUnknownSync(schema as never, { onExcessProperty: "error" })(message);
  expect(Schema.encodeSync(schema as never)(decoded as never)).toEqual(message);
}

/** The `type` of each member of a union of tagged structs. */
const kinds = (union: { readonly members: ReadonlyArray<unknown> }): string[] =>
  union.members.flatMap((member) => {
    const { literal, literals } = (
      member as {
        fields: { type: { literal?: string; literals?: ReadonlyArray<string> } };
      }
    ).fields.type;
    return literals ?? [literal!];
  });

describe("the schemas match the server's messages", () => {
  it.each(fixture.design.map((m, i) => [label(m, i), m] as const))("design %s", (_, message) => {
    roundTrips(DesignMessage, message);
  });

  it.each(fixture.lobby.map((m, i) => [label(m, i), m] as const))("lobby %s", (_, message) => {
    roundTrips(LobbyMessage, message);
  });

  it.each(fixture.client.map((m, i) => [label(m, i), m] as const))("client %s", (_, message) => {
    roundTrips(ClientMessage, message);
  });

  it("has an example of every kind", () => {
    const seen = (messages: ReadonlyArray<unknown>) =>
      new Set(messages.map((m) => (m as { type: string }).type));
    expect(seen(fixture.design)).toEqual(new Set(kinds(DesignMessage)));
    expect(seen(fixture.lobby)).toEqual(new Set(kinds(LobbyMessage)));
    expect(seen(fixture.client)).toEqual(new Set(kinds(ClientMessage)));
  });
});

describe("the socket's heartbeat matches the server's", () => {
  it("sends and expects the same strings", () => {
    expect(PING).toBe(fixture.heartbeat.ping);
    expect(PONG).toBe(fixture.heartbeat.pong);
  });

  it("pings as often as the server does, and gives up before it would", () => {
    expect(PING_EVERY).toBe(fixture.heartbeat.pingEveryMs);
    // The page's answer deadline ends well before the server closes a silent socket.
    expect(PING_EVERY + ANSWER_WITHIN).toBeLessThan(fixture.heartbeat.silentForMs);
  });
});

// One of each edit a person can make, recorded by crates/design/tests/user_edits.rs.
const userEdits = JSON.parse(
  readFileSync(
    new URL("../../../../crates/design/fixtures/user_edits.json", import.meta.url),
    "utf8",
  ),
) as ReadonlyArray<{ readonly kind: string }>;

describe("the user edit schema matches the server's", () => {
  it.each(userEdits.map((e, i) => [`${i} ${e.kind}`, e] as const))("%s", (_, edit) => {
    expect(Schema.decodeUnknownSync(UserEdit)(edit)).toEqual(edit);
  });

  it("has an example of every kind", () => {
    const kinds = new Set(userEdits.map((e) => e.kind));
    for (const member of UserEdit.members) {
      expect(kinds).toContain(member.fields.kind.literal);
    }
  });
});
