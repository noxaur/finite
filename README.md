# Finite

Finite is a design canvas that agents edit. Agents connect over MCP and build designs out of HTML and inline CSS. Several agents can work at once, on the same design or on different ones. People open the app to browse every design in a grid and watch any one of them update live on a pan-and-zoom canvas. In this MVP, people can create empty designs but can't edit them. Every edit to a design's content comes from an agent, and people steer agents by pinning comments to the canvas.

For a guided tour of the internals, read [How Finite works](docs/how-finite-works.md).

The frontend is Next.js (React), styled with StyleX, and talks to the backend through an Effect HTTP client and WebSockets. The backend is a Rust server built on axum. Vite+ (`vp`) runs the JavaScript side, and Cargo builds the Rust side.

## Connect an agent

Start the app with `vp run dev`, then point an MCP client at the server's Streamable HTTP endpoint:

```bash
claude mcp add --transport http finite http://127.0.0.1:4100/mcp
```

The tools follow [Paper's MCP server](https://paper.design/docs/mcp): `get_basic_info` and `get_tree_summary` to orient, `create_artboard` and `write_html` to build, `update_styles` and `set_text_content` to refine, and `get_screenshot` to check the render. Every tool except `list_designs` and `create_design` takes a `designId`, which is how agents pick the canvas they edit. The server's MCP instructions (`crates/server/src/mcp/instructions.md`) explain the workflow to the agent, and `crates/server/src/mcp/mod.rs` defines every tool.

`get_screenshot` renders the artboard with a local headless Chrome, Chromium or Edge. Set `FINITE_CHROME` if yours isn't in a standard location.

## Styles, motion and scripts

Agents can style with inline `style` attributes or with `<style>` blocks and classes, so `@keyframes` animations and `:hover` effects work. Each artboard renders inside a shadow root, which scopes its CSS to that artboard and keeps the app's CSS out.

An artboard that contains a `<script>` renders in a sandboxed iframe instead. The `sandbox="allow-scripts"` attribute gives the iframe an opaque origin, so its code can't reach the app or the app's API. A content security policy also blocks its network requests, while still letting it load remote images, fonts and stylesheets. The iframe reloads after each burst of edits, so a script's state resets when an agent changes the artboard. A small runtime inside the iframe forwards wheel events to the canvas, so you can still pan and zoom over it. The server strips inline `on*` handlers and `<script src>`, so scripts attach listeners with `addEventListener`.

Thumbnails never run scripts. Screenshots run them under the same content policy, capturing the frame about 3 seconds after load.

## Comments

The pill at the bottom of the canvas switches between the pointer tool (`V`) and the comment tool (`C`). In comment mode, you see an outline around the element under the cursor, and a click pins a comment to it. The left button no longer drags the canvas in comment mode; the wheel and the middle button still pan.

A comment stores its artboard, the element you clicked, and the pin's offset from the artboard's corner, so the pin follows the artboard when an agent moves it. This works inside sandboxed (script) artboards too: the canvas asks the iframe which element is under the pointer.

Agents read comments with `get_comments` and answer with `reply_to_comment`, usually with `resolve: true`. `get_basic_info` counts open comments, and the MCP instructions tell agents to check them. When an agent replies, the server links that agent's changes to the comment's artboard since the thread's previous message. The thread shows them as buttons, and clicking one outlines the elements it changed. A reply from you reopens a resolved comment, so you can keep steering in the same thread. An agent can also call `wait_for_comments`, which returns as soon as a comment or reply is waiting for it, so you can leave feedback for an agent that's already running.

Comments aren't part of the document, so undo never touches them. They're saved with the design's snapshot. People have no accounts yet: each browser keeps a random id in local storage and posts over `POST /api/designs/{id}/comments`. It posts as "Guest" until you click the name in a new comment's box and set your own, which is saved in the same browser.

## Undo and redo

Each agent can undo only its own changes. This follows Liveblocks' [multiplayer undo/redo design](https://liveblocks.io/blog/how-to-build-undo-redo-in-a-multiplayer-environment), which is the command pattern: applying an op returns its inverse, captured from the document at that moment, and undo applies that inverse as a new change. Undo never restores a snapshot, so it can't wipe out another agent's work.

Conflicts resolve per property, last writer wins. Two things are easy to miss:

- If another agent deleted the nodes an undo step touches, that step is skipped, and undo moves on to the next one that still applies.
- Undo then redo returns the document to where it was. If you delete an artboard that holds another agent's nodes, redo brings those nodes back too, because the inverse captured the whole subtree.

The history belongs to an actor, per design. Today an actor is an MCP session, or the value of an `X-Finite-Agent` header if the client sends one. A user's browser tab will be another kind of actor when users can edit. `History` also supports batching (Liveblocks calls it pausing), so a drag can undo in one step.

## How a change flows

1. An MCP tool call, like `update_styles`, runs an edit command from `crates/design/src/edit.rs`. The command validates the request and turns it into ops: `create`, `delete`, `set` (one property) or `move`.
2. `Design::commit` applies the ops to the server's document, pushes the inverse onto the actor's undo stack, and assigns the change a sequence number. Each design has its own lock, so edits to one design are applied in a single order, and edits to different designs never wait on each other.
3. The hub broadcasts the change to every viewer's WebSocket and saves the design to disk a moment later.
4. In the browser, `Replica` applies the same ops with the same rules, and `Renderer` patches only the DOM nodes they touched.

Sibling order uses fractional indexes, so inserting or moving a node rewrites only that node. That keeps concurrent edits from conflicting and is what multiplayer editing will build on.

## Layout

| Path                  | What it is                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/web`            | Next.js + StyleX + Effect frontend, built as a static export into `out/`                                |
| `apps/web/src/design` | The canvas client: schemas, `Replica` (document copy), `Renderer` (DOM), `Camera` (pan/zoom)            |
| `apps/desktop`        | Electron main and preload processes, bundled with `vp pack`                                             |
| `crates/design`       | The document model with no I/O: nodes, ops and inverses, history, edit commands, HTML import/export     |
| `crates/server`       | Rust server (axum). Serves `/api/*`, the MCP endpoint at `/mcp`, and the built frontend in release mode |
| `Cargo.toml`          | Cargo workspace for everything in `crates/`                                                             |

`crates/server/package.json` and `crates/design/package.json` wrap the Cargo commands, so `vp run` can start, test and build the Rust crates along with the JS packages.

## Commands

```bash
vp install              # install deps (also downloads the Electron binary)
vp run dev              # web on http://localhost:5310, Rust API on :4100
vp run dev:desktop      # same, plus an Electron window pointed at the dev server
vp run start:desktop    # release build of everything, then Electron with the Rust sidecar
vp run test             # cargo test for both crates, plus the web app's Vitest suite
vp run e2e              # build, start a server, and drive the app in headless Chrome
vp run ready            # format, lint and type check (web and Rust, clippy too), test, build
```

Each commit runs `vp staged` from the pre-commit hook (`.vite-hooks/pre-commit`). It runs `vp check --fix` on the staged files and `rustfmt` on staged Rust files, as set in the `staged` block of `vite.config.ts`.

## How the pieces connect

The frontend calls the API with relative `/api/...` URLs, so it needs both on the same origin:

- **Web dev:** `next dev` rewrites `/api/*` to the Rust server on `127.0.0.1:4100`. Set `FINITE_API_URL` to point elsewhere.
- **Desktop dev:** Electron loads the Next.js dev server, so it uses the same rewrite.
- **Desktop release:** Electron starts `finite-server` as a sidecar process on port 4100 (or a free port if that's taken), with `FINITE_STATIC_DIR` pointing at `apps/web/out`. The window loads that server. Electron starts it once: on macOS the app stays open with no windows, and a new window reuses the running server, because a second one would find the data folder locked. When the app quits, Electron sends the server SIGTERM and waits up to 5 seconds for it to save and exit.
- **Web deploy:** run `finite-server` with `FINITE_STATIC_DIR` and `FINITE_PORT`. To split designs across several servers, also set `FINITE_NODES` and `FINITE_NODE` on each, and put `finite-server router` in front (see the guide's "Running more than one server"). If agents or the router reach a server by a hostname other than localhost, add it to `FINITE_ALLOWED_HOSTS`. To run several routers, give them a shared `FINITE_SESSION_DIR` so any of them can serve any agent's MCP session.

The API client is `apps/web/src/api/Api.ts`, an Effect `Context.Service` whose responses are decoded with `Schema`. Live updates arrive over two WebSockets: `/api/designs/ws` streams the design list, and `/api/designs/{id}/ws` streams one design (a snapshot, then every change and presence update). After a dropped connection, the browser resumes with `?epoch=…&since=…` and gets only the changes it missed. `apps/web/src/design/schema.ts` defines the schemas for both. Keep them in sync with the Rust types in `crates/design` and `crates/server/src/hub/messages.rs`.

The server saves each design in `FINITE_DATA_DIR/designs/` (default `./data`, so `crates/server/data` in dev) as a snapshot (`<id>.json`) plus an append-only journal of later edits (`<id>.log`). The guide explains how the journal is compacted and recovered after a crash. The desktop app sets it to Electron's user data folder. Storage goes through the `Store` trait in `crates/server/src/store.rs`, so a database can replace the files without touching anything else. StyleX design tokens are in `apps/web/src/styles/tokens.stylex.ts`.

`next build` produces a static export (`output: "export"` in `apps/web/next.config.ts`), so there's no Node server to ship. That rules out Next features that need a server at request time: route handlers, server actions, middleware, and dynamic routes without `generateStaticParams`. The Rust server handles everything dynamic. Components that use Effect or `window` need `"use client"`.

StyleX compiles through Babel (`apps/web/babel.config.js`) and the StyleX PostCSS plugin (`apps/web/postcss.config.js`). The PostCSS plugin replaces the `@stylex;` line in `src/app/globals.css` with the collected rules. This setup follows StyleX's official Next.js example.

The preload script exposes `window.finite` (platform and versions) to the renderer. Its type lives in `apps/web/src/global.d.ts`. Update both files together.

## Gotchas

- If the server exits with `another Finite server is using …`, a second server is pointed at the same data folder. Stop the other one, or give this one its own `FINITE_DATA_DIR`.
- If Electron crashes with `Cannot read properties of undefined (reading 'whenReady')`, your shell has `ELECTRON_RUN_AS_NODE=1` set. Electron-based terminals and editors often export it. Run `unset ELECTRON_RUN_AS_NODE` first.
- Packaging into a `.app`/`.exe` isn't set up yet. When you add electron-builder or Forge, copy `target/release/finite-server` and `apps/web/out` (as `web/`) into the app's resources directory. `apps/desktop/src/main.ts` looks for them there.
