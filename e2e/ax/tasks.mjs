// The tasks agents run in an AX (agent experience) experiment. Each one seeds
// a design over MCP, gives the agent a prompt, and checks the result, so a
// change to the MCP tools can be measured, not just guessed at.
//
// A task has:
//   prompt(ctx)      what the agent is asked to do
//   seed(mcp)        sets up the design and returns ctx (ids the prompt and check need)
//   check(mcp, ctx)  returns { passed, total, notes } from the design afterwards
//   workdir          "none" (an empty folder) or "web-src" (a copy of the web app's source)
//   followUp(ctx)    optional: a second prompt in the same session, measured on its own
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "../cdp.mjs";
import { idAfter } from "../mcp.mjs";

/**
 * Renders an artboard's HTML (from get_html) in Chrome and returns every
 * element's box, relative to the artboard, with its text and computed
 * styles, so a check can test what a person would see. It doesn't depend on
 * the server build under test.
 */
async function rendered(html, width, height, css = "") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finite-ax-check-"));
  const file = path.join(dir, "page.html");
  fs.writeFileSync(
    file,
    `<!doctype html><html><head><meta charset="utf-8"><style>*, *::before, *::after { box-sizing: border-box; } html, body { margin: 0; }</style><style>${css}</style></head><body>${html}</body></html>`,
  );
  const page = await launch({ width, height });
  try {
    await page.goto(`file://${file}`);
    return await page.eval(`(() => {
      const board = document.body.firstElementChild.getBoundingClientRect();
      return [...document.querySelectorAll("[data-id]")].map((el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return { id: el.dataset.id, name: el.dataset.name ?? null, tag: el.tagName.toLowerCase(),
          text: el.textContent.trim(), x: r.x - board.x, y: r.y - board.y, width: r.width, height: r.height,
          position: s.position, background: s.backgroundColor, fontSize: parseFloat(s.fontSize),
          visible: s.visibility !== "hidden" && s.display !== "none" && r.width > 0 && r.height > 0 };
      });
    })()`);
  } finally {
    await page.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const centerIn = (pin, target, slack = 4) => {
  const cx = pin.x + pin.width / 2;
  const cy = pin.y + pin.height / 2;
  return (
    cx >= target.x - slack &&
    cx <= target.x + target.width + slack &&
    cy >= target.y - slack &&
    cy <= target.y + target.height + slack
  );
};
const overlaps = (a, b) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const BLUE = "#3b82f6";

/** A landing page with the brand blue in a dozen places, three buttons and a typo. */
const landing = `
<style>.card { border: 1px solid #e5e7eb; border-radius: 12px; padding: 24px; display: flex; flex-direction: column; gap: 12px; flex: 1 }</style>
<header data-name="Nav" style="display: flex; justify-content: space-between; align-items: center; padding: 20px 64px; border-bottom: 1px solid #e5e7eb">
  <div data-name="Logo" style="font: 700 22px Inter, sans-serif; color: ${BLUE}">Acme</div>
  <nav data-name="Links" style="display: flex; gap: 28px; font: 500 15px Inter, sans-serif; color: #374151">
    <a style="color: #374151">Product</a><a style="color: #374151">Pricing</a><a style="color: ${BLUE}">Docs</a>
  </nav>
  <button data-name="Nav CTA" style="background: ${BLUE}; color: white; border: none; padding: 10px 18px; border-radius: 6px; font: 600 14px Inter, sans-serif">Sign in</button>
</header>
<section data-name="Hero" style="display: flex; flex-direction: column; align-items: center; gap: 20px; padding: 96px 64px; text-align: center">
  <span data-name="Eyebrow" style="font: 600 13px Inter, sans-serif; letter-spacing: 0.08em; text-transform: uppercase; color: ${BLUE}">New in 2026</span>
  <h1 data-name="Headline" style="font: 800 56px/1.1 Inter, sans-serif; margin: 0; color: #111827">Ship faster with Acme Clould</h1>
  <p style="font: 400 19px/1.6 Inter, sans-serif; color: #4b5563; margin: 0; max-width: 640px">Deploy, observe and scale every service from one place.</p>
  <div data-name="Actions" style="display: flex; gap: 12px">
    <button data-name="Primary" style="background: ${BLUE}; color: white; border: none; padding: 14px 24px; border-radius: 8px; font: 600 16px Inter, sans-serif">Start free</button>
    <button data-name="Secondary" style="background: white; color: ${BLUE}; border: 1px solid ${BLUE}; padding: 14px 24px; border-radius: 8px; font: 600 16px Inter, sans-serif">Book a demo</button>
  </div>
</section>
<section data-name="Features" style="display: flex; gap: 24px; padding: 0 64px 96px">
  <div class="card"><div style="width: 40px; height: 40px; border-radius: 10px; background: ${BLUE}"></div><h3 style="margin: 0; font: 700 18px Inter, sans-serif">Deploy</h3><p style="margin: 0; color: #4b5563; font: 15px/1.5 Inter, sans-serif">Push to main and you're live.</p></div>
  <div class="card"><div style="width: 40px; height: 40px; border-radius: 10px; background: ${BLUE}"></div><h3 style="margin: 0; font: 700 18px Inter, sans-serif">Observe</h3><p style="margin: 0; color: #4b5563; font: 15px/1.5 Inter, sans-serif">Logs, traces and metrics in one view.</p></div>
  <div class="card"><div style="width: 40px; height: 40px; border-radius: 10px; background: ${BLUE}"></div><h3 style="margin: 0; font: 700 18px Inter, sans-serif">Scale</h3><p style="margin: 0; color: #4b5563; font: 15px/1.5 Inter, sans-serif">From one user to <span style="color: ${BLUE}; font-weight: 700">ten million</span>.</p></div>
</section>
<footer data-name="Footer" style="margin-top: auto; padding: 32px 64px; border-top: 1px solid #e5e7eb; font: 14px Inter, sans-serif; color: #6b7280">© 2026 Acme · <a style="color: ${BLUE}">Status</a></footer>`;

async function seedLanding(mcp, name) {
  const design = (await mcp.call("create_design", { name })).match(/designId "([^"]+)"/)[1];
  const board = idAfter(
    await mcp.call("create_artboard", {
      designId: design,
      name: "Landing — desktop",
      width: 1440,
      height: 1000,
      x: 0,
      y: 0,
    }),
    "artboard",
  );
  await mcp.call("write_html", { designId: design, targetId: board, html: landing });
  return { design, board };
}

/** Every node in a design, as get_html's markup, one artboard at a time. */
async function allHtml(mcp, design) {
  const info = JSON.parse(await mcp.call("get_basic_info", { designId: design }));
  const parts = [];
  for (const a of info.artboards)
    parts.push(await mcp.call("get_html", { designId: design, nodeId: a.id }));
  return { info, html: parts.join("\n") };
}

export const tasks = {
  // The brand color changed: every use, in styles and in a <style> block, has to change.
  restyle: {
    workdir: "none",
    seed: (mcp) => seedLanding(mcp, "Acme landing"),
    prompt: () =>
      `Use the Finite MCP tools. In the Finite design named "Acme landing", Acme's brand color changed from blue ${BLUE} to orange #f97316. ` +
      `Replace every use of the old blue with the new orange, make every button fully rounded (pill shaped), and fix the typo in the hero headline. ` +
      `Don't change anything else. Stop when you're done.`,
    async check(mcp, ctx) {
      const { html } = await allHtml(mcp, ctx.design);
      const lower = html.toLowerCase();
      const blue = (lower.match(/#3b82f6|rgb\(59, ?130, ?246\)/g) ?? []).length;
      const orange = (lower.match(/#f97316|rgb\(249, ?115, ?22\)/g) ?? []).length;
      const buttons = [...html.matchAll(/<button[^>]*style="([^"]*)"/g)].map((m) => m[1]);
      const pill = buttons.filter((s) =>
        /border-radius:\s*(9{3,}|[1-9]\d{2,})px|border-radius:\s*(50%|100vmax|9999px)/.test(s),
      );
      const notes = [
        `${blue} blue left, ${orange} orange`,
        `${pill.length}/${buttons.length} buttons pill`,
      ];
      const checks = [
        blue === 0,
        orange >= 12,
        buttons.length === 3 && pill.length === 3,
        /Acme Cloud\b/.test(html) && !/Clould/.test(html),
      ];
      return { passed: checks.filter(Boolean).length, total: checks.length, notes };
    },
  },

  // Change one value inside a <style> block and one inside a <script>, without resending either.
  "code-edit": {
    workdir: "none",
    async seed(mcp) {
      const design = (await mcp.call("create_design", { name: "Motion lab" })).match(
        /designId "([^"]+)"/,
      )[1];
      const board = idAfter(
        await mcp.call("create_artboard", {
          designId: design,
          name: "Carousel",
          width: 800,
          height: 400,
          x: 0,
          y: 0,
        }),
        "artboard",
      );
      await mcp.call("write_html", {
        designId: design,
        targetId: board,
        html: `<style>
.slide { position: absolute; inset: 0; display: grid; place-items: center; font: 700 32px Inter, sans-serif; opacity: 0; transition: opacity 400ms ease }
.slide.on { opacity: 1 }
.dot { width: 10px; height: 10px; border-radius: 50%; background: #d1d5db; transition: background 150ms ease }
.dot.on { background: #111827 }
.hint { position: absolute; bottom: 16px; left: 16px; font: 14px Inter, sans-serif; animation: pulse 2s ease-in-out infinite }
@keyframes pulse { 50% { opacity: 0.4 } }
</style>
<div class="slide on" data-name="Slide 1">One</div><div class="slide" data-name="Slide 2">Two</div>
<div class="hint" data-name="Hint">Swipe</div>
<script>
const slides = document.querySelectorAll(".slide");
let i = 0;
function next() { slides[i].classList.remove("on"); i = (i + 1) % slides.length; slides[i].classList.add("on"); }
setInterval(next, 3000);
</script>`,
      });
      return { design, board };
    },
    prompt: () =>
      `Use the Finite MCP tools. In the Finite design named "Motion lab", make two changes to the Carousel artboard: ` +
      `the slide fade should take 800ms instead of 400ms, and the carousel should advance every 5000ms instead of 3000ms. ` +
      `Don't change anything else. Stop when you're done.`,
    async check(mcp, ctx) {
      const html = await mcp.call("get_html", { designId: ctx.design, nodeId: ctx.board });
      const checks = [
        /opacity 800ms ease/.test(html) && !/opacity 400ms/.test(html),
        /setInterval\(next, 5000\)/.test(html) && !/3000/.test(html),
        /transition: background 150ms ease/.test(html) &&
          /animation: pulse 2s ease-in-out infinite/.test(html),
        /function next\(\)/.test(html) && /Swipe/.test(html),
      ];
      return { passed: checks.filter(Boolean).length, total: checks.length, notes: [] };
    },
  },

  // A mobile version of an existing desktop artboard.
  mobile: {
    workdir: "none",
    seed: (mcp) => seedLanding(mcp, "Acme landing"),
    prompt: () =>
      `Use the Finite MCP tools. The Finite design "Acme landing" has a desktop landing page. ` +
      `Add a mobile version (390 px wide) of the same page as a new artboard beside it, with the same content, laid out for a phone. ` +
      `Check that it renders well. Stop when you're done.`,
    async check(mcp, ctx) {
      const { info, html } = await allHtml(mcp, ctx.design);
      const mobile = info.artboards.find((a) => a.id !== ctx.board && a.width <= 430);
      const overlap =
        mobile && info.artboards.some((a) => a.id !== mobile.id && rectsOverlap(a, mobile));
      const keeps = ["Start free", "Book a demo", "Deploy", "Observe", "Scale", "Status"].filter(
        (t) => (html.match(new RegExp(t, "g")) ?? []).length >= 2,
      );
      const checks = [Boolean(mobile), mobile && !overlap, keeps.length === 6];
      return {
        passed: checks.filter(Boolean).length,
        total: checks.length,
        notes: [
          mobile ? `mobile ${mobile.width}×${mobile.height}` : "no mobile artboard",
          `${keeps.length}/6 texts copied`,
        ],
        screenshot: mobile?.id,
      };
    },
  },

  // Comments users pinned to elements.
  comments: {
    workdir: "none",
    async seed(mcp, api) {
      const ctx = await seedLanding(mcp, "Acme landing");
      const tree = await mcp.call("get_tree_summary", { designId: ctx.design, depth: 6 });
      const id = (label) => tree.match(new RegExp(`"${label}" #([a-z0-9]+)`))[1];
      const comment = (nodeId, body) =>
        api("POST", `/api/designs/${ctx.design}/comments`, {
          artboardId: ctx.board,
          nodeId,
          x: 100,
          y: 100,
          body,
          author: { id: "user-1", name: "Dana" },
        });
      await comment(
        id("Secondary"),
        "This should look like a link, not a button. Just underlined text.",
      );
      await comment(id("Features"), "Add a fourth card: Secure, 'SSO and audit logs built in.'");
      return ctx;
    },
    prompt: () =>
      `Use the Finite MCP tools. Users left comments on the Finite design "Acme landing". Handle them, then stop.`,
    async check(mcp, ctx) {
      const open = await mcp.call("get_comments", { designId: ctx.design });
      const { html } = await allHtml(mcp, ctx.design);
      const secondary =
        html.match(/data-name="Secondary"[^>]*>|<[^>]*data-name="Secondary"/)?.[0] ?? "";
      const checks = [
        open.startsWith("No open comments"),
        /Secure/.test(html) && /SSO and audit logs/.test(html),
        /underline/.test(html) && !/border: 1px solid/.test(secondary),
      ];
      return { passed: checks.filter(Boolean).length, total: checks.length, notes: [] };
    },
  },

  // The same rebrand across several artboards, with the color in a <style> rule too.
  rebrand: {
    workdir: "none",
    async seed(mcp) {
      const ctx = await seedLanding(mcp, "Acme site");
      await mcp.call("duplicate_nodes", { designId: ctx.design, nodeIds: [ctx.board] });
      const pricing = idAfter(
        await mcp.call("create_artboard", {
          designId: ctx.design,
          name: "Pricing",
          width: 1440,
          height: 800,
          x: 0,
          y: 1200,
        }),
        "artboard",
      );
      const plan = (name, price, featured) => `
<div class="plan${featured ? " featured" : ""}" data-name="${name}"><span class="badge">${name}</span><div style="font: 800 40px Inter, sans-serif">${price}</div>
<button style="background: ${featured ? BLUE : "white"}; color: ${featured ? "white" : BLUE}; border: 1px solid ${BLUE}; padding: 12px; border-radius: 8px; font: 600 15px Inter, sans-serif">Choose ${name}</button></div>`;
      await mcp.call("write_html", {
        designId: ctx.design,
        targetId: pricing,
        html: `<style>.plan { flex: 1; display: flex; flex-direction: column; gap: 16px; padding: 32px; border: 1px solid #e5e7eb; border-radius: 16px }
.plan.featured { border-color: ${BLUE}; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25) }
.badge { align-self: flex-start; background: ${BLUE}; color: white; padding: 4px 10px; border-radius: 999px; font: 600 12px Inter, sans-serif }</style>
<h2 data-name="Title" style="font: 800 40px Inter, sans-serif; text-align: center; margin: 64px 0 40px">Pricing</h2>
<div data-name="Plans" style="display: flex; gap: 24px; padding: 0 120px">${plan("Starter", "$0", false)}${plan("Team", "$49", true)}${plan("Scale", "$199", false)}</div>`,
      });
      return { ...ctx, pricing };
    },
    prompt: () =>
      `Use the Finite MCP tools. In the Finite design named "Acme site", Acme's brand color changed from blue ${BLUE} to orange #f97316. ` +
      `Replace every use of the old blue across all artboards (including tints of it) with the new orange. Don't change anything else. Stop when you're done.`,
    async check(mcp, ctx) {
      const { html } = await allHtml(mcp, ctx.design);
      const lower = html.toLowerCase();
      const blue = (lower.match(/#3b82f6|rgba?\(59, ?130, ?246/g) ?? []).length;
      const orange = (lower.match(/#f97316|rgba?\(249, ?115, ?22/g) ?? []).length;
      const checks = [blue === 0, orange >= 30, /Choose Team/.test(html)];
      return {
        passed: checks.filter(Boolean).length,
        total: checks.length,
        notes: [`${blue} blue left, ${orange} orange`],
        board: ctx.pricing,
        screenshot: ctx.pricing,
      };
    },
  },

  // Build from nothing: three screens that should share one look.
  screens: {
    workdir: "none",
    seed: async (mcp) => ({
      design: (await mcp.call("create_design", { name: "Plantpal onboarding" })).match(
        /designId "([^"]+)"/,
      )[1],
    }),
    prompt: () =>
      `Use the Finite MCP tools. In the Finite design "Plantpal onboarding", design a three-screen mobile onboarding flow for a plant-care app: ` +
      `Welcome, Pick your plants (a grid of at least 6 selectable plant cards, two selected), and All set. ` +
      `The screens must share the same top bar, colors, type and button style. Check how they look. Stop when you're done.`,
    async check(mcp, ctx) {
      const { info, html } = await allHtml(mcp, ctx.design);
      const boards = info.artboards;
      const overlap = boards.some((a, i) => boards.some((b, j) => i < j && rectsOverlap(a, b)));
      const checks = [boards.length >= 3, !overlap, /Welcome/i.test(html) && /All set/i.test(html)];
      return {
        passed: checks.filter(Boolean).length,
        total: checks.length,
        notes: [`${boards.length} artboards, ${info.nodeCount} nodes`],
        screenshot: boards[1]?.id ?? boards[0]?.id,
      };
    },
  },

  // Pins over content the agent didn't size: it has to find where things rendered.
  pins: {
    workdir: "none",
    async seed(mcp) {
      const ctx = await seedLanding(mcp, "Acme landing");
      const html = await mcp.call("get_html", { designId: ctx.design, nodeId: ctx.board });
      const before = await rendered(html, 1440, 1000);
      const at = (text, tag) => before.find((e) => e.tag === tag && e.text === text);
      return { ...ctx, start: at("Start free", "button"), observe: at("Observe", "h3") };
    },
    prompt: () =>
      `Use the Finite MCP tools. On the Finite design "Acme landing", mark two spots for a design review. ` +
      `Add pin 1 over the "Start free" button and pin 2 over the "Observe" card's heading. ` +
      `A pin is a 28 px red (#ef4444) circle with its number in white, absolutely positioned inside the artboard, ` +
      `and its center must land on its target. Don't move or change anything else. Stop when you're done.`,
    async check(mcp, ctx) {
      const html = await mcp.call("get_html", { designId: ctx.design, nodeId: ctx.board });
      const after = await rendered(html, 1440, 1000);
      const pin = (n) =>
        after.find(
          (e) =>
            e.text === n &&
            ["absolute", "fixed"].includes(e.position) &&
            e.width >= 20 &&
            e.width <= 40,
        );
      const start = after.find((e) => e.tag === "button" && e.text === "Start free");
      const observe = after.find((e) => e.tag === "h3" && e.text === "Observe");
      const [p1, p2] = [pin("1"), pin("2")];
      const unmoved = [
        [start, ctx.start],
        [observe, ctx.observe],
      ].every(([a, b]) => a && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1);
      const checks = [
        Boolean(p1 && centerIn(p1, start)),
        Boolean(p2 && centerIn(p2, observe)),
        unmoved,
      ];
      const where = (p, t) =>
        p
          ? `pin at (${Math.round(p.x + p.width / 2)}, ${Math.round(p.y + p.height / 2)}) vs target ${Math.round(t.x)},${Math.round(t.y)} ${Math.round(t.width)}×${Math.round(t.height)}`
          : "no pin";
      return {
        passed: checks.filter(Boolean).length,
        total: checks.length,
        notes: [where(p1, start), where(p2, observe)],
      };
    },
  },

  // A small label overlapping the artboard name, like the bug the UI-states agent hit.
  overlap: {
    workdir: "none",
    async seed(mcp) {
      const design = (await mcp.call("create_design", { name: "Canvas mock" })).match(
        /designId "([^"]+)"/,
      )[1];
      const board = idAfter(
        await mcp.call("create_artboard", {
          designId: design,
          name: "Canvas",
          width: 1200,
          height: 700,
          x: 0,
          y: 0,
          styles: { "background-color": "#f4f4f5" },
          html: `<div data-name="Frame" style="position: relative; margin: 64px; width: 640px; height: 420px; flex-shrink: 0">
  <div data-name="Frame title" style="position: absolute; left: 0; top: -22px; font: 500 13px Inter, sans-serif; color: #52525b">Checkout — desktop</div>
  <div data-name="Working badge" style="position: absolute; left: 96px; top: -24px; padding: 2px 8px; border-radius: 999px; background: #7c3aed; color: white; font: 600 11px Inter, sans-serif; white-space: nowrap">An agent is working on this</div>
  <div data-name="Frame body" style="width: 100%; height: 100%; background: white; border: 1px solid #e4e4e7; border-radius: 8px"></div>
</div>
<div data-name="Toolbar" style="position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); display: flex; gap: 4px; padding: 4px; background: white; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,.12)"><button style="padding: 6px 10px">Pointer</button><button style="padding: 6px 10px">Comment</button></div>`,
        }),
        "artboard",
      );
      return { design, board };
    },
    prompt: () =>
      `Use the Finite MCP tools. A user reports that on the Finite design "Canvas mock", the small "An agent is working on this" badge ` +
      `overlaps the frame's name above it. Fix it so they don't overlap and both stay readable and above the frame, ` +
      `without changing anything else. Stop when you're done.`,
    async check(mcp, ctx) {
      const html = await mcp.call("get_html", { designId: ctx.design, nodeId: ctx.board });
      const after = await rendered(html, 1200, 700);
      const title = after.find((e) => e.text === "Checkout — desktop" && e.tag === "div");
      const badge = after.find((e) => e.text === "An agent is working on this" && e.tag === "div");
      const body = after.find((e) => e.name === "Frame body");
      const checks = [
        Boolean(title && badge && !overlaps(title, badge)),
        Boolean(badge?.visible && title?.visible && badge.fontSize >= 10 && title.fontSize >= 12),
        Boolean(
          body &&
          badge &&
          title &&
          badge.y + badge.height <= body.y + 2 &&
          title.y + title.height <= body.y + 2,
        ),
      ];
      return {
        passed: checks.filter(Boolean).length,
        total: checks.length,
        notes: [
          title && badge
            ? `title ${Math.round(title.x)}–${Math.round(title.x + title.width)}, badge ${Math.round(badge.x)}–${Math.round(badge.x + badge.width)}`
            : "missing",
        ],
      };
    },
  },

  // Build three screens, then change something they share: the UI-states
  // agent's top complaint was that this meant editing every copy.
  "screens-change": {
    workdir: "none",
    seed: async (mcp) => ({
      design: (await mcp.call("create_design", { name: "Plantpal onboarding" })).match(
        /designId "([^"]+)"/,
      )[1],
    }),
    prompt: () =>
      `Use the Finite MCP tools. In the Finite design "Plantpal onboarding", design a three-screen mobile onboarding flow for a plant-care app: ` +
      `Welcome, Pick your plants (a grid of at least 6 selectable plant cards, two selected), and All set. ` +
      `The screens must share the same top bar, colors, type and button style. Check how they look. Stop when you're done.`,
    followUp: () =>
      `The client changed their mind: the top bar on every screen should be dark green (#14532d) with white text. ` +
      `Make that change on all screens and check it. Stop when you're done.`,
    async check(mcp, ctx) {
      const info = JSON.parse(await mcp.call("get_basic_info", { designId: ctx.design }));
      const shared = await mcp
        .callRaw("get_shared_css", { designId: ctx.design })
        .catch(() => null);
      const css = shared && !shared.isError ? (shared.content?.[0]?.text ?? "") : "";
      const sharedCss = css.startsWith("This design has no shared CSS") ? "" : css;
      let green = 0;
      for (const a of info.artboards) {
        const html = await mcp.call("get_html", { designId: ctx.design, nodeId: a.id });
        const els = await rendered(html, a.width, a.height, sharedCss);
        const bar = els.find(
          (e) => e.background === "rgb(20, 83, 45)" && e.y < 160 && e.width >= a.width * 0.8,
        );
        if (bar) green++;
      }
      const checks = [info.artboards.length >= 3, green >= 3 && green === info.artboards.length];
      return {
        passed: checks.filter(Boolean).length,
        total: checks.length,
        notes: [`${green}/${info.artboards.length} green top bars`],
      };
    },
  },

  // The task from the "Use the Finite MCP" thread: document the app's own UI.
  "ui-states": {
    workdir: "web-src",
    seed: async () => ({}),
    prompt: () =>
      `Use the Finite MCP tools. The source of Finite's own web app is in ./web in this folder (Next.js + React). ` +
      `Create a Finite design called "Finite UI states" and put every UI state of the app on it (the design list, empty states, the canvas, ` +
      `the comment tool, comment threads, loading and error states, and so on), drawn as faithfully as you can, so a designer can review them all. ` +
      `Stop when you're done.`,
    async check(mcp) {
      const list = JSON.parse(await mcp.call("list_designs", { query: "UI states" }));
      if (!list.length) return { passed: 0, total: 1, notes: ["no design"] };
      const info = JSON.parse(await mcp.call("get_basic_info", { designId: list[0].designId }));
      return {
        passed: 1,
        total: 1,
        notes: [`${info.artboardCount} artboards, ${info.nodeCount} nodes`],
        design: list[0].designId,
        screenshot: info.artboards[0]?.id,
      };
    },
  },
};

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}
