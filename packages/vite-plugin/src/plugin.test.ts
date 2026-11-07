import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { BRIDGE_CONNECT, BRIDGE_HELLO } from "@finite/protocol";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { allowsOrigin, CONNECT, HELLO } from "./client/bridge.ts";
import { frameEntry, frameFile, frameHtml, PAGE_BACKGROUND } from "./frame.ts";
import { finite } from "./index.ts";
import { injectIntoHtml } from "./html.ts";
import { routeParams, scanRoutes } from "./routes.ts";
import { addFiniteSource } from "./tailwind.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function project(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "finite-plugin-"));
  dirs.push(root);
  for (const [file, text] of Object.entries({ "package.json": "{}", ...files })) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

const noLoad = () => Promise.reject(new Error("no module loading here"));

describe("routes", () => {
  test("reads params from every router's syntax", () => {
    expect(routeParams("/users/:id/:tab?")).toEqual(["id", "tab"]);
    expect(routeParams("/files/*")).toEqual(["*"]);
    expect(routeParams("/posts/$postId/{-$lang}/$")).toEqual(["postId", "lang", "_splat"]);
    expect(routeParams("/blog/[slug]/[...rest]/[[...tail]]")).toEqual(["slug", "rest", "tail"]);
  });

  test("finds routes in a routes array imported into createBrowserRouter", async () => {
    const root = project({
      "src/main.tsx": `
        import { createBrowserRouter } from "react-router";
        import { routes } from "./routes";
        createBrowserRouter(routes);`,
      "src/routes.tsx": `
        import Home from "./pages/Home.js";
        import type { RouteObject } from "react-router";
        export const routes = [
          { path: "/", element: <Home />, children: [
            { path: "settings", lazy: () => import("./pages/Settings") },
            { path: "/legal/*", Component: Legal },
          ] },
        ] satisfies RouteObject[];
        function Legal() { return null; }`,
      "src/pages/Home.tsx": "export default () => null;",
      "src/pages/Settings.tsx": "export const Component = () => null;",
    });
    expect(await scanRoutes(root, "react-router", noLoad)).toEqual([
      { path: "/", params: [], file: "src/pages/Home.tsx" },
      { path: "/settings", params: [], file: "src/pages/Settings.tsx" },
      { path: "/legal/*", params: ["*"], file: "src/routes.tsx" },
    ]);
  });

  test("finds declarative <Routes> and createRoutesFromElements", async () => {
    const root = project({
      "src/App.tsx": `
        import { Route, Routes, createRoutesFromElements } from "react-router-dom";
        import { Shop } from "./Shop";
        export const App = () => (
          <Routes>
            <Route path="/" element={<Shop />}>
              <Route index element={<Shop />} />
              <Route path="items/:itemId" element={<Shop />} />
            </Route>
          </Routes>
        );
        createRoutesFromElements(<Route path="/other" />);`,
      "src/Shop.tsx": "export const Shop = () => null;",
    });
    expect(await scanRoutes(root, "react-router", noLoad)).toEqual([
      { path: "/", params: [], file: "src/Shop.tsx" },
      { path: "/items/:itemId", params: ["itemId"], file: "src/Shop.tsx" },
      { path: "/other", params: [] },
    ]);
  });

  test("lists nothing for a design without a router", async () => {
    expect(await scanRoutes(project({}), "none", noLoad)).toEqual([]);
    expect(await scanRoutes(project({}), "tanstack", noLoad)).toEqual([]);
  });
});

describe("frames", () => {
  test("renders the export inside the wrapper and a memory router", () => {
    const code = frameEntry(
      { router: "react-router", css: ["src/index.css"], wrapper: ".finite/Wrapper.tsx" },
      { file: "src/Card.tsx", exportName: "Card", routerPackage: "react-router" },
    );
    expect(code).toContain(`import "/src/index.css";`);
    expect(code).toContain(`import * as frame from "/src/Card.tsx";`);
    expect(code).toContain(`import Wrapper from "/.finite/Wrapper.tsx";`);
    expect(code).toContain(`const Component = frame["Card"];`);
    expect(code).toContain(`createMemoryRouter([{ path: "*", Component: element }])`);
  });

  test("runs React Router's HMR preamble and gives its runtime a data router in framework mode", () => {
    const config = { router: "react-router" as const, css: [], wrapper: undefined };
    const input = {
      file: "app/routes/home.tsx",
      exportName: "default",
      routerPackage: "react-router",
    };
    const code = frameEntry(config, { ...input, framework: true });
    expect(code.indexOf(`import "virtual:react-router/inject-hmr-runtime";`)).toBe(0);
    expect(code).toContain("window.__reactRouterDataRouter ??=");
    expect(frameEntry(config, input)).not.toContain("__reactRouter");
  });

  test("the file frame page has a light fill unless the design paints its own", () => {
    const html = frameHtml("/entry");
    expect(html).toContain(
      `<style id="finite-page">html { background: ${PAGE_BACKGROUND}; }</style>`,
    );
    expect(PAGE_BACKGROUND).toBe("#f7f9fa");
    expect(html).not.toContain("transparent; }");
  });

  test("checks the frame file", () => {
    const root = project({ "src/A.tsx": "" });
    expect(frameFile(root, "src/A.tsx")).toEqual({ file: "src/A.tsx" });
    expect(frameFile(root, "../x.tsx")).toMatchObject({
      reason: expect.stringContaining("outside"),
    });
    expect(frameFile(root, "src/B.tsx")).toMatchObject({
      reason: expect.stringContaining("doesn't exist"),
    });
    expect(frameFile(root, null)).toMatchObject({ reason: expect.stringContaining("?file=") });
  });
});

describe("tailwind", () => {
  test("adds .finite as a source to the stylesheet that imports Tailwind", () => {
    expect(addFiniteSource(`@import "tailwindcss";`, "/p/src/styles/app.css", "/p")).toBe(
      `@import "tailwindcss";\n@source "../../.finite";\n`,
    );
    expect(addFiniteSource(`@import 'tailwindcss' source(none);`, "/p/app.css", "/p")).toContain(
      `@source "./.finite";`,
    );
    expect(addFiniteSource(`body { color: red }`, "/p/app.css", "/p")).toBeNull();
  });
});

describe("html injection", () => {
  async function serve(handler: http.RequestListener) {
    const server = http.createServer((req, res) => {
      injectIntoHtml(res, `<script src="/finite-b"></script>`, "/finite-b");
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const text = await fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
    server.close();
    return text;
  }

  test("adds the tag to streamed HTML with headers passed to writeHead", async () => {
    const text = await serve((_, res) => {
      res.writeHead(200, "OK", { "content-type": "text/html", "content-length": "26" });
      res.write("<html><head></head>");
      res.end("<body></body></html>");
    });
    expect(text).toBe(`<html><head><script src="/finite-b"></script></head><body></body></html>`);
  });

  test("leaves HTML that already has it, and other responses, alone", async () => {
    const html = `<html><head><script src="/finite-b"></script></head></html>`;
    expect(
      await serve((_, res) => {
        res.setHeader("content-type", "text/html");
        res.end(html);
      }),
    ).toBe(html);
    expect(
      await serve((_, res) => {
        res.setHeader("content-type", "application/json");
        res.end("<head>");
      }),
    ).toBe("<head>");
  });
});

test("the bridge client speaks the protocol's handshake", () => {
  expect(HELLO).toBe(BRIDGE_HELLO);
  expect(CONNECT).toBe(BRIDGE_CONNECT);
});

describe("the Finite shell's origin", () => {
  test("is allowed when its host is listed (any port) or its host:port is", () => {
    const hosts = ["localhost", "127.0.0.1", "::1", "finite.lan:8443"];
    expect(allowsOrigin(hosts, "http://127.0.0.1:4100")).toBe(true);
    expect(allowsOrigin(hosts, "http://localhost:3000")).toBe(true);
    expect(allowsOrigin(hosts, "http://[::1]:4100")).toBe(true);
    expect(allowsOrigin(hosts, "https://finite.lan:8443")).toBe(true);
    expect(allowsOrigin(hosts, "https://finite.lan:9000")).toBe(false);
    expect(allowsOrigin(hosts, "https://evil.example")).toBe(false);
    expect(allowsOrigin(hosts, "http://localhost.evil.example")).toBe(false);
    expect(allowsOrigin(hosts, "null")).toBe(false);
    expect(allowsOrigin(hosts, "file:///Users/x/index.html")).toBe(false);
  });

  test("limits the dev server's CORS and the bridge to the allowed hosts", async () => {
    const root = project({});
    const frames = finite({ root, allowedHosts: ["127.0.0.1", "studio.lan"] }).find(
      (p) => p.name === "finite:frames",
    )!;
    type Origin = (origin: string | undefined, done: (error: unknown, ok: boolean) => void) => void;
    const config = (frames.config as unknown as () => { server: { cors: { origin: Origin } } })();
    const cors = (origin: string | undefined) =>
      new Promise((resolve) => config.server.cors.origin(origin, (_, ok) => resolve(ok)));
    expect(await cors("http://127.0.0.1:4100")).toBe(true);
    expect(await cors("http://studio.lan:3000")).toBe(true);
    expect(await cors("http://localhost:3000")).toBe(false);
    expect(await cors("https://evil.example")).toBe(false);
    expect(await cors(undefined)).toBe(false);

    const resolved = (frames.resolveId as (id: string) => string)("/@finite/bridge");
    const bridge = await (frames.load as (id: string) => Promise<string> | string)(resolved);
    expect(bridge.startsWith('const FINITE_ALLOWED_HOSTS = ["127.0.0.1","studio.lan"];\n')).toBe(
      true,
    );
    expect(bridge).toContain("allowsOrigin(hosts, event.origin)");
  });
});
