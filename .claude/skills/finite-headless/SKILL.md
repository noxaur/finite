---
name: finite-headless
description: Run Finite headless and drive it from the shell, to see a change working in the real app. Starts the Rust server and headless Chrome, calls MCP tools as one or more agents, and clicks, types, reads and screenshots the page, from the shell or from Python. Use when asked to run, try, test or screenshot Finite, to reproduce a bug in the canvas or the design list, or to check what a person sees after an agent's edit.
---

# Test Finite headless

`node e2e/headless.mjs` starts Finite with an empty data folder and opens it in headless Chrome. Then each command does one thing to that running app: call an MCP tool, click, type, read the page or take a screenshot. A background process holds the server, the page and the MCP sessions between commands, so state carries over the way it would for a person and an agent working side by side.

It differs from `vp run e2e`, which runs a fixed script of checks and exits. Use this tool to explore, reproduce a bug or check a change. Then add a check to `e2e/run.mjs` if the behavior should stay fixed.

## Start, work, stop

```bash
node e2e/headless.mjs start              # builds first; --no-build reuses the last builds
node e2e/headless.mjs call create_design '{"name":"Test"}'
node e2e/headless.mjs call create_artboard '{"designId":"<id>","name":"Page","width":800,"height":500}'
node e2e/headless.mjs call write_html @input.json
node e2e/headless.mjs design <designId>  # opens it and waits for the artboards to render
node e2e/headless.mjs screenshot         # prints a PNG path: Read it to see the page
node e2e/headless.mjs stop               # stops the server and Chrome, and deletes the data
```

Run `node e2e/headless.mjs help` for every command. Rebuild after you change code: `stop`, then `start`. The Rust server and the web app's static export are both built by `start`, so a change to either needs a restart. `start --no-build` takes under a second. A build with nothing to do takes about 4 seconds, and longer after a change.

A session stops itself after 30 idle minutes (`--idle <minutes>`). Each checkout has its own session in the temp folder. To run a second one beside it, pass `--session <name>` to every command.

## Reading the page

- `snapshot` prints the accessibility tree: headings, buttons and their names, alerts, text. It's the quickest way to see what a person would see. Pass `--selector main` to narrow it.
- `query <css>` lists every match with its position and size, and marks the ones inside an artboard or out of view. Use it to pick a click target.
- `text` prints the visible text, artboards included.
- `screenshot [file] [--selector <css>]` saves a PNG. Read the file to look at it.
- `console` prints what the page logged since the last call, with exceptions and failed requests. Check it after anything that should have worked.
- `logs` prints the server's last lines (`-n 200` for more).

## Pointing at things

Artboards render inside shadow roots, and these commands reach into them. So `query button` lists the design's buttons after the app's toolbar buttons. To search one artboard, use `[data-artboard="<artboardId>"] >>> button`. `click`, `hover`, `text`, `snapshot` and `screenshot` take the first match, or `--nth <i>` as `query` numbers them. In `eval` and `wait`, `$deep(css)` and `$$deep(css)` find elements the same way.

An artboard with a `<script>` renders in a sandboxed iframe that selectors can't reach. Find the iframe's position with `query "[data-artboard] iframe"`, then `click <x> <y>`.

`click <css> --shift` holds Shift, as when you add elements to a comment. `upload <css> <file>` picks a file in a file input, hidden ones included, the way the OS file picker hands one over. Use it for the Import button, whose picker headless Chrome can't show.

If a target is out of view, `click` says so. Press `key Shift+1` to fit every artboard on screen, or use `viewport <w> <h>` to resize.

## The canvas's keys

`key c` switches to the comment tool and `key v` to the pointer. `Escape` closes a comment box, `Shift+1` fits the view, and `=` and `-` zoom.

A comment round trip:

```bash
node e2e/headless.mjs key c
node e2e/headless.mjs click '[data-artboard] >>> button'
node e2e/headless.mjs click textarea
node e2e/headless.mjs type "Make it orange"
node e2e/headless.mjs key Enter
node e2e/headless.mjs call wait_for_comments '{"designId":"<id>","timeoutSeconds":5}'
```

Page commands run one at a time, but `call` doesn't wait for them. So you can start `call wait_for_comments` in the background first, then post the comment, and check that the agent gets it while it waits.

## Several agents

Each `--agent <name>` on `call` opens a separate MCP session with that name, sent as `X-Finite-Agent`. So `--agent Alice` and `--agent Bob` have separate undo histories and show as separate presence badges. Without `--agent`, calls go out as "Agent". `call`'s input is JSON inline, `@file`, or `-` for stdin. Images a tool returns, like `get_screenshot`'s, are saved as PNG files and their paths printed.

## From Python

`e2e/finite_headless.py` drives the same session from Python, with only the standard library. It's handy when a test needs loops, threads or assertions on the results. Each method sends one command and returns data: `eval` and `wait` return the JavaScript value, `query` a list of dicts, `screenshot` a `Path`, and `call` the tool's text.

```python
import sys
sys.path.insert(0, "e2e")
from finite_headless import Finite, design_id, id_after

with Finite.start(build=False) as finite:  # stops the session when the block ends
    design = design_id(finite.call("create_design", name="Test"))
    board = id_after(finite.call("create_artboard", designId=design, name="Page", width=800, height=500), "artboard")
    finite.call("write_html", designId=design, targetId=board, html="<button>Go</button>")
    finite.design(design)
    assert finite.query(f'[data-artboard="{board}"] >>> button')[0]["text"] == "Go"
```

`Finite.connect()` attaches to a session you started from the shell, and leaves it running. A failed command raises `HeadlessError`, and a tool error raises `ToolError`, with the same message the CLI prints. `call_full` also returns the paths of any images, like `get_screenshot`'s. To test `wait_for_comments`, call it from a thread, then post the comment from the main thread.

## Against `vp run dev`

To test with hot reload instead of a static build, run `vp run dev` yourself, then attach:

```bash
node e2e/headless.mjs start --url http://localhost:5310 --server http://127.0.0.1:4100
```

`--server` is where MCP and `api` go, because the Next dev server only proxies `/api`. In this mode `stop` leaves the dev server running, `logs` has nothing to show, and the designs live in `crates/server/data`.
