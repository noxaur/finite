// The tasks agents run in an AX (agent experience) experiment. Each one seeds
// a design over MCP, gives the agent a prompt, and checks the result, so a
// change to the MCP tools can be measured, not just guessed at.
//
// A task has:
//   prompt(ctx)      what the agent is asked to do
//   seed(mcp)        sets up the design and returns ctx (ids the prompt and check need)
//   check(mcp, ctx)  returns { passed, total, notes } from the design afterwards
//   workdir          "none" (an empty folder) or "web-src" (a copy of the web app's source)
//   files            optional: { name: content } written into the agent's folder
//   followUp(ctx)    optional: a second prompt in the same session, measured on its own
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch } from "../cdp.mjs";

/**
 * The design's tokens as CSS: a function from an artboard's id to a `:root`
 * rule in that artboard's mode (`read` lists the artboards not in the first
 * mode as `artboardModes`).
 */
async function tokenCss(mcp, design) {
  const text = await mcp.call("read", { designId: design, as: "css" }).catch(() => "");
  const json = text.match(/^\{[\s\S]*?^\}/m)?.[0];
  if (!json) return () => "";
  const { modes, tokens, artboardModes = {} } = JSON.parse(json);
  const modeOf = new Map(
    Object.entries(artboardModes).flatMap(([mode, ids]) => ids.map((id) => [id, mode])),
  );
  return (board) => {
    const mode = modeOf.get(board) ?? modes[0];
    const rules = Object.entries(tokens).map(([name, value]) => {
      const v =
        typeof value === "string"
          ? value
          : (value[mode] ?? value[modes[0]] ?? Object.values(value)[0]);
      return v === undefined ? "" : `${name}: ${v};`;
    });
    return `:root { ${rules.join(" ")} }`;
  };
}

/**
 * Renders an artboard's HTML (from read) in Chrome and returns every
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
          fontWeight: Number(s.fontWeight),
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
/** Whether two boxes overlap. An artboard that grows with its content has no height here, so counts as flat. */
const overlaps = (a, b) =>
  a.x < b.x + b.width &&
  b.x < a.x + a.width &&
  a.y < b.y + (b.height ?? 0) &&
  b.y < a.y + (a.height ?? 0);

const BLUE = "#3b82f6";

/** A marketing page from outside Finite, with code that mustn't run in a design. */
const IMPORT_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Northwind Coffee</title>
  <script src="https://cdn.example.com/analytics.js"></script>
  <script>track("pageview")</script>
</head>
<body style="margin: 0; background: #1f2a1d; color: #f5efe6; font-family: Georgia, serif">
  <header style="display: flex; justify-content: space-between; padding: 24px 64px">
    <strong style="font-size: 22px">Northwind</strong>
    <nav style="display: flex; gap: 24px"><a href="/menu">Menu</a><a href="/beans">Beans</a></nav>
  </header>
  <main style="display: flex; flex-direction: column; align-items: center; gap: 24px; padding: 96px 64px; text-align: center">
    <h1 style="font-size: 64px; margin: 0">Coffee that keeps up</h1>
    <p style="max-width: 560px; font-size: 20px">Roasted every Monday, at your door by Wednesday.</p>
    <button onclick="track('order'); location.href='/order'" style="background: #e0a458; color: #1f2a1d; border: 0; padding: 16px 32px; border-radius: 999px; font-size: 18px">Order now</button>
    <img src="https://images.example.com/beans.jpg" alt="Beans" style="width: 640px; height: 360px; object-fit: cover; border-radius: 16px">
    <iframe src="https://www.youtube.com/embed/xyz" width="640" height="360"></iframe>
  </main>
</body>
</html>
`;

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
  const design = await mcp.createDesign(name);
  const board = await mcp.artboard(design, {
    name: "Landing — desktop",
    width: 1440,
    height: 1000,
    x: 0,
    y: 0,
    html: landing,
  });
  return { design, board };
}

/** The design's artboards and node count, and every artboard's HTML. */
async function allHtml(mcp, design) {
  const { artboards, nodes } = await mcp.overview(design);
  const parts = [];
  for (const a of artboards) parts.push(await mcp.readFullHtml(design, `#${a.id}`));
  return { info: { artboards, nodeCount: nodes }, html: parts.join("\n") };
}

/**
 * A real website saved as one HTML file with its CSS inlined, from
 * FINITE_AX_PAGES (a folder you fill yourself: third-party pages aren't
 * committed). Imported as one artboard that grows to fit, like a person
 * pasting a page in to redesign it.
 */
async function seedPage(mcp, file, name) {
  const dir = process.env.FINITE_AX_PAGES;
  if (!dir || !fs.existsSync(path.join(dir, file)))
    throw new Error(`set FINITE_AX_PAGES to a folder holding ${file}`);
  const design = await mcp.createDesign(name);
  const content = fs.readFileSync(path.join(dir, file), "utf8");
  await mcp.edit(design, [{ op: "import", name: file, content }]);
  const { artboards, nodes } = await mcp.overview(design);
  const board = artboards[0].id;
  return { design, board, nodes };
}

/** How many elements `read` finds `text` in, in "text", "styles" or "attributes". */
const matches = async (mcp, design, text, where = "text") => {
  const found = await mcp.call("read", { designId: design, contains: text }).catch(() => "");
  return Number(found.match(new RegExp(`In ${where}[^:\\n]*: (\\d+) elements?`))?.[1] ?? 0);
};

export const tasks = {
  "delete-design": {
    workdir: "none",
    async seed(mcp) {
      const design = await mcp.createDesign("Discarded draft");
      const keep = await mcp.createDesign("Published work");
      await mcp.artboard(design, { name: "Draft", width: 390 });
      return { design, keep };
    },
    prompt: () =>
      'Permanently delete the Finite design named "Discarded draft". Keep "Published work" unchanged. Use the Finite MCP tools and stop when done.',
    async check(mcp, ctx) {
      const designs = await mcp.call("designs");
      const deleted = await mcp.callRaw("read", { designId: ctx.design });
      const kept = await mcp.callRaw("read", { designId: ctx.keep });
      const checks = [!designs.includes(ctx.design), !!deleted.isError, !kept.isError];
      return {
        passed: checks.filter(Boolean).length,
        total: checks.length,
        notes: ["Draft removed; published work retained"],
      };
    },
  },
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
      const design = await mcp.createDesign("Motion lab");
      const board = await mcp.artboard(design, {
        name: "Carousel",
        width: 800,
        height: 400,
        x: 0,
        y: 0,
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
      const html = await mcp.readHtml(ctx.design, `#${ctx.board}`);
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
        mobile && info.artboards.some((a) => a.id !== mobile.id && overlaps(a, mobile));
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

  // Fill a fixed-height artboard a section at a time. Six sections don't fit
  // in 700 px unless the agent makes them small or the artboard taller, which
  // is what the layout check after each edit is meant to prompt. run.mjs
  // counts the artboards left clipped.
  sections: {
    workdir: "none",
    async seed(mcp) {
      const design = await mcp.createDesign("Pocket app");
      const board = await mcp.artboard(design, {
        name: "Landing",
        width: 390,
        height: 700,
        x: 0,
        y: 0,
      });
      return { design, board };
    },
    prompt: () =>
      `Use the Finite MCP tools. The Finite design "Pocket app" has an empty 390 px wide phone artboard named "Landing". ` +
      `Build a landing page for a budgeting app called Pocket in it, one html op per section, with these six sections in order: ` +
      `a header with the logo and a menu, a hero with a headline and a sign-up button, three feature cards, a testimonial, a pricing card, and a footer with links. ` +
      `Stop when you're done.`,
    async check(mcp, ctx) {
      const html = await mcp.readHtml(ctx.design, `#${ctx.board}`);
      const checks = [
        /pocket/i.test(html),
        /<button/i.test(html),
        (html.match(/<footer|data-name="Footer/gi) ?? []).length >= 1,
        /pric/i.test(html) && /testimonial|“|"/i.test(html),
      ];
      return { passed: checks.filter(Boolean).length, total: checks.length, notes: [] };
    },
  },

  // Comments users pinned to elements.
  comments: {
    workdir: "none",
    async seed(mcp, api) {
      const ctx = await seedLanding(mcp, "Acme landing");
      const tree = await mcp.call("read", { designId: ctx.design, select: ":root", depth: 6 });
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
      const open = await mcp.call("comments", { designId: ctx.design });
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
      await mcp.edit(ctx.design, [
        { op: "move", select: `#${ctx.board}`, copy: true, x: 1540, y: 0 },
      ]);
      const pricing = await mcp.artboard(ctx.design, {
        name: "Pricing",
        width: 1440,
        height: 800,
        x: 0,
        y: 1200,
      });
      const plan = (name, price, featured) => `
<div class="plan${featured ? " featured" : ""}" data-name="${name}"><span class="badge">${name}</span><div style="font: 800 40px Inter, sans-serif">${price}</div>
<button style="background: ${featured ? BLUE : "white"}; color: ${featured ? "white" : BLUE}; border: 1px solid ${BLUE}; padding: 12px; border-radius: 8px; font: 600 15px Inter, sans-serif">Choose ${name}</button></div>`;
      await mcp.write(
        ctx.design,
        pricing,
        `<style>.plan { flex: 1; display: flex; flex-direction: column; gap: 16px; padding: 32px; border: 1px solid #e5e7eb; border-radius: 16px }
.plan.featured { border-color: ${BLUE}; box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.25) }
.badge { align-self: flex-start; background: ${BLUE}; color: white; padding: 4px 10px; border-radius: 999px; font: 600 12px Inter, sans-serif }</style>
<h2 data-name="Title" style="font: 800 40px Inter, sans-serif; text-align: center; margin: 64px 0 40px">Pricing</h2>
<div data-name="Plans" style="display: flex; gap: 24px; padding: 0 120px">${plan("Starter", "$0", false)}${plan("Team", "$49", true)}${plan("Scale", "$199", false)}</div>`,
      );
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
    seed: async (mcp) => ({ design: await mcp.createDesign("Plantpal onboarding") }),
    prompt: () =>
      `Use the Finite MCP tools. In the Finite design "Plantpal onboarding", design a three-screen mobile onboarding flow for a plant-care app: ` +
      `Welcome, Pick your plants (a grid of at least 6 selectable plant cards, two selected), and All set. ` +
      `The screens must share the same top bar, colors, type and button style. Check how they look. Stop when you're done.`,
    async check(mcp, ctx) {
      const { info, html } = await allHtml(mcp, ctx.design);
      const boards = info.artboards;
      const overlap = boards.some((a, i) => boards.some((b, j) => i < j && overlaps(a, b)));
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
      const html = await mcp.readHtml(ctx.design, `#${ctx.board}`);
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
      const html = await mcp.readHtml(ctx.design, `#${ctx.board}`);
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
      const design = await mcp.createDesign("Canvas mock");
      const board = await mcp.artboard(design, {
        name: "Canvas",
        width: 1200,
        height: 700,
        x: 0,
        y: 0,
        html: `<div data-name="Frame" style="position: relative; margin: 64px; width: 640px; height: 420px; flex-shrink: 0">
  <div data-name="Frame title" style="position: absolute; left: 0; top: -22px; font: 500 13px Inter, sans-serif; color: #52525b">Checkout — desktop</div>
  <div data-name="Working badge" style="position: absolute; left: 96px; top: -24px; padding: 2px 8px; border-radius: 999px; background: #7c3aed; color: white; font: 600 11px Inter, sans-serif; white-space: nowrap">An agent is working on this</div>
  <div data-name="Frame body" style="width: 100%; height: 100%; background: white; border: 1px solid #e4e4e7; border-radius: 8px"></div>
</div>
<div data-name="Toolbar" style="position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); display: flex; gap: 4px; padding: 4px; background: white; border-radius: 10px; box-shadow: 0 2px 8px rgba(0,0,0,.12)"><button style="padding: 6px 10px">Pointer</button><button style="padding: 6px 10px">Comment</button></div>`,
      });
      await mcp.edit(design, [
        { op: "css", select: `#${board}`, css: "background-color: #f4f4f5" },
      ]);
      return { design, board };
    },
    prompt: () =>
      `Use the Finite MCP tools. A user reports that on the Finite design "Canvas mock", the small "An agent is working on this" badge ` +
      `overlaps the frame's name above it. Fix it so they don't overlap and both stay readable and above the frame, ` +
      `without changing anything else. Stop when you're done.`,
    async check(mcp, ctx) {
      const html = await mcp.readHtml(ctx.design, `#${ctx.board}`);
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
    seed: async (mcp) => ({ design: await mcp.createDesign("Plantpal onboarding") }),
    prompt: () =>
      `Use the Finite MCP tools. In the Finite design "Plantpal onboarding", design a three-screen mobile onboarding flow for a plant-care app: ` +
      `Welcome, Pick your plants (a grid of at least 6 selectable plant cards, two selected), and All set. ` +
      `The screens must share the same top bar, colors, type and button style. Check how they look. Stop when you're done.`,
    followUp: () =>
      `The client changed their mind: the top bar on every screen should be dark green (#14532d) with white text. ` +
      `Make that change on all screens and check it. Stop when you're done.`,
    async check(mcp, ctx) {
      const info = await allHtml(mcp, ctx.design).then((r) => r.info);
      const tokens = await tokenCss(mcp, ctx.design);
      let green = 0;
      for (const a of info.artboards) {
        const html = await mcp.readFullHtml(ctx.design, `#${a.id}`);
        const els = await rendered(html, a.width, a.height ?? 900, tokens(a.id));
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
  // screens-change with a change to the bar's elements, not just its colors,
  // which tokens alone can't make in one place.
  "screens-restructure": {
    workdir: "none",
    seed: async (mcp) => ({ design: await mcp.createDesign("Plantpal onboarding") }),
    prompt: () =>
      `Use the Finite MCP tools. In the Finite design "Plantpal onboarding", design a three-screen mobile onboarding flow for a plant-care app: ` +
      `Welcome, Pick your plants (a grid of at least 6 selectable plant cards, two selected), and All set. ` +
      `The screens must share the same top bar, colors, type and button style. Check how they look. Stop when you're done.`,
    followUp: () =>
      `The top bar changed. On every screen it now needs a back-arrow button at its left and a "Help" link at its right, ` +
      `and its title should be bold. Each screen keeps its own title. Make the change on all screens and check it. Stop when you're done.`,
    async check(mcp, ctx) {
      const info = await allHtml(mcp, ctx.design).then((r) => r.info);
      const tokens = await tokenCss(mcp, ctx.design);
      const titles = ["Welcome", "Pick your plants", "All set"];
      let done = 0;
      const notes = [];
      for (const a of info.artboards) {
        const html = await mcp.readFullHtml(ctx.design, `#${a.id}`);
        const top = (await rendered(html, a.width, a.height ?? 900, tokens(a.id))).filter(
          (e) => e.visible && e.y < 140,
        );
        const has = {
          back: top.some((e) => /^(←|‹|<|❮|〈|back)/i.test(e.text) || e.tag === "svg"),
          help: top.some((e) => e.text === "Help"),
          bold: top.some((e) => titles.some((t) => e.text === t) && e.fontWeight >= 600),
        };
        if (Object.values(has).every(Boolean)) done++;
        else
          notes.push(
            `${a.name ?? a.id}: no ${Object.keys(has)
              .filter((k) => !has[k])
              .join(", ")}`,
          );
      }
      const checks = [info.artboards.length >= 3, done >= 3 && done === info.artboards.length];
      return { passed: checks.filter(Boolean).length, total: checks.length, notes };
    },
  },

  // The task from the "Use the Finite MCP" thread: document the app's own UI.
  // A file from somewhere else, with code in it that mustn't run, goes onto a given page.
  "import-page": {
    workdir: "none",
    files: { "landing.html": IMPORT_PAGE },
    async seed(mcp) {
      const design = await mcp.createDesign("Northwind");
      await mcp.edit(design, [
        { op: "artboard", name: "Home", width: 1440, height: 900 },
        { op: "page", create: "Inbox" },
      ]);
      return { design };
    },
    prompt: () =>
      `Use the Finite MCP tools. Put the page in landing.html, in this folder, into the Finite design "Northwind" on its "Inbox" page, so the team can keep designing it there. ` +
      `Then tell me in two or three sentences whether anything on the page didn't come across, and why. Stop when you're done.`,
    async check(mcp, ctx) {
      const { artboards } = await mcp.overview(ctx.design);
      const boards = artboards.filter((a) => a.page === "Inbox");
      const html = (
        await Promise.all(boards.map((a) => mcp.readHtml(ctx.design, `#${a.id}`)))
      ).join("\n");
      const checks = [
        boards.length >= 1,
        /Coffee that keeps up/.test(html) && /Order now/.test(html),
        /#1f2a1d|rgb\(31, ?42, ?29\)/i.test(html),
        !/onclick|track\(|<iframe/i.test(html),
      ];
      const notes = [`${boards.length} artboard(s) on Inbox`, `${artboards.length} in all`];
      return { passed: checks.filter(Boolean).length, total: checks.length, notes };
    },
  },

  // A file to open in Figma, saved where the person asked.
  // Edits inside a real, large page (about 4,800 nodes and 560 KB of CSS).
  "big-edit": {
    workdir: "none",
    seed: (mcp) => seedPage(mcp, "stripe.html", "Stripe home"),
    prompt: () =>
      `Use the Finite MCP tools. The Finite design "Stripe home" holds a copy of a big real website. Make four changes and nothing else: ` +
      `change the hero headline (the large one at the top, starting "Financial infrastructure to grow your revenue") to "Payments for every business"; ` +
      `remove the "Book of the week" card (only that card, not the "What's happening" section around it); change the "Ready to get started?" heading to "Start building today"; ` +
      `and replace the brand purple #635bff with #0a7cff everywhere it's used. Stop when you're done.`,
    async check(mcp, ctx) {
      const { nodes } = await mcp.overview(ctx.design);
      const count = (text, where) => matches(mcp, ctx.design, text, where);
      const purple = (await count("#635bff", "styles")) + (await count("#635bff", "attributes"));
      const checks = [
        // The page holds the headline twice (two layouts); both change.
        (await count("Payments for every business")) >= 1 &&
          (await count("to grow your revenue")) === 0,
        (await count("Book of the week")) === 0 && (await count("How Africa Works")) === 0,
        (await count("Start building today")) >= 1 && (await count("Ready to get started")) === 0,
        purple === 0 && (await count("#0a7cff", "styles")) >= 1,
        // Book of the week is one card of about 50 nodes in the "What's
        // happening" section, whose other cards stay.
        (await count("What's happening")) >= 1 &&
          (await count("Tobi Lütke")) >= 1 &&
          nodes > ctx.nodes - 120,
      ];
      const notes = [`${nodes}/${ctx.nodes} nodes`, `${purple} purple left`];
      return { passed: checks.filter(Boolean).length, total: checks.length, notes };
    },
  },

  // A long article: a word changes all through its text, and one heading.
  "big-wiki": {
    workdir: "none",
    seed: (mcp) => seedPage(mcp, "wikipedia.html", "Typography article"),
    prompt: () =>
      `Use the Finite MCP tools. The Finite design "Typography article" holds a copy of a long Wikipedia article. ` +
      `In the article's visible text, replace every "typeface" with "font" and every "Typefaces" or "typefaces" with "fonts", keeping capitals ("Typeface" becomes "Font"). ` +
      `Then change the page title heading "Typography" at the top to "Typography (draft)". Change nothing else. Stop when you're done.`,
    async check(mcp, ctx) {
      const left = await matches(mcp, ctx.design, "typeface");
      const { nodes } = await mcp.overview(ctx.design);
      const checks = [
        left === 0,
        (await matches(mcp, ctx.design, "font")) >= 30,
        // The heading's text sits in a child span, so find it by its text.
        (await matches(mcp, ctx.design, "Typography (draft)")) >= 1,
        nodes > ctx.nodes * 0.98,
      ];
      const notes = [`${left} with "typeface" left`, `${nodes}/${ctx.nodes} nodes`];
      return { passed: checks.filter(Boolean).length, total: checks.length, notes };
    },
  },

  "export-figma": {
    workdir: "none",
    seed: (mcp) => seedLanding(mcp, "Acme landing"),
    prompt: () =>
      `Use the Finite MCP tools. I want to keep working on the landing page from the Finite design "Acme landing" in Figma, with the Finite Figma plugin. ` +
      `Save a file I can open with the plugin in this folder as landing.figma.json, then tell me in two or three sentences what won't carry over exactly. Stop when you're done.`,
    async check(_mcp, ctx) {
      const file = path.join(ctx.workdir, "landing.figma.json");
      let payload = null;
      try {
        payload = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {}
      const text = JSON.stringify(payload ?? {});
      const checks = [
        payload !== null,
        payload?.v === 1 && payload?.kind === "figma-payload",
        (payload?.nodes?.length ?? 0) >= 1,
        /Ship faster/.test(text),
      ];
      const notes = [payload ? `${text.length} chars` : "no file"];
      return { passed: checks.filter(Boolean).length, total: checks.length, notes };
    },
  },

  "ui-states": {
    workdir: "web-src",
    seed: async () => ({}),
    prompt: () =>
      `Use the Finite MCP tools. The source of Finite's own web app is in ./web in this folder (Next.js + React). ` +
      `Create a Finite design called "Finite UI states" and put every UI state of the app on it (the design list, empty states, the canvas, ` +
      `the comment tool, comment threads, loading and error states, and so on), drawn as faithfully as you can, so a designer can review them all. ` +
      `Stop when you're done.`,
    async check(mcp) {
      const design = (await mcp.call("designs", { query: "UI states" })).match(
        /"designId": "([a-z0-9]+)"/,
      )?.[1];
      if (!design) return { passed: 0, total: 1, notes: ["no design"] };
      const { artboards, nodes } = await mcp.overview(design);
      return {
        passed: 1,
        total: 1,
        notes: [`${artboards.length} artboards, ${nodes} nodes`],
        design,
        screenshot: artboards[0]?.id,
      };
    },
  },
};
