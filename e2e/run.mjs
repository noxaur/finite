// End-to-end test: a real server, a real agent over MCP, and headless Chrome.
//
//   vp run e2e
//
// It builds the server and the web app (set E2E_SKIP_BUILD=1 to reuse the
// last builds), starts the server on a free port with a throwaway data folder,
// and checks what a person sees while an agent works. Set FINITE_CHROME if
// Chrome isn't in a standard place, and E2E_SERVER to run a server binary
// other than target/debug/finite-server. Exits with 1 if any check fails.
//
// With E2E_ROUTER=1 (`vp run e2e:router`), it starts two servers and a router
// in front of them instead, and runs every check through the router.
//
// With E2E_SHARED=1 (`vp run e2e:shared`), the two servers and the router
// share one Postgres database, as in a failover setup. It takes the database
// from E2E_DATABASE_URL or FINITE_TEST_DATABASE_URL, and skips with a note if
// neither is set. Each run keeps its tables in a new schema, finite_e2e_*,
// which it leaves behind, so point it at a database for tests.
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

const shared = Boolean(process.env.E2E_SHARED);
const database = process.env.E2E_DATABASE_URL || process.env.FINITE_TEST_DATABASE_URL;
if (shared && !database) {
  console.log("SKIP e2e:shared needs E2E_DATABASE_URL or FINITE_TEST_DATABASE_URL");
  process.exit(0);
}

if (!process.env.E2E_SKIP_BUILD) {
  const run = (cmd, args, cwd) => {
    console.log(`$ ${cmd} ${args.join(" ")}`);
    const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
    if (result.status !== 0) process.exit(1);
  };
  // The shared store is behind a cargo feature.
  const features = shared ? ["--features", "postgres"] : [];
  run("cargo", ["build", "-q", "-p", "finite-server", ...features], root);
  run("node", ["crates/wasm/build.mjs"], root);
  run("npx", ["next", "build"], path.join(root, "apps/web"));
}

const freePort = () =>
  new Promise((resolve) => {
    const probe = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
const viaRouter = Boolean(process.env.E2E_ROUTER) || shared;
const bin = process.env.E2E_SERVER || path.join(root, "target/debug/finite-server");
const staticDir = path.join(root, "apps/web/out");
/** Every process this run starts, and the throwaway data folders they use. */
const processes = [];
const folders = [];
const start = (args, env) => {
  const child = spawn(bin, args, {
    env: { ...process.env, RUST_LOG: "warn", ...env },
    stdio: ["ignore", "inherit", "inherit"],
  });
  processes.push(child);
  return child;
};
const healthy = async (url) => {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/api/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
};

let base;
if (shared) {
  const schema = `finite_e2e_${Math.random().toString(36).slice(2, 10)}`;
  const db = { FINITE_DATABASE_URL: database, FINITE_DATABASE_SCHEMA: schema };
  const ports = [await freePort(), await freePort()];
  const servers = ports.map((p) => `http://127.0.0.1:${p}`);
  ports.forEach((p, i) => {
    start([], { ...db, FINITE_PORT: String(p), FINITE_NODE_URL: servers[i] });
  });
  const front = await freePort();
  start(["router"], { ...db, FINITE_PORT: String(front), FINITE_STATIC_DIR: staticDir });
  for (const url of servers) await healthy(url);
  base = `http://127.0.0.1:${front}`;
  await healthy(base);
  // The router reads the live servers from the database every 2 seconds.
  // Each server owns about half the ids, so 20 ids reach both once it sees them.
  let seen = 0;
  for (let i = 0; i < 100 && seen < 2; i++) {
    const owners = await Promise.all(
      Array.from({ length: 20 }, async (_, n) => {
        const res = await fetch(`${base}/api/owner/probe${n}`).catch(() => null);
        return res?.ok ? (await res.json()).owner : null;
      }),
    );
    seen = new Set(owners.filter((o) => servers.includes(o))).size;
    if (seen < 2) await new Promise((r) => setTimeout(r, 100));
  }
  check("the router sees both servers in the database", seen === 2, `schema ${schema}`);
} else if (viaRouter) {
  const ports = [await freePort(), await freePort()];
  const nodes = ports.map((p) => `http://127.0.0.1:${p}`).join(",");
  ports.forEach((p, i) => {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), "finite-e2e-data-"));
    folders.push(data);
    start([], {
      FINITE_PORT: String(p),
      FINITE_DATA_DIR: data,
      FINITE_NODES: nodes,
      FINITE_NODE: String(i),
    });
  });
  const front = await freePort();
  start(["router"], {
    FINITE_PORT: String(front),
    FINITE_NODES: nodes,
    FINITE_STATIC_DIR: staticDir,
  });
  for (const p of ports) await healthy(`http://127.0.0.1:${p}`);
  base = `http://127.0.0.1:${front}`;
} else {
  const port = await freePort();
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "finite-e2e-data-"));
  folders.push(data);
  start([], { FINITE_PORT: String(port), FINITE_DATA_DIR: data, FINITE_STATIC_DIR: staticDir });
  base = `http://127.0.0.1:${port}`;
}
await healthy(base);
console.log(
  shared
    ? `Through a router at ${base}, in front of two servers sharing Postgres`
    : viaRouter
      ? `Through a router at ${base}, in front of two servers`
      : `Server at ${base}`,
);

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
  const title = idAfter(built, '"Title"');
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
  // Rendering can outlast goto's wait on a busy machine.
  await page
    .until(`document.querySelectorAll("[data-artboard]").length === 2`, 10_000)
    .catch(() => {});
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
  const activity = `[...document.querySelectorAll('ol[aria-label="Recent changes"] li')].map((l) => l.textContent)[0] ?? ""`;

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

  // Components: an instance draws its component, and an edit to the
  // component draws every instance again, while an override changes one.
  const badge = idAfter(
    await agent.call("write_html", {
      designId: design,
      targetId: page1,
      html: `<span data-name="Badge" style="color: rgb(0, 0, 0)">New</span>`,
    }),
    '"Badge"',
  );
  await agent.call("create_component", { designId: design, nodeId: badge });
  const instance = idAfter(
    await agent.call("write_html", {
      designId: design,
      targetId: page1,
      html: `<span data-instance-of="${badge}"></span>`,
    }),
    "span",
  );
  const drawn = (id) => `${shadow}.querySelectorAll("span")[${id === badge ? 0 : 1}]`;
  check(
    "an instance draws its component",
    Boolean(await page.until(`${drawn(instance)}?.textContent === "New"`)),
  );
  await agent.call("update_styles", {
    designId: design,
    updates: [{ nodeIds: [badge], styles: { color: "rgb(0, 128, 0)" } }],
  });
  check(
    "editing the component draws the instance again",
    Boolean(await page.until(`${drawn(instance)}?.style.color === "rgb(0, 128, 0)"`)),
  );
  await agent.call("set_text_content", {
    designId: design,
    updates: [{ nodeId: instance, text: "Sale" }],
  });
  check(
    "an override changes only the instance",
    Boolean(
      await page.until(
        `${drawn(instance)}?.textContent === "Sale" && ${drawn(badge)}.textContent === "New"`,
      ),
    ),
  );
  await agent.call("delete_nodes", { designId: design, nodeIds: [badge, instance] });

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

  // Agent HTML can't smuggle a script URL in through SVG animation.
  await agent.call("write_html", {
    designId: design,
    targetId: page1,
    html: `<svg data-name="Trap" width="80" height="20"><a><animate attributeName="href" values="0;javascript:alert(1)"/><text y="15">Go</text></a></svg>`,
  });
  check(
    "an SVG animation can't set a script URL",
    (await page.until(`${shadow}.querySelector("animate") ? "ready" : null`)) === "ready" &&
      (await page.eval(`${shadow}.querySelector("animate").getAttribute("values")`)) === null,
  );
  await agent.call("undo", { designId: design });

  // Links and forms in a design don't take the viewer anywhere, not even a
  // form submitted with Enter, which needs no click.
  await agent.call("write_html", {
    designId: design,
    targetId: page1,
    html: `<div data-name="Leaks" style="display:flex;gap:8px"><a href="https://example.com/" style="display:block;width:80px;height:30px">Out</a><form action="https://example.com/"><input name="q" style="width:120px;height:30px"></form></div>`,
  });
  await page.until(`${shadow}.querySelector("form") ? "ready" : null`);
  // The Navigation API sees every navigation a click or a form starts.
  await page.eval(
    `window.__navigations = 0; navigation.addEventListener("navigate", (e) => { __navigations++; if (e.cancelable) e.preventDefault(); }); 0`,
  );
  await page.key("c", "KeyC", 67);
  await page.eval(
    `new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))`,
  );
  const link = await rectOf(`${shadow}.querySelector("a[href]")`);
  await page.click(link.x + link.w / 2, link.y + link.h / 2);
  await page.key("Escape", "Escape", 27);
  await page.key("Escape", "Escape", 27);
  await page.eval(`${shadow}.querySelector("input").focus(); 0`);
  // With `text`, Chrome runs Enter's default action: implicit submission.
  const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...enter, text: "\r" });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
  await page.sleep(300);
  const navigations = await page.eval(`__navigations`);
  check(
    "a design's links and forms don't navigate the page",
    navigations === 0,
    `${navigations} navigations`,
  );
  await agent.call("undo", { designId: design });

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

  // A person adds a token in the app. Every artboard gets it, the sandboxed
  // one too, and the button the agent styled with var(--ok) turns green.
  await agent.call("update_styles", {
    designId: design,
    updates: [{ nodeIds: [cta], styles: { color: "var(--ok, rgb(1, 2, 3))" } }],
  });
  // The agent's presence chip moves the header's buttons, so wait for the edit first.
  await page.until(`getComputedStyle(${shadow}.querySelector("button")).color === "rgb(1, 2, 3)"`);
  const panel = `document.querySelector('section[aria-label="Tokens"]')`;
  const tokensToggle = await rectOf(
    `[...document.querySelectorAll("header button")].find((b) => b.textContent === "Tokens")`,
  );
  await page.click(tokensToggle.x + tokensToggle.w / 2, tokensToggle.y + tokensToggle.h / 2);
  await page.until(panel);
  const field = (label) => `${panel}.querySelector('input[aria-label="${label}"]')`;
  const nameBox = await rectOf(field("New token name"));
  await page.click(nameBox.x + 10, nameBox.y + nameBox.h / 2);
  await page.type("--ok");
  const valueBox = await rectOf(field("New token value"));
  await page.click(valueBox.x + 10, valueBox.y + valueBox.h / 2);
  await page.type("rgb(0, 128, 0)");
  const add = await rectOf(`${panel}.querySelector('form[aria-label="Add a token"] button')`);
  await page.click(add.x + add.w / 2, add.y + add.h / 2);
  const ctaStyle = `getComputedStyle(${shadow}.querySelector("button"))`;
  check(
    "a token reaches every artboard",
    Boolean(await page.until(`${ctaStyle}.color === "rgb(0, 128, 0)"`)) &&
      Boolean(
        await page.until(
          `document.querySelector("[data-artboard] iframe").srcdoc.includes("--ok: rgb(0, 128, 0);")`,
        ),
      ),
  );
  check(
    "the activity list shows the person's edit",
    (await page.eval(activity)).includes("Set tokens"),
  );
  check(
    "the panel lists the token",
    Boolean(await page.until(`${field("--ok in Default")}?.value === "rgb(0, 128, 0)"`)),
  );

  // An agent adds a Dark mode, and the person puts the artboard in it.
  await agent.call("set_tokens", {
    designId: design,
    modes: ["Light", "Dark"],
    tokens: { "--ok": { Dark: "rgb(0, 0, 255)" } },
  });
  await page.until(`${field("--ok in Dark")}?.value === "rgb(0, 0, 255)"`);
  // The select of the artboard named "Page".
  const select = `[...${panel}.querySelectorAll("label")].find((l) => l.textContent.startsWith("Page")).querySelector("select")`;
  await page.eval(
    `(() => { const s = ${select}; s.value = [...s.options].find((o) => o.textContent === "Dark").value; s.dispatchEvent(new Event("change", { bubbles: true })); })()`,
  );
  check(
    "an artboard in the Dark mode takes its values",
    Boolean(await page.until(`${ctaStyle}.color === "rgb(0, 0, 255)"`)),
  );
  const close = await rectOf(`${panel}.querySelector('button[type="button"]')`);
  await page.click(close.x + close.w / 2, close.y + close.h / 2);
  await page.until(`!${panel}`);
  await fetch(`${base}/api/designs/${design}/tokens`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ author: { id: "e2e", name: "E2E" }, tokens: { "--ok": null } }),
  });
  await page.until(`${ctaStyle}.color === "rgb(1, 2, 3)"`);

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
  // Shift-click adds the title to what the comment points at.
  const heading = await rectOf(`${shadow}.querySelector("h1")`);
  // Its left end: the comment box opens over the rest.
  await page.click(heading.x + 5, heading.y + heading.h / 2, { shift: true });
  await page.until(`document.querySelector('[data-selection-count="2"]')`);
  check(
    "shift-click outlines both elements",
    (await page.eval(`document.querySelectorAll('[data-outline="target"]').length`)) === 2,
  );
  check(
    "and keeps the comment box focused",
    await page.eval(`document.activeElement?.value === "Make it orange"`),
  );
  await page.key("Enter", "Enter", 13);
  await page.until(`document.querySelectorAll('button[aria-label^="Comment:"]').length === 1`);
  const [posted] = await comments(design);
  check("the comment points at the button", posted?.nodeId === cta);
  check("and the title picked with it", posted?.extraNodeIds?.[0] === title);
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

  // A resolved pin leaves the canvas at once, and reopening brings it back.
  const pins = `document.querySelectorAll('button[aria-label^="Comment:"]').length`;
  const setResolved = (resolved) =>
    fetch(`${base}/api/designs/${design}/comments/${posted.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved }),
    });
  await setResolved(true);
  await page.until(`${pins} === 0`);
  check("a resolved pin leaves the canvas", true);
  await setResolved(false);
  await page.until(`${pins} === 1`);
  check("and returns when the comment reopens", true);

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

  // A comment the server refuses says why. Fill the design to its 500 open comments.
  let filled = 0;
  for (; filled < 600; filled++) {
    const res = await fetch(`${base}/api/designs/${design}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        author: { id: "e2e", name: "Tester" },
        body: `Filler ${filled}`,
        artboardId: null,
        nodeId: null,
        x: -2000 - filled,
        y: -2000,
      }),
    });
    if (res.status === 422) break;
  }
  check("a design stops taking comments at 500 open ones", filled < 600, `${filled} posted`);
  // Clicking the box again left focus on the page here, so focus it directly.
  await page.eval(`document.querySelector("textarea").focus()`);
  await page.key("Enter", "Enter", 13);
  check(
    "a comment the server refuses says why",
    Boolean(
      await page.until(
        `document.querySelector('[role="alert"]')?.textContent.includes("500 open comments")`,
      ),
    ),
    await page.eval(`document.querySelector('[role="alert"]')?.textContent`),
  );
  await page.key("Escape", "Escape", 27);

  // On the design list, a design that can't be created says so.
  await page.goto(`${base}/`);
  await page.until(`document.querySelectorAll("main li").length > 0`);

  // A thumbnail follows an agent's edits, but fetches at most every 2 seconds.
  const fetches = `performance.getEntriesByType("resource").filter((e) => e.name.endsWith("/api/designs/${design}")).length`;
  await page.sleep(1000);
  const fetchedBefore = await page.eval(fetches);
  const editsStarted = Date.now();
  for (let i = 0; i < 6; i++) {
    await agent.call("update_styles", {
      designId: design,
      updates: [{ nodeIds: [cta], styles: { opacity: String(0.5 + i / 20) } }],
    });
    await page.sleep(400);
  }
  // About 2.4 s, longer on a busy machine: one fetch per 2 s of it, plus
  // the first and the last.
  const editing = Date.now() - editsStarted;
  await page.sleep(2500);
  const thumbnailFetches = (await page.eval(fetches)) - fetchedBefore;
  check(
    "a thumbnail refetches at most every 2 seconds",
    thumbnailFetches >= 1 && thumbnailFetches <= Math.floor(editing / 2000) + 2,
    `${thumbnailFetches} fetches for 6 edits over ${(editing / 1000).toFixed(1)} s`,
  );
  // A design too big to preview shows its size, and stops being fetched.
  const huge = (await agent.call("create_design", { name: "Huge" })).match(
    /designId "([a-z0-9]+)"/,
  )[1];
  const hugeBoard = idAfter(
    await agent.call("create_artboard", { designId: huge, name: "Wall", width: 400, height: 300 }),
    "artboard",
  );
  await agent.call("write_html", {
    designId: huge,
    targetId: hugeBoard,
    html: "<i></i>".repeat(6000),
  });
  await page.until(`document.body.textContent.includes("6,001 nodes, too many to preview")`);
  // A preview fetch from before the write can still be landing, more so
  // through the router, so let it finish before counting.
  await page.sleep(500);
  const hugeFetches = `performance.getEntriesByType("resource").filter((e) => e.name.endsWith("/api/designs/${huge}")).length`;
  const hugeBefore = await page.eval(hugeFetches);
  for (let i = 0; i < 3; i++) {
    await agent.call("update_styles", {
      designId: huge,
      updates: [{ nodeIds: [hugeBoard], styles: { opacity: String(0.9 - i / 10) } }],
    });
  }
  await page.sleep(2500);
  check(
    "a design too big to preview shows its size and isn't fetched",
    (await page.eval(hugeFetches)) === hugeBefore,
  );

  // With more designs than the list starts with, a search finds the rest.
  for (let i = 0; i < 200; i++) {
    await fetch(`${base}/api/designs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `Filler ${i}` }),
    });
  }
  await page.goto(`${base}/`);
  check(
    "a long design list says how much it shows",
    Boolean(
      await page.until(`document.body.textContent.includes("most recently edited of 202 designs")`),
    ),
  );
  const search = await rectOf(`document.querySelector('input[type="search"]')`);
  await page.click(search.x + 10, search.y + 5);
  await page.type("E2E");
  check(
    "and searching by name finds an older one",
    Boolean(
      await page.until(
        `document.querySelectorAll("main li").length === 1 && document.querySelector("main li").textContent.includes("E2E")`,
      ),
    ),
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

  // A search that fails says so, and searches the designs the page has.
  await page.send("Network.setBlockedURLs", { urls: ["*/api/designs?q=*"] });
  // The alert above moved the search box, so find it again.
  const searchNow = await rectOf(`document.querySelector('input[type="search"]')`);
  await page.click(searchNow.x + 10, searchNow.y + 5);
  await page.eval(`document.querySelector('input[type="search"]').select()`);
  await page.type("Filler 19");
  check(
    "a search that fails says so and shows the matches it has",
    Boolean(
      await page.until(
        `[...document.querySelectorAll('[role="alert"]')].some((a) => a.textContent.includes("search every design")) && document.querySelectorAll("main li").length === 11`,
      ),
    ),
  );
  await page.send("Network.setBlockedURLs", { urls: [] });

  const deleteSearch = await rectOf(`document.querySelector('input[type="search"]')`);
  await page.click(deleteSearch.x + 10, deleteSearch.y + 5);
  await page.eval(`document.querySelector('input[type="search"]').select()`);
  await page.type("E2E");
  check(
    "the design to delete is found by search",
    Boolean(
      await page.until(
        `document.querySelectorAll("main li").length === 1 && document.querySelector("main li").textContent.includes("E2E")`,
      ),
    ),
  );
  await agent.call("delete_design", { designId: design });
  check(
    "deletion refreshes active search results",
    Boolean(await page.until(`document.querySelectorAll("main li").length === 0`)),
  );

  // Artboards outside the view are hidden. A sandboxed one keeps its
  // document for a while, so showing it again doesn't start its scripts
  // over. "Fit to view" still counts the hidden ones, and an auto-height one
  // keeps the height it had when it was shown.
  const wide = (await agent.call("create_design", { name: "Culling" })).match(
    /designId "([a-z0-9]+)"/,
  )[1];
  const near = idAfter(
    await agent.call("create_artboard", { designId: wide, name: "Near", width: 600, height: 400 }),
    "artboard",
  );
  const far = idAfter(
    await agent.call("create_artboard", {
      designId: wide,
      name: "Far",
      width: 600,
      x: 30_000,
      y: 0,
    }),
    "artboard",
  );
  await agent.call("write_html", {
    designId: wide,
    targetId: far,
    html: `<div data-name="Tall" style="height:900px;background:#eee"></div>`,
  });
  const farLive = idAfter(
    await agent.call("create_artboard", {
      designId: wide,
      name: "Far live",
      width: 600,
      height: 400,
      x: 0,
      y: 30_000,
    }),
    "artboard",
  );
  await agent.call("write_html", {
    designId: wide,
    targetId: farLive,
    html: `<div data-name="Box" style="width:100px;height:100px;animation:spin 1s infinite"></div><style>@keyframes spin{to{opacity:.5}}</style><script>document.title="on";parent.postMessage({boot:1},"*")</script>`,
  });
  await page.goto(`${base}/design/?id=${wide}`);
  await page.until(`document.querySelectorAll("[data-artboard]").length === 3`, 10_000);
  const hidden = (id) =>
    page.eval(`document.querySelector('[data-artboard="${id}"]').style.display === "none"`);
  const loaded = () =>
    page.eval(`document.querySelector('[data-artboard="${farLive}"] iframe').srcdoc.length > 0`);
  const zoom = () =>
    page.eval(
      `getComputedStyle(document.querySelector("[data-artboard]").parentElement.parentElement).transform`,
    );
  await page.until(`!!document.querySelector('[data-artboard="${farLive}"] iframe')`, 10_000);
  await page.sleep(300);
  // Counts the times the sandboxed artboard's script starts from here on.
  await page.eval(
    `window.boots = 0; addEventListener("message", (e) => { if (e.data?.boot) window.boots++; })`,
  );
  check(
    "zoomed out to fit, every artboard is drawn",
    !(await hidden(near)) && !(await hidden(far)) && !(await hidden(farLive)) && (await loaded()),
  );
  const fitted = await zoom();
  await page.key("0");
  check(
    "at 100%, artboards outside the view are hidden and their iframe stays loaded",
    Boolean(
      await page.until(
        `document.querySelector('[data-artboard="${far}"]').style.display === "none" && document.querySelector('[data-artboard="${farLive}"]').style.display === "none"`,
        5000,
      ),
    ) &&
      !(await hidden(near)) &&
      (await loaded()),
  );
  await page.key("!", "Digit1");
  check(
    "fit to view counts the hidden artboards, so it frames the same view",
    Boolean(
      await page.until(
        `document.querySelector('[data-artboard="${far}"]').style.display === ""`,
        5000,
      ),
    ) && (await zoom()) === fitted,
  );
  await page.sleep(300);
  check(
    "showing the sandboxed artboard again doesn't restart its script",
    (await loaded()) && (await page.eval("window.boots")) === 0,
  );

  // Editing a component draws its instances in hidden artboards too, without
  // reloading a hidden sandboxed one, and the index learns the new size.
  const swatch = idAfter(
    await agent.call("write_html", {
      designId: wide,
      targetId: near,
      html: `<div data-name="Swatch" style="height:20px;background:rgb(0, 0, 255)"></div>`,
    }),
    '"Swatch"',
  );
  await agent.call("create_component", { designId: wide, nodeId: swatch });
  for (const target of [far, farLive]) {
    await agent.call("write_html", {
      designId: wide,
      targetId: target,
      html: `<div data-instance-of="${swatch}"></div>`,
    });
  }
  await page.key("0");
  await page.until(
    `document.querySelector('[data-artboard="${far}"]').style.display === "none" && document.querySelector('[data-artboard="${farLive}"]').style.display === "none"`,
    5000,
  );
  await agent.call("update_styles", {
    designId: wide,
    updates: [{ nodeIds: [swatch], styles: { background: "rgb(0, 128, 0)" } }],
  });
  await page.sleep(600);
  check(
    "a hidden sandboxed artboard isn't reloaded when its component changes",
    !(await page.eval(
      `document.querySelector('[data-artboard="${farLive}"] iframe').srcdoc.includes("rgb(0, 128, 0)")`,
    )),
  );
  check(
    "a hidden artboard's instance is drawn again",
    await page.eval(
      `[...document.querySelector('[data-artboard="${far}"]').querySelectorAll("*")].map((e) => e.shadowRoot).find(Boolean).innerHTML.includes("rgb(0, 128, 0)")`,
    ),
  );
  await page.key("!", "Digit1");
  check(
    "the sandboxed artboard loads the changed component once it's in view",
    Boolean(
      await page.until(
        `document.querySelector('[data-artboard="${farLive}"] iframe').srcdoc.includes("rgb(0, 128, 0)")`,
        5000,
      ),
    ),
  );

  check("no errors on the page", page.errors.length === 0, page.errors.join(" | "));
} catch (error) {
  check("the run finished", false, error.stack ?? String(error));
  if (page) await page.screenshot(path.join(os.tmpdir(), "finite-e2e-failure.png")).catch(() => {});
} finally {
  // SIGTERM makes a server save every open design, so let each finish
  // before its data folder goes.
  await Promise.all(
    processes.map((child) => {
      const exited =
        child.exitCode === null ? new Promise((r) => child.once("exit", r)) : Promise.resolve();
      child.kill();
      return exited;
    }),
  );
  await page?.close().catch(() => {});
  for (const data of folders) fs.rmSync(data, { recursive: true, force: true, maxRetries: 5 });
}

console.log(failures.length ? `\n${failures.length} check(s) failed` : "\nAll checks passed");
process.exit(failures.length ? 1 : 0);
