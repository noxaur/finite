// Measures the viewer on big designs, in headless Chrome against a release server.
//
//   vp run bench
//
// It prints four numbers, each the median of a few runs:
//
// - open: from navigation until all 240 artboards of a 90,000-node design are
//   drawn, plus the main thread's script and task time while it opens.
// - pan: frames per second while the wheel pans that design, fitted to the
//   window, so every artboard is in view.
// - pan at 100%: the same at 100% zoom, where only a few artboards are in
//   view and the rest can be skipped, plus the main thread's task time per
//   second of panning (frames per second tops out near 60).
// - sweep at 100%: the wheel pans from the first artboard to the last, so
//   every artboard comes into view once. Every tenth artboard has a script and
//   an animation, so it renders in a sandboxed iframe. It reports frames per
//   second and main-thread task time per second of the sweep.
// - write: one edit with an html op of 30,000 nodes into an open design, from
//   the tool call until the last node is on the page, plus script and task time.
// - thumbnails: the design list with four 5,000-node designs, the most a
//   preview draws, as script and task time per thumbnail.
//
// Script and task time come from the DevTools Performance domain
// (`Performance.getMetrics`), so they count only work on the page's main
// thread. Set BENCH_SKIP_BUILD=1 to reuse the last builds, BENCH_RUNS to change
// the number of runs, and BENCH_SERVER to measure another server binary.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { launch, shadowOf } from "./cdp.mjs";
import { root, sleep, startServer } from "./lib.mjs";
import { connect } from "./mcp.mjs";

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

const server = await startServer({
  bin: process.env.BENCH_SERVER || path.join(root, "target/release/finite-server"),
  staticDir: path.join(root, "apps/web/out"),
});
const base = server.url;

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
const addArtboard = (designId, i, html) =>
  agent.artboard(designId, { name: `Board ${i}`, width: 800, height: 1000, html });
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

try {
  // Thumbnails first, while these are the only designs on the list. The
  // empty list is the baseline, so the difference is the previews' cost.
  const listPage = async (count) => {
    const samples = [];
    for (let run = 0; run < runs; run++) {
      await page.goto("about:blank");
      samples.push(
        await busy(async () => {
          await page.send("Page.navigate", { url: `${base}/` });
          // Each preview draws its artboard into a shadow root.
          await page.until(
            `document.querySelector("main") && [...document.querySelectorAll("[data-artboard]")].filter((a) => [...a.querySelectorAll("*")].some((e) => e.shadowRoot && e.shadowRoot.childElementCount > 2)).length === ${count}`,
            30_000,
          );
          // Work that follows the last preview, like a trailing refetch, belongs
          // in the measurement, and nothing marks its end.
          await sleep(500);
          await page.settle();
          return {};
        }),
      );
    }
    return samples;
  };
  const emptyList = await listPage(0);
  const previews = [];
  for (let i = 0; i < 4; i++) {
    const id = await agent.createDesign(`Preview ${i}`);
    await addArtboard(id, 0, cards(999));
    previews.push(id);
  }
  const previewNodes = await nodeCount(previews[0]);
  const thumbs = await listPage(4);

  // A 90,000-node design across 240 artboards.
  const big = await agent.createDesign("Big");
  // Every tenth artboard has a script and an animation, which makes it a sandboxed iframe.
  const live = `<style>@keyframes pulse{50%{opacity:.5}}.note{animation:pulse 1s infinite}</style><script>setInterval(() => { document.title = String(Date.now()); }, 50);</script>`;
  for (let i = 0; i < 240; i++) await addArtboard(big, i, cards(75) + (i % 10 === 0 ? live : ""));
  const bigNodes = await nodeCount(big);
  const opens = [];
  const pans = [];
  const zoomedPans = [];
  const sweeps = [];
  for (let run = 0; run < runs; run++) {
    await page.goto("about:blank");
    opens.push(
      await busy(async () => {
        await page.goto(`${base}/design/?id=${big}`);
        await page.until(`document.querySelectorAll("[data-artboard]").length === 240`, 60_000);
        await page.settle();
        return { wall: await page.eval(`performance.now()`) };
      }),
    );
    // Pan with the wheel for two seconds and count the frames drawn.
    await page.eval(
      `window.__frames = 0; (function count() { __frames++; requestAnimationFrame(count); })(); 0`,
    );
    const wheel = (deltaX) => page.wheel(700, 450, deltaX);
    const panFor = async (ms) => {
      await page.eval(`__frames = 0; 0`);
      const started = Date.now();
      let step = 0;
      while (Date.now() - started < ms) {
        await wheel(step++ % 40 < 20 ? 40 : -40);
      }
      return (await page.eval(`__frames`)) / ((Date.now() - started) / 1000);
    };
    pans.push(await panFor(2000));
    // The "0" key sets 100% zoom, and the settle lets the browser redraw.
    await page.press("0");
    // At 100% the artboards outside the view are hidden.
    await page.until(
      `[...document.querySelectorAll("[data-artboard]")].some((a) => a.style.display === "none")`,
    );
    await page.settle();
    const zoomed = await busy(async () => ({ fps: await panFor(2000) }));
    zoomedPans.push(zoomed);
    // Back to the start, then sweep across every artboard.
    const extent = await page.eval(
      `Math.max(...[...document.querySelectorAll("[data-artboard]")].map((a) => new DOMMatrix(a.style.transform).m41)) + 800`,
    );
    for (let x = 0; x < extent + 2000; x += 400) await wheel(-400);
    // The wheel pans past the start, where the view may show no artboard,
    // so nothing marks when the canvas has redrawn.
    await sleep(500);
    await page.settle();
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

  // One edit with 30,000 nodes of HTML into an open design.
  const writes = [];
  for (let run = 0; run < runs; run++) {
    const id = await agent.createDesign(`Write ${run}`);
    const board = await addArtboard(id, 0);
    await page.goto(`${base}/design/?id=${id}`);
    await page.until(`document.querySelectorAll("[data-artboard]").length === 1`, 10_000);
    await page.settle();
    const html = cards(5999);
    writes.push(
      await busy(async () => {
        const started = Date.now();
        await agent.write(id, board, html);
        await page.until(
          `${shadowOf('document.querySelector("[data-artboard]")')}?.querySelector("div > div:nth-child(5999)")`,
          60_000,
        );
        await page.settle();
        return { wall: Date.now() - started };
      }),
    );
    if (run === 0) console.log(`write: ${(await nodeCount(id)) - 1} nodes added`);
  }

  console.log(`\nopen ${bigNodes.toLocaleString()} nodes, 240 artboards`);
  console.log(`  until drawn   ${ms(median(opens.map((o) => o.wall)))}`);
  console.log(`  script        ${ms(median(opens.map((o) => o.script)))}`);
  console.log(`  task          ${ms(median(opens.map((o) => o.task)))}`);
  console.log(`pan             ${median(pans).toFixed(1)} fps`);
  console.log(`pan at 100%     ${median(zoomedPans.map((p) => p.fps)).toFixed(1)} fps`);
  console.log(`  task per second panned  ${ms(median(zoomedPans.map((p) => p.task)) / 2)}`);
  console.log(`sweep at 100%   ${median(sweeps.map((p) => p.fps)).toFixed(1)} fps`);
  console.log(
    `  task per second swept   ${ms(median(sweeps.map((p) => p.task / p.seconds)))} (${median(sweeps.map((p) => p.seconds)).toFixed(1)} s)`,
  );
  console.log(`edit html, 30,000 nodes`);
  console.log(`  until drawn   ${ms(median(writes.map((w) => w.wall)))}`);
  console.log(`  script        ${ms(median(writes.map((w) => w.script)))}`);
  console.log(`  task          ${ms(median(writes.map((w) => w.task)))}`);
  console.log(`thumbnails, ${previewNodes.toLocaleString()} nodes each`);
  const perThumb = (key) =>
    ms((median(thumbs.map((t) => t[key])) - median(emptyList.map((t) => t[key]))) / 4);
  console.log(`  script        ${perThumb("script")} per thumbnail`);
  console.log(`  task          ${perThumb("task")} per thumbnail`);
  console.log(
    `raw runs: ${JSON.stringify({ opens, pans, zoomedPans, sweeps, writes, emptyList, thumbs })}`,
  );
} finally {
  await page.close();
  await server.stop();
}
