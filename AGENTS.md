# Finite

Finite is a design canvas for real React projects, which agents edit and people steer.

## What makes Finite special?

These are the things we can't compromise on. They make us what we are today and tomorrow.

- Real React projects: a design is an ordinary React and TypeScript codebase, not a custom format. Frames are live pages of the project's own Vite dev server, and every hand edit writes TSX in the project's own convention (Tailwind, CSS modules, StyleX or inline styles). The project's files are the truth; Finite's own state is JSON in `.finite/`.
- Built for agents: agents do most of the work, through the person's local Claude Code CLI with Finite's canvas tools. Every tool result, refusal and error is written for an agent or a person to read, and says what to do instead. People select, move, resize and restyle on the canvas too.
- Live and shared: several people and threads work on one design at once and see every change live. One actor's edit or undo never wipes out another's work.
- Fast: the canvas holds many live iframes and stays smooth while agents work. Performance is a core feature. Measure it, and don't trade it for convenience.

## General principles

- Channel your inner yagni, kiss, and SOLID.
- Before adding complexity for a speculative or vanishingly unlikely race or security edge case, explain the concrete failure mode, likelihood, and complexity cost to the user and get their buy-in. Do not silently expand scope for theoretical robustness.
- Do not write bypasses, write real fixes.
- Keep things in one function unless composable or reusable.
- If a short request has two possible meanings, ask one question before you start.
- Do not say a bug is fixed until a test, log or recording shows it.

## Hit every surface

The most common defect in this repo is a feature that works on the path you tested and is missing everywhere else. Before you call a change done, walk this list and say which entries applied:

- **Agent and person.** Agents work through threads and canvas tools, people through the page, so a feature needs both halves. A new thing a person can do usually needs a tool or an instruction so an agent can do it too (`apps/server/src/agent/tools.ts`, `instructions.ts`), and what an agent makes must show in the page without a reload.
- **Both tabs.** The Design tab (pages, layers, tokens, inspector) and the Prototypes tab (thread list, composer, prototype canvases) share the canvas. A canvas change must work on a page and on a prototype, where hand edits outside `.finite/` are refused with `outside-prototype`.
- **Connected and blank designs.** A blank design starts from `apps/server/scaffold`; a connected one is whatever the person has. Test both. A connected root is the person's own code: Finite never deletes it.
- **The three router adapters.** Routes come from TanStack Router's route tree, React Router's framework-mode `routes.ts`, or a scan of React Router's data and declarative modes (`packages/vite-plugin/src/routes.ts`). The fixtures `rr-spa`, `rr-framework` and `tanstack` in `apps/server/fixtures` cover each.
- **Every styling convention.** A hand edit has a Tailwind, a CSS-modules, a StyleX and an inline path (`apps/server/src/source/`). Change one and check the others, and the `unsupported-style` refusal. The `stylex` fixture covers StyleX.
- **Undo and concurrent edits.** Undo is per actor and works by span patches. Check undo, redo, and an edit by someone else in the same file in between.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Remove needs restore, resolve needs reopen, snooze and settle need a way to wake. A one-way door is a bug.
- **The protocol.** A new request or event goes in `packages/protocol/src/wire.ts`, a handler in `apps/server/src/handlers.ts`, and the client side in `apps/web/src/client/finite.ts`.
- **Docs.** Check whether the change makes `docs/how-finite-works.md` or the README inaccurate.

## How it works

Read `docs/how-finite-works.md` before you change the server, the plugin or the canvas. The page opens one WebSocket on `/api/ws` and speaks the protocol in `packages/protocol/src/wire.ts`. `apps/server/src/hub.ts` routes each request to a handler in `handlers.ts`, which calls one of four modules: `store/` (the designs registry and each design's `.finite/` folder, written atomically), `preview/` (one Vite dev server per open design, in a child process, with `@finite/vite-plugin`), `source/` (hand edits to TSX, tokens, per-actor undo) and `agent/` (one Claude Agent SDK query per live thread, running the local `claude` CLI with the canvas tools and the write fence). Frames are iframes of the design's dev server. The plugin stamps every JSX element with `data-finite-loc` and `data-finite-rev`, and the page reaches into a frame only through the bridge, a `MessageChannel`: it hit-tests a press, inspects the element, and sends a `source.edit` naming the loc and the file's rev. The server refuses the edit with `stale` if the file changed since, else rewrites the TSX, and Vite's HMR updates every viewer's frame.

## Code map

- `packages/protocol/`: the contract. `model.ts` (designs, canvases, threads, settings, refusal codes), `wire.ts` (every `/api/ws` request and event), `bridge.ts` (page and frame), `tools.ts` (canvas tool inputs), `server.ts` (the server modules' interfaces).
- `packages/vite-plugin/`: `@finite/vite-plugin`. `stamp.ts` (JSX locs and revs), `routes.ts` (the three router adapters), `frame.ts` (file frames), `html.ts` (bridge injection into server-rendered HTML), `tailwind.ts` (`@source` for `.finite/`), `client/bridge.ts` (the frame's half of the bridge).
- `apps/server/`: the Node server, run from TypeScript source with Node 22's type stripping, so only erasable TS and `.ts` extensions in relative imports.
  - `main.ts`, `config.ts` (every `FINITE_*` variable), `app.ts`, `hub.ts`, `handlers.ts`, `http.ts` (attachments, the export zip, static files), `guard.ts` (Host and Origin checks).
  - `store/`: the registry, settings, `.finite/` files, project detection (`detect.ts`), installs and the Routes page (`routes.ts`).
  - `preview/`: the dev servers; `vite-host.mjs` is the child.
  - `source/`: `rewrite.ts` (the edit kinds), `tailwind.ts`, `css.ts`, `stylex.ts`, `tokens.ts`, `history.ts` (undo), `imports.ts` and `components.ts` (copying and detaching files).
  - `agent/`: `index.ts` (sessions, steer and queue), `policy.ts` (the fence), `tools.ts` (canvas tools), `instructions.ts` (the system prompt addition; keep it under 2,500 characters), `events.ts`, `status.ts`, `screenshot.ts`.
  - `scaffold/` (the blank design) and `fixtures/` (test apps).
- `apps/web/`: the Next.js static export, styled with StyleX. `src/client/finite.ts` (the socket and live state), `src/canvas/` (camera world, frames, editor, bridge, selection), `src/components/` (design list, design screen, sidebars, thread list, composer, ✱ menu, comments, settings, `inspector/`), `src/design/editing/` (control values to CSS), `src/styles/tokens.stylex.ts` (the theme tokens).
- `apps/desktop/`: the Electron app that runs the server bundle and shows the web app, with restarts and updates.
- `e2e/`: `run.mjs` (the end-to-end test) and `lib.mjs` (server, web build, socket client, fixtures, Chrome).

## Vocabulary

Read "Words used in the code" at the end of `docs/how-finite-works.md` for the words Finite uses, such as loc, rev, frame, board, production, actor and turn.

## UI

- Use the StyleX tokens in `apps/web/src/styles/tokens.stylex.ts`. Do not type a raw value or copy a component. If a component cannot do what you need, extend it.
- Read `apps/web/AGENTS.md` before you change the web app. This Next.js version differs from your training data.

## Branch names

Use a short branch name of at most three words, separated by hyphens.

Examples: session-recovery, fix-scroll-state, regenerate-sdk.

## Pull requests

Never make a PR unless you've been asked to.

Write conventional commit titles in plain English. `feat(source): keep arbitrary Tailwind values`. Start the body by explaining the problem with 1-2 concise sentences. Under this add any media like screenshots (via `--attach`, never commit assets), benchmark results in a grid and or etc. Under `## changes` list what changes you've made in an ul, continue with a short section on how you verified. Omit things such as linter and style-check. Then watch the PR until it has been merged. Address conflicts, and comments. Verify each reported bug or review issue before you fix it. Fix only a bug that you verified.

## Documentation

Agents read code and understand it well, comments aren't needed for everything. When you change how something works, update `docs/how-finite-works.md` and the README.

## Plans, artifacts and other residue files

Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree.

## Checks

- Run `vp install` after you pull.
- `vp run ready` runs everything CI runs before the end-to-end test: `vp check`, every test and every build. It must pass.
- `vp check --fix` formats and lints.
- `vp run dev` starts the server on 4100 and the web app on 5310. If the user's desktop app holds 4100, run `FINITE_PORT=4200 node apps/server/src/main.ts` and `FINITE_API_URL=http://127.0.0.1:4200 next dev` in `apps/web` instead.

## Testing

Run `vp test` in a package, or `vp run test` for all of them. Server tests sit beside the code (`*.test.ts`). Tests that need a real project copy a fixture to a temp folder and install it (`apps/server/src/preview/fixtures.ts`). The plugin's golden files are in `packages/vite-plugin/src/__golden__/`. Tests that need the real `claude` run only with `FINITE_REAL_AGENT=1`. `vp run e2e` checks a person's core flow in headless Chrome. To see a change in the real app, use the `finite-headless` skill; to prove it with evidence, `verify-finite`. Tests and manual runs use port 0 or 4300 and up: the user's own Finite may hold 4100 and 5310.

## Skills

Project skills live in `.agents/skills/`, where Codex, Cursor and opencode find them. `.claude/skills` is a symlink to it for Claude Code. Add a new skill to `.agents/skills/`.

- `finite-headless`: run a private Finite (server, web app, Chrome) and drive it from the shell.
- `verify-finite`: prove a feature works in the real app, with evidence in `.verify/<run>/`.
- Test actual implementation, do not duplicate logic into tests.
