import { afterEach, expect, test, vi } from "vite-plus/test";

afterEach(() => vi.unstubAllGlobals());

test("the frame tells the parent it's leaving when the page unloads", async () => {
  const parent = { postMessage: vi.fn() };
  const win = Object.assign(new EventTarget(), { parent });
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", {
    documentElement: { scrollWidth: 0, getBoundingClientRect: () => ({ height: 0 }) },
    body: { scrollHeight: 0 },
    head: {},
    addEventListener: () => {},
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
    },
  );
  vi.stubGlobal(
    "MutationObserver",
    class {
      observe() {}
    },
  );
  const { CONNECT } = await import("./bridge.ts");

  const port = { postMessage: vi.fn(), close: () => {} };
  win.dispatchEvent(
    Object.assign(new Event("message"), {
      source: parent,
      origin: "http://localhost:4100",
      data: { type: CONNECT },
      ports: [port],
    }),
  );
  win.dispatchEvent(new Event("pagehide"));

  expect(port.postMessage).toHaveBeenCalledWith({ type: "leaving" });
});
