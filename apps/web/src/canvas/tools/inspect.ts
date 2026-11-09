import type { Frame, Measurement, MeasureTarget, Rect } from "@finite/protocol";
import type { Point } from "../gestures";
import type { Gesture, ToolDef, ToolHost } from "./host";

/** One measured element and how to measure it again. */
export type Probe = { frameId: string; target: MeasureTarget; m: Measurement };

export type InspectState = {
  readonly hover: Probe | null;
  readonly pin: Probe | null;
  /** How many stamped parents ↑ has walked from what the pointer is on. */
  readonly up: number;
  /** A dragged rectangle and what's under it. While it's set, nothing is hovered or pinned. */
  readonly area: InspectArea | null;
};

export type InspectArea = {
  frameId: string;
  /** In frame CSS pixels. */
  rect: Rect;
  elements: Measurement[];
  /** How many elements overlap it, which can be more than `elements`. */
  total: number;
};

export const NO_INSPECT: InspectState = { hover: null, pin: null, up: 0, area: null };

/** Under this on a side, a released drag is a sliver and clears. */
const MIN_AREA = 2;
const AREA_MAX = 150;

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
  /** The press drawing an area now; a gesture that isn't this one ignores its moves and release. */
  drag: object | null;
  /** Bumped when the area is cleared or replaced, so a measure in flight doesn't land after. */
  areaSeq: number;
  /** The newest rect to measure. One request runs at a time; drags replace this one. */
  wanted: { frameId: string; rect: Rect } | null;
  scheduled: boolean;
  measuring: boolean;
};

const sessions = new WeakMap<ToolHost, Session>();

function sessionOf(host: ToolHost): Session {
  let session = sessions.get(host);
  if (!session) {
    session = {
      raf: 0,
      seq: 0,
      pinSeq: 0,
      pointer: null,
      drag: null,
      areaSeq: 0,
      wanted: null,
      scheduled: false,
      measuring: false,
    };
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

/** Drops the area and anything still measuring it. A press already down can't act on it after. */
function clearArea(host: ToolHost) {
  const session = sessionOf(host);
  session.areaSeq++;
  session.pinSeq++;
  session.wanted = null;
  session.drag = null;
  if (host.state.inspect.area) host.update({ inspect: { ...host.state.inspect, area: null } });
}

function wantArea(host: ToolHost, frameId: string, rect: Rect) {
  const session = sessionOf(host);
  session.wanted = { frameId, rect };
  scheduleArea(host);
}

function scheduleArea(host: ToolHost) {
  const session = sessionOf(host);
  if (session.scheduled || session.measuring) return;
  session.scheduled = true;
  requestAnimationFrame(() => {
    session.scheduled = false;
    void measureWanted(host);
  });
}

async function measureWanted(host: ToolHost) {
  const session = sessionOf(host);
  const job = session.wanted;
  if (!job || session.measuring) return;
  session.wanted = null;
  session.measuring = true;
  const seq = session.areaSeq;
  const reply = await host
    .bridge(job.frameId)
    ?.measureArea(job.rect, AREA_MAX)
    .catch(() => null);
  session.measuring = false;
  const { area } = host.state.inspect;
  if (reply && area && seq === session.areaSeq) {
    host.update({ inspect: { ...host.state.inspect, area: { ...area, ...reply } } });
  }
  if (session.wanted) scheduleArea(host);
}

/** A press in `frame` that passed the slop: replaces what's shown and follows the pointer. */
function startArea(host: ToolHost, frame: Frame, start: Point): Gesture {
  stopProbing(host);
  clearArea(host);
  const session = sessionOf(host);
  host.update({ inspect: NO_INSPECT });
  const drag = {};
  session.drag = drag;
  const clamped = (p: Point) => {
    const box = host.boxOf(frame);
    const at = host.local(frame, p);
    return {
      x: Math.min(box.width, Math.max(0, at.x)),
      y: Math.min(box.height, Math.max(0, at.y)),
    };
  };
  return {
    move(_screen, world) {
      if (session.drag !== drag) return;
      const a = clamped(start);
      const b = clamped(world);
      const rect = {
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        width: Math.abs(a.x - b.x),
        height: Math.abs(a.y - b.y),
      };
      const { inspect: now } = host.state;
      const area = now.area ?? { frameId: frame.id, rect, elements: [], total: 0 };
      host.update({ inspect: { ...now, area: { ...area, rect } } });
      wantArea(host, frame.id, rect);
    },
    end(commit) {
      if (session.drag !== drag) return;
      session.drag = null;
      const { area } = host.state.inspect;
      if (!commit || !area || area.rect.width < MIN_AREA || area.rect.height < MIN_AREA) {
        clearArea(host);
      }
    },
  };
}

/** A frame loaded or applied an HMR update: what's measured may have moved or gone. */
async function remeasure(host: ToolHost) {
  const { area } = host.state.inspect;
  if (area) wantArea(host, area.frameId, area.rect);
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
  hint: "Drag an area · Click to pin · ↑ parent · Esc",
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
    clearArea(host);
    host.update({ inspect: NO_INSPECT });
  },
  down(host, p) {
    // Esc or a tool switch during the press cancels it, as it does a click already answering.
    const session = sessionOf(host);
    const seq = session.pinSeq;
    const hadArea = host.state.inspect.area !== null;
    return {
      begin: async () =>
        p.frame && seq === session.pinSeq && host.frame(p.frame.id)
          ? startArea(host, p.frame, p.world)
          : null,
      click: () => {
        if (seq !== session.pinSeq) return;
        if (hadArea) return clearArea(host);
        return pinAt(host, p.world, p.frame);
      },
    };
  },
  pointerMove(host, e) {
    if (!host.state.inspect.area) probeAt(host, e);
  },
  pointerLeave: clearProbe,
  frameUpdated(host) {
    void remeasure(host);
  },
  canvasChanged(host) {
    const { hover, pin, area } = host.state.inspect;
    if (area && !host.frame(area.frameId)) clearArea(host);
    const here = (p: Probe | null) => (p && host.frame(p.frameId) ? p : null);
    if (here(hover) !== hover || here(pin) !== pin) {
      host.update({ inspect: { ...host.state.inspect, hover: here(hover), pin: here(pin) } });
    }
  },
  key(host, e) {
    if (e.key === "Escape") {
      if (sessionOf(host).drag) {
        clearArea(host);
        host.escape();
        return true;
      }
      // A comment open over the canvas closes first; with nothing shown, Esc goes back to Select.
      const { inspect: m, commentDraft, openComment } = host.state;
      if ((!m.area && !m.pin) || commentDraft || openComment) return false;
      if (m.area) clearArea(host);
      else unpin(host);
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
