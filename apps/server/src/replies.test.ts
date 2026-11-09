import { REPLY_KEPT_MS, type Reply } from "@finite/protocol";
import { describe, expect, it } from "vite-plus/test";
import { createReplyMemory } from "./replies.ts";

const reply = (rid: string): Reply => ({ type: "reply", rid, ok: true, value: rid });
const person = () => {
  const got: Reply[] = [];
  return { got, send: (message: unknown) => void got.push(message as Reply) };
};

describe("reply memory", () => {
  it("is new the first time, running while it runs, and the reply once done", () => {
    const memory = createReplyMemory();
    const a = person();
    expect(memory.ask("r", a)).toBeUndefined();
    expect(memory.ask("r", a)).toBe("running");
    memory.finish("r", reply("r"));
    expect(memory.ask("r", a)).toEqual(reply("r"));
  });

  it("answers everyone who asked while it ran, once each", () => {
    const memory = createReplyMemory();
    const [a, b] = [person(), person()];
    memory.ask("r", a);
    memory.ask("r", b);
    memory.ask("r", b);
    memory.finish("r", reply("r"));
    expect(a.got).toEqual([reply("r")]);
    expect(b.got).toEqual([reply("r")]);
  });

  it("forgets a reply when it's old, without changing its name", () => {
    let now = 0;
    const memory = createReplyMemory(() => now);
    const name = memory.name();
    memory.ask("r", person());
    memory.finish("r", reply("r"));
    now = REPLY_KEPT_MS - 1;
    expect(memory.ask("r", person())).toEqual(reply("r"));
    now = REPLY_KEPT_MS;
    expect(memory.ask("r", person())).toBeUndefined();
    expect(memory.name()).toBe(name);
  });

  it("won't run a request asked again after its reply was pushed out", () => {
    const memory = createReplyMemory(Date.now, 1);
    memory.ask("a", person());
    memory.finish("a", reply("a"));
    const name = memory.name();
    memory.ask("b", person());
    memory.finish("b", reply("b"));
    expect(memory.ask("a", person(), name)).toBe("forgotten");
    expect(memory.ask("a", person(), memory.name())).toBeUndefined();
  });

  it("changes its name when it runs out of room, so a page can tell", () => {
    const memory = createReplyMemory(Date.now, 2);
    const name = memory.name();
    for (const rid of ["a", "b"]) {
      memory.ask(rid, person());
      memory.finish(rid, reply(rid));
    }
    expect(memory.name()).toBe(name);
    memory.ask("c", person());
    memory.finish("c", reply("c"));
    expect(memory.name()).not.toBe(name);
    expect(memory.ask("a", person())).toBeUndefined();
    expect(memory.ask("b", person())).toEqual(reply("b"));
  });

  it("doesn't count what's still running against its room", () => {
    const memory = createReplyMemory(Date.now, 1);
    const name = memory.name();
    memory.ask("slow", person());
    memory.ask("a", person());
    memory.finish("a", reply("a"));
    expect(memory.ask("slow", person())).toBe("running");
    expect(memory.name()).toBe(name);
  });
});
