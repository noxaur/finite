# How Finite works

Finite is a design canvas where every design is a real React and TypeScript project. A frame on the canvas is a live iframe of that project's own dev server, Vite or Next.js. A person selects an element in a frame and changes it in the inspector, and Finite rewrites the TSX that made it. An agent works in a thread, which runs the person's local Claude Code CLI on the same project with a set of canvas tools.

Two ideas carry the rest of this guide:

- **Files are the truth.** The project's source, plus a `.finite/` folder of JSON in its root, hold everything: canvases, comments and threads. The server keeps a copy in memory and writes every change straight back. So git, an editor and an agent's `Edit` tool all see the same state the canvas shows.
- **Every rendered element knows where it came from.** A Vite plugin (a loader, under Next.js) stamps each JSX element with its file, line and column, and a hash of the file. A hand edit names those, and the server refuses it when the file has changed since (optimistic concurrency).

## The big picture

```
browser tab / Electron window (Next.js static app, apps/web)
   │  one WebSocket per tab: /api/ws (JSON, packages/protocol)
   ▼
apps/server (Node 22, node:http + ws)
   ├─ store/    designs.json, settings.json, each design's .finite/
   ├─ preview/  one Vite or Next.js child per open design, with @finite/vite-plugin
   ├─ source/   hand edits → TSX, tokens, per-actor undo
   └─ agent/    one Claude Agent SDK query per live thread
                     │ spawns
                     ▼
               the local `claude` CLI, cwd = the design's workspace, else its root

iframes ──────────▶ each design's own dev server (another port, same host)
```

The page talks to the server over one socket. It loads frames from the design's dev server directly, so the dev server's hot module replacement (HMR) updates every viewer's iframes when a file changes, whoever changed it.

In development, `vp run dev` starts `node --watch apps/server/src/main.ts` on port 4100 and `next dev` on 5310, which proxies `/api/*`, the WebSocket included, to `FINITE_API_URL` (default `http://127.0.0.1:4100`). In the desktop app, Electron runs the bundled server (`apps/server/dist/main.mjs`) with its own Node (`ELECTRON_RUN_AS_NODE=1`), passes the login shell's `PATH` so it finds `claude` and `pnpm`, and points `FINITE_STATIC_DIR` at the web export, so the page and `/api` share one origin.

`apps/server/src/config.ts` reads every setting:

| Variable               | Default          | What it is                                                                            |
| ---------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| `FINITE_PORT`          | `4100`           | The port. The desktop app picks a free one when 4100 is taken.                        |
| `FINITE_HOST`          | `127.0.0.1`      | The host. Each design's Vite server binds the same one.                               |
| `FINITE_DATA_DIR`      | `./.finite-data` | The registry, settings and blank projects. The desktop app uses its user data folder. |
| `FINITE_STATIC_DIR`    | unset            | A built web app to serve outside `/api`.                                              |
| `FINITE_ALLOWED_HOSTS` | loopback names   | Extra host names the guard accepts, comma-separated.                                  |

The guard (`guard.ts`) checks `Host` and `Origin` on every request and upgrade. Browsers don't apply the same-origin policy to WebSockets, so without it any web page could open `ws://127.0.0.1:4100/api/ws` and read every design (cross-site WebSocket hijacking), and DNS rebinding could reach the HTTP side.

## Data on disk

```
$FINITE_DATA_DIR/
  designs.json        [{ id, name, root, origin, workspace?, app?, setup? }]   origin: connected | blank | import
  settings.json       default model, effort, speed, steer-or-queue, Show Working separately
  projects/<id>/      blank and imported designs: a copy of apps/server/scaffold
<root>/.finite/       meant to be committed with the project
  design.json         { version: 1, id, router, styling, css[], wrapper?, brandDir }   router: react-router | tanstack | next-app | next-pages | none (a setup design)
  runtime/            generated files for Next.js and Tailwind v3 designs, ignored by git (see Previews)
  canvases/<id>.json  one canvas: frames, text labels, comments
  boards/<canvasId>/  the prototype components agents write, one default export per file
  threads/<id>.json   thread metadata (ThreadMeta)
  threads/<id>.jsonl  the thread's event log, one ThreadEvent per line
  attachments/        files people attached to messages
  Wrapper.tsx         optional providers every file frame renders inside
<root>/<brandDir>     brand assets (default src/assets/brand)
```

`store/` is the only writer of these files. It writes through a temp file and a rename (an atomic write), so a reader never sees half a file, and it serializes writes per design. It also watches `.finite/` and reads back changes made outside the server, such as an agent editing a canvas file, after 100 ms of quiet.

A **connected** design is a reference to a folder that already exists. `design.connect` runs `store/detect.ts`: the folder needs a `package.json` and either `next` (a Next.js app) or Vite with React Router or TanStack Router, or it's refused with code `unsupported-project` and a reason. For a Next.js app, the router is `next-app` when there is an `app/` folder and `next-pages` when there is only `pages/`, so `app/` wins when both exist. As in Next, `app/` or `pages/` at the root win over `src/app/` and `src/pages/`. The global stylesheets come from `app/layout` or `pages/_app`, and the brand folder is `src/assets/brand`, or `assets/brand` when the project has no `src/`. Detection also picks the styling convention (StyleX, Tailwind, CSS modules or inline styles) and the global stylesheets: the ones that use Tailwind (`@import "tailwindcss"` on v4, `@tailwind` directives on v3) when there are any, else the `.css`, `.scss` or `.less` files the entry imports. StyleX wins when `@stylexjs/stylex` is a dependency and at least as many files call its `props` as use `className` strings. A design keeps the `styling` stored in `.finite/design.json`, and connecting it again doesn't detect it again, so edit that field to switch a design's convention. A `finite.json` at or above the folder comes first, and a folder with a `package.json` that detection refuses becomes a setup design instead of a refusal (see "Workspaces and finite.json"). Removing a connected design forgets it and leaves the folder alone. A **blank** design copies `apps/server/scaffold` (Vite 8, React 19, TypeScript, Tailwind v4, React Router) into `projects/<id>/` and installs its dependencies with `pnpm install --ignore-workspace`, or npm when pnpm isn't on `PATH`. Until the install ends, the design's preview reports `starting` with the install's output. An **import** is a blank design plus a thread that rebuilds the source (a Figma link, a URL or attachments) in TSX.

Every new design starts with three pages: **Routes**, with one frame per route the dev server reports, laid out in a grid of four columns and kept in step with the routes (`store/routes.ts`); **Brand**, for logos, images and fonts; and **Components**. A route frame fills each dynamic segment with the sample value `"1"`, unless the app's `routes` in `finite.json` gives values for that path. A sync matches frames by path and params, so it's idempotent and keeps frames where people moved them: it adds a frame for each new path and params, and marks `gone` (keeping it) any frame that neither the dev server's routes nor `finite.json` give any more. Each sync reads `finite.json` again, and while it's invalid the page stays as it is. A removed canvas keeps `removedAt` for 30 days, so it can be restored, and is deleted the next time the design opens after that.

## The wire protocol

`packages/protocol/src/wire.ts` is the contract. Each tab opens one WebSocket on `/api/ws` and sends JSON requests with a `rid`. The server answers each with `{ type: "reply", rid, ok: true, value }` or `{ ok: false, reason, code? }`. `reason` is written for a person or an agent to act on, and `code` (from `RefusalCode`: `stale`, `outside-prototype`, `unsupported-style`, `not-logged-in` and others) is what the UI reacts to. Zod parses every message, so a bad one is refused with the path of the bad field, like `canvas.patch: patch.frames.0.x: expected number`.

The first message is `hello { user }`. `subscribe { designId }` returns the design's whole state (`DesignState`: the design, its canvases, threads, preview state and routes), and from then on the server pushes events: `canvas` (the whole canvas after any change), `thread`, `thread.event`, `preview` and `routes`. `designs` and `settings` go to every socket. The requests fall into groups:

- Designs: `designs.list`, `design.create`, `design.connect`, `design.setup` (start a setup thread), `design.remove`. `setup.done { designId, next }` tells a design's subscribers which design to show once its setup passed.
- Canvases: `canvas.create`, `rename`, `remove`, `restore` and `patch`. A `CanvasPatch` moves, resizes, adds, removes, renames or moves frames to another canvas, or sets and removes a text label.
- Source: `source.edit`, `source.undo`, `source.redo`, `source.detach`, `tokens.get`, `tokens.set`, `components.list`.
- Comments: `comment.add`, `reply`, `resolve`, `reopen`.
- Threads: `thread.send`, `thread.queued` (edit or drop a queued message), `interrupt`, `snooze`, `settle`, `rename`, `history`.
- Settings and Claude: `settings.get`, `settings.set`, `claude.status`.
- `frame.error`: a frame's runtime error, which the page forwards for the agent's `frame_errors` tool.

Two things don't fit a JSON socket and are plain HTTP (`http.ts`): `POST /api/designs/:id/attachments` (multipart, up to 25 MB) stores a file in `.finite/attachments/` and returns its path for `thread.send`, and `GET /api/designs/:id/export?canvasId=&frameIds=` returns a zip of the frames' TSX files and the `.finite/` files they import. `GET /api/health` answers `{ ok: true }`.

`hub.ts` holds the sockets. It opens each design once and forwards the open design's changes, and its preview's, to the sockets subscribed to it. `handlers.ts` has one thin function per request type that calls into the modules; `packages/protocol/src/server.ts` declares those modules' interfaces (`Store`, `OpenDesign`, `Previews`, `SourceEditor`, `Agents`).

## Previews, the plugin and the bridge

`preview/` runs one dev server per open design, each in a child process: `preview/vite-host.mjs` for a Vite app and `preview/next-host.mjs` for a Next.js app. The child loads the project's own Vite through `createRequire(root)`, with the project's own config, and passes `@finite/vite-plugin` as an inline plugin. Vite merges inline config over the project's, so the project's files stay untouched. The child reports its URL over IPC, and `changed` when source files change. When nobody views a design for 60 seconds, its dev server stops. A crash shows as preview `error` with the tail of its log.

`@finite/vite-plugin` (`packages/vite-plugin/src/`) does four things:

- **Stamps** every intrinsic (lowercase) JSX element in `.tsx` and `.jsx` files outside `node_modules` with `data-finite-loc="src/x.tsx:12:4"` and `data-finite-rev="<first 8 hex digits of the file's sha1>"` (`stamp.ts`). It parses with `@babel/parser` and inserts with `magic-string`, so the source map still lines up. Components and fragments aren't stamped, so an element inside `<Button>` carries `Button.tsx`'s loc: editing it edits the component everywhere it's used.
- **Injects the bridge** into every page: through `transformIndexHtml` for a single-page app, and by rewriting the HTML response for React Router's framework mode, which renders HTML on the server (`html.ts`). Under Next.js the host streams it in, as described below.
- **Serves frames and routes.** `GET /__finite/frame?file=&export=` renders one component on its own page: the design's stylesheets, then the component inside `.finite/Wrapper.tsx` when there is one and a memory router, so a `<Link>` in a copied production component works. In React Router framework mode it first runs React Router's HMR preamble and sets a stand-in data router, because React Router's HMR runtime updates `window.__reactRouterDataRouter` before React Refresh runs and throws without one. `GET /__finite/routes` lists the app's routes (`routes.ts`): TanStack Router's `FileRoutesByFullPath` from `routeTree.gen.ts`; React Router's framework-mode `app/routes.ts`, loaded through Vite; or, for React Router's data and declarative modes, a Babel scan of `createBrowserRouter([...])` and `<Route path>`.
- **Lets Tailwind see `.finite/`.** In dev it appends `@source "<path to .finite>";` to the stylesheet that imports Tailwind v4, so classes used only in prototypes get generated (`tailwind.ts`). Tailwind v3 scans its config's `content` instead, so for a stylesheet with `@tailwind` directives Finite writes a config, `.finite/runtime/css/<sheet>.tailwind.config.cjs`, that requires the project's own (the one the sheet's `@config` names, else `tailwind.config.*` at the root) and adds `.finite/` (but not `.finite/runtime`) to its `content`. It requires it by a literal relative path, which Tailwind's dependency scan follows, so an edit to the project's config rebuilds; when Node can't require a TypeScript or ESM config, Tailwind's loader falls back to jiti for Finite's config and the require inside it. The stylesheet Vite loads gets `@config` pointing at it, in place of its own `@config`, after the leading `@charset` and `@import`s, which must come first. Relative globs of a `relative: true` config are made absolute, since they would otherwise resolve against Finite's config.

### Next.js designs

`next-host.mjs` loads the project's own `next` and runs `next dev` as a custom server, so the project's `next.config` and plugins apply. It runs Turbopack unless the project needs webpack (`nextBundler` in `next/index.ts`): the flag on the script that runs `next dev` decides, the `dev` script first (`--webpack` or `--turbopack`); with no flag, a raw config that has a `webpack` function but no `turbopack` config means webpack, the case where Next 16's own `next dev` stops and asks for a flag. Next's own loader reads that raw config in a short-lived child process, since Next caches a raw load as the full config. Next has no inline plugin option, so Finite hooks the config another way: the child sets `NEXT_ADAPTER_PATH` to `packages/vite-plugin/src/next/adapter.ts`, and Next calls its `modifyConfig` on the project's config. The adapter adds the stamping loader (`next/loader.ts`) for both bundlers, so it runs before SWC on the file as it is on disk and locs and revs match. For Turbopack it's the first rule for `*.tsx`, `*.jsx` and `*.js` (and `*.css` for Tailwind v3); for webpack, the adapter chains a `webpack` function onto the project's own: it calls the project's first, then adds a `pre` rule for the same files outside `node_modules`, last so it runs first among pre loaders, and one that names each Tailwind v3 stylesheet by path, since a rule whose `test` matches any `.css` file turns Next's built-in CSS support off. The webpack function also adds the `distDir` to `watchOptions.ignored`. Next ignores only `.next`, and Tailwind watches the whole root, so without it each build's output would start the next build and refresh every open page. It also sets `distDir` to `.finite/runtime/next`, so the project's own `.next` and its dev lock stay untouched, turns `compress` off so the bridge can be added to HTML, turns `devIndicators` off so Next's badge isn't in every frame, and drops `output: "export"` in the dev phase, since it forbids the Pages Router mount's `getServerSideProps` and the preview never exports. A project's own `adapterPath` would replace Finite's adapter, so the child registers a module resolve hook (`registerHooks`) that sends Next's import of that adapter to Finite's, with the project's adapter's URL in `?adapter=`. Finite's adapter then wraps the project's: the project's `modifyConfig` runs first, Finite's changes go on top, and the project's other hooks, such as `onBuildComplete`, pass through. If Finite's adapter still didn't run, say because a later Next loads adapters another way, the preview is refused. Finite's `modifyConfig` sees the config after Next filled in its defaults and the project's adapter ran, so it hands the `basePath` and `pageExtensions` to the host (through `globalThis.FINITE_NEXT_CONFIGURE`), and the host writes its files then, before Next scans the routes. Finite never parses `next.config` itself; Next's loader reads it.

A project's `basePath` prefixes every URL, Finite's included. The preview URL the child reports ends in it (`http://127.0.0.1:<port>/docs`), and `frameHref` in `packages/protocol/src/routes.ts`, which the server's `Previews.frameUrl` and the page's iframes both use, puts each frame under that URL. The bridge, routes, asset and frame URLs below are all under the `basePath`, and outside it they're Next's 404s.

A `node:http` server in front of Next (`finiteNext` in `next/index.ts`) answers Finite's URLs and passes everything else to Next. It does these jobs:

- **Bridge injection.** It streams each HTML response and adds the bridge `<script>` right after `<head>`, holding back only the bytes before it (`streamIntoHtml` in `html.ts`). RSC payloads and assets pass through. The bridge can't use Vite's HMR events here, so it watches the page with a `MutationObserver` and posts `updated` once a stamped element's rev changed, stamped elements were added, or a head stylesheet changed, and the DOM has been quiet for a moment.
- **Routes.** `GET /__finite/routes` runs the Next route scanner (`next/routes.ts`): the `page` files under `app/` and every file under `pages/` (but `_app`, `_document`, `_error` and `api/`). A file counts only with one of the config's `pageExtensions`, matched as Next matches them: with `pageExtensions: ["page.tsx"]`, `about.page.tsx` is `/about` and `Card.tsx` beside it is no route. Route groups `(x)` and slots `@x` add no segment, private `_x` folders and intercepting routes aren't routes, and the App Router's page wins when both routers define a URL. Paths keep Next's segments (`[id]`, `[...slug]`, `[[...slug]]`), and `routeHref` fills them: `[id]` and `[...slug]` are required (a catch-all's value keeps its slashes), and `[[...slug]]` is dropped when empty.
- **File frames.** Next can't import a path chosen at request time, so a file frame renders through a mount, the one Finite-owned file outside `.finite/`: `app/%5F%5Ffinite/frame/page.tsx` for the App Router (`%5F` is how Next spells a leading `_` that isn't private, and the folder goes inside the first route group with a layout, like `app/(site)/`, when `app/` has no root layout of its own) or `pages/__finite/frame.tsx` for the Pages Router, under `src/` when the project uses it. Its extension is the first of the `pageExtensions` that ends in `tsx` (`frame.page.tsx` with `page.tsx`), and a project whose `pageExtensions` have none is refused with a reason. It serves `/__finite/frame?file=&export=`. The mount reads `.finite/runtime/frames.ts`, a registry of literal `import()`s, one per file a frame has shown, because Next only compiles what it can see. When a frame asks for a file that isn't there yet, Finite adds it and waits until Next renders the mount instead of a 404. The registry also imports the design's global CSS and the wrapper. The mount is listed in `.git/info/exclude`, so it never shows as a change, and removed when the preview stops, unless someone edited it. Finite records the sha1 of the mount it wrote in `.finite/runtime/mount.sha1`; if the project already has its own file at that path, or the mount changed since Finite wrote it, the preview is refused with a reason.
- **Tailwind.** For each stylesheet that imports Tailwind v4, Finite writes a copy under `.finite/runtime/css/` that imports the original and adds `@source` lines for `.finite/` (but not `.finite/runtime`). The loader points the project's imports of that stylesheet at the copy. A Tailwind v3 stylesheet can't work that way, since the copy's `@import` would be compiled on its own with the project's config. Instead Finite writes the same config as under Vite, and the adapter adds the loader to `*.css` too, where it adds the same `@config` to the stylesheet as it passes through. Both bundlers run PostCSS after the loaders, so Tailwind reads Finite's config, and a board written after `next dev` started gets its classes, since Tailwind reports the content folders to the bundler as dependencies.
- **The brand board.** Without Vite's `import.meta.glob`, `.finite/runtime/brand.ts` lists the brand folder's files, served at `/__finite/asset`, and the design's CSS text.
- **The host guard.** It applies Vite's rule against DNS rebinding and the same cross-origin rule as the bridge (CORS only for loopback origins or `FINITE_ALLOWED_HOSTS`).

The child watches the project for source changes and any change in the brand folder, syncs the registry and brand files, and reports `changed`. It also restores `next-env.d.ts` and `tsconfig.json` if `next dev` rewrote them for the new `distDir`.

A frame's source is a route (`{ kind: "route", path, params? }`, loaded at that path) or a file (`{ kind: "file", file, exportName? }`, loaded through `/__finite/frame`). `Previews.frameUrl` turns either into the iframe's URL.

The **bridge** connects the page to each iframe over a `MessageChannel` (`packages/protocol/src/bridge.ts`; the iframe half is `packages/vite-plugin/src/client/bridge.ts`, the page half `apps/web/src/canvas/bridge.ts`). The iframe posts `finite:hello` to its parent, and the parent answers with `finite:connect` and the port. The bridge takes the port, and the dev server answers cross-origin requests, only from an origin whose host is a loopback name or one in `FINITE_ALLOWED_HOSTS` (a bare name allows any port, so `next dev` on 5310 connects too), the same rule the guard applies. The parent then asks `hit(x, y)` (the stamped element under a point, which instance of its loc it is, and its stamped ancestors), `rects(locs)`, `inspect(loc, index)` (computed styles and class names for the inspector) and `layers()` (the stamped tree for the Layers panel), and sends `preview(loc, styles)` to show a style while a gesture runs. The iframe sends `size` (for frames whose height hugs their content), `updated` after HMR (under Next.js, after a DOM change), `key` (so canvas shortcuts work with focus inside a frame) and `error` (runtime errors, rejections and `console.error`).

## Workspaces and finite.json

A design is one app, but many apps don't run with just their dev server. A monorepo root has no app of its own, and an app may need a workspace package built first, generated code, or an API running. `finite.json`, committed at the repository root, tells Finite how to run them. It holds commands and non-secret env only, and Finite never writes it itself: a setup thread's agent does.

```json
{
  "setup": ["pnpm install", "pnpm -F @acme/ui build"],
  "apps": {
    "web": { "path": "apps/web", "needs": ["api"] },
    "docs": { "path": "apps/docs" }
  },
  "services": {
    "db": { "run": "docker compose up db", "ready": 5432 },
    "api": { "run": "pnpm -F api dev", "ready": "http://localhost:4000/health", "needs": ["db"] }
  },
  "env": { "API_URL": "http://localhost:4000" }
}
```

The schema is `FiniteJson` in `packages/protocol/src/model.ts`, and `store/workspace.ts` reads and checks it:

- `setup`: shell commands run in order in the workspace root before any app's dev server starts. An app's own `setup` runs in its folder after.
- `apps` (at least one): `path` is relative to the workspace root, and `"."` is the root itself (a single app that needs a service). Each path must hold a `package.json`, and no two apps share one.
- `services`: a long-running `run` command, in `cwd` (default the root). `ready` is a URL, ready when a GET answers below 500, or a port, ready when a TCP connect to 127.0.0.1 succeeds. Without `ready`, a service is ready once spawned.
- `routes` (in an app): values for dynamic segments, keyed by the route path exactly as the router reports it (`:id`, `$id`, `[id]`). The value is one params object, or an array of them for one Routes page frame each, like `"routes": { "/users/:userId": { "userId": "42" }, "/posts/$slug": [{ "slug": "hello" }, { "slug": "draft" }], "/internal/preview": {} }`. Those params replace the sample `"1"`. A path the router doesn't report is added as a custom route frame, which is never marked `gone` while it's listed. The preview watches the workspace folder for `finite.json` changes and sends the routes again, so an edit to `routes` shows on the Routes page while the dev server runs. Values are strings, keys are the path's segment names as `routeHref` reads them (a splat is `*` or `_splat`), and every required segment needs a value, so `apps.web.routes./users/:userId: no param "id" in this path; its params are userId.`
- `env`: added to every setup command, service and dev server. Process env loses to finite.json's `env`, which loses to an app's or service's own `env`.
- Names are lowercase letters, digits and hyphens. Every `needs` must name a service, and services can't need each other in a cycle.

An invalid file is refused with code `invalid-config` and one sentence per problem, naming its key path, like `apps.web.needs: there's no service "api". Add it under services, or remove it from needs.` Finite finds a design's `finite.json` by walking up from the app folder to the nearest folder that has one, stopping at the folder that holds `.git`.

### Connect

`design.connect { path }` reads `finite.json` first. When `path` is the workspace root, Finite connects every app it lists, one design each, with detection run on the app folder, and returns the first. When `path` is in an app's folder, it connects that app. Each such design's row in `designs.json` gets `workspace` (the absolute folder holding `finite.json`) and `app` (its name there). A design that opens for the first time in a server run, or whose folder is connected again, looks its `finite.json` up again: it gets `workspace` and `app` when a `finite.json` written since lists it, and loses them when none does. An invalid `finite.json` keeps the fields as they are, and the preview reports the problems. The design's `root` is still the app folder, where `.finite/`, routes, the preview and hand edits live.

Without a `finite.json`, detection runs as before. When it refuses a folder that has a `package.json`, like a monorepo root or an app missing a dependency, Finite connects it as a **setup design**: root and workspace are the folder, `router: "none"`, inline styling, no stylesheets, brand folder `assets/brand`, and `setup: true` on its row. Its preview never starts; it reports `needs-setup`, with a log that gives detection's reason (run again each time the design opens, like `… doesn't use Vite or Next.js (no vite or next in package.json).`) and says to finish the setup thread. The design screen shows that reason above "Set up with Claude". The connect dialog then asks `design.setup`, which starts the setup thread, the way an import starts its thread.

### The setup thread

`design.setup { designId }` starts a thread with `setup: true` in its `ThreadMeta`. Its first message says why Finite can't run the folder: detection's reason for a setup design, the preview's log for a design whose preview failed. Its system prompt is `SETUP_INSTRUCTIONS` instead of the usual one: read the package manager, the workspace config, the dev scripts and what the pages need (built packages, codegen, servers), write a minimal `finite.json` with no secrets, then call `finish_setup` and fix what it reports until it passes. The fence lets a setup thread write that one `finite.json`: the setup design's workspace, else the nearest `finite.json` above the design, else the repository root.

`finish_setup` validates `finite.json` and returns every problem, or connects every app in it. A setup design whose folder is one of the apps (`"path": "."`) becomes that app: Finite detects it again, rewrites `.finite/design.json` and clears `setup`. Otherwise the apps replace it: the page moves to the first app, and when the thread's turn ends Finite removes the setup design's row and the `.finite/` folder it made. A `.finite/` that was in the folder before the setup design (`madeFinite` isn't set on its row) stays. A design that was already connected can be set up again from its failed preview, through "Set up with Claude"; its row gets `workspace` and `app`. Either way the store emits `setup.done { designId, next }`, the page navigates to `next` (or fetches the design again when `next` is itself), and the tool restarts `next`'s preview and waits for it. So the agent sees whether setup, services and the dev server really run, with the log when they don't.

### Running a preview

`Previews.ensure` on a design with a `workspace` (`preview/workspace.ts`) does three things before the dev server:

1. Runs the workspace's `setup`, then the app's, once per server run and again whenever `finite.json`'s text changes (its sha1). Designs of one workspace share the run. While it runs, the preview is `starting` with the output in `log`; a failing command makes it `error` with the command, its exit code and output.
2. Starts the services the app needs, transitively, each after the ones it needs, and waits for `ready` up to the start timeout. Every design of the workspace shares a service, counted by reference. It stops (SIGTERM to its process group, SIGKILL after 5 s) when the last preview that needs it stops. A service that's already answering on its `ready` before Finite starts it, because the person runs it themselves, is used as is.
3. Starts the dev server child as before, with the merged env.

A preview stopped during these steps (by `Previews.stop` or removing the design) starts nothing after the step it's on and lets go of the services it holds. A setup command other designs share runs to its end; `Previews.close` kills it.

Commands run through the user's shell (`spawn(cmd, { shell: true })`) with the server's `PATH`.

### Agents in a workspace

An agent on a workspace design runs with the workspace root as its working directory. Its prototypes and brand assets still go under the app's `.finite/` and brand folder, but `move_to_prod` lets it write anywhere in the workspace, so it can change shared packages. Relative paths in the fence and the canvas tools are taken from the workspace root too, so `apps/web/src/Card.tsx` and `src/Card.tsx` both name the app's file.

## Hand edits: the source editor

`source/` turns a hand edit into a change to the TSX. A `SourceEdit` is `style`, `text`, `reorder`, `remove`, `duplicate` or `attr`, and names the locs it touches plus the rev of each file. `rewrite.ts` parses the file with Babel, finds the opening element at each loc, checks its tag, and splices the change in with `magic-string`, so the file's formatting survives. It returns a remap of old locs to new ones, so the selection follows the element.

A style edit follows the design's convention:

- **Tailwind** (`tailwind.ts`): a CSS property becomes a class. A value that equals a theme variable exactly becomes its name (`bg-ink`, `rounded-card`), a v4 spacing value on a quarter step of `--spacing` becomes that step (`p-13`), and anything else an arbitrary value (`w-[312px]`). `tailwind-merge`, taught the project's theme names, drops the classes the new one replaces. It edits a literal `className`, or a literal argument of `cn`, `clsx` or `twMerge`.
- **Tailwind v3** (`tailwind3.ts`): a design whose installed `tailwindcss` is 3.x and that has a `tailwind.config.{ts,js,mjs,cjs}` keeps its theme in the config, not `@theme`. A short-lived child `node` loads the config with the project's own `tailwindcss/loadConfig` and `resolveConfig` and prints the resolved theme, cached until the config's mtime changes; the child runs the project's code, so the server never does. The theme is flattened into the same names (`colors.brand.DEFAULT` is `--color-brand`, `fontSize.sm: [size, opts]` is `--text-sm`), with a namespace per v3 scale that v4 opened up (padding, margin, gap, width, height, inset, z-index, opacity, border width). v3 writes only names from those scales: `DEFAULT` is the bare class (`rounded`, `shadow`, `border`), v4's defaults don't apply (v3's `rounded-sm` is 0.125rem), and an off-scale value is arbitrary (`p-[13px]`, `z-[15]`), since v3 has no `--spacing` multiplier. When the config throws, the server logs it and every value becomes arbitrary.
- **CSS modules**: `className={styles.card}` means editing the top-level `.card` rule in the imported `*.module.css`, `*.module.scss` or `*.module.less` with PostCSS, and adding the rule when the class appears nowhere in the sheet (`css.ts`). The file extension picks the dialect, so one design can mix them. `postcss-scss` and `postcss-less` parse and print the sheet, which keeps `//` comments and mixins and changes only the edited declaration. Values are written raw, so a `$var` or `@var` in that declaration becomes the literal value, unless the value is itself a Sass or Less variable token (`$brand`, `@line`). Then it's written as is, and when the module doesn't define or load the file that holds it, Finite adds `@use "<path>" as *;` (Sass) or `@import (reference) "<path>";` (Less) after the module's own `@use`s or `@import`s. A plain `@use "<path>"` already there turns `$brand` into `<namespace>.$brand`. Sass has no reference-only import, so `@use` copies the used file's CSS into every module that loads it. Finite adds the `@use` only for a file that outputs no CSS (just variables, `@use`, `@forward`, mixins, functions and comments), such as a `_tokens.scss` partial. A variable in a sheet with rules, like a global sheet with `:root` and `body`, is refused with `unsupported-style`, which says to move the `$vars` into a partial that the global sheet `@use`s. A variable token on an element no module rule styles (Tailwind, inline, StyleX) is refused with `unsupported-style`. Finite refuses with `unsupported-style` when the class appears only nested or in a compound selector (`.list .card`, `&__title`, `.card.on`), since a new top-level rule wouldn't win. It refuses indented `*.module.sass` too, which has no round-trip parser.
- **StyleX** (`stylex.ts`): `{...stylex.props(styles.card, active && styles.on)}` means editing the `card` entry of the top-level `const styles = stylex.create({…})` in the same file, above or below the JSX. The import can be the namespace or named (`create`, `props`) under any local name, and `sx={…}` counts as a `props` spread. The target is the last argument that always applies; if a later conditional argument sets the same property, the edit refuses, since the change wouldn't show. Keys are camelCase (custom properties quoted) and values strings. A conditional value (`{ default, ":hover" }`) gets its `default` set and keeps the other branches; `null` deletes a plain property or sets `default: null`. It refuses with `unsupported-style` when the styles come from another file, the entry is a function or has a spread, the `default` is itself an object, no argument always applies, or the element spreads `props` twice. An element with no `style`, `className` or other spread gets a new entry in the file's top-level `create` object and a `{...stylex.props(styles.<key>)}` spread, under the file's own import names. The key comes from the element's `id` or `role`, else its tag (`heading` for `h1`–`h6`, `text` for `p`, `link`, `image`, `list`, `item`, or the tag itself), with a number added when it's taken (`item2`). A file without a `create` object gets `const styles = stylex.create({…})` after its imports, and one that doesn't import `props` gets `import * as stylex`. An element with a `style`, a `className` or a spread Finite can't read gets an inline style instead. StyleX's own Vite plugin compiles after Finite stamps, so locs and revs match the file on disk. In React Router framework mode the project's `root.tsx` links StyleX's dev stylesheet and runtime, as StyleX's docs say (the `stylex-framework` fixture), so server-rendered HTML has the CSS and HMR updates it. A picked `defineVars` token (`colors.brand`) is written as that member expression, not a string, in the existing or the new entry; a known token inside a longer value, like `color-mix(in srgb, colors.brand 50%, transparent)`, makes the value a template literal with `${colors.brand}` in its place. When the file doesn't import the group yet, Finite adds `import { colors } from "<relative path>.stylex";` after its other imports, beside the `stylex` import when a new entry needs one too, in the quotes and semicolons of the file's last import. A group imported under another name is used by that name. Every name Finite adds (`styles`, `stylex`, a token group) is numbered when the module already binds it, including a type-only import, an enum or a namespace with values: `stylex2`, `styles2`, `import { colors as colors2 }`. A StyleX token on a Tailwind, CSS-modules or inline element, or on a StyleX design's element that gets an inline style, is refused with `unsupported-style`.
- **Inline**: a `style={{ … }}` prop, used only when the element has no `className` at all.

Anything else, like a computed class expression or styled-components, is refused with `unsupported-style` and "Ask the agent to change this", rather than an inline style that would override responsive classes. Tokens are the CSS custom properties in the design's global stylesheets (`.css`, `.scss` or `.less`): light ones in `@theme` (or `:root`), dark ones in `.dark`. `tokens.ts` reads and writes them with PostCSS. A new light token goes in `@theme` for Tailwind, and otherwise in the first `:root` rule, added after any `@use`, `@forward` and `@import`. The top-level Sass `$vars` of the global `.scss` sheets and Less `@vars` of the global `.less` sheets are tokens too, named with their sigil. For Sass, Finite also follows each global sheet's `@use`, `@forward` and `@import` into the local `.scss` partials it loads, and their partials in turn, and reads their top-level `$vars` (not their custom properties). Each variable token belongs to the file that defines it, which an edit on the Tokens page changes. Variable tokens have one value, shown as Light; setting a dark value is refused. A new one goes after the last top-level variable of the first sheet of its dialect that outputs no CSS (for Sass, usually a partial), else of the first sheet of its dialect, and an edit keeps Sass's `!default` and `!global` flags. In a StyleX design, the `export const <group> = stylex.defineVars({ … })` calls in the `*.stylex.ts` (or `.js`, `.tsx` and so on) files under `src/` and `app/` are tokens too, named `<group>.<key>` (`stylex.ts`, `readVars` and `writeVar`). Light is a plain literal value (a negative number like `-8` counts) or a conditional value's `default`, and Dark its `@media (prefers-color-scheme: dark)` branch; values built from code, like `stylex.types.color(…)`, are left out. An edit writes the literal back into the `defineVars` object and keeps the other branches: a dark value turns a plain value into `{ default, "@media (prefers-color-scheme: dark)": … }`, and clearing it turns it back. A new token goes after the others in the first `defineVars` of its group; a group no file defines, or a design with no `defineVars`, is refused with a message that says what to add. The inspector reads computed values, so it shows the value a StyleX token resolves to, not the token's name. A Tailwind v3 design lists and edits the custom properties its sheets already have (shadcn keeps them in `:root`), but refuses a new token with `invalid` and says to add it to `theme.extend` in the config, since a variable there makes no class.

Writes take a per-file lock (a mutex inside the server): read the file, compare its rev with the edit's, write atomically. A mismatch refuses with `stale` and "The file changed; try again". Undo is per actor (`history.ts`): each change stores span patches (`{ file, before, after, at }`, whole lines plus a line of context), and undo swaps `after` back to `before` at `at`, or wherever `after` appears exactly once in the file now. So one person's undo works after an agent edited a different part of the same file, and refuses when someone changed that same part since. A new change clears that actor's redo stack.

A prototype canvas only takes edits to files under `.finite/`. An edit to a production file from a prototype is refused with `outside-prototype`, and the page offers `source.detach`, which copies that file into `.finite/boards/<canvasId>/` and points the importer at the copy.

## Agents

`agent/` runs each live thread as one `query()` of the Claude Agent SDK, which drives the `claude` CLI on `PATH` (`pathToClaudeCodeExecutable`) with the design's workspace, or else its root, as its working directory. There's no API key: the person logs in with `claude` once, and `claude.status` reports `claude auth status --json` and the models the CLI offers. The query uses Claude Code's own system prompt with `agent/instructions.ts` appended, streams partial messages (the thread's `text.delta` events), and resumes the thread's last `sessionId` on the next message. A thread idle for 10 minutes closes its query.

Each message is a turn. `thread.send` with mode `steer` pushes the message into the running turn's input (priority `now`); `queue` holds it in `ThreadMeta.queued`, where people can edit or drop it, and sends it when the turn's `result` arrives. A change of model, effort or fast mode between turns goes through `setModel` and `applyFlagSettings`. `agent/events.ts` turns the SDK's messages into `ThreadEvent`s (`user`, `text.delta`, `text`, `tool`, `result`, `error`), which the store appends to the thread's `.jsonl` (all but `text.delta`) and broadcasts.

The **permission fence** (`agent/policy.ts`) keeps agents out of production code. Reading and Bash are allowed anywhere. `Write`, `Edit`, `MultiEdit` and `NotebookEdit` are allowed under `.finite/` and the brand folder, `finite.json` in a setup thread, and anywhere in the project (the whole workspace, for a workspace design) only during a turn that called `move_to_prod`; the grant ends with the turn, and the thread settles when that turn succeeds. The fence runs twice: as `canUseTool`, and as a `PreToolUse` hook, which runs even when the person's own Claude Code settings pre-approve a tool. `AskUserQuestion` is refused, since nobody can answer the dialog. Bash can still change files; the system prompt tells the agent not to.

The **canvas tools** are an in-process MCP server named `finite` (`agent/tools.ts`, input shapes in `packages/protocol/src/tools.ts`):

| Tool                          | What it does                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------- |
| `read_canvas`, `open_canvas`  | Read a canvas; open a page or prototype by name (or make one) and link it to the thread.          |
| `place_frames`                | Put TSX files on a canvas in a row, each with a title and a why label above it.                   |
| `write_text`, `comment`       | A text label on the canvas; a comment pinned to a frame or an element in it.                      |
| `copy_production`             | Copy one production component or route file onto the board, its imports pointing at production.   |
| `move_to_prod`                | Allow production writes for the rest of the turn.                                                 |
| `add_brand_asset`             | Copy a file or URL into the brand folder and list it on the Brand page.                           |
| `spawn_thread`, `name_thread` | Start a child thread; name this one.                                                              |
| `screenshot`, `frame_errors`  | A PNG of a frame, taken in the system Chrome with puppeteer-core; the errors its bridge reported. |
| `finish_setup`                | Check `finite.json` and connect its apps, then start the next design's preview and report it.     |

## The web app

`apps/web` is a Next.js static export (`output: "export"`), styled with StyleX, so there's no Next server: the Node server serves `out/` in the desktop app. A design screen is `/design/?id=<designId>` (with `&tab=prototypes` on the Prototypes tab), since a static export can't prerender a route per design.

- `src/client/finite.ts` is the page's one connection: the `/api/ws` socket, which reconnects by itself and subscribes again to every design on screen; typed requests; and the live state React reads through `useSyncExternalStore` hooks (`useDesigns`, `useDesignState`, `useSettings`).
- `src/canvas/` is the canvas. `Canvas.tsx` places frames and text labels in a pan-and-zoom camera world (`design/camera.ts`). `FrameView.tsx` is one frame's iframe, which never takes the pointer unless Interact is on; at most 12 frames keep a live iframe (`virtualize.ts`), and the rest show a name card. `editor.ts` hit-tests every press through the bridge, previews gestures through it, and sends one `source.edit` or `canvas.patch` on release. `selection.ts` is the selection store the layers, inspector, composer and ✱ menu share.
- `src/components/` holds the screens: `DesignGrid` (the design list and its three ways to start), `DesignScreen`, `LeftSidebar` (the Design | Prototypes switch; pages, layers and tokens; or the prototype list), `ThreadList`, `Composer`, `StarMenu` (the ✱ menu on a selected frame), `ChatPanel`, `Comments`, `Settings` and `inspector/`, fed by the bridge's `inspect`. `src/design/editing/` holds the pure rules that turn a control's value into CSS.
- `src/styles/tokens.stylex.ts` has the theme tokens, and `raised.ts` the raised look of pressable controls.

## The end-to-end test

`vp run e2e` (`e2e/run.mjs`) builds the web app, starts the server on a free port from 4300 with a temp data folder, and drives headless Chrome through a person's core flow: create a blank design, wait for the install and the preview, see the Home frame on the Routes page, select the `h1` inside it, set its opacity in the inspector and check the TSX file changed, undo it, and open the Prototypes tab. With `FINITE_REAL_AGENT=1` it also sends a message from the composer and waits for the local `claude` to answer. `E2E_SKIP_BUILD=1` reuses `apps/web/out`. A failure saves `$TMPDIR/finite-e2e-failure.png`. `e2e/lib.mjs` has the shared pieces, which the `finite-headless` skill's script uses too.

## Words used in the code

- **Design**: one React project Finite knows about, with a `.finite/` folder in its root. Its **origin** is connected, blank or import.
- **Root**: the design's project folder.
- **Canvas**: a page (Routes, Brand, Components, or one a person adds) or a prototype. It holds frames, text labels and comments.
- **Frame**: a rectangle on a canvas that shows a route or one component file, live, in an iframe.
- **Board**: `.finite/boards/<canvasId>/`, where a prototype's component files live.
- **Production**: the project's own code, outside `.finite/` and the brand folder. (The Next.js frame mount is Finite's file, not production.)
- **Loc**: `"src/x.tsx:12:4"`, the position of a JSX opening element, which the plugin stamps on what it renders. **Index** is which rendered instance of a loc, when a `.map()` renders it many times.
- **Rev**: the first 8 hex digits of a file's sha1 when Vite transformed it. An edit carries the revs it saw.
- **Remap**: where each edited loc moved, so the selection follows the element.
- **Convention**: how the design styles things (Tailwind, CSS modules, StyleX or inline), which hand edits follow.
- **Preview**: a design's dev server (Vite or Next.js), and its status (stopped, starting, ready, error, needs-setup).
- **Workspace**: the folder holding `finite.json`, usually the repository root, and the apps and services it lists. A workspace design's `root` is its app's folder inside it.
- **Service**: a long-running process from `finite.json`, like an API or a database, that an app's preview needs. Previews of one workspace share it.
- **Setup design**: a folder Finite couldn't run yet (`setup: true`), with no preview, whose setup thread writes `finite.json` and calls `finish_setup`. The apps it lists replace it, or it becomes the one at its own path.
- **Bridge**: the `MessageChannel` between the page and one frame.
- **Actor**: who made a change, a person or an agent. An agent's id is its thread's id. Undo is per actor.
- **Thread**: one agent conversation, with its metadata and event log. A prototype is a thread plus the canvas it works on.
- **Turn**: one message and the agent's work on it, ending in a `result`. **Steer** folds a message into the running turn; **queue** holds it until the turn ends.
- **Working, Active, Snoozed, Settled**: where a thread sits in the prototype list (`threadSection` in `model.ts`). Working: the agent is running. Snoozed: a person snoozed it. Settled: a person settled it, or its move to prod finished. Active: everything else, the person's turn. Sending a message wakes a snoozed or settled thread.
- **Fence**: the rule that agents write only prototypes and brand assets (and a setup thread `finite.json`), unless the turn called `move_to_prod`.
- **Refusal**: a request the server won't do, with a reason to show and a code to react to.
