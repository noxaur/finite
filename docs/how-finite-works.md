# How Finite works

Finite is a design canvas where every design is a real React and TypeScript project. A frame on the canvas is a live iframe of that project's Vite dev server. A person selects an element in a frame and changes it in the inspector, and Finite rewrites the TSX that made it. An agent works in a thread, which runs the person's local Claude Code CLI on the same project with a set of canvas tools.

Two ideas carry the rest of this guide:

- **Files are the truth.** The project's source, plus a `.finite/` folder of JSON in its root, hold everything: canvases, comments and threads. The server keeps a copy in memory and writes every change straight back. So git, an editor and an agent's `Edit` tool all see the same state the canvas shows.
- **Every rendered element knows where it came from.** A Vite plugin stamps each JSX element with its file, line and column, and a hash of the file. A hand edit names those, and the server refuses it when the file has changed since (optimistic concurrency).

## The big picture

```
browser tab / Electron window (Next.js static app, apps/web)
   │  one WebSocket per tab: /api/ws (JSON, packages/protocol)
   ▼
apps/server (Node 22, node:http + ws)
   ├─ store/    designs.json, settings.json, each design's .finite/
   ├─ preview/  one Vite child per open design, with @finite/vite-plugin
   ├─ source/   hand edits → TSX, tokens, per-actor undo
   └─ agent/    one Claude Agent SDK query per live thread
                     │ spawns
                     ▼
               the local `claude` CLI, cwd = the design's root

iframes ──────────▶ each design's own Vite dev server (another port, same host)
```

The page talks to the server over one socket. It loads frames from the design's dev server directly, so Vite's hot module replacement (HMR) updates every viewer's iframes when a file changes, whoever changed it.

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
  designs.json        [{ id, name, root, origin }]   origin: connected | blank | import
  settings.json       default model, effort, speed, steer-or-queue, Show Working separately
  projects/<id>/      blank and imported designs: a copy of apps/server/scaffold
<root>/.finite/       meant to be committed with the project
  design.json         { version: 1, id, router, styling, css[], wrapper?, brandDir }
  canvases/<id>.json  one canvas: frames, text labels, comments
  boards/<canvasId>/  the prototype components agents write, one default export per file
  threads/<id>.json   thread metadata (ThreadMeta)
  threads/<id>.jsonl  the thread's event log, one ThreadEvent per line
  attachments/        files people attached to messages
  Wrapper.tsx         optional providers every file frame renders inside
<root>/<brandDir>     brand assets (default src/assets/brand)
```

`store/` is the only writer of these files. It writes through a temp file and a rename (an atomic write), so a reader never sees half a file, and it serializes writes per design. It also watches `.finite/` and reads back changes made outside the server, such as an agent editing a canvas file, after 100 ms of quiet.

A **connected** design is a reference to a folder that already exists. `design.connect` runs `store/detect.ts`: the folder needs a `package.json`, Vite and React Router or TanStack Router, or it's refused with code `unsupported-project` and a reason. Detection also picks the styling convention (Tailwind, CSS modules or inline styles) and the global stylesheets (`.css`, `.scss` or `.less`) the entry imports. Removing a connected design forgets it and leaves the folder alone. A **blank** design copies `apps/server/scaffold` (Vite 8, React 19, TypeScript, Tailwind v4, React Router) into `projects/<id>/` and installs its dependencies with `pnpm install --ignore-workspace`, or npm when pnpm isn't on `PATH`. Until the install ends, the design's preview reports `starting` with the install's output. An **import** is a blank design plus a thread that rebuilds the source (a Figma link, a URL or attachments) in TSX.

Every new design starts with three pages: **Routes**, with one frame per route the dev server reports, laid out in a grid of four columns and kept in step with the routes (`store/routes.ts`); **Brand**, for logos, images and fonts; and **Components**. A removed canvas keeps `removedAt` for 30 days, so it can be restored, and is deleted the next time the design opens after that.

## The wire protocol

`packages/protocol/src/wire.ts` is the contract. Each tab opens one WebSocket on `/api/ws` and sends JSON requests with a `rid`. The server answers each with `{ type: "reply", rid, ok: true, value }` or `{ ok: false, reason, code? }`. `reason` is written for a person or an agent to act on, and `code` (from `RefusalCode`: `stale`, `outside-prototype`, `unsupported-style`, `not-logged-in` and others) is what the UI reacts to. Zod parses every message, so a bad one is refused with the path of the bad field, like `canvas.patch: patch.frames.0.x: expected number`.

The first message is `hello { user }`. `subscribe { designId }` returns the design's whole state (`DesignState`: the design, its canvases, threads, preview state and routes), and from then on the server pushes events: `canvas` (the whole canvas after any change), `thread`, `thread.event`, `preview` and `routes`. `designs` and `settings` go to every socket. The requests fall into groups:

- Designs: `designs.list`, `design.create`, `design.connect`, `design.remove`.
- Canvases: `canvas.create`, `rename`, `remove`, `restore` and `patch`. A `CanvasPatch` moves, resizes, adds, removes, renames or moves frames to another canvas, or sets and removes a text label.
- Source: `source.edit`, `source.undo`, `source.redo`, `source.detach`, `tokens.get`, `tokens.set`, `components.list`.
- Comments: `comment.add`, `reply`, `resolve`, `reopen`.
- Threads: `thread.send`, `thread.queued` (edit or drop a queued message), `interrupt`, `snooze`, `settle`, `rename`, `history`.
- Settings and Claude: `settings.get`, `settings.set`, `claude.status`.
- `frame.error`: a frame's runtime error, which the page forwards for the agent's `frame_errors` tool.

Two things don't fit a JSON socket and are plain HTTP (`http.ts`): `POST /api/designs/:id/attachments` (multipart, up to 25 MB) stores a file in `.finite/attachments/` and returns its path for `thread.send`, and `GET /api/designs/:id/export?canvasId=&frameIds=` returns a zip of the frames' TSX files and the `.finite/` files they import. `GET /api/health` answers `{ ok: true }`.

`hub.ts` holds the sockets. It opens each design once and forwards the open design's changes, and its preview's, to the sockets subscribed to it. `handlers.ts` has one thin function per request type that calls into the modules; `packages/protocol/src/server.ts` declares those modules' interfaces (`Store`, `OpenDesign`, `Previews`, `SourceEditor`, `Agents`).

## Previews, the plugin and the bridge

`preview/` runs one Vite dev server per open design, each in a child process (`preview/vite-host.mjs`). The child loads the project's own Vite through `createRequire(root)`, with the project's own config, and passes `@finite/vite-plugin` as an inline plugin. Vite merges inline config over the project's, so the project's files stay untouched. The child reports its URL over IPC, and `changed` when source files change. When nobody views a design for 60 seconds, its dev server stops. A crash shows as preview `error` with the tail of its log.

`@finite/vite-plugin` (`packages/vite-plugin/src/`) does four things:

- **Stamps** every intrinsic (lowercase) JSX element in `.tsx` and `.jsx` files outside `node_modules` with `data-finite-loc="src/x.tsx:12:4"` and `data-finite-rev="<first 8 hex digits of the file's sha1>"` (`stamp.ts`). It parses with `@babel/parser` and inserts with `magic-string`, so the source map still lines up. Components and fragments aren't stamped, so an element inside `<Button>` carries `Button.tsx`'s loc: editing it edits the component everywhere it's used.
- **Injects the bridge** into every page: through `transformIndexHtml` for a single-page app, and by rewriting the HTML response for React Router's framework mode, which renders HTML on the server (`html.ts`).
- **Serves frames and routes.** `GET /__finite/frame?file=&export=` renders one component on its own page: the design's stylesheets, then the component inside `.finite/Wrapper.tsx` when there is one and a memory router, so a `<Link>` in a copied production component works. `GET /__finite/routes` lists the app's routes (`routes.ts`): TanStack Router's `FileRoutesByFullPath` from `routeTree.gen.ts`; React Router's framework-mode `app/routes.ts`, loaded through Vite; or, for React Router's data and declarative modes, a Babel scan of `createBrowserRouter([...])` and `<Route path>`.
- **Lets Tailwind see `.finite/`.** In dev it appends `@source "<path to .finite>";` to the stylesheet that imports Tailwind, so classes used only in prototypes get generated (`tailwind.ts`).

A frame's source is a route (`{ kind: "route", path, params? }`, loaded at that path) or a file (`{ kind: "file", file, exportName? }`, loaded through `/__finite/frame`). `Previews.frameUrl` turns either into the iframe's URL.

The **bridge** connects the page to each iframe over a `MessageChannel` (`packages/protocol/src/bridge.ts`; the iframe half is `packages/vite-plugin/src/client/bridge.ts`, the page half `apps/web/src/canvas/bridge.ts`). The iframe posts `finite:hello` to its parent, and the parent answers with `finite:connect` and the port. The bridge takes the port, and the dev server answers cross-origin requests, only from an origin whose host is a loopback name or one in `FINITE_ALLOWED_HOSTS` (a bare name allows any port, so `next dev` on 5310 connects too), the same rule the guard applies. The parent then asks `hit(x, y)` (the stamped element under a point, which instance of its loc it is, and its stamped ancestors), `rects(locs)`, `inspect(loc, index)` (computed styles and class names for the inspector) and `layers()` (the stamped tree for the Layers panel), and sends `preview(loc, styles)` to show a style while a gesture runs. The iframe sends `size` (for frames whose height hugs their content), `updated` after HMR, `key` (so canvas shortcuts work with focus inside a frame) and `error` (runtime errors, rejections and `console.error`).

## Hand edits: the source editor

`source/` turns a hand edit into a change to the TSX. A `SourceEdit` is `style`, `text`, `reorder`, `remove`, `duplicate` or `attr`, and names the locs it touches plus the rev of each file. `rewrite.ts` parses the file with Babel, finds the opening element at each loc, checks its tag, and splices the change in with `magic-string`, so the file's formatting survives. It returns a remap of old locs to new ones, so the selection follows the element.

A style edit follows the design's convention:

- **Tailwind** (`tailwind.ts`): a CSS property becomes a class. A value that equals a theme variable exactly becomes its name (`bg-ink`, `rounded-card`), and anything else an arbitrary value (`w-[312px]`). `tailwind-merge`, taught the project's theme names, drops the classes the new one replaces. It edits a literal `className`, or a literal argument of `cn`, `clsx` or `twMerge`.
- **CSS modules**: `className={styles.card}` means editing the top-level `.card` rule in the imported `*.module.css`, `*.module.scss` or `*.module.less` with PostCSS, and adding the rule when the class appears nowhere in the sheet (`css.ts`). The file extension picks the dialect, so one design can mix them. `postcss-scss` and `postcss-less` parse and print the sheet, which keeps `//` comments and mixins and changes only the edited declaration. Values are written raw, so a `$var` or `@var` in that declaration becomes the literal value. Finite refuses with `unsupported-style` when the class appears only nested or in a compound selector (`.list .card`, `&__title`, `.card.on`), since a new top-level rule wouldn't win. It refuses indented `*.module.sass` too, which has no round-trip parser.
- **Inline**: a `style={{ … }}` prop, used only when the element has no `className` at all.

Anything else, like a computed class expression or styled-components, is refused with `unsupported-style` and "Ask the agent to change this", rather than an inline style that would override responsive classes. Tokens are the CSS custom properties in the design's global stylesheets (`.css`, `.scss` or `.less`): light ones in `@theme` (or `:root`), dark ones in `.dark`. `tokens.ts` reads and writes them with PostCSS. A new light token goes in `@theme` for Tailwind, and otherwise in the first `:root` rule, added after any `@use`, `@forward` and `@import`. Sass `$vars` and Less `@vars` aren't tokens.

Writes take a per-file lock (a mutex inside the server): read the file, compare its rev with the edit's, write atomically. A mismatch refuses with `stale` and "The file changed; try again". Undo is per actor (`history.ts`): each change stores span patches (`{ file, before, after, at }`, whole lines plus a line of context), and undo swaps `after` back to `before` at `at`, or wherever `after` appears exactly once in the file now. So one person's undo works after an agent edited a different part of the same file, and refuses when someone changed that same part since. A new change clears that actor's redo stack.

A prototype canvas only takes edits to files under `.finite/`. An edit to a production file from a prototype is refused with `outside-prototype`, and the page offers `source.detach`, which copies that file into `.finite/boards/<canvasId>/` and points the importer at the copy.

## Agents

`agent/` runs each live thread as one `query()` of the Claude Agent SDK, which drives the `claude` CLI on `PATH` (`pathToClaudeCodeExecutable`) with the design's root as its working directory. There's no API key: the person logs in with `claude` once, and `claude.status` reports `claude auth status --json` and the models the CLI offers. The query uses Claude Code's own system prompt with `agent/instructions.ts` appended, streams partial messages (the thread's `text.delta` events), and resumes the thread's last `sessionId` on the next message. A thread idle for 10 minutes closes its query.

Each message is a turn. `thread.send` with mode `steer` pushes the message into the running turn's input (priority `now`); `queue` holds it in `ThreadMeta.queued`, where people can edit or drop it, and sends it when the turn's `result` arrives. A change of model, effort or fast mode between turns goes through `setModel` and `applyFlagSettings`. `agent/events.ts` turns the SDK's messages into `ThreadEvent`s (`user`, `text.delta`, `text`, `tool`, `result`, `error`), which the store appends to the thread's `.jsonl` (all but `text.delta`) and broadcasts.

The **permission fence** (`agent/policy.ts`) keeps agents out of production code. Reading and Bash are allowed anywhere. `Write`, `Edit`, `MultiEdit` and `NotebookEdit` are allowed under `.finite/` and the brand folder, and anywhere in the project only during a turn that called `move_to_prod`; the grant ends with the turn, and the thread settles when that turn succeeds. The fence runs twice: as `canUseTool`, and as a `PreToolUse` hook, which runs even when the person's own Claude Code settings pre-approve a tool. `AskUserQuestion` is refused, since nobody can answer the dialog. Bash can still change files; the system prompt tells the agent not to.

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
- **Production**: the project's own code, outside `.finite/` and the brand folder.
- **Loc**: `"src/x.tsx:12:4"`, the position of a JSX opening element, which the plugin stamps on what it renders. **Index** is which rendered instance of a loc, when a `.map()` renders it many times.
- **Rev**: the first 8 hex digits of a file's sha1 when Vite transformed it. An edit carries the revs it saw.
- **Remap**: where each edited loc moved, so the selection follows the element.
- **Convention**: how the design styles things (Tailwind, CSS modules or inline), which hand edits follow.
- **Preview**: a design's Vite dev server, and its status (stopped, starting, ready, error).
- **Bridge**: the `MessageChannel` between the page and one frame.
- **Actor**: who made a change, a person or an agent. An agent's id is its thread's id. Undo is per actor.
- **Thread**: one agent conversation, with its metadata and event log. A prototype is a thread plus the canvas it works on.
- **Turn**: one message and the agent's work on it, ending in a `result`. **Steer** folds a message into the running turn; **queue** holds it until the turn ends.
- **Working, Active, Snoozed, Settled**: where a thread sits in the prototype list (`threadSection` in `model.ts`). Working: the agent is running. Snoozed: a person snoozed it. Settled: a person settled it, or its move to prod finished. Active: everything else, the person's turn. Sending a message wakes a snoozed or settled thread.
- **Fence**: the rule that agents write only prototypes and brand assets, unless the turn called `move_to_prod`.
- **Refusal**: a request the server won't do, with a reason to show and a code to react to.
