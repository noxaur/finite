import fs from "node:fs";
import path from "node:path";
import type { DesignConfig, Router } from "@finite/protocol";

export type FrameConfig = {
  router: Router;
  /** Stylesheets every frame imports, relative to the root. */
  css: string[];
  /** Providers frames render inside, relative to the root. */
  wrapper: string | undefined;
};

/** `.finite/design.json`, falling back to what `package.json` says when it's missing. */
export function readFrameConfig(root: string): FrameConfig {
  let config: Partial<DesignConfig> = {};
  try {
    config = JSON.parse(fs.readFileSync(path.join(root, ".finite/design.json"), "utf8"));
  } catch {
    // Not connected yet: guess.
  }
  const defaultWrapper = [".finite/Wrapper.tsx", ".finite/Wrapper.jsx"].find((file) =>
    fs.existsSync(path.join(root, file)),
  );
  return {
    router: config.router ?? detectRouter(root),
    css: config.css ?? [],
    wrapper: config.wrapper ?? defaultWrapper,
  };
}

function detectRouter(root: string): Router {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps.next) return nextRouter(root);
    if (deps["@tanstack/react-router"]) return "tanstack";
    if (deps["react-router"] || deps["react-router-dom"]) return "react-router";
  } catch {
    // No package.json: no router.
  }
  return "none";
}

/** As in Next, `app/` or `pages/` at the root win over `src/app/` and `src/pages/`. */
function nextRouter(root: string): Router {
  const isDir = (dir: string) =>
    fs.statSync(path.join(root, dir), { throwIfNoEntry: false })?.isDirectory();
  const base = isDir("app") || isDir("pages") ? "" : "src/";
  if (isDir(`${base}app`)) return "next-app";
  if (isDir(`${base}pages`)) return "next-pages";
  return "none";
}

/**
 * Checks a frame's `file` query: a path inside the root that exists. Returns it as a posix path
 * relative to the root, or a reason the frame can't render.
 */
export function frameFile(
  root: string,
  file: string | null,
): { file: string } | { reason: string } {
  if (!file) return { reason: "Add ?file=<path relative to the design root> to the frame URL." };
  const full = path.resolve(root, file);
  const relative = path.relative(root, full);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return { reason: `${file} is outside the design folder; frames render files inside it.` };
  }
  if (!fs.existsSync(full)) return { reason: `${file} doesn't exist in the design folder.` };
  return { file: relative.split(path.sep).join("/") };
}

/** The page a file frame shows when the design's CSS paints no background of its own. */
export const PAGE_BACKGROUND = "#f7f9fa";

/**
 * A file frame's fill. Like a Figma frame it has one: the background the design's CSS gives
 * `html` or `body`, else `PAGE_BACKGROUND`. The default rule switches off whenever the design's
 * stylesheets (which the dev server adds and updates in the head) paint either one. It goes in the
 * head: Next's file frames get it injected there.
 */
export const PAGE_FILL = `<style id="finite-page">html { background: ${PAGE_BACKGROUND}; }</style>
    <script>
      (() => {
        const page = document.getElementById("finite-page");
        const clear = (el) => {
          const s = getComputedStyle(el);
          return s.backgroundImage === "none" && ["transparent", "rgba(0, 0, 0, 0)"].includes(s.backgroundColor);
        };
        const check = () => {
          if (!document.body) return;
          page.disabled = true;
          page.disabled = !(clear(document.documentElement) && clear(document.body));
        };
        new MutationObserver(check).observe(document.head, { childList: true, subtree: true, characterData: true });
        addEventListener("DOMContentLoaded", check);
        addEventListener("load", check);
        check();
      })();
    </script>`;

/** A file frame's page under Vite, with the fill. */
export function frameHtml(entry: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    ${PAGE_FILL}
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${escapeAttr(entry)}"></script>
  </body>
</html>
`;
}

/**
 * The entry module of a file frame: the design's stylesheets, then the component inside the
 * optional wrapper and a memory router, so `<Link>` in copied production components works.
 */
export function frameEntry(
  config: FrameConfig,
  input: {
    file: string;
    exportName: string;
    routerPackage: string | undefined;
    /** A module that must run before any component, such as React Router's HMR preamble. */
    preamble?: string | undefined;
  },
): string {
  const url = (file: string) => JSON.stringify(`/${file}`);
  const lines = [
    ...(input.preamble ? [`import ${JSON.stringify(input.preamble)};`] : []),
    ...config.css.map((css) => `import ${url(css)};`),
    `import { createElement } from "react";`,
    `import { createRoot } from "react-dom/client";`,
    `import * as frame from ${url(input.file)};`,
    config.wrapper
      ? `import Wrapper from ${url(config.wrapper)};`
      : `const Wrapper = ({ children }) => children;`,
  ];
  const exportName = JSON.stringify(input.exportName);
  const render = [
    `const Component = frame[${exportName}];`,
    `if (typeof Component !== "function" && typeof Component !== "object") {`,
    `  throw new Error(${JSON.stringify(`${input.file} has no export named ${input.exportName}`)});`,
    `}`,
    `const element = () => createElement(Wrapper, null, createElement(Component));`,
  ];
  if (config.router === "react-router" && input.routerPackage) {
    lines.push(
      `import { createMemoryRouter, RouterProvider } from ${JSON.stringify(input.routerPackage)};`,
    );
    render.push(
      `const router = createMemoryRouter([{ path: "*", Component: element }]);`,
      `const app = createElement(RouterProvider, { router });`,
    );
  } else if (config.router === "tanstack" && input.routerPackage) {
    lines.push(
      `import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from ${JSON.stringify(input.routerPackage)};`,
    );
    render.push(
      `const router = createRouter({`,
      `  routeTree: createRootRoute({ component: element }),`,
      `  history: createMemoryHistory({ initialEntries: ["/"] }),`,
      `});`,
      `const app = createElement(RouterProvider, { router });`,
    );
  } else {
    render.push(`const app = element();`);
  }
  render.push(
    `const root = createRoot(document.getElementById("root"));`,
    `root.render(app);`,
    // A change that React Refresh can't apply stops here and re-renders this frame, instead of
    // reloading every page of the dev server.
    `if (import.meta.hot) {`,
    `  import.meta.hot.accept();`,
    `  import.meta.hot.dispose(() => root.unmount());`,
    `}`,
  );
  return [...lines, ...render, ""].join("\n");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}
