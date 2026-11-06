// The originals of methods this replaces are kept unbound, to call on the page's own objects.
// The file is one function expression, which hosts call.
// oxlint-disable typescript/unbound-method, eslint/no-unused-expressions
// Runs first in every artboard that runs scripts, before the artboard's own
// code, in the viewer's sandboxed iframes and in screenshots. Hosts call it
// with a config: `(BOOTSTRAP)({ nonce, storage })`.
//
// It talks to the viewer over a private MessagePort. The artboard's own
// scripts run in this same frame and can post to the parent too, so the
// port is the only channel the viewer trusts for anything that acts outside
// the frame: opening a link, writing storage. The port arrives in an `init`
// message, which a capturing listener registered here, before any other
// code, takes and hides from every later listener.
//
// It also enforces what the iframe sandbox can't: audio stays muted until the
// viewer allows it, a page can't take focus by itself or go fullscreen, and
// `localStorage` works (an opaque origin has none), backed by the viewer.
(config) => {
  const win = window;
  const doc = document;
  // The page's scripts run after this and can replace any prototype method
  // or getter, including the ones a MessagePort is used through, to catch
  // the port as `this`. So the channel only ever goes through the originals,
  // taken now, and called with the original `Reflect.apply`, not `.call`.
  const apply = Reflect.apply;
  const getter = (proto, name) => Object.getOwnPropertyDescriptor(proto, name).get;
  const eventData = getter(MessageEvent.prototype, "data");
  const eventPorts = getter(MessageEvent.prototype, "ports");
  const eventSource = getter(MessageEvent.prototype, "source");
  const stopEvent = Event.prototype.stopImmediatePropagation;
  const portPost = MessagePort.prototype.postMessage;
  const portOnMessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage").set;
  let port = null;
  // Messages sent before the port arrives. A linked list of own properties,
  // not an array: a page can replace Array.prototype.push or shift, and
  // could swap in a message of its own as the queue drains.
  let first = null;
  let last = null;
  const send = (message) => {
    if (port) return apply(portPost, port, [message]);
    const node = { message, next: null };
    if (last) last.next = node;
    else first = node;
    last = node;
  };
  // What the viewer allows right now. `interact`: the page takes input on the
  // canvas. `presenting`: interactive mode, where the page owns the wheel.
  const state = { interact: false, presenting: false, audio: false };

  // --- The private channel --------------------------------------------------

  win.addEventListener(
    "message",
    (e) => {
      const data = apply(eventData, e, []);
      const m = apply(eventSource, e, []) === parent && data && data.finite;
      if (!m || m.type !== "init") return;
      apply(stopEvent, e, []);
      const given = apply(eventPorts, e, [])[0];
      if (port || !given || m.nonce !== config.nonce) return;
      port = given;
      apply(portOnMessage, port, [(ev) => receive(apply(eventData, ev, []))]);
      for (let node = first; node; node = node.next) apply(portPost, port, [node.message]);
      first = last = null;
    },
    true,
  );
  parent.postMessage({ finite: { type: "hello", nonce: config.nonce } }, "*");

  // --- Storage --------------------------------------------------------------

  // About 5 MB of UTF-16, like a browser's own quota.
  const QUOTA = 2_500_000;
  const quotaError = () => new DOMException("The design's storage is full.", "QuotaExceededError");
  const makeStorage = (initial, persist) => {
    const map = new Map();
    let used = 0;
    for (const [k, v] of Object.entries(initial || {})) {
      if (typeof v === "string") {
        map.set(k, v);
        used += k.length + v.length;
      }
    }
    const api = {
      get length() {
        return map.size;
      },
      key: (i) => [...map.keys()][i] ?? null,
      getItem: (k) => map.get(String(k)) ?? null,
      setItem(k, v) {
        k = String(k);
        v = String(v);
        const before = map.has(k) ? k.length + map.get(k).length : 0;
        if (used - before + k.length + v.length > QUOTA) throw quotaError();
        used += k.length + v.length - before;
        map.set(k, v);
        persist?.({ set: [[k, v]] });
      },
      removeItem(k) {
        k = String(k);
        if (!map.has(k)) return;
        used -= k.length + map.get(k).length;
        map.delete(k);
        persist?.({ set: [[k, null]] });
      },
      clear() {
        map.clear();
        used = 0;
        persist?.({ clear: true });
      },
    };
    const own = (p) => typeof p === "string" && !(p in api) && map.has(p);
    const storage = new Proxy(api, {
      get: (t, p) => (p in t ? t[p] : typeof p === "string" ? map.get(p) : undefined),
      set: (t, p, v) => (t.setItem(p, v), true),
      deleteProperty: (t, p) => (t.removeItem(p), true),
      has: (t, p) => p in t || own(p),
      ownKeys: () => [...map.keys()],
      getOwnPropertyDescriptor: (t, p) =>
        own(p)
          ? { value: map.get(p), writable: true, enumerable: true, configurable: true }
          : undefined,
    });
    // Changes made in another frame of the same design.
    const sync = (change) => {
      if (change.clear) {
        map.clear();
        used = 0;
      }
      for (const [k, v] of change.set || []) {
        if (typeof k !== "string") continue;
        if (map.has(k)) used -= k.length + map.get(k).length;
        if (typeof v === "string") {
          map.set(k, v);
          used += k.length + v.length;
        } else map.delete(k);
      }
    };
    return { storage, sync };
  };
  const local = makeStorage(config.storage, (change) => send({ type: "storage", ...change }));
  const session = makeStorage({}, null);
  for (const [name, store] of [
    ["localStorage", local],
    ["sessionStorage", session],
  ]) {
    try {
      Object.defineProperty(win, name, { configurable: true, get: () => store.storage });
    } catch {}
  }

  // --- Audio ----------------------------------------------------------------

  // Media stays muted, and audio contexts suspended, until the viewer turns
  // audio on. The page's own `muted` reads back what it set.
  const mutedDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "muted");
  const wanted = new WeakMap();
  const media = new Set();
  const track = (el) => {
    if (!wanted.has(el)) wanted.set(el, mutedDesc.get.call(el));
    media.add(el);
  };
  Object.defineProperty(HTMLMediaElement.prototype, "muted", {
    configurable: false,
    enumerable: true,
    get() {
      return wanted.has(this) ? wanted.get(this) : mutedDesc.get.call(this);
    },
    set(value) {
      track(this);
      wanted.set(this, !!value);
      mutedDesc.set.call(this, !state.audio || !!value);
    },
  });
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    track(this);
    if (!state.audio) mutedDesc.set.call(this, true);
    return play.call(this);
  };
  // `<video autoplay>` starts without calling play().
  doc.addEventListener(
    "play",
    (e) => {
      if (!(e.target instanceof HTMLMediaElement)) return;
      track(e.target);
      if (!state.audio) mutedDesc.set.call(e.target, true);
    },
    true,
  );
  const contexts = new Map();
  const Context = win.AudioContext || win.webkitAudioContext;
  if (Context) {
    const resume = Context.prototype.resume;
    const suspend = Context.prototype.suspend;
    Context.prototype.resume = function () {
      contexts.set(this, true);
      return state.audio ? resume.call(this) : Promise.resolve();
    };
    Context.prototype.suspend = function () {
      contexts.set(this, false);
      return suspend.call(this);
    };
    const Gated = class extends Context {
      constructor(...args) {
        super(...args);
        contexts.set(this, true);
        if (!state.audio) void suspend.call(this);
      }
    };
    win.AudioContext = Gated;
    if (win.webkitAudioContext) win.webkitAudioContext = Gated;
    var setAudio = (on) => {
      for (const [ctx, running] of contexts) {
        if (on && running) void resume.call(ctx);
        else if (!on) void suspend.call(ctx);
      }
    };
  }
  if (win.speechSynthesis) {
    const speak = win.speechSynthesis.speak.bind(win.speechSynthesis);
    win.speechSynthesis.speak = (u) => state.audio && speak(u);
  }
  const applyAudio = () => {
    for (const el of media) mutedDesc.set.call(el, !state.audio || wanted.get(el));
    if (setAudio) setAudio(state.audio);
  };

  // --- Focus and fullscreen ---------------------------------------------------

  // A page takes focus only once it has it, or right after a person used it.
  for (const proto of [HTMLElement.prototype, SVGElement.prototype]) {
    const focus = proto.focus;
    proto.focus = function (options) {
      if (doc.hasFocus() || (navigator.userActivation && navigator.userActivation.isActive)) {
        return focus.call(this, options);
      }
    };
  }
  win.focus = () => {};
  const refuse = () => Promise.reject(new TypeError("Artboards can't go fullscreen."));
  Element.prototype.requestFullscreen = refuse;
  if (Element.prototype.webkitRequestFullscreen) Element.prototype.webkitRequestFullscreen = refuse;

  // --- Network activity -------------------------------------------------------

  // What the page reached, as far as it can be seen: requests the page made,
  // and the scripts it loaded. Images and stylesheets don't count.
  const hosts = new Set();
  const note = (url) => {
    try {
      const u = new URL(url, location.href);
      if (!/^(https?|wss?):$/.test(u.protocol) || hosts.has(u.host)) return;
      hosts.add(u.host);
      send({ type: "network", host: u.host });
    } catch {}
  };
  const COUNTED = new Set(["fetch", "xmlhttprequest", "beacon", "script", "other"]);
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) if (COUNTED.has(entry.initiatorType)) note(entry.name);
    }).observe({ type: "resource", buffered: true });
  } catch {}
  for (const name of ["WebSocket", "EventSource"]) {
    const Base = win[name];
    if (!Base) continue;
    win[name] = class extends Base {
      constructor(url, ...rest) {
        super(url, ...rest);
        note(url);
      }
    };
  }

  // --- Layout questions -------------------------------------------------------

  const report = () => {
    const root = doc.body && doc.body.firstElementChild;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    send({ type: "size", width: Math.ceil(rect.width), height: Math.ceil(rect.height) });
  };
  doc.addEventListener("DOMContentLoaded", () => {
    report();
    const root = doc.body.firstElementChild;
    if (root) new ResizeObserver(report).observe(root);
  });
  // Elements carry their node id in data-finite-id.
  // How far its outline and unblurred outer shadows reach past the box,
  // as strokeOutset in apps/web/src/design/outset.ts works it out.
  const outset = (el) => {
    const css = getComputedStyle(el);
    const o = { top: 0, right: 0, bottom: 0, left: 0 };
    if (css.outlineStyle !== "none") {
      const reach = (parseFloat(css.outlineWidth) || 0) + (parseFloat(css.outlineOffset) || 0);
      o.top = o.right = o.bottom = o.left = Math.max(0, reach);
    }
    for (const shadow of css.boxShadow.split(/,(?![^(]*\))/)) {
      if (/\binset\b/.test(shadow)) continue;
      const [x = 0, y = 0, blur = 0, spread = 0] = (shadow.match(/-?[\d.]+px/g) || []).map(
        parseFloat,
      );
      if (blur > 0) continue;
      o.top = Math.max(o.top, spread - y);
      o.right = Math.max(o.right, spread + x);
      o.bottom = Math.max(o.bottom, spread + y);
      o.left = Math.max(o.left, spread - x);
    }
    return o;
  };
  const place = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, width: r.width, height: r.height, outset: outset(el) };
  };

  const receive = (m) => {
    if (!m || typeof m !== "object") return;
    if (m.type === "state") {
      state.interact = !!m.interact;
      state.presenting = !!m.presenting;
      const audio = !!m.audio;
      if (audio !== state.audio) {
        state.audio = audio;
        applyAudio();
      }
    } else if (m.type === "hit") {
      let el = doc.elementFromPoint(m.x, m.y);
      while (el && !el.getAttribute("data-finite-id")) el = el.parentElement;
      send({
        type: "hit",
        x: m.x,
        y: m.y,
        id: el ? el.getAttribute("data-finite-id") : null,
        rect: el ? place(el) : null,
      });
    } else if (m.type === "rect" && typeof m.id === "string") {
      const el = doc.querySelector('[data-finite-id="' + CSS.escape(m.id) + '"]');
      send({ type: "rect", id: m.id, rect: el ? place(el) : null });
    } else if (m.type === "storage") {
      local.sync(m);
    }
  };

  // --- Input ------------------------------------------------------------------

  const using = () => state.interact || state.presenting;

  // The scroll container a wheel gesture belongs to. It's picked once, when
  // the gesture starts, whether or not it can move that way yet, and keeps
  // the gesture through momentum and its own edges.
  const GESTURE_GAP_MS = 120;
  let owner = null;
  let lastWheel = 0;
  const scrolls = (el, dx, dy) => {
    const style = getComputedStyle(el);
    const y = /(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight;
    const x = /(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth;
    return (dy !== 0 && y) || (dx !== 0 && x);
  };
  const ownerOf = (e) => {
    for (const el of e.composedPath()) {
      if (!(el instanceof Element)) continue;
      if (el === doc.documentElement || el === doc.body) break;
      if (scrolls(el, e.deltaX, e.deltaY)) return el;
    }
    const page = doc.scrollingElement;
    const tall =
      page && (page.scrollHeight > page.clientHeight || page.scrollWidth > page.clientWidth);
    return tall ? page : null;
  };
  win.addEventListener(
    "wheel",
    (e) => {
      const zoom = e.ctrlKey || e.metaKey;
      if (state.presenting) {
        // Interactive mode locks the camera: the page scrolls, nothing zooms.
        if (zoom) e.preventDefault();
        return;
      }
      if (state.interact && !zoom) {
        if (e.timeStamp - lastWheel > GESTURE_GAP_MS) owner = ownerOf(e);
        lastWheel = e.timeStamp;
        if (owner) return;
      }
      e.preventDefault();
      send({
        type: "wheel",
        deltaX: e.deltaX,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        clientX: e.clientX,
        clientY: e.clientY,
      });
    },
    { passive: false, capture: true },
  );

  // Links: one to another artboard asks the viewer to go there, an external
  // one asks it to open a new tab. Only a person's click does either. A link
  // to a section of the page scrolls, like a real page. Anything else does nothing.
  const ARTBOARD_LINK = "#finite-artboard=";
  const onLink = (e) => {
    const a = e
      .composedPath()
      .find((el) => el instanceof Element && el.matches("a[href], area[href]"));
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#") && !href.startsWith(ARTBOARD_LINK)) return;
    e.preventDefault();
    if (!e.isTrusted || e.type !== "click" || !using()) return;
    if (href.startsWith(ARTBOARD_LINK)) {
      send({ type: "goto", target: decodeURIComponent(href.slice(ARTBOARD_LINK.length)) });
    } else if (/^https?:$/.test(a.protocol)) {
      send({ type: "open", url: a.href });
    }
  };
  win.addEventListener("click", onLink, true);
  win.addEventListener("auxclick", onLink, true);
  // Forms never send anything; their submit handlers still run.
  win.addEventListener("submit", (e) => e.preventDefault());

  // Keys the viewer needs even while the page has focus: leaving, stepping,
  // going back, restarting, the tool shortcuts, and holding C or Space. Typing in a field
  // keeps every key but Escape. Arrows and letters go only when the page
  // didn't use them, which is known once its own listeners have run.
  const editing = (el) =>
    el instanceof Element && (el.isContentEditable || el.closest("input, textarea, select"));
  const FORWARDED = new Set([
    "ArrowLeft",
    "ArrowRight",
    "[",
    "c",
    "C",
    "v",
    "V",
    "i",
    "I",
    "p",
    "P",
    "r",
    "R",
    " ",
  ]);
  const forward = (e, phase) => {
    // Escape always goes, so a page that kept the focus after it stopped
    // taking input can't trap the way out.
    if (e.key === "Escape") {
      if (phase === "down") send({ type: "key", phase, key: e.key });
      return;
    }
    if (!using()) return;
    if (!FORWARDED.has(e.key) || e.altKey || e.ctrlKey) return;
    if (e.metaKey && e.key !== "[") return;
    if (editing(e.composedPath()[0])) return;
    const key = e.key;
    const meta = e.metaKey;
    setTimeout(
      () => e.defaultPrevented || send({ type: "key", phase, key, meta, repeat: e.repeat }),
    );
  };
  win.addEventListener("keydown", (e) => {
    forward(e, "down");
    if (state.interact && !state.presenting) send({ type: "used" });
  });
  win.addEventListener("keyup", (e) => forward(e, "up"));
  // Held keys end here when focus leaves the page.
  win.addEventListener("blur", () => send({ type: "blur" }));
  win.addEventListener(
    "pointerdown",
    (e) => {
      if (!using()) return;
      // The middle button pans the canvas, which leaves interactive mode.
      if (e.button === 1) {
        e.preventDefault();
        send({ type: "pan" });
        return;
      }
      send({ type: "used" });
    },
    true,
  );
};
