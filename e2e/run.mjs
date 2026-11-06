// The end-to-end test: a person's core flow through the built web app, headless.
//
//   vp run e2e                      builds apps/web, then runs every check
//   E2E_SKIP_BUILD=1 vp run e2e     reuses apps/web/out
//   FINITE_REAL_AGENT=1 vp run e2e  also starts a thread on the local `claude` CLI
//
// It starts the Node server on a free port (4300 and up) with a temp data folder, serving the
// static export, so the page and /api share one origin. A failure saves a screenshot to
// $TMPDIR/finite-e2e-failure.png.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildWeb, connect, launchChrome, root, sleep, startServer, until } from "./lib.mjs";

const realAgent = process.env.FINITE_REAL_AGENT === "1";
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "finite-e2e-")));
const failureShot = path.join(os.tmpdir(), "finite-e2e-failure.png");
const started = Date.now();

const staticDir = path.join(root, "apps/web/out");
if (process.env.E2E_SKIP_BUILD !== "1" || !fs.existsSync(staticDir)) buildWeb();

let server;
let browser;
let client;
let page;
let failed = false;
/** Errors a check already printed, so the catch below doesn't print them twice. */
const reported = new WeakSet();

async function check(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`ok   ${name} (${Date.now() - t} ms)`);
  } catch (error) {
    console.log(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`);
    if (error instanceof Error) reported.add(error);
    throw error;
  }
}

/** The page's point over `selector` inside the frame's iframe, through the canvas's zoom. */
async function pointInFrame(frameId, selector) {
  const iframe = await page.$(`iframe[data-frame-id="${frameId}"]`);
  const outer = await iframe.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, scale: r.width / el.offsetWidth };
  });
  const frame = await iframe.contentFrame();
  const inner = await frame.$eval(selector, (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  return { x: outer.left + inner.x * outer.scale, y: outer.top + inner.y * outer.scale };
}

try {
  server = await startServer({
    dataDir: path.join(tmp, "data"),
    staticDir,
    log: path.join(tmp, "server.log"),
  });
  client = await connect(server.url);
  browser = await launchChrome({ userDataDir: path.join(tmp, "chrome") });
  page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  let designId;
  let home;
  let file;

  await check("the design list loads", async () => {
    await page.goto(server.url, { waitUntil: "networkidle2" });
    await page.waitForSelector("::-p-text(Create blank design)", { timeout: 15_000 });
  });

  await check("Create blank design opens the new design", async () => {
    await (await page.waitForSelector("::-p-text(Create blank design)")).click();
    await (await page.waitForSelector('button[type="submit"]::-p-text(Create)')).click();
    await page.waitForFunction(() => location.pathname.startsWith("/design"), { timeout: 30_000 });
    designId = new URL(page.url()).searchParams.get("id");
    if (!designId) throw new Error(`no design id in ${page.url()}`);
  });

  await check("the project installs and its preview starts", async () => {
    const state = await client.request("subscribe", { designId });
    if (state.preview.status !== "ready") {
      const event = await client.waitFor(
        (e) => e.type === "preview" && e.designId === designId && e.status !== "starting",
        "the preview",
        240_000,
      );
      if (event.status !== "ready") throw new Error(`preview ${event.status}: ${event.log}`);
    }
  });

  await check("the Routes page shows the Home frame, rendered", async () => {
    const state = await client.request("subscribe", { designId });
    const routes = state.canvases.find((c) => c.name === "Routes");
    home = routes?.frames.find((f) => f.name === "Home");
    if (!home) throw new Error(`no Home frame on Routes: ${JSON.stringify(routes?.frames)}`);
    await page.waitForSelector(`[data-frame-title="${home.id}"]::-p-text(Home)`, {
      timeout: 15_000,
    });
    const iframe = await page.waitForSelector(`iframe[data-frame-id="${home.id}"]`, {
      timeout: 30_000,
    });
    await until(
      async () => (await iframe.contentFrame())?.$("h1[data-finite-loc]"),
      "a stamped h1 in the Home frame",
      60_000,
    );
  });

  await check("selecting an element and setting its opacity rewrites the TSX", async () => {
    const frame = await (await page.$(`iframe[data-frame-id="${home.id}"]`)).contentFrame();
    const loc = await frame.$eval("h1[data-finite-loc]", (el) => el.dataset.finiteLoc);
    file = path.join(
      fs.realpathSync(path.join(tmp, "data")),
      "projects",
      designId,
      loc.split(":")[0],
    );
    const before = fs.readFileSync(file, "utf8");
    const at = await pointInFrame(home.id, "h1[data-finite-loc]");
    await page.mouse.click(at.x, at.y);
    await page.waitForSelector("[data-selected]", { timeout: 10_000 });
    if (!(await page.$('input[aria-label="Layer opacity"]'))) {
      await (await page.waitForSelector('button[aria-label="Show inspector"]')).click();
    }
    const opacity = await page.waitForSelector('input[aria-label="Layer opacity"]', {
      timeout: 10_000,
    });
    await opacity.click({ count: 3 });
    await page.keyboard.type("50");
    await page.keyboard.press("Enter");
    const after = await until(
      () => {
        const text = fs.readFileSync(file, "utf8");
        return text !== before && text;
      },
      `${loc.split(":")[0]} to change`,
      10_000,
    );
    if (!after.includes("opacity-50")) throw new Error(`no opacity-50 in ${file}`);
    fs.writeFileSync(path.join(tmp, "before.tsx"), before);
  });

  await check("undo puts the file back", async () => {
    await page.evaluate(() => document.activeElement?.blur?.());
    const before = fs.readFileSync(path.join(tmp, "before.tsx"), "utf8");
    await page.keyboard.down("Control");
    await page.keyboard.press("z");
    await page.keyboard.up("Control");
    await until(() => fs.readFileSync(file, "utf8") === before, "the file to be restored", 10_000);
  });

  await check("the Prototypes tab opens an empty prototype with a composer", async () => {
    await (await page.waitForSelector('[role="tab"]::-p-text(Prototypes)')).click();
    await page.waitForFunction(() => location.search.includes("tab=prototypes"));
    await page.waitForSelector("::-p-text(Describe something to prototype)", { timeout: 10_000 });
    await page.waitForSelector('[aria-label="Message"]', { visible: true, timeout: 10_000 });
  });

  if (realAgent) {
    await check("a message starts a thread on the local claude CLI", async () => {
      await page.click('[aria-label="Message"]');
      await page.keyboard.type("Reply with the single word OK. Don't use any tools.");
      await page.keyboard.press("Enter");
      const thread = await client.waitFor(
        (e) => e.type === "thread" && e.designId === designId,
        "a thread",
        30_000,
      );
      const end = await client.waitFor(
        (e) =>
          e.type === "thread.event" &&
          e.threadId === thread.meta.id &&
          (e.event.type === "result" || e.event.type === "error"),
        "the agent's turn to end",
        180_000,
      );
      if (end.event.type === "error") throw new Error(end.event.message);
      await page.waitForSelector(`::-p-text(OK)`, { timeout: 15_000 });
    });
  } else {
    console.log("skip a real agent thread (set FINITE_REAL_AGENT=1 to run it)");
  }

  await check("the page threw no errors", async () => {
    if (errors.length) throw new Error(errors.join("\n"));
  });
} catch (error) {
  failed = true;
  if (!reported.has(error))
    console.log(`FAIL ${error instanceof Error ? error.stack : String(error)}`);
  if (page) await page.screenshot({ path: failureShot }).catch(() => {});
  console.log(`server log: ${path.join(tmp, "server.log")}`);
  if (page) console.log(`screenshot: ${failureShot}`);
} finally {
  client?.close();
  await browser?.close().catch(() => {});
  if (server) {
    // The server stops each design's Vite child on SIGTERM.
    const exited = new Promise((resolve) => server.child.once("exit", resolve));
    server.child.kill("SIGTERM");
    await Promise.race([exited, sleep(5_000)]);
    server.child.kill("SIGKILL");
  }
  if (!failed) fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`${failed ? "FAIL" : "PASS"} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
process.exit(failed ? 1 : 0);
