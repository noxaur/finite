// A small Chrome DevTools Protocol client: launch headless Chrome, then
// evaluate, move, click and type in one page.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findChrome, sleep } from "./lib.mjs";

const MODIFIERS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };
const NAMED_KEYS = {
  Enter: 13,
  Escape: 27,
  Tab: 9,
  Backspace: 8,
  Delete: 46,
  Space: 32,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
};
const SHIFTED = {
  1: "!",
  2: "@",
  3: "#",
  4: "$",
  5: "%",
  6: "^",
  7: "&",
  8: "*",
  9: "(",
  0: ")",
  "=": "+",
  "-": "_",
};
const PUNCTUATION = {
  "=": ["Equal", 187],
  "+": ["Equal", 187],
  "-": ["Minus", 189],
  "!": ["Digit1", 49],
  "]": ["BracketRight", 221],
  "[": ["BracketLeft", 219],
};

/** A key spec like `Enter`, `c`, `Shift+1` or `Meta+z` as a CDP key event. */
function keyEvent(spec) {
  const parts = spec.split("+");
  // "+" on its own, or as the last part of "Shift++", is the key itself.
  if (spec.endsWith("+") && parts.at(-1) === "") parts.splice(-2, 2, "+");
  let name = parts.pop();
  let modifiers = 0;
  for (const m of parts) {
    if (!(m in MODIFIERS))
      throw new Error(`unknown modifier ${m}: use Alt, Control, Meta or Shift`);
    modifiers |= MODIFIERS[m];
  }
  let key, code, keyCode;
  if (name === "Space") name = " ";
  if (name in NAMED_KEYS) {
    [key, code, keyCode] = [name, name, NAMED_KEYS[name]];
  } else if (name === " ") {
    [key, code, keyCode] = [" ", "Space", 32];
  } else if (name.length === 1) {
    const shift = modifiers & 8;
    if (/[a-z]/i.test(name)) {
      [key, code, keyCode] = [
        shift ? name.toUpperCase() : name,
        `Key${name.toUpperCase()}`,
        name.toUpperCase().charCodeAt(0),
      ];
    } else if (/\d/.test(name)) {
      [key, code, keyCode] = [shift ? SHIFTED[name] : name, `Digit${name}`, name.charCodeAt(0)];
    } else {
      const [c, k] = PUNCTUATION[name] ?? ["", 0];
      [key, code, keyCode] = [shift && SHIFTED[name] ? SHIFTED[name] : name, c, k];
    }
  } else {
    throw new Error(
      `unknown key ${name}: use a character, or one of ${Object.keys(NAMED_KEYS).join(", ")}`,
    );
  }
  // A printable key types its character, unless Control or Meta turns it into a shortcut.
  const text = key.length === 1 && !(modifiers & 6) ? key : undefined;
  return { key, code, windowsVirtualKeyCode: keyCode, modifiers, text };
}

/**
 * JavaScript for the shadow root an artboard draws into, given JavaScript for
 * the artboard's element, like `document.querySelector('[data-artboard="k3x9a2bq"]')`.
 */
export const shadowOf = (board) =>
  `[...${board}.querySelectorAll("*")].map((e) => e.shadowRoot).find(Boolean)`;

export async function launch({ width = 1440, height = 900 } = {}) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error("no Chrome found; set FINITE_CHROME");
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "finite-e2e-chrome-"));
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "--no-first-run",
    "about:blank",
  ]);
  // Chrome prints the DevTools address once it's listening.
  const endpoint = await new Promise((resolve, reject) => {
    let text = "";
    chrome.stderr.on("data", (chunk) => {
      text += chunk;
      const match = text.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) resolve(match[1]);
    });
    chrome.on("exit", () => reject(new Error(`Chrome exited: ${text}`)));
  });
  const port = new URL(endpoint).port;
  let page;
  for (let i = 0; i < 50 && !page; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    page = targets.find((t) => t.type === "page");
    if (!page) await sleep(100);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  let next = 1;
  const pending = new Map();
  const errors = [];
  /** Event listeners by CDP method, added with `on`. */
  const listeners = new Map();
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description ?? d.text);
    }
    for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, (msg) =>
        msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result),
      );
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const page_ = {
    errors,
    send,
    /**
     * Calls `fn` with the params of every `method` event, like
     * `Page.loadEventFired`. Returns a function that stops it.
     */
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(fn);
      return () =>
        listeners.set(
          method,
          listeners.get(method).filter((f) => f !== fn),
        );
    },
    /** Resolves once Chrome exits, for whatever reason. */
    exited: new Promise((r) => chrome.once("exit", r)),
    /** Loads `url` and resolves on its load event. Throws if that takes over 15 seconds. */
    async goto(url) {
      let off;
      let timer;
      const loaded = new Promise((resolve, reject) => {
        off = page_.on("Page.loadEventFired", resolve);
        timer = setTimeout(
          () => reject(new Error(`${url} didn't finish loading in 15 seconds`)),
          15_000,
        );
      });
      try {
        const { errorText } = await send("Page.navigate", { url });
        if (errorText) throw new Error(`couldn't open ${url}: ${errorText}`);
        await loaded;
      } finally {
        off();
        clearTimeout(timer);
      }
    },
    async eval(expression) {
      const { result, exceptionDetails } = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (exceptionDetails)
        throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    },
    /** Polls `expression` until it's truthy. A DOM node comes back as `true`. */
    async until(expression, timeout = 5000) {
      const start = Date.now();
      for (;;) {
        const value = await page_.eval(
          `(() => { const v = (${expression}); return v instanceof Node ? true : v; })()`,
        );
        if (value) return value;
        if (Date.now() - start > timeout) throw new Error(`timed out waiting for ${expression}`);
        await sleep(50);
      }
    },
    async move(x, y) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    },
    /** Clicks at `x`, `y`, holding Shift when `shift` is set, twice when `double` is. */
    async click(x, y, { shift = false, double = false } = {}) {
      await page_.move(x, y);
      const modifiers = shift ? 8 : 0;
      for (const clickCount of double ? [1, 2] : [1]) {
        for (const type of ["mousePressed", "mouseReleased"]) {
          await send("Input.dispatchMouseEvent", {
            type,
            x,
            y,
            modifiers,
            button: "left",
            clickCount,
          });
        }
      }
    },
    /**
     * Presses at `from`, moves to `to` in `steps` moves, and releases, the
     * way a person drags. Holds Shift when `shift` is set.
     */
    async drag(from, to, { steps = 10, shift = false } = {}) {
      const modifiers = shift ? 8 : 0;
      const mouse = (type, { x, y }, extra = {}) =>
        send("Input.dispatchMouseEvent", { type, x, y, modifiers, button: "left", ...extra });
      await page_.move(from.x, from.y);
      await mouse("mousePressed", from, { clickCount: 1, buttons: 1 });
      for (let i = 1; i <= steps; i++) {
        const at = {
          x: from.x + ((to.x - from.x) * i) / steps,
          y: from.y + ((to.y - from.y) * i) / steps,
        };
        await mouse("mouseMoved", at, { buttons: 1 });
        // A frame between moves, so the page's animation-frame work runs.
        await sleep(20);
      }
      await mouse("mouseReleased", to, { clickCount: 1 });
    },
    async type(text) {
      for (const ch of text) await send("Input.insertText", { text: ch });
    },
    /**
     * Presses a key like `Enter`, `c`, `Shift+1` or `Meta+z`. `text` replaces
     * the character the key types, which Chrome needs for Enter to submit a form.
     */
    async press(spec, { text } = {}) {
      const { text: typed, ...event } = keyEvent(spec);
      const chars = text ?? typed;
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        ...event,
        ...(chars ? { text: chars } : {}),
      });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
    },
    /** One wheel event at `x`, `y`; `ctrl` holds Control, which zooms. */
    async wheel(x, y, deltaX, deltaY = 0, { ctrl = false } = {}) {
      await send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x,
        y,
        deltaX,
        deltaY,
        modifiers: ctrl ? 2 : 0,
      });
    },
    /** Two animation frames, so React and the canvas draw what an input changed. */
    settle() {
      return page_.eval(
        `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`,
      );
    },
    /** The box of the element `js` evaluates to, as `{ x, y, w, h }`. */
    rect(js) {
      return page_.eval(
        `(() => { const r = (${js}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
      );
    },
    /** Waits for the element `js` evaluates to, then clicks its center. */
    async clickOn(js) {
      await page_.until(js);
      const r = await page_.rect(js);
      await page_.click(r.x + r.w / 2, r.y + r.h / 2);
    },
    async screenshot(file) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(file, Buffer.from(data, "base64"));
    },
    async close() {
      ws.close();
      const exited = new Promise((r) => chrome.once("exit", r));
      chrome.kill();
      await exited;
      fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
    },
  };
  return page_;
}
