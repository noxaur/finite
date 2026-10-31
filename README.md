# Finite

Finite is a desktop and web app. The frontend is Next.js (React), styled with StyleX, and talks to the backend through an Effect HTTP client. The backend is a Rust server built on axum. Vite+ (`vp`) runs the JavaScript side, and Cargo builds the Rust side.

## Layout

| Path            | What it is                                                                       |
| --------------- | -------------------------------------------------------------------------------- |
| `apps/web`      | Next.js + StyleX + Effect frontend, built as a static export into `out/`         |
| `apps/desktop`  | Electron main and preload processes, bundled with `vp pack`                      |
| `crates/server` | Rust API server (axum). Serves `/api/*`, plus the built frontend in release mode |
| `Cargo.toml`    | Cargo workspace for everything in `crates/`                                      |

`crates/server/package.json` wraps the Cargo commands, so `vp run` can start, test and build the server along with the JS packages.

## Commands

```bash
vp install              # install deps (also downloads the Electron binary)
vp run dev              # web on http://localhost:5310, Rust API on :4100
vp run dev:desktop      # same, plus an Electron window pointed at the dev server
vp run start:desktop    # release build of everything, then Electron with the Rust sidecar
vp run test             # cargo test (add `test` scripts to JS packages as needed)
vp run ready            # format + lint + type check, test, build
```

## How the pieces connect

The frontend calls the API with relative `/api/...` URLs, so it needs both on the same origin:

- **Web dev:** `next dev` rewrites `/api/*` to the Rust server on `127.0.0.1:4100`. Set `FINITE_API_URL` to point elsewhere.
- **Desktop dev:** Electron loads the Next.js dev server, so it uses the same rewrite.
- **Desktop release:** Electron starts `finite-server` as a sidecar process on a free port, with `FINITE_STATIC_DIR` pointing at `apps/web/out`. The window loads that server, and Electron kills the server when the app quits.
- **Web deploy:** run `finite-server` with `FINITE_STATIC_DIR` and `FINITE_PORT`.

The API client is `apps/web/src/api/Api.ts`, an Effect `Context.Service` whose responses are decoded with `Schema`. Keep its schemas in sync with the Rust structs in `crates/server/src/lib.rs`. StyleX design tokens are in `apps/web/src/styles/tokens.stylex.ts`.

`next build` produces a static export (`output: "export"` in `apps/web/next.config.ts`), so there's no Node server to ship. That rules out Next features that need a server at request time: route handlers, server actions, middleware, and dynamic routes without `generateStaticParams`. The Rust server handles everything dynamic. Components that use Effect or `window` need `"use client"`.

StyleX compiles through Babel (`apps/web/babel.config.js`) and the StyleX PostCSS plugin (`apps/web/postcss.config.js`). The PostCSS plugin replaces the `@stylex;` line in `src/app/globals.css` with the collected rules. This setup follows StyleX's official Next.js example.

The preload script exposes `window.finite` (platform and versions) to the renderer. Its type lives in `apps/web/src/global.d.ts`. Update both files together.

## Gotchas

- If Electron crashes with `Cannot read properties of undefined (reading 'whenReady')`, your shell has `ELECTRON_RUN_AS_NODE=1` set. Electron-based terminals and editors often export it. Run `unset ELECTRON_RUN_AS_NODE` first.
- Packaging into a `.app`/`.exe` isn't set up yet. When you add electron-builder or Forge, copy `target/release/finite-server` and `apps/web/out` (as `web/`) into the app's resources directory. `apps/desktop/src/main.ts` looks for them there.
