---
name: finite-headless
description: Run Finite headless and drive it from the shell, to see a change working in the real app. Starts the Node server, the web app and headless Chrome, sends requests and thread messages over /api/ws, connects fixture codebases, and clicks, types, evaluates and screenshots the page and the design frames inside it. Use when asked to run, try, test or screenshot Finite, or to reproduce a bug in the canvas, the design list, the inspector or a thread.
---

# Run Finite headless

`scripts/finite.mjs` starts a private Finite in the background, then each call does one thing to it: a request on `/api/ws`, a thread message, a click, a key, an `eval` or a screenshot. State carries over between calls, the way it would for a person and an agent working side by side. `vp run e2e` (`e2e/run.mjs`) is the fixed regression run; this is for exploring. Add a check to `e2e/run.mjs` when a behavior should stay fixed.

```bash
f() { node .agents/skills/finite-headless/scripts/finite.mjs "$@" --session mine; }
```

Shell functions don't survive between tool calls: repeat the `f()` line at the start of each call. Run `f` with no command for every command and flag.

## Start, work, stop

```bash
f start                       # builds apps/web/out, then server + Chrome; prints the URL
f start --no-build            # reuses apps/web/out (rebuild after changing apps/web)
f start --web dev             # next dev with hot reload instead (one per checkout: .next/dev/lock)
f call design.create '{"name":"Test","kind":"blank"}'
f watch <designId> --until routes --for 120   # subscribe; prints design.state, then events
f open "/design/?id=<designId>"
f shot .verify/<run>/01-canvas.png            # Read the PNG to see it
f stop                        # kills server, its Vite children and Chrome; deletes the data
```

- **Ports and data.** The server runs `node apps/server/src/main.ts` on the first free port from 4300, with `FINITE_DATA_DIR` in `$TMPDIR/finite-headless/<session>/data`. It never takes 4100 or 5310: the user's desktop app or `vp run dev` may hold them, with their real designs. Drive only a session you started.
- **Static vs dev.** `static` serves the web export from the server's own origin. `dev` runs `next dev` with `FINITE_API_URL` pointing at the server. A server change needs `stop` and `start` either way.
- **Logs.** `f logs server` (and `f logs web` in dev). `f console` prints page errors and console output caught while a command was attached.

## The server

`call <type> '<json>'` sends one request from `packages/protocol/src/wire.ts` (`requests` lists every type and its params) and prints the reply value or the refusal's reason. `@file.json` reads the params from a file.

- `watch <designId>` subscribes: preview status (`starting` while a blank design installs, then `ready` with the Vite URL), `routes`, `canvas`, `thread` and `thread.event`.
- `send <designId> "<text>"` starts a thread (`--thread <id>` continues one, `--canvas <id>` puts it on a prototype canvas) and streams its events until `result` or `error`. It runs the real local `claude` CLI on the user's subscription, so keep prompts small.
- `fixture rr-spa` (or `rr-framework`, `tanstack`) copies `apps/server/fixtures/<name>` to a temp folder, installs it and prints the path. Then `f call design.connect '{"path":"<path>"}'` makes a connected design.

## The page

Selectors are puppeteer's: CSS, `::-p-text(Create blank design)`, `::-p-aria(Send)`. Prefer the app's `aria-label`s and titles to coordinates.

- **Frames.** Each frame is `iframe[data-frame-id="<frameId>"]`, loaded from the design's own Vite server. Its elements carry `data-finite-loc="src/x.tsx:12:4"` (the JSX in the source) and `data-finite-rev`. `--frame <frameId>` runs `eval`, `click` and `wait` inside it.
- **Selecting.** Frames take no pointer events: the canvas hit-tests through the bridge. To select an element, `click <x> <y>` on its spot in the page, then check `[data-selected]`. `eval` inside the frame gives the element's rect, and the iframe's rect in the page gives the offset and the zoom.
- **Inspector.** It's collapsed by default: `click 'button[aria-label="Show inspector"]'`. Its fields are `input[aria-label="Layer opacity"]`, `"Corner radius"`, `"Width"` and so on. `click` one, `key Meta+a`, `type 50`, `key Enter`, then read the TSX file under the design's root to see the edit.
- **Tabs.** `click '[role=tab]::-p-text(Prototypes)'` and `::-p-text(Design)`. The composer is `[aria-label=Message]`.
- **Keys.** `key Meta+z` and `key Meta+Shift+z` undo and redo hand edits. Blur inputs first (`eval 'document.activeElement.blur()'`), or the field gets the key.
