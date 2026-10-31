// End-to-end test: a real server, a real agent over MCP, and headless Chrome.
//
//   vp run e2e
//
// It builds the server and the web app (set E2E_SKIP_BUILD=1 to reuse the
// last builds), starts the server on a free port with a throwaway data folder,
// and checks what a person sees while an agent works. Set FINITE_CHROME if
// Chrome isn't in a standard place. Exits with 1 if any check fails.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp.mjs";
import { connect, idAfter } from "./mcp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures.push(label);
};

if (!process.env.E2E_SKIP_BUILD) {
  const run = (cmd, args, cwd) => {
    console.log(`$ ${cmd} ${args.join(" ")}`);
    const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
    if (result.status !== 0) process.exit(1);
  };
  run("cargo", ["build", "-q", "-p", "finite-server"], root);
  run("npx", ["next", "build"], path.join(root, "apps/web"));
}

const port = await new Promise((resolve) => {
  const probe = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const base = `http://127.0.0.1:${port}`;
const data = fs.mkdtempSync(path.join(os.tmpdir(), "finite-e2e-data-"));
const server = spawn(path.join(root, "target/debug/finite-server"), [], {
  env: {
    ...process.env,
    FINITE_PORT: String(port),
    FINITE_DATA_DIR: data,
    FINITE_STATIC_DIR: path.join(root, "apps/web/out"),
    RUST_LOG: "warn",
  },
  stdio: ["ignore", "inherit", "inherit"],
});
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

let page;
try {
  const agent = await connect(base);
  const comments = async (id) => (await (await fetch(`${base}/api/designs/${id}`)).json()).comments;

  // An agent builds two artboards: plain HTML, and one with a script, which
  // renders in a sandboxed iframe.
  const design = (await agent.call("create_design", { name: "E2E" })).match(
    /designId "([a-z0-9]+)"/,
  )[1];
  const page1 = idAfter(
    await agent.call("create_artboard", {
      designId: design,
      name: "Page",
      width: 800,
      height: 500,
    }),
    "artboard",
  );
  const built = await agent.call("write_html", {
    designId: design,
    targetId: page1,
    html: `<div data-name="Hero" style="padding:48px;display:flex;flex-direction:column;gap:16px"><h1 data-name="Title" style="margin:0;font:600 36px system-ui">Hello</h1><button data-name="CTA" style="width:160px;height:48px">Start</button></div>`,
  });
  const cta = idAfter(built, '"CTA"');
  const live = idAfter(
    await agent.call("create_artboard", {
      designId: design,
      name: "Live",
      width: 600,
      height: 400,
    }),
    "artboard",
  );
  const scripted = await agent.call("write_html", {
    designId: design,
    targetId: live,
    html: `<div data-name="Stage" style="position:relative;width:600px;height:400px"><button data-name="Go" class="go" style="position:absolute;left:100px;top:100px;width:160px;height:48px">Go</button></div><script>document.querySelector(".go").addEventListener("click", () => {});</script>`,
  });
  const go = idAfter(scripted, '"Go"');

  page = await launch();
  // Keep every WebSocket the page opens, so a check can drop one.
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `const Native = WebSocket; window.__sockets = []; window.WebSocket = class extends Native { constructor(...args) { super(...args); __sockets.push(this); } };`,
  });
  await page.goto(`${base}/design/?id=${design}`);
  check(
    "both artboards render",
    (await page.eval(`document.querySelectorAll("[data-artboard]").length`)) === 2,
  );
  check(
    "the scripted one renders in a sandboxed iframe",
    (await page.eval(`document.querySelectorAll("[data-artboard] iframe[sandbox]").length`)) === 1,
  );

  // Helpers that find things inside the plain artboard's shadow root.
  const shadow = `[...document.querySelector('[data-artboard="${page1}"]').querySelectorAll("*")].map((e) => e.shadowRoot).find(Boolean)`;
  const rectOf = (js) =>
    page.eval(
      `(() => { const r = (${js}).getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
    );
  const activity = `[...document.querySelectorAll("ol li")].map((l) => l.textContent)[0] ?? ""`;

  // Live edits and undo.
  await agent.call("update_styles", {
    designId: design,
    updates: [{ nodeIds: [cta], styles: { outline: "3px solid rgb(0, 128, 0)" } }],
  });
  check(
    "an agent's edit patches the page",
    Boolean(
      await page.until(
        `${shadow}.querySelector("button").style.outline.includes("rgb(0, 128, 0)")`,
      ),
    ),
  );
  check("the activity list shows it", (await page.eval(activity)).includes("Update styles"));
  await agent.call("undo", { designId: design });
  check(
    "undo reverts it",
    Boolean(await page.until(`${shadow}.querySelector("button").style.outline === ""`)),
  );

  // A dropped connection resumes: the page gets what it missed, and the
  // artboards aren't rebuilt (a snapshot would replace the iframe).
  await page.eval(
    `window.__frame = document.querySelector("[data-artboard] iframe"); __sockets.filter((s) => s.url.includes("/ws")).forEach((s) => s.close()); 0`,
  );
  await agent.call("update_styles", {
    designId: design,
    updates: [{ nodeIds: [cta], styles: { outline: "3px solid rgb(0, 0, 255)" } }],
  });
  check(
    "a dropped connection catches up",
    Boolean(
      await page.until(
        `${shadow}.querySelector("button").style.outline.includes("rgb(0, 0, 255)")`,
      ),
    ),
  );
  check(
    "by resuming, not starting over",
    (await page.eval(`__sockets.some((s) => s.url.includes("since="))`)) &&
      (await page.eval(`__frame.isConnected`)),
  );
  await agent.call("undo", { designId: design });
  await page.until(`${shadow}.querySelector("button").style.outline === ""`);

  // Presence.
  await agent.call("start_working_on_nodes", {
    designId: design,
    nodeIds: [cta],
    status: "Testing",
  });
  check(
    "the working badge shows",
    Boolean(await page.until(`document.body.textContent.includes("E2E: Testing")`)),
  );
  await agent.call("finish_working_on_nodes", { designId: design });
  check(
    "and clears",
    Boolean(await page.until(`!document.body.textContent.includes("E2E: Testing")`)),
  );

  // A person comments on the button, under their own name.
  await page.key("c", "KeyC", 67);
  const button = await rectOf(`${shadow}.querySelector("button")`);
  const target = `document.querySelector('[data-outline="target"]')`;
  await page.move(button.x + 5, button.y + 5);
  await page.move(button.x + button.w / 2, button.y + button.h / 2);
  await page.until(target);
  const outline = await rectOf(target);
  check(
    "hovering outlines the button",
    Math.abs(outline.w - button.w) < 2 && Math.abs(outline.h - button.h) < 2,
    `${Math.round(outline.w)}×${Math.round(outline.h)}`,
  );
  await page.click(button.x + button.w / 2, button.y + button.h / 2);
  const nameButton = await rectOf(`document.querySelector('button[title="Change your name"]')`);
  await page.click(nameButton.x + 2, nameButton.y + 2);
  await page.type("Tester");
  await page.key("Enter", "Enter", 13);
  const textarea = await rectOf(`document.querySelector("textarea")`);
  await page.click(textarea.x + 10, textarea.y + 10);
  await page.type("Make it orange");
  await page.key("Enter", "Enter", 13);
  await page.until(`document.querySelectorAll('button[aria-label^="Comment:"]').length === 1`);
  const [posted] = await comments(design);
  check("the comment points at the button", posted?.nodeId === cta);
  check("under the name the person set", posted?.messages[0].author.name === "Tester");

  // The agent picks it up, changes the button, and replies.
  const waiting = await agent.call("wait_for_comments", { designId: design, timeoutSeconds: 5 });
  check("wait_for_comments hands the agent the comment", waiting.includes("Make it orange"));
  await agent.call("update_styles", {
    designId: design,
    updates: [{ nodeIds: [cta], styles: { backgroundColor: "orange" } }],
  });
  const replied = await agent.call("reply_to_comment", {
    designId: design,
    commentId: posted.id,
    message: "Done",
    resolve: true,
  });
  check("the reply links the agent's change", replied.includes("1 change"), replied);

  // The person opens the thread and jumps to the change.
  const pin = await rectOf(`document.querySelector('button[aria-label^="Comment:"]')`);
  await page.key("Escape", "Escape", 27);
  await page.click(pin.x + pin.w / 2, pin.y + pin.h / 2);
  await page.until(`document.querySelector('button[title="Show what changed"]')`);
  const chip = await rectOf(`document.querySelector('button[title="Show what changed"]')`);
  await page.click(chip.x + chip.w / 2, chip.y + chip.h / 2);
  check(
    "showing the change outlines it",
    Boolean(await page.until(`document.querySelector('[data-outline="flash"]')`)),
  );
  await page.until(`!document.querySelector('[data-outline="flash"]')`);
  await page.key("Escape", "Escape", 27);

  // A comment inside the sandboxed artboard points at the element there.
  // Comment mode turns off the iframe's pointer events, but Chrome routes the
  // mouse by the last drawn frame, so wait for one or the iframe gets the moves.
  await page.key("c", "KeyC", 67);
  await page.until(
    `getComputedStyle(document.querySelector("[data-artboard] iframe")).pointerEvents === "none"`,
  );
  await page.eval(
    `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`,
  );
  const frame = await page.eval(
    `(() => { const f = document.querySelector("[data-artboard] iframe"); const r = f.getBoundingClientRect(); return { x: r.x, y: r.y, scale: r.width / f.offsetWidth }; })()`,
  );
  const goX = frame.x + 180 * frame.scale;
  const goY = frame.y + 124 * frame.scale;
  await page.move(goX - 5, goY - 5);
  await page.move(goX, goY);
  await page.until(
    `(() => { const o = document.querySelector('[data-outline="target"]'); return o && Math.abs(o.getBoundingClientRect().width - ${160 * frame.scale}) < 2; })()`,
  );
  check("hovering inside the sandbox outlines its button", true);
  await page.click(goX, goY);
  const sandboxBox = await rectOf(`document.querySelector("textarea")`);
  await page.click(sandboxBox.x + 10, sandboxBox.y + 10);
  await page.type("Sandbox note");
  await page.key("Enter", "Enter", 13);
  await page.until(`document.querySelectorAll('button[aria-label^="Comment:"]').length === 2`);
  const sandboxComment = (await comments(design)).find(
    (c) => c.messages[0].body === "Sandbox note",
  );
  check("the sandbox comment points at that button", sandboxComment?.nodeId === go);

  // Pins stay put when their artboard is deleted, and follow it back.
  const scratch = idAfter(
    await agent.call("create_artboard", {
      designId: design,
      name: "Scratch",
      width: 300,
      height: 200,
    }),
    "artboard",
  );
  await fetch(`${base}/api/designs/${design}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      author: { id: "e2e", name: "Tester" },
      body: "Detach me",
      artboardId: scratch,
      nodeId: scratch,
      x: 30,
      y: 30,
    }),
  });
  const detachPin = `(() => { const b = [...document.querySelectorAll('button[aria-label^="Comment:"]')].find((b) => b.getAttribute("aria-label").includes("Detach me")); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y) }; })()`;
  const before = await page.until(detachPin);
  await agent.call("delete_nodes", { designId: design, nodeIds: [scratch] });
  await page.until(`document.querySelectorAll("[data-artboard]").length === 2`);
  const after = await page.eval(detachPin);
  check(
    "a pin stays put when its artboard is deleted",
    after?.x === before.x && after?.y === before.y,
    JSON.stringify({ before, after }),
  );
  await agent.call("undo", { designId: design });
  await page.until(`document.querySelectorAll("[data-artboard]").length === 3`);
  const back = await page.eval(detachPin);
  check(
    "and is still there when undo brings the artboard back",
    back?.x === before.x && back?.y === before.y,
  );

  // A comment that can't be sent says so, and keeps its text.
  await page.send("Network.enable");
  await page.send("Network.setBlockedURLs", { urls: ["*/comments"] });
  await page.key("Escape", "Escape", 27);
  await page.key("c", "KeyC", 67);
  const board = await rectOf(`document.querySelector('[data-artboard="${page1}"]')`);
  await page.click(board.x + 20, board.y + board.h - 20);
  const draftBox = await rectOf(`document.querySelector("textarea")`);
  await page.click(draftBox.x + 10, draftBox.y + 10);
  await page.type("Offline note");
  await page.key("Enter", "Enter", 13);
  check(
    "a comment that fails to send says so",
    Boolean(
      await page.until(`document.querySelector('[role="alert"]')?.textContent.includes("Couldn")`),
    ),
  );
  check(
    "and keeps its text",
    (await page.eval(`document.querySelector("textarea").value`)) === "Offline note",
  );
  await page.send("Network.setBlockedURLs", { urls: [] });
  await page.key("Escape", "Escape", 27);

  // On the design list, a design that can't be created says so.
  await page.goto(`${base}/`);
  await page.until(`document.querySelectorAll("main li").length > 0`);

  // A thumbnail follows an agent's edits, but fetches at most every 2 seconds.
  const fetches = `performance.getEntriesByType("resource").filter((e) => e.name.endsWith("/api/designs/${design}")).length`;
  await page.sleep(1000);
  const fetchedBefore = await page.eval(fetches);
  for (let i = 0; i < 6; i++) {
    await agent.call("update_styles", {
      designId: design,
      updates: [{ nodeIds: [cta], styles: { opacity: String(0.5 + i / 20) } }],
    });
    await page.sleep(400);
  }
  await page.sleep(2500);
  const thumbnailFetches = (await page.eval(fetches)) - fetchedBefore;
  check(
    "a thumbnail refetches at most every 2 seconds",
    thumbnailFetches >= 1 && thumbnailFetches <= 3,
    `${thumbnailFetches} fetches for 6 edits over 2.4 s`,
  );
  await page.send("Network.setBlockedURLs", { urls: ["*/api/designs"] });
  const newButton = await rectOf(
    `[...document.querySelectorAll("button")].find((b) => b.textContent === "New design")`,
  );
  await page.click(newButton.x + 5, newButton.y + 5);
  check(
    "a design that fails to be created says so",
    Boolean(
      await page.until(`document.querySelector('[role="alert"]')?.textContent.includes("Couldn")`),
    ),
  );
  await page.send("Network.setBlockedURLs", { urls: [] });

  check("no errors on the page", page.errors.length === 0, page.errors.join(" | "));
} catch (error) {
  check("the run finished", false, error.stack ?? String(error));
  if (page) await page.screenshot(path.join(os.tmpdir(), "finite-e2e-failure.png")).catch(() => {});
} finally {
  server.kill();
  await page?.close().catch(() => {});
  fs.rmSync(data, { recursive: true, force: true, maxRetries: 5 });
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nAll checks passed");
process.exit(failures.length ? 1 : 0);
