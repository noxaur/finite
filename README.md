# Finite

Finite is a design canvas for real React projects. Each design is a React and TypeScript codebase, and each frame on the canvas is a live page of it. You can connect a codebase you already have (a Next.js app, or a Vite app with React Router or TanStack Router), create a blank design (a new Vite, React, TypeScript and Tailwind project), or import one from a Figma link, a URL or files.

You edit frames like in Figma: select an element, move and resize it, change its text and styles in the inspector, undo with ⌘Z. Finite writes each edit back to the TSX in the project's own convention, so a Tailwind project gets Tailwind classes, a CSS-modules project (plain CSS, Sass or Less) gets a changed rule and a StyleX project gets a changed or new `stylex.create` entry. Agents work beside you. On the Prototypes tab, a message to the composer starts a thread, which runs your local Claude Code CLI on the project. The agent writes prototype components onto a canvas, labels each one with what it tried and why, and leaves comments. It can read all of production but writes only prototypes and brand assets, until you ask it to move a prototype to prod.

For a tour of the internals, read [How Finite works](docs/how-finite-works.md).

## Setup

You need:

- Node 22.18 or later, which runs the server's TypeScript directly.
- [Vite+](https://viteplus.dev) (`vp`), which manages the toolchain and pnpm.
- The [Claude Code](https://claude.com/claude-code) CLI on your `PATH`, logged in: run `claude` once and log in. Finite has no API key setting. Without it, everything but threads works, and Settings and the composer tell you to run `claude`.
- Google Chrome or Chromium, for the agent's `screenshot` tool and the end-to-end test. Set `FINITE_CHROME` if yours isn't in a standard place.

```bash
vp install
vp run dev     # the web app on http://localhost:5310, the server on :4100
```

Designs you create in dev go to `apps/server/.finite-data/`. A connected codebase stays where it is, with a `.finite/` folder added to its root for the canvases, comments and threads. Commit that folder with the project.

In [T3 Code](https://t3.codes), `t3.json` starts each new thread in a separate worktree and runs `vp install` there. Its scripts menu has Dev and Ready.

## Desktop app

```bash
vp run dev:desktop      # dev, plus an Electron window on the dev server
vp run start:desktop    # builds everything, then Electron with the bundled server
vp run package:desktop  # packages the app for this machine into apps/desktop/release
```

The packaged app runs the server bundle (`apps/server/dist/main.mjs`) with Electron's own Node, on port 4100 or a free port when that's taken, and keeps its designs in Electron's user data folder. It passes your login shell's `PATH` to the server, so it finds `claude` and `pnpm` the way a terminal does. Connect a codebase there with **Choose…**, which opens a folder picker. If the server stops on its own, Electron starts it again on the same port and open pages reconnect. After three stops in a minute it shows an error and quits (`apps/desktop/src/restarts.ts`).

## Commands

```bash
vp run dev              # web on :5310, server on :4100 (node --watch)
vp run test             # every package's Vitest suite
vp run build            # every package's build, the web app's static export included
vp run e2e              # build the web app, start a server, and drive it in headless Chrome
vp run ready            # vp check (format, lint, type check), test, build
```

`vp run dev` starts with `scripts/dev-cleanup.mjs`. It stops a Finite dev server an earlier run left holding port 4100 or 5310, and refuses to touch any other process on them, such as the desktop app's server.

`FINITE_REAL_AGENT=1 vp run e2e` also sends a thread message to your local `claude`, and `FINITE_REAL_AGENT=1 vp test` runs the server's real-agent test. Both use your Claude subscription. To try a change by hand, or let an agent try it, use the `finite-headless` skill (`.agents/skills/finite-headless/`): it starts a private server, web app and Chrome on ports from 4300 and drives them from the shell.

`.github/workflows/ci.yml` runs `vp check`, the tests, the builds and `vp run e2e` on pushes to `main` and on pull requests. If the e2e step fails, the workflow uploads the failure screenshot. Each commit runs `vp staged` from the pre-commit hook (`.vite-hooks/pre-commit`), which runs `vp check --fix` on the staged files.

## Layout

| Path                   | What it is                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `apps/web`             | The Next.js app, styled with StyleX, built as a static export into `out/`                                       |
| `apps/server`          | The Node server: `/api/ws`, the design store, previews, the source editor and agents                            |
| `apps/server/scaffold` | The project a blank design starts from                                                                          |
| `apps/server/fixtures` | Small React Router, TanStack and Next.js apps the tests connect                                                 |
| `apps/desktop`         | The Electron app, bundled with `vp pack`                                                                        |
| `packages/protocol`    | The wire protocol, the data model and the module interfaces, as zod schemas and types                           |
| `packages/vite-plugin` | `@finite/vite-plugin`: stamps JSX with its source location, injects the bridge, lists routes (also for Next.js) |
| `e2e`                  | The end-to-end test and its helpers                                                                             |

## How the pieces connect

The page calls the server with relative `/api/...` URLs, so it needs both on one origin:

- **Web dev:** `next dev` rewrites `/api/*`, the `/api/ws` WebSocket included, to the server on `127.0.0.1:4100`. Set `FINITE_API_URL` to point elsewhere.
- **Desktop dev:** Electron loads the Next.js dev server, so it uses the same rewrite.
- **Desktop release and deploys:** the server serves the built web app itself, from `FINITE_STATIC_DIR`.

Frames load from each design's own dev server (Vite, or `next dev` with Turbopack, or webpack for a project that needs it), which the server starts on a free port on the same host when someone opens the design. `next build` produces a static export (`output: "export"` in `apps/web/next.config.ts`), so Next features that need a server at request time (route handlers, server actions, middleware, dynamic routes without `generateStaticParams`) aren't available.

StyleX compiles through Babel (`apps/web/babel.config.js`) and the StyleX PostCSS plugin (`apps/web/postcss.config.js`), which replaces the `@stylex;` line in `src/app/globals.css` with the collected rules. This follows StyleX's official Next.js example.

## Releases and updates

The desktop app updates itself, with no prompts. electron-updater looks for a new version at launch, every four hours and when the computer wakes. It downloads it in the background and installs it the next time the app quits. It never restarts the app on its own, because that would stop every running agent turn. On Windows and Linux, closing the last window quits. On a Mac it doesn't, but choosing Quit, logging out or restarting does. `apps/desktop/src/updates.ts` does all this, and it only runs in a packaged app.

Every push to main that passes CI is a release. `.github/workflows/release.yml` starts when the CI run finishes and builds the app on three runners: the Mac runner for Apple silicon and Intel, Windows an NSIS installer, Linux an AppImage. Each runner builds the web app, the desktop app and the server bundle (`vp run @finite/server#build`), which Electron's own Node runs, so one bundle serves every architecture. Pushes that only change Markdown or `docs/` skip CI, so they don't release. To release by hand, such as after a failed run, run the workflow from the Actions tab.

The version is the major and minor from the root `package.json`, then the number of commits on main. The 152nd commit is `0.0.152`. To start `0.1.x`, change the root `package.json` to `0.1.0`. The patch keeps counting commits, so it never goes back down.

Each release is a GitHub release in this repo, tagged `v0.0.152` on the released commit, with notes generated from the merged pull requests. This repo is private, and electron-updater downloads without a token, so the updater reads an S3-compatible bucket instead, like Cloudflare R2 or AWS S3. The workflow uploads the builds there first, then the `latest*.yml` files the updater reads, with `Cache-Control: no-cache`, so the updater never sees a version with one platform's files missing. The bucket's URL is built into each app's `app-update.yml` (`-c.publish.url`). A local `vp run package:desktop` has no feed, so it doesn't update.

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

The bucket has to be publicly readable. Don't change `UPDATES_URL` once apps are installed: they keep reading the URL they were built with. Before each upload, the workflow deletes the oldest versions' builds until the bucket, with the new version added, fits under `UPDATES_LIMIT_BYTES`. It never deletes the newest version already there, because `latest*.yml` points at it until the upload replaces them. If even that doesn't fit, the release fails before it deletes or uploads anything. The GitHub releases keep every version.

Mac builds are signed with a self-signed certificate, not an Apple Developer ID. Squirrel.Mac, which installs updates on a Mac, only checks that an update is signed with the same certificate as the running app. `apps/desktop/scripts/sign-mac.cjs` signs the app, because electron-builder only signs with certificates macOS trusts. The Mac build fails without `MAC_CERTIFICATE`, because an unsigned build could never update. Keep the certificate: the original is in `~/.config/finite-signing/` on the machine that made it, with its password. If you sign with a new one, every Mac install stops updating, and people have to download the app again.

Without a Developer ID, the app isn't notarized, so Gatekeeper blocks the first launch with "Apple could not verify Finite". Open System Settings, then Privacy & Security, and click Open Anyway, once. Windows builds are unsigned too, so SmartScreen warns on the first install. On a Mac, an app run from the disk image or from Downloads is read-only, so it can't replace itself, and at launch it offers to move itself to Applications.

## Gotchas

- If the browser gets `403` with `unknown host` or `requests from … aren't allowed`, you opened Finite under a name it doesn't know, such as your machine's network address. Add that name to `FINITE_ALLOWED_HOSTS` (comma-separated). The check keeps other websites from reading your designs.
- If **Connect** refuses a folder, the reason says what's missing: Finite needs a `package.json` and either Next.js (with an `app/` or `pages/` folder) or Vite with React Router or TanStack Router.
- A Next.js design gets one file of Finite's outside `.finite/`: `app/%5F%5Ffinite/frame/page.tsx` (inside the route group that holds your root layout, if `app/layout` doesn't exist), or `pages/__finite/frame.tsx`. It is listed in `.git/info/exclude` and removed when the preview stops. If your project already has a file there, or you edited Finite's, the preview refuses to start and says so.
- If a design's dev server fails to start, the canvas shows the end of its output, such as a plugin in the project's `vite.config.ts` that throws. Fix the project, then open the design again.
- If threads don't start, run `claude` in a terminal and log in. In the desktop app, Finite looks for `claude` on your login shell's `PATH`.
- If Electron crashes with `Cannot read properties of undefined (reading 'whenReady')`, your shell has `ELECTRON_RUN_AS_NODE=1` set. Electron-based terminals and editors often export it. Run `unset ELECTRON_RUN_AS_NODE` first.
- `vp run dev` refuses to start while the desktop app holds port 4100. Quit the app, or run the server on another port (`FINITE_PORT=4200 node apps/server/src/main.ts`) and `FINITE_API_URL=http://127.0.0.1:4200 next dev` in `apps/web`.
