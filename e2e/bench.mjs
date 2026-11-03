// Measures the viewer on big designs, in headless Chrome against a release server.
//
//   vp run bench
//
// It prints these numbers, each the median of a few runs:
//
// - open: from navigation until all 240 artboards of a 90,000-node design are
//   drawn, plus the main thread's script and task time while it opens.
// - bitmaps: from the design being drawn until every artboard in view without
//   a script has switched to a cached bitmap (scripted ones stay live), which happens at this zoom because it's far out.
// - bitmap memory: what the cached bitmaps hold at a pixel ratio of 2, fitted
//   and zoomed in to just below where bitmaps stop.
// - zoom: main-thread task time per zoom step at that zoom, with 600 ms
//   between steps so the browser redraws what it can see after each.
// - pan: frames per second while the wheel pans that design, fitted to the
//   window, plus the main thread's task time per second of panning.
// - pan at 100%: the same at 100% zoom, where only a few artboards are in
//   view and the rest can be skipped, plus the main thread's task time per
//   second of panning (frames per second tops out near 60).
// - sweep at 100%: the wheel pans from the first artboard to the last, so
//   every artboard comes into view once. Every tenth artboard has a script and
//   an animation, so it renders in a sandboxed iframe. It reports frames per
//   second and main-thread task time per second of the sweep.
// - write: one write_html of 30,000 nodes into an open design, from the
//   tool call until the last node is on the page, plus script and task time.
// - thumbnails: the design list with four 5,000-node designs, the most a
//   preview draws, as script and task time per thumbnail.
//
// Script and task time come from the DevTools Performance domain
// (`Performance.getMetrics`), so they count only work on the page's main
// thread. Set BENCH_SKIP_BUILD=1 to reuse the last builds and BENCH_RUNS to
// change the number of runs.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launch } from "./cdp.mjs";
import { connect, idAfter } from "./mcp.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runs = Number(process.env.BENCH_RUNS ?? 3);

if (!process.env.BENCH_SKIP_BUILD) {
  const run = (cmd, args) => {
    console.log(`$ ${cmd} ${args.join(" ")}`);
    if (spawnSync(cmd, args, { cwd: root, stdio: "inherit" }).status !== 0) process.exit(1);
  };
  run("cargo", ["build", "-q", "--release", "-p", "finite-server"]);
  run("vp", ["run", "wasm#build"]);
  run("vp", ["run", "web#build"]);
}

const port = await new Promise((resolve) => {
  const probe = net.createServer().listen(0, "127.0.0.1", () => {
    const { port } = probe.address();
    probe.close(() => resolve(port));
  });
});
const data = fs.mkdtempSync(path.join(os.tmpdir(), "finite-bench-data-"));
const server = spawn(path.join(root, "target/release/finite-server"), [], {
  env: {
    ...process.env,
    RUST_LOG: "warn",
    FINITE_PORT: String(port),
    FINITE_DATA_DIR: data,
    FINITE_STATIC_DIR: path.join(root, "apps/web/out"),
  },
  stdio: ["ignore", "inherit", "inherit"],
});
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch(`${base}/api/health`)).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const ms = (n) => `${Math.round(n)} ms`;
/** `count` cards of five nodes each: a div, a bold label and its text, a span and its text. */
const cards = (count) =>
  `<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;padding:16px">${Array.from(
    { length: count },
    (_, i) =>
      `<div style="padding:8px;border:1px solid #ddd;border-radius:6px"><b>Card ${i}</b><span class="note" style="color:#666">Note ${i}</span></div>`,
  ).join("")}</div>`;

const agent = await connect(base, "Bench");
const createDesign = async (name) =>
  (await agent.call("create_design", { name })).match(/designId "([a-z0-9]+)"/)[1];
const addArtboard = async (designId, i, html) => {
  const id = idAfter(
    await agent.call("create_artboard", { designId, name: `Board ${i}`, width: 800, height: 1000 }),
    "artboard",
  );
  if (html) await agent.call("write_html", { designId, targetId: id, html });
  return id;
};
const nodeCount = async (designId) =>
  (await (await fetch(`${base}/api/designs/${designId}`)).json()).nodes.length;

const page = await launch();
await page.send("Performance.enable");
const metrics = async () => {
  const { metrics } = await page.send("Performance.getMetrics");
  const get = (name) => metrics.find((m) => m.name === name).value * 1000;
  return { script: get("ScriptDuration"), task: get("TaskDuration") };
};
/** Main-thread script and task time spent while `work` runs. */
const busy = async (work) => {
  const before = await metrics();
  const result = await work();
  const after = await metrics();
  return { ...result, script: after.script - before.script, task: after.task - before.task };
};
const settle = () =>
  page.eval(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(0))))`);

try {
  // Thumbnails first, while these are the only designs on the list. The
  // empty list is the baseline, so the difference is the previews' cost.
  const listPage = async (count) => {
    const samples = [];
    for (let run = 0; run < runs; run++) {
      await page.send("Page.navigate", { url: "about:blank" });
      await page.sleep(300);
      samples.push(
        await busy(async () => {
          await page.send("Page.navigate", { url: `${base}/` });
          // Each preview draws its artboard into a shadow root.
          await page.until(
            `document.querySelector("main") && [...document.querySelectorAll("[data-artboard]")].filter((a) => [...a.querySelectorAll("*")].some((e) => e.shadowRoot && e.shadowRoot.childElementCount > 2)).length === ${count}`,
            30_000,
          );
          await page.sleep(500);
          await settle();
          return {};
        }),
      );
    }
    return samples;
  };
  const emptyList = await listPage(0);
  const previews = [];
  for (let i = 0; i < 4; i++) {
    const id = await createDesign(`Preview ${i}`);
    await addArtboard(id, 0, cards(999));
    previews.push(id);
  }
  const previewNodes = await nodeCount(previews[0]);
  const thumbs = await listPage(4);

  // A 90,000-node design across 240 artboards.
  const big = await createDesign("Big");
  // Every tenth artboard has a script and an animation, which makes it a sandboxed iframe.
  const live = `<style>@keyframes pulse{50%{opacity:.5}}.note{animation:pulse 1s infinite}</style><script>setInterval(() => { document.title = String(Date.now()); }, 50);</script>`;
  for (let i = 0; i < 240; i++) await addArtboard(big, i, cards(75) + (i % 10 === 0 ? live : ""));
  const bigNodes = await nodeCount(big);
  const opens = [];
  const pans = [];
  const bitmaps = [];
  const zooms = [];
  const zoomedPans = [];
  const sweeps = [];
  for (let run = 0; run < runs; run++) {
    await page.send("Page.navigate", { url: "about:blank" });
    await page.sleep(300);
    opens.push(
      await busy(async () => {
        await page.send("Page.navigate", { url: `${base}/design/?id=${big}` });
        await page.until(`document.querySelectorAll("[data-artboard]").length === 240`, 60_000);
        await settle();
        return { wall: await page.eval(`performance.now()`) };
      }),
    );
    // Pan with the wheel for two seconds and count the frames drawn.
    await page.eval(
      `window.__frames = 0; (function count() { __frames++; requestAnimationFrame(count); })(); 0`,
    );
    const wheel = (deltaX) =>
      page.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 700,
        y: 450,
        deltaX,
        deltaY: 0,
      });
    const panFor = async (ms) => {
      await page.eval(`__frames = 0; 0`);
      const started = Date.now();
      let step = 0;
      while (Date.now() - started < ms) {
        await page.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: 700,
          y: 450,
          deltaX: step++ % 40 < 20 ? 40 : -40,
          deltaY: 0,
        });
      }
      return (await page.eval(`__frames`)) / ((Date.now() - started) / 1000);
    };
    // Zoomed out to fit, the artboards in view become bitmaps one frame at a
    // time. The ones far outside the view are hidden and stay as they are.
    const inView = `[...document.querySelectorAll("[data-artboard]")].filter((a) => a.style.display !== "none" && !a.querySelector("iframe"))`;
    const lodStarted = Date.now();
    await page
      .until(
        `${inView}.every((a) => a.dataset.lod === "bitmap") && ${inView}.length > 0`,
        Number(process.env.BENCH_BITMAP_WAIT ?? 60_000),
      )
      .catch(() => false);
    bitmaps.push({
      wall: Date.now() - lodStarted,
      drawn: await page.eval(`document.querySelectorAll('[data-lod="bitmap"]').length`),
      inView: await page.eval(`${inView}.length`),
    });
    await page.sleep(500);
    await settle();
    // Zoom in and out a step at a time, past the point where the browser redraws.
    zooms.push(
      await busy(async () => {
        for (let i = 0; i < 6; i++) {
          await page.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: 700,
            y: 450,
            deltaX: 0,
            deltaY: i % 2 ? 30 : -30,
            modifiers: 2,
          });
          await page.sleep(600);
          await settle();
        }
        return {};
      }),
    );
    await page.sleep(500);
    await settle();
    pans.push(await busy(async () => ({ fps: await panFor(2000) })));
    // The "0" key sets 100% zoom, and the settle lets the browser redraw.
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "0", text: "0" });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key: "0" });
    await page.sleep(500);
    await settle();
    const zoomed = await busy(async () => ({ fps: await panFor(2000) }));
    zoomedPans.push(zoomed);
    // Back to the start, then sweep across every artboard.
    const extent = await page.eval(
      `Math.max(...[...document.querySelectorAll("[data-artboard]")].map((a) => new DOMMatrix(a.style.transform).m41)) + 800`,
    );
    for (let x = 0; x < extent + 2000; x += 400) await wheel(-400);
    await page.sleep(500);
    await settle();
    sweeps.push(
      await busy(async () => {
        await page.eval(`__frames = 0; 0`);
        const started = Date.now();
        for (let x = 0; x < extent; x += 400) await wheel(400);
        const seconds = (Date.now() - started) / 1000;
        return { fps: (await page.eval(`__frames`)) / seconds, seconds };
      }),
    );
  }

  // What the bitmaps hold in memory at a pixel ratio of 2: fitted, and then
  // zoomed in to just below where bitmaps stop, where they're sharpest.
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 2,
    mobile: false,
  });
  await page.send("Page.navigate", { url: `${base}/design/?id=${big}` });
  await page.until(`document.querySelectorAll("[data-artboard]").length === 240`, 60_000);
  const inViewAll = `[...document.querySelectorAll("[data-artboard]")].filter((a) => a.style.display !== "none" && !a.querySelector("iframe"))`;
  const bitmapped = () =>
    page
      .until(
        `${inViewAll}.length > 0 && ${inViewAll}.every((a) => a.dataset.lod === "bitmap")`,
        60_000,
      )
      .catch(() => false);
  const held = async () => ({
    mb:
      (Number(
        await page.eval(
          `document.querySelector("[data-artboard]").parentElement.dataset.bitmapPixels`,
        ),
      ) *
        4) /
      1e6,
    count: await page.eval(`document.querySelectorAll('[data-artboard] canvas').length`),
    zoom: await page.eval(
      `new DOMMatrix(getComputedStyle(document.querySelector("[data-artboard]").parentElement.parentElement).transform).a`,
    ),
  });
  await bitmapped();
  await page.sleep(500);
  const memoryFitted = await held();
  for (let i = 0; i < 3; i++) {
    await page.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x: 700,
      y: 450,
      deltaX: 0,
      deltaY: -85,
      modifiers: 2,
    });
    await page.sleep(300);
  }
  await bitmapped();
  await page.sleep(1500);
  const memoryZoomed = await held();
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });

  // One write_html of 30,000 nodes into an open design.
  const writes = [];
  for (let run = 0; run < runs; run++) {
    const id = await createDesign(`Write ${run}`);
    const board = await addArtboard(id, 0, null);
    await page.send("Page.navigate", { url: `${base}/design/?id=${id}` });
    await page.until(`document.querySelectorAll("[data-artboard]").length === 1`, 10_000);
    await settle();
    const html = cards(5999);
    writes.push(
      await busy(async () => {
        const started = Date.now();
        await agent.call("write_html", { designId: id, targetId: board, html });
        await page.until(
          `[...document.querySelector("[data-artboard]").querySelectorAll("*")].find((e) => e.shadowRoot)?.shadowRoot.querySelector("div > div:nth-child(5999)")`,
          60_000,
        );
        await settle();
        return { wall: Date.now() - started };
      }),
    );
    if (run === 0) console.log(`write: ${(await nodeCount(id)) - 1} nodes added`);
  }

  console.log(`\nopen ${bigNodes.toLocaleString()} nodes, 240 artboards`);
  console.log(`  until drawn   ${ms(median(opens.map((o) => o.wall)))}`);
  console.log(`  script        ${ms(median(opens.map((o) => o.script)))}`);
  console.log(`  task          ${ms(median(opens.map((o) => o.task)))}`);
  console.log(
    `bitmaps         ${median(bitmaps.map((b) => b.drawn))} of ${median(bitmaps.map((b) => b.inView))} artboards in view, ${ms(median(bitmaps.map((b) => b.wall)))} after drawn`,
  );
  console.log(`zoom            task per step  ${ms(median(zooms.map((z) => z.task)) / 6)}`);
  console.log(`pan             ${median(pans.map((p) => p.fps)).toFixed(1)} fps`);
  console.log(`  task per second panned  ${ms(median(pans.map((p) => p.task)) / 2)}`);
  console.log(`pan at 100%     ${median(zoomedPans.map((p) => p.fps)).toFixed(1)} fps`);
  console.log(`  task per second panned  ${ms(median(zoomedPans.map((p) => p.task)) / 2)}`);
  console.log(`sweep at 100%   ${median(sweeps.map((p) => p.fps)).toFixed(1)} fps`);
  console.log(
    `  task per second swept   ${ms(median(sweeps.map((p) => p.task / p.seconds)))} (${median(sweeps.map((p) => p.seconds)).toFixed(1)} s)`,
  );
  console.log(`bitmap memory at pixel ratio 2`);
  for (const [name, m] of [
    ["fitted", memoryFitted],
    ["zoomed in", memoryZoomed],
  ]) {
    console.log(
      `  ${name.padEnd(13)} ${m.mb.toFixed(1)} MB in ${m.count} bitmaps, at ${(m.zoom * 100).toFixed(1)}% zoom`,
    );
  }
  console.log(`write_html, 30,000 nodes`);
  console.log(`  until drawn   ${ms(median(writes.map((w) => w.wall)))}`);
  console.log(`  script        ${ms(median(writes.map((w) => w.script)))}`);
  console.log(`  task          ${ms(median(writes.map((w) => w.task)))}`);
  console.log(`thumbnails, ${previewNodes.toLocaleString()} nodes each`);
  const perThumb = (key) =>
    ms((median(thumbs.map((t) => t[key])) - median(emptyList.map((t) => t[key]))) / 4);
  console.log(`  script        ${perThumb("script")} per thumbnail`);
  console.log(`  task          ${perThumb("task")} per thumbnail`);
  console.log(
    `raw runs: ${JSON.stringify({ memoryFitted, memoryZoomed, opens, bitmaps, zooms, pans, zoomedPans, sweeps, writes, emptyList, thumbs })}`,
  );
} finally {
  await page.close();
  const exited = new Promise((r) => server.once("exit", r));
  server.kill();
  await exited;
  fs.rmSync(data, { recursive: true, force: true });
}
