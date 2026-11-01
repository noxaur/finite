// The tasks agents run in an AX (agent experience) experiment. Each one seeds
// a design over MCP, gives the agent a prompt, and checks the result, so a
// change to the MCP tools can be measured, not just guessed at.
//
// A task has:
//   prompt(ctx)      what the agent is asked to do
//   seed(mcp)        sets up the design and returns ctx (ids the prompt and check need)
//   check(mcp, ctx)  returns { passed, total, notes } from the design afterwards
//   workdir          "none" (an empty folder) or "web-src" (a copy of the web app's source)
import { idAfter } from "../mcp.mjs";

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
