// A small Chrome DevTools Protocol client: launch headless Chrome, then
// evaluate, move, click and type in one page.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
];

export function findChrome() {
  return process.env.FINITE_CHROME ?? CANDIDATES.find((p) => fs.existsSync(p));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === "Runtime.exceptionThrown") {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description ?? d.text);
    }
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
    sleep,
    async goto(url) {
      await send("Page.navigate", { url });
      await sleep(2500);
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
    async click(x, y) {
      await page_.move(x, y);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
    },
    async type(text) {
      for (const ch of text) await send("Input.insertText", { text: ch });
    },
    async key(key, code = key, keyCode = 0) {
      await send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key,
        code,
        windowsVirtualKeyCode: keyCode,
        ...(key.length === 1 ? { text: key } : {}),
      });
      await send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key,
        code,
        windowsVirtualKeyCode: keyCode,
      });
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
