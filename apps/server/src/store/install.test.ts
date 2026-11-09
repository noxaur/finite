import { EventEmitter } from "node:events";
import type { InstallState } from "@finite/protocol";
import { expect, test, vi } from "vite-plus/test";
import { install } from "./install.ts";

class FakeInstall extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

const child = vi.hoisted(() => ({ current: undefined as unknown }));

vi.mock("node:child_process", () => ({
  spawn: () => {
    child.current = new FakeInstall();
    return child.current;
  },
  spawnSync: () => ({ status: 0 }),
}));

test("output that arrives after the install exits doesn't mark it running again", async () => {
  vi.useFakeTimers();
  try {
    const seen: InstallState["status"][] = [];
    const job = install("/design", (state) => seen.push(state.status));
    const fake = child.current as FakeInstall;
    fake.emit("exit", 1, null);
    await expect(job.done).rejects.toThrow(/failed/);
    fake.stdout.emit("data", Buffer.from("late"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(job.state.status).toBe("error");
    expect(seen).toEqual(["running", "error"]);
  } finally {
    vi.useRealTimers();
  }
});
