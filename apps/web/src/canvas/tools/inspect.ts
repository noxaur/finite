import type { Frame, Measurement, MeasureTarget } from "@finite/protocol";
import type { Point } from "../gestures";
import type { ToolDef, ToolHost } from "./host";

/** One measured element and how to measure it again. */
export type Probe = { frameId: string; target: MeasureTarget; m: Measurement };

export type InspectState = {
  readonly hover: Probe | null;
  readonly pin: Probe | null;
  /** How many stamped parents ↑ has walked from what the pointer is on. */
  readonly up: number;
};

export const NO_INSPECT: InspectState = { hover: null, pin: null, up: 0 };

export const sameElement = (a: Probe, b: Probe) =>
  a.frameId === b.frameId && a.m.loc === b.m.loc && a.m.index === b.m.index;

const sameMeasurement = (a: Measurement, b: Measurement) => JSON.stringify(a) === JSON.stringify(b);

/** What's in flight, per editor. None of it is drawn, so none of it is in the store. */
type Session = {
  raf: number;
  seq: number;
  /** Bumped when the pin changes, so a click still waiting on its frame doesn't pin afterwards. */
  pinSeq: number;
  /** Where the tool last probed, and the element right under that point. */
  pointer: { frameId: string; at: Point; leaf: string | null } | null;
};

const sessions = new WeakMap<ToolHost, Session>();

function sessionOf(host: ToolHost): Session {
  let session = sessions.get(host);
  if (!session) {
    session = { raf: 0, seq: 0, pinSeq: 0, pointer: null };
    sessions.set(host, session);
  }
  return session;
}

function stopProbing(host: ToolHost) {
  const session = sessionOf(host);
  cancelAnimationFrame(session.raf);
  session.seq++;
  session.pointer = null;
}

function clearProbe(host: ToolHost) {
  stopProbing(host);
  const { inspect } = host.state;
  if (inspect.hover || inspect.up > 0) {
    host.update({ inspect: { ...inspect, hover: null, up: 0 } });
  }
}

function probeAt(host: ToolHost, e: PointerEvent) {
  const session = sessionOf(host);
  cancelAnimationFrame(session.raf);
  const { clientX, clientY, target } = e;
  session.raf = requestAnimationFrame(() => {
    // Over the card or the toolbar the probe holds still, so what the card shows can be read.
    if (target instanceof Element && target.closest("[data-canvas-ui]")) return;
    const world = host.worldOf({ clientX, clientY });
    const frame = host.frameAt(world);
    if (!frame) return clearProbe(host);
    void probe(host, frame.id, host.local(frame, world), host.state.inspect.up);
  });
}

/**
 * The element at a point, `up` stamped parents above the one right under it. A different element
 * under the point starts the walk over; `up` comes back as the walk that was kept.
 */
async function elementAt(host: ToolHost, frameId: string, at: Point, up: number) {
  const targets: MeasureTarget[] = up > 0 ? [{ at }, { at, up }] : [{ at }];
  const replies = await host
    .bridge(frameId)
    ?.measure(targets)
    .catch(() => null);
  const leaf = replies?.[0] ?? null;
  if (!leaf) return null;
  const key = `${frameId}|${leaf.loc}|${leaf.index}`;
  return up > 0 && key === sessionOf(host).pointer?.leaf
    ? { key, m: replies?.[1] ?? leaf, up }
    : { key, m: leaf, up: 0 };
}

async function probe(host: ToolHost, frameId: string, at: Point, up: number) {
  const session = sessionOf(host);
  const seq = ++session.seq;
  const found = await elementAt(host, frameId, at, up);
  if (seq !== session.seq || host.pressing || host.state.tool !== "inspect") return;
  if (!found) return clearProbe(host);
  session.pointer = { frameId, at, leaf: found.key };
  const { inspect } = host.state;
  const hover: Probe = { frameId, target: { at, up: found.up }, m: found.m };
  if (inspect.hover && sameElement(inspect.hover, hover)) {
    // ↑ past the topmost stamped element: there's nothing more to walk.
    if (found.up > inspect.up) return;
    if (found.up === inspect.up && sameMeasurement(inspect.hover.m, hover.m)) return;
  }
  host.update({ inspect: { ...inspect, hover, up: found.up } });
}

function walk(host: ToolHost, delta: 1 | -1) {
  const up = host.state.inspect.up + delta;
  const { pointer } = sessionOf(host);
  if (pointer && up >= 0) void probe(host, pointer.frameId, pointer.at, up);
}

function unpin(host: ToolHost) {
  sessionOf(host).pinSeq++;
  host.update({ inspect: { ...host.state.inspect, pin: null } });
}

/** A click: pins what's under it, or unpins when that's the pin or nothing at all. */
async function pinAt(host: ToolHost, world: Point, frame: Frame | null) {
  if (!frame) return unpin(host);
  const session = sessionOf(host);
  const at = host.local(frame, world);
  const seq = ++session.pinSeq;
  const found = await elementAt(host, frame.id, at, host.state.inspect.up);
  if (seq !== session.pinSeq) return;
  if (!found) return unpin(host);
  const { m } = found;
  const target: MeasureTarget =
    m.loc === undefined ? { at, up: found.up } : { loc: m.loc, index: m.index };
  const pinned: Probe = { frameId: frame.id, target, m };
  const { pin } = host.state.inspect;
  host.update({
    inspect: { ...host.state.inspect, pin: pin && sameElement(pin, pinned) ? null : pinned },
  });
}

/** A frame loaded or applied an HMR update: what's measured may have moved or gone. */
async function remeasure(host: ToolHost) {
  const { pointer } = sessionOf(host);
  if (pointer) void probe(host, pointer.frameId, pointer.at, host.state.inspect.up);
  const { pin } = host.state.inspect;
  if (!pin) return;
  const replies = await host
    .bridge(pin.frameId)
    ?.measure([pin.target])
    .catch(() => null);
  // A refresh keeps the pin's target, so a second refresh in flight still lands.
  const current = host.state.inspect.pin;
  if (!replies || current?.target !== pin.target) return;
  const m = replies[0] ?? null;
  if (m && sameMeasurement(m, current.m)) return;
  host.update({ inspect: { ...host.state.inspect, pin: m && { ...current, m } } });
}

/** Shows an element's box model and spec on hover, and distances from a pinned element. */
export const inspect = {
  id: "inspect",
  group: "comment",
  label: "Inspect",
  keys: { key: "m" },
  icon: "inspect",
  cursor: "var(--cursor-inspect, crosshair)",
  enabled: true,
  sticky: true,
  hint: "Click to pin · ↑ parent · Esc",
  activate(host) {
    // The inspect card scrolls itself; a pinch over it still zooms.
    host.camera.routeWheel = (e) =>
      !e.ctrlKey &&
      !e.metaKey &&
      e.target instanceof Element &&
      e.target.closest("[data-inspect-card]")
        ? "native"
        : "camera";
  },
  deactivate(host) {
    host.camera.routeWheel = null;
    stopProbing(host);
    sessionOf(host).pinSeq++;
    host.update({ inspect: NO_INSPECT });
  },
  down(host, p) {
    // Esc or a tool switch during the press cancels it, as it does a click already answering.
    const seq = sessionOf(host).pinSeq;
    return {
      begin: async () => null,
      click: () => (seq === sessionOf(host).pinSeq ? pinAt(host, p.world, p.frame) : undefined),
    };
  },
  pointerMove: probeAt,
  pointerLeave: clearProbe,
  frameUpdated(host) {
    void remeasure(host);
  },
  canvasChanged(host) {
    const { hover, pin } = host.state.inspect;
    const here = (p: Probe | null) => (p && host.frame(p.frameId) ? p : null);
    if (here(hover) !== hover || here(pin) !== pin) {
      host.update({ inspect: { ...host.state.inspect, hover: here(hover), pin: here(pin) } });
    }
  },
  key(host, e) {
    if (e.key === "Escape") {
      // A comment open over the canvas closes first; with no pin, Esc goes back to Select.
      const { inspect: m, commentDraft, openComment } = host.state;
      if (!m.pin || commentDraft || openComment) return false;
      unpin(host);
      return true;
    }
    const mod = e.metaKey || e.ctrlKey;
    // This tool hides the selection: Delete and Duplicate would act on something unseen.
    if (e.key === "Backspace" || e.key === "Delete") return true;
    if (mod && e.key.toLowerCase() === "d") return true;
    if (!mod && !e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      walk(host, e.key === "ArrowUp" ? 1 : -1);
      return true;
    }
    return false;
  },
} as const satisfies ToolDef<"inspect">;
