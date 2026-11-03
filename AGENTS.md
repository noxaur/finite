# Finite

Finite is a design canvas that agents edit and people steer.

## What makes Finite special?

These are the things we can't compromise on. They make us what we are today and tomorrow.

- Built for agents: agents are the only editors, so every tool, result and error is written for an agent to read. Measure a change with an AX run (`e2e/ax`) instead of guessing whether it helps.
- Live and shared: several agents edit at once while people watch every change live. One agent's edit or undo never wipes out another's work.
- Fast: an edit holds the design's lock, so a slow edit makes every agent and viewer wait. Performance is a core feature. Measure it (`vp run bench`, the `examples/` in each crate), and do not trade it for convenience.
- Plain HTML and CSS: designs are ordinary HTML and CSS that agents already know, not a custom format.

## General principles

- Channel your inner yagni, kiss, and SOLID.
- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.
- Do not write bypasses, write real fixes.
- Keep things in one function unless composable or reusable.
- If a short request has two possible meanings, ask one question before you start.
- Do not say a bug is fixed until a test, log or recording shows it.

## How it works

Read `docs/how-finite-works.md` before you change the document model, the server or the viewer. An agent calls an MCP tool at `/mcp` (`crates/server/src/mcp/`). The tool runs an edit command (`crates/design/src/edit.rs`), which reads the document and returns ops but never changes it. `DesignHandle::edit` (`hub/design.rs`) locks the design, commits the ops through `Design::commit`, broadcasts the change to every WebSocket and queues it for saving. Applying an op returns its inverse, and undo applies that inverse as a new change, so each agent undoes only its own work. `store.rs` saves a snapshot plus an append-only journal for each design. The browser runs the same Rust document model compiled to WebAssembly (`crates/wasm`): `socket.ts` receives the change, `DesignSession` feeds it to the `Replica`, and the `Renderer` patches only the DOM nodes each op touched. Artboards render in a shadow root, or in a sandboxed iframe when they contain a `<script>`. Comments are stored with the design but aren't part of the document, so undo never touches them. With several servers, `cluster.rs` picks each design's owner by rendezvous hashing and `router.rs` sends each request to it.

## Code map

- `crates/design/`: the document model, with no I/O. `node.rs` (nodes and properties), `document.rs` (the node map, ops and limits), `design.rs` (the document plus every actor's history and comments), `history.rs` (undo stacks), `edit.rs` (edit commands), `html.rs` (HTML in and out, and what's unsafe), `search.rs`, `comment.rs`, `fractional.rs` (sibling order) and `label.rs`. Add a tool's logic in `edit.rs`, not in the server.
- `crates/wasm/`: the document model as `finite.wasm`, with a plain C ABI for the viewer. A new call is an export in `src/lib.rs` and a method in `apps/web/src/design/wasm.ts`.
- `crates/server/`: the axum server.
  - `mcp/`: the tools. `mod.rs` defines them, `params.rs` holds their arguments, `format.rs` writes outlines and layout notes, `search.rs` and `styles.rs` hold search and shared CSS. `instructions.md` is what agents read when they connect; keep it under 4,000 characters.
  - `hub/`: the designs in memory. `mod.rs` loads, unloads and saves them, `design.rs` has `DesignHandle`, `messages.rs` has the WebSocket messages.
  - `api.rs`: REST and WebSockets for the web app. `guard.rs` keeps other websites out, and `heartbeat.rs` pings the sockets.
  - `store.rs` and `postgres/`: the folder store and the shared Postgres store.
  - `cluster.rs`, `router.rs` and `relay.rs`: running more than one server.
  - `screenshot/`: renders artboards with headless Chrome over CDP.
- `apps/web/`: the Next.js app, styled with StyleX. `src/design/` is the viewer (socket, session, replica, renderer, camera), `src/components/` the React parts (design grid, canvas, comments, shared CSS), `src/api/` the Effect HTTP client and `src/styles/tokens.stylex.ts` the theme tokens.
- `apps/desktop/`: the Electron app that starts the server and shows the web app, with restarts and updates.
- `e2e/`: `run.mjs` is the end-to-end test, `bench.mjs` the canvas benchmark, `headless.mjs` and `finite_headless.py` drive Finite by hand, and `ax/` runs real agents against the tools.

## Vocabulary

Read "Words used in the code" at the end of `docs/how-finite-works.md` for the words Finite uses, such as op, change, actor, replica and owner.

## UI

- Use the StyleX tokens in `apps/web/src/styles/tokens.stylex.ts`. Do not type a raw value or copy a component. If a component cannot do what you need, extend it.
- Read `apps/web/AGENTS.md` before you change the web app. This Next.js version differs from your training data.

## Branch names

Use a short branch name of at most three words, separated by hyphens.

Examples: session-recovery, fix-scroll-state, regenerate-sdk.

## Pull requests

Never make a PR unless you've been asked to.

Write conventional commit titles in plain English. `feat(mcp): find nodes by text`. Start the body by explaining the problem with 1-2 concise sentences. Under this add any media like screenshots (via `--attach`, never commit assets), benchmark results in a grid and or etc. Under `## changes` list what changes you've made in an ul, continue with a short section on how you verified. Omit things such as linter and style-check. Then watch the PR until it has been merged. Address conflicts, and comments. Verify each reported bug or review issue before you fix it. Fix only a bug that you verified.

## Documentation

Agents read code and understand it well, comments aren't needed for everything. When you change how something works, update `docs/how-finite-works.md` and the README.

## Plans, artifacts and other residue files

Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree.

## Checks

- Run `vp install` after you pull.
- `vp run ready` runs everything CI runs before the end-to-end test: `vp check`, `cargo fmt --check`, `cargo clippy -D warnings`, every test and every build. It must pass.
- `vp check --fix` formats and lints the web side. `cargo fmt --all` formats the Rust side.
- `vp run dev` starts the server and the web app. `vp run wasm#build` builds `finite.wasm` when you need it on its own.

## Testing

Run `vp test` for the web side and `cargo test --workspace` for the Rust side. Put a document-model test in `crates/design/tests/` and a server test in `crates/server/tests/`. The golden files in `crates/*/fixtures/` are rewritten by `FINITE_UPDATE_FIXTURES=1 cargo test`; add the changed ones to your change. `vp run e2e` checks what a person sees in headless Chrome. To see a change in the real app, use the `finite-headless` skill.

A change to how servers hand a design between them (leases, saving, `Hub::tick`) must pass `crates/server/tla/check.sh`; the `verify-design-leases` skill says how to read it.

## Skills

Project skills live in `.agents/skills/`, where Codex, Cursor and opencode find them. `.claude/skills` is a symlink to it for Claude Code. Add a new skill to `.agents/skills/`.

- Test actual implementation, do not duplicate logic into tests.
