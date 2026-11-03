# Finite

Finite is a design canvas that agents edit. Agents connect over MCP and build designs out of HTML and inline CSS. Several agents can work at once, on the same design or on different ones. People open the app to browse every design in a grid and watch any one of them update live on a pan-and-zoom canvas. In this MVP, people can create empty designs but can't edit them. Every edit to a design's content comes from an agent, and people steer agents by pinning comments to the canvas.

For a guided tour of the internals, read [How Finite works](docs/how-finite-works.md).

The frontend is Next.js (React), styled with StyleX, and talks to the backend through an Effect HTTP client and WebSockets. The backend is a Rust server built on axum. The document rules are Rust too, and the browser runs them compiled to WebAssembly. Vite+ (`vp`) runs the JavaScript side, and Cargo builds the Rust side.

## Setup

You need Node 22.18 or later, Vite+ (`vp`) and a Rust toolchain from [rustup](https://rustup.rs). The browser runs the Rust rules as WebAssembly, so add that target once:

```bash
rustup target add wasm32-unknown-unknown
vp install
```

`vp run ready`, `vp test` and `vp run dev` build `crates/wasm/dist/finite.wasm` when they need it. To build it yourself, run `vp run wasm#build`.

In [T3 Code](https://t3.codes), `t3.json` starts each new thread in its own worktree and runs `vp install` there. Its scripts menu has Dev and Ready. When a thread settles, `cargo clean` deletes that worktree's `target/`, so the next `cargo` command rebuilds from scratch.

## Connect an agent

Start the app with `vp run dev`, then point an MCP client at the server's Streamable HTTP endpoint:

```bash
claude mcp add --transport http finite http://127.0.0.1:4100/mcp
```

The tools follow [Paper's MCP server](https://paper.design/docs/mcp): `get_basic_info` and `get_tree_summary` to orient, `create_artboard` and `write_html` to build, `update_styles` and `set_text_content` to refine, and `get_screenshot` to check the render. `delete_design` permanently removes a canvas, including its comments and undo history. Every tool except `list_designs` and `create_design` takes a `designId`, which is how agents pick the canvas they edit. The server's MCP instructions (`crates/server/src/mcp/instructions.md`) explain the workflow to the agent, and `crates/server/src/mcp/mod.rs` defines every tool.

`get_screenshot` renders artboards with a local headless Chrome, Chromium or Edge, and reports anything cut off by the artboard's edge. Set `FINITE_CHROME` if yours isn't in a standard location.

`get_jsx` returns a node as JSX for a React codebase, with style objects or, with `tailwind`, Tailwind classes. `find_nodes` and `replace_values` search a design and change a value, like a brand color, everywhere at once. `set_shared_css` and `get_shared_css` hold CSS that every artboard in a design uses. `create_page`, `rename_page`, `delete_page` and `move_to_page` split a design into pages, which people switch between in the sidebar on the canvas, and `get_layout` says where everything rendered without a screenshot. `FINITE_MCP_EXTRA` turns on experimental tool groups, as a comma-separated list, while AX runs decide whether they ship. `e2e/ax` runs real agents against the tools to measure whether a change helps (see `e2e/ax/README.md`).

## Styles, motion and scripts

Agents can style with inline `style` attributes or with `<style>` blocks and classes, so `@keyframes` animations and `:hover` effects work. Each artboard renders inside a shadow root, which scopes its CSS to that artboard and keeps the app's CSS out. CSS that every artboard needs, like a `--brand` variable or a `.btn` class, goes in the design's shared CSS instead. Artboards render with it before their own styles, so those still override it. People can read and edit it with the Shared CSS button on the canvas.

An artboard that contains a `<script>` renders in a sandboxed iframe instead. The `sandbox="allow-scripts"` attribute gives the iframe an opaque origin, so its code can't reach the app or the app's API. A content security policy also blocks its network requests, while still letting it load remote images, fonts and stylesheets. The iframe reloads after each burst of edits, so a script's state resets when an agent changes the artboard. A small runtime inside the iframe forwards wheel events to the canvas, so you can still pan and zoom over it. The server strips inline `on*` handlers and `<script src>`, so scripts attach listeners with `addEventListener`.

Thumbnails never run scripts. Screenshots run them under the same content policy, capturing the frame about 3 seconds after load.

## Comments

The pill at the bottom of the canvas switches between the pointer tool (`V`) and the comment tool (`C`). In comment mode, you see an outline around the element under the cursor, and a click pins a comment to it. The left button no longer drags the canvas in comment mode; the wheel and the middle button still pan.

A comment stores its artboard, the element you clicked, and the pin's offset from the artboard's corner, so the pin follows the artboard when an agent moves it. This works inside sandboxed (script) artboards too: the canvas asks the iframe which element is under the pointer.

Agents read comments with `get_comments` and answer with `reply_to_comment`, usually with `resolve: true`. `get_basic_info` counts open comments, and the MCP instructions tell agents to check them. When an agent replies, the server links that agent's changes to the comment's artboard since the thread's previous message. The thread shows them as buttons, and clicking one outlines the elements it changed. A reply from you reopens a resolved comment, so you can keep steering in the same thread. An agent can also call `wait_for_comments`, which returns as soon as a comment or reply is waiting for it, so you can leave feedback for an agent that's already running.

A resolved pin fades out and leaves the canvas a minute later. The **Comments** button in the top bar opens a side panel with every comment, open and resolved, and picking one opens its thread on the canvas. In a thread you can delete the comment, or edit your own message while it's still the newest one, before an agent has answered.

Comments aren't part of the document, so undo never touches them. They're saved with the design's snapshot. People have no accounts yet: each browser keeps a random id in local storage and posts over `POST /api/designs/{id}/comments`. It posts as "Guest" until you click the name in a new comment's box and set your own, which is saved in the same browser.

## Undo and redo

Each agent can undo only its own changes. This follows Liveblocks' [multiplayer undo/redo design](https://liveblocks.io/blog/how-to-build-undo-redo-in-a-multiplayer-environment), which is the command pattern: applying an op returns its inverse, captured from the document at that moment, and undo applies that inverse as a new change. Undo never restores a snapshot, so it can't wipe out another agent's work.

Conflicts resolve per property, last writer wins. Two things are easy to miss:

- If another agent deleted the nodes an undo step touches, that step is skipped, and undo moves on to the next one that still applies.
- Undo then redo returns the document to where it was. If you delete an artboard that holds another agent's nodes, redo brings those nodes back too, because the inverse captured the whole subtree.

The history belongs to an actor, per design. Today an actor is an MCP session, or the value of an `X-Finite-Agent` header if the client sends one. Send the header if you can: a named agent's undo survives restarts and lasts six idle hours, while a session's undo ends with the session, after an hour without a call. Each stack keeps up to 200 steps and about 32 MB of ops. A user's browser tab will be another kind of actor when users can edit. `History` also supports batching (Liveblocks calls it pausing), so a drag can undo in one step.

## How a change flows

1. An MCP tool call, like `update_styles`, runs an edit command from `crates/design/src/edit.rs`. The command validates the request and turns it into ops: `create`, `delete`, `set` (one property) or `move`.
2. `Design::commit` applies the ops to the server's document, pushes the inverse onto the actor's undo stack, and assigns the change a sequence number. Each design has its own lock, so edits to one design are applied in a single order, and edits to different designs never wait on each other.
3. The hub broadcasts the change to every viewer's WebSocket and saves the design to disk a moment later.
4. In the browser, `Replica` applies the same ops with the same Rust code, built as WebAssembly. `Renderer` patches only the DOM nodes they touched.

Sibling order uses fractional indexes, so inserting or moving a node rewrites only that node. That keeps concurrent edits from conflicting and is what multiplayer editing will build on.

## Layout

| Path                  | What it is                                                                                              |
| --------------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/web`            | Next.js + StyleX + Effect frontend, built as a static export into `out/`                                |
| `apps/web/src/design` | The canvas client: schemas, `Replica` (document copy), `Renderer` (DOM), `Camera` (pan/zoom)            |
| `apps/desktop`        | Electron main and preload processes, bundled with `vp pack`                                             |
| `crates/design`       | The document model with no I/O: nodes, ops and inverses, history, edit commands, HTML import/export     |
| `crates/wasm`         | The same model built as WebAssembly (`dist/finite.wasm`), which the web app loads                       |
| `crates/server`       | Rust server (axum). Serves `/api/*`, the MCP endpoint at `/mcp`, and the built frontend in release mode |
| `Cargo.toml`          | Cargo workspace for everything in `crates/`                                                             |

`crates/server/package.json`, `crates/design/package.json` and `crates/wasm/package.json` wrap the Cargo commands, so `vp run` can start, test and build the Rust crates along with the JS packages. The web app lists `wasm` as a dependency, so `vp run -r build` builds `finite.wasm` before the web app.

## Commands

```bash
vp install              # install deps (also downloads the Electron binary)
vp run dev              # web on http://localhost:5310, Rust API on :4100
vp run dev:desktop      # same, plus an Electron window pointed at the dev server
vp run start:desktop    # release build of everything, then Electron with the Rust sidecar
vp run package:desktop  # package the desktop app for this machine into apps/desktop/release
vp run test             # cargo test for both crates, plus the web app's Vitest suite
vp run e2e              # build, start a server, and drive the app in headless Chrome
vp run e2e:router       # the same checks through a router in front of two servers
vp run e2e:shared       # the same, with both servers on one Postgres
vp run bench            # time a 90,000-node design, a big write and thumbnails in headless Chrome
vp run ready            # format, lint and type check (web and Rust, clippy too), test, build
```

Both dev commands start with `scripts/dev-cleanup.mjs`. It stops a Finite dev server an earlier run left holding port 4100 or 5310, and with `cargo install cargo-sweep` it deletes build files in `target/` that nothing has used since the previous run started.

To try a change by hand, or let an agent try it, `node e2e/headless.mjs start` builds and starts Finite with an empty data folder and opens it in headless Chrome. Each later command does one thing to that running app: `call write_html '{…}'` calls an MCP tool, `click`, `type` and `key` drive the page, `snapshot` prints its accessibility tree, and `screenshot` saves a PNG. `node e2e/headless.mjs help` lists them all, and `.claude/skills/finite-headless/SKILL.md` shows agents how to use it. To script the same session from Python, import `Finite` from `e2e/finite_headless.py`.

`.github/workflows/ci.yml` runs `vp run ready`, then `vp run e2e` and `vp run e2e:router`, on pushes to `main` and on pull requests. A second job turns on the `postgres` feature, which every other build leaves off. It runs clippy and the tests that way, with a Postgres to talk to. Then it runs `vp run e2e:shared`.

If you don't set `FINITE_TEST_DATABASE_URL`, the database tests and `e2e:shared` skip on your machine. You'll find a quick way to run a Postgres for them in the guide.

CI hasn't run yet, because the repo has no GitHub remote. If the e2e step fails, the workflow uploads the failure screenshot.

Each commit runs `vp staged` from the pre-commit hook (`.vite-hooks/pre-commit`). It runs `vp check --fix` on the staged files and `rustfmt` on staged Rust files, as set in the `staged` block of `vite.config.ts`.

## How the pieces connect

The frontend calls the API with relative `/api/...` URLs, so it needs both on the same origin:

- **Web dev:** `next dev` rewrites `/api/*` to the Rust server on `127.0.0.1:4100`. Set `FINITE_API_URL` to point elsewhere.
- **Desktop dev:** Electron loads the Next.js dev server, so it uses the same rewrite.
- **Desktop release:** Electron starts `finite-server` as a sidecar process on port 4100 (or a free port if that's taken), with `FINITE_STATIC_DIR` pointing at `apps/web/out`. The window loads that server. Electron starts it once: on macOS the app stays open with no windows, and a new window reuses the running server, because a second one would find the data folder locked. When the app quits, Electron sends the server SIGTERM and waits up to 5 seconds for it to save and exit. If the server stops on its own, say the system killed it, Electron starts it again on the same port, and open pages reconnect and resume. After three stops within a minute, it shows an error and quits (`apps/desktop/src/restarts.ts`).
- **Web deploy:** run `finite-server` with `FINITE_STATIC_DIR` and `FINITE_PORT`. To run several servers that fail over to each other, build with `--features postgres`. Then give them all the same Postgres database in `FINITE_DATABASE_URL`, give each its own `FINITE_NODE_URL`, and put `finite-server router` in front, with the same `FINITE_DATABASE_URL`. Servers then find each other by heartbeat, and a dead server's designs move to the others in about one lease (`FINITE_LEASE_MS`, 10 seconds by default). Servers that keep their own data folders work too, with a fixed `FINITE_NODES` and `FINITE_NODE` on each (see the guide's "Running more than one server"). If agents or the router reach a server by a hostname other than localhost, add it to `FINITE_ALLOWED_HOSTS`. To run several routers, give them a shared `FINITE_SESSION_DIR` so any of them can serve any agent's MCP session.

If you use a managed Postgres, like RDS, add `sslmode=verify-full` to the URL, and its CA file in `sslrootcert`. The guide's "Connecting with TLS" lists each mode.

The API client is `apps/web/src/api/Api.ts`, an Effect `Context.Service` whose responses are decoded with `Schema`. Live updates arrive over two WebSockets: `/api/designs/ws` streams the design list, and `/api/designs/{id}/ws` streams one design (a snapshot, then every change and presence update). After a dropped connection, the browser resumes with `?epoch=…&since=…` and gets only the changes it missed. `apps/web/src/design/schema.ts` defines the schemas for both. Keep them in sync with the Rust types in `crates/design` and `crates/server/src/hub/messages.rs`.

The server saves each design in `FINITE_DATA_DIR/designs/` (default `./data`, so `crates/server/data` in dev) as a snapshot (`<id>.json`) plus an append-only journal of later edits (`<id>.log`). `vp run dev` first copies each snapshot in `crates/server/seed/designs/` into the dev data folder unless that design is already there, so a fresh checkout opens with the Finite app screens. The guide explains how the journal is compacted and recovered after a crash. The desktop app sets it to Electron's user data folder. Storage goes through the `Store` trait in `crates/server/src/store.rs`. With `FINITE_DATABASE_URL`, the same snapshot and journal live in Postgres instead (`crates/server/src/postgres/mod.rs`), and every write carries a fencing token, so a server that lost a design can't overwrite it. StyleX design tokens are in `apps/web/src/styles/tokens.stylex.ts`.

`next build` produces a static export (`output: "export"` in `apps/web/next.config.ts`), so there's no Node server to ship. That rules out Next features that need a server at request time: route handlers, server actions, middleware, and dynamic routes without `generateStaticParams`. The Rust server handles everything dynamic. Components that use Effect or `window` need `"use client"`.

StyleX compiles through Babel (`apps/web/babel.config.js`) and the StyleX PostCSS plugin (`apps/web/postcss.config.js`). The PostCSS plugin replaces the `@stylex;` line in `src/app/globals.css` with the collected rules. This setup follows StyleX's official Next.js example.

## Releases and updates

The desktop app updates itself, with no prompts. electron-updater looks for a new version at launch, every four hours and when the computer wakes. It downloads the new version in the background and installs it the next time the app quits. It never restarts the app on its own, because agents would lose their MCP sessions. On Windows and Linux, closing the last window quits. On a Mac it doesn't, but choosing Quit, logging out or restarting does. `apps/desktop/src/updates.ts` does all this, and it only runs in a packaged app.

Every push to main that passes CI is a release. `.github/workflows/release.yml` starts when the CI run finishes, builds the app on three runners and publishes it in two places. The Mac runner builds for Apple silicon and Intel, Windows gets an NSIS installer, and Linux gets an AppImage. Pushes that only change Markdown or `docs/` skip CI, so they don't release. To release by hand, such as after a failed run, run the workflow from the Actions tab.

The version is the major and minor from the root `package.json`, then the number of commits on main. The 152nd commit is `0.0.152`. To start `0.1.x`, change the root `package.json` to `0.1.0`. The patch keeps counting commits, so it never goes back down.

Each release is a GitHub release in this repo, tagged `v0.0.152` on the released commit, with notes generated from the merged pull requests. This repo is private, and electron-updater downloads without a token, so the updater can't read those. It reads an S3-compatible bucket instead, like Cloudflare R2 or AWS S3. The workflow uploads the builds there first, then the `latest*.yml` files the updater reads, with `Cache-Control: no-cache`. So the updater never sees a version with one platform's files missing. The bucket's URL is built into each app's `app-update.yml` (`-c.publish.url`). A local `vp run package:desktop` has no feed, so it doesn't update.

The workflow needs these secrets and variables:

| Name                        | Kind     | What it is                                                   |
| --------------------------- | -------- | ------------------------------------------------------------ |
| `UPDATES_ACCESS_KEY_ID`     | secret   | An S3 access key that can write to the bucket                |
| `UPDATES_SECRET_ACCESS_KEY` | secret   | Its secret                                                   |
| `MAC_CERTIFICATE`           | secret   | The self-signed code signing certificate, as a base64 `.p12` |
| `MAC_CERTIFICATE_PASSWORD`  | secret   | Its password                                                 |
| `UPDATES_BUCKET`            | variable | The bucket's name                                            |
| `UPDATES_ENDPOINT`          | variable | Its S3 API endpoint. Leave it unset for AWS S3               |
| `UPDATES_REGION`            | variable | Its region. Leave it unset for R2, which uses `auto`         |
| `UPDATES_URL`               | variable | The bucket's public URL, which the updater downloads from    |
| `UPDATES_LIMIT_BYTES`       | variable | The most the bucket may hold. Leave it unset for 10 GB       |

The bucket has to be publicly readable. Don't change `UPDATES_URL` once apps are installed: they keep reading the URL they were built with.

The bucket stays under 10 GB. Before each upload, the workflow deletes the oldest versions' builds until the bucket, with the new version added, fits. A release is about 730 MB, so the bucket holds the newest 12 or so. It never deletes the newest version already there, because `latest*.yml` points at it until the upload replaces them. If even that doesn't fit, the release fails before it deletes or uploads anything. The GitHub releases keep every version.

Mac builds are signed with a self-signed certificate, not an Apple Developer ID. Squirrel.Mac, which installs updates on a Mac, only checks that an update is signed with the same certificate as the running app. Apple doesn't have to issue it. `apps/desktop/scripts/sign-mac.cjs` signs the app, because electron-builder only signs with certificates macOS trusts. The Mac build fails without `MAC_CERTIFICATE`, because an unsigned build could never update.

Without a Developer ID, the app isn't notarized, so Gatekeeper blocks the first launch with "Apple could not verify Finite". Open System Settings, then Privacy & Security, and click Open Anyway. You only do this once. Updates don't come from a browser, so macOS doesn't quarantine them, and they open without asking. Windows builds are unsigned too, so SmartScreen warns on the first install, and updates install without a warning.

Keep the certificate. The original is in `~/.config/finite-signing/` on the machine that made it, with its password. If you lose it and sign with a new one, every Mac install stops updating, and people have to download the app again. The same goes for moving to an Apple Developer ID later.

Two other details. On a Mac, an app run from the disk image or from Downloads is read-only, so it can't replace itself. At launch the app offers to move itself to Applications. And `apps/desktop/scripts/stage-server.mjs` builds `finite-server` for each architecture and copies it into `apps/desktop/server/<arch>/`. electron-builder copies it from there, with `apps/web/out` as `web/`, into the app's resources folder, where `main.ts` finds them.

The preload script exposes `window.finite` (platform and versions) to the renderer. Its type lives in `apps/web/src/global.d.ts`. Update both files together.

## Gotchas

- If the browser gets `403` with `unknown host` or `requests from … aren't allowed`, you opened Finite under a name it doesn't know, such as your machine's network address. Add that name to `FINITE_ALLOWED_HOSTS` (comma-separated, like `192.168.1.20,finite.example.com`). The check keeps other websites from reading your designs.
- If a tool call or comment is refused with a limit, that's on purpose, and the message says what to do instead. A design holds up to 100,000 nodes nested at most 256 deep, 500 open comments, and 200 messages per thread. An agent's working indicator names up to 100 nodes. Long tool results are cut at 60,000 characters, with a note on how to see the rest. The guide's sections on edit commands, MCP and comments say why each limit exists.
- If the server exits with `another Finite server is using …`, a second server is pointed at the same data folder. Stop the other one, or give this one its own `FINITE_DATA_DIR`.
- With a shared database, a request can get `503` with "the design is moving" for up to one lease after the servers change. The old owner is saving its last snapshot first. Browsers and agents just try again. A server that logs `another live Finite server is using the URL …` shares its `FINITE_NODE_URL` with a running one, and stays out of the cluster until you fix that.
- If Electron crashes with `Cannot read properties of undefined (reading 'whenReady')`, your shell has `ELECTRON_RUN_AS_NODE=1` set. Electron-based terminals and editors often export it. Run `unset ELECTRON_RUN_AS_NODE` first.
- A Mac build made without `MAC_CERTIFICATE` is unsigned, and it can't update itself. `vp run package:desktop` makes one, which is fine for trying a package. Squirrel.Mac refuses the download with `Code signature … did not pass validation`.
