---
name: verify-finite
description: Prove a Finite feature works in the real app and keep the evidence. Launches an isolated headless run (Rust server, static web app, headless Chrome, MCP agents), drives the browser and the MCP tools the way a person and an agent would, and saves transcripts and screenshots to .verify/<run>/. Use before saying a change to the canvas, design list, comments, shared CSS, pages, import/export or an MCP tool works, before saying a bug is fixed, or when asked to verify, prove or demo one.
---

# Verify Finite

Finite has two surfaces, and most features need both. **Agents** edit designs through MCP tools at `/mcp`. **People** watch in the browser: the design list at `/` and the canvas at `/design/?id=<designId>`. A proof drives the agent side with `call` and checks the person's side in the page, or the other way round for comments.

The harness is `e2e/headless.mjs`. `.agents/skills/finite-headless/SKILL.md` is its command reference (selectors that reach into shadow roots, sandboxed iframes, `--agent`, Python). Read it once before your first drive. This skill adds isolation, a doctor, an evidence folder, before-and-after runs and the feature map.

Every command below runs from the checkout root:

```bash
V=.agents/skills/verify-finite/scripts/verify.sh
```

Shell variables don't survive between tool calls. Repeat `V=...` and `RUN=...` at the start of each call.

## Steps

1. **Pick features.** Find the features your change touches in the table under "Which features a change touches" in [`features/README.md`](features/README.md).
2. **Launch** a run of your code. For a bug fix, launch a second run of the code before the fix too (see "Before and after").
3. **Doctor** each run until it prints only `ok` lines.
4. **Drive** every entry point in each picked feature file, saving evidence as you go.
5. **Clean up** every run you launched, failed runs included.
6. **Report** in the format under "Report".

You're done when every entry point of every picked feature is proven, skipped with a reason, or failed with its evidence, and `$V list` shows nothing running.

## Launch

```bash
$V launch                          # builds the server, finite.wasm and the web app, then starts them
$V launch --no-build               # reuses the last builds; refused if the code changed since they were made
$V launch --width 390 --height 844 # a phone-sized page (the default is 1440 × 900)
$V launch --at main                # a run of another commit, in a temporary checkout (see "Before and after")
```

It prints `RUN=<run>`. Keep that id: every other command takes it. A cold build takes about 2 minutes, and a build with nothing to do a few seconds. Set the Bash timeout to 600000. `--no-build` only saves the few seconds of a build with nothing to do, so when in doubt leave it off.

Launch is ready when it prints `Finite at http://127.0.0.1:<port>`. The harness waits for `/api/health` and loads the design list before it prints that line. The data folder starts empty, and there's no seed data, migrations or login. A person posts comments as "Guest", and agents post as "Agent" unless you pass `--agent <name>`.

Each run is a separate session (`verify-<run>`) with its own free port, temp data folder and Chrome profile, so runs can go side by side. Never drive a Finite you didn't launch. `vp run dev` serves the user's real designs from `crates/server/data`, and the desktop app serves the user's own data too. The doctor fails on a session that attached to someone else's server.

A run stops itself after 30 idle minutes. After that, `doctor` fails: clean up and launch again.

## Doctor

```bash
$V doctor $RUN
```

It only reads state, and every line says `ok` or `FAIL`. It checks five things:

- The session is alive and owns a private `finite-headless-data-*` folder.
- `/api/health` answers `ok` with the version in `package.json`.
- The running build matches the code. It compares a hash of the build inputs (`crates/`, `apps/web/`, the harness, the lockfiles, untracked files included) against the hash of the code the run was built from. Edits to docs, skills or tests don't count.
- A Chrome, Chromium or Edge is there for `get_screenshot`.
- The page answers.

Then it prints the page's console since the last call. Run it first, after any surprise, and before you capture final proof. On a `FAIL`, clean up and launch again rather than driving on. After you change code, the build check fails by design: clean up and launch again.

## Drive

`$V h $RUN <command> ...` runs any `e2e/headless.mjs` command against this run. The commands you'll use most:

```bash
$V h $RUN call create_design '{"name":"Verify"}'      # agent side: prints designId "<id>"
$V h $RUN call create_artboard @input.json            # JSON inline, @file, or - for stdin
$V h $RUN design <designId>                           # person side: open the canvas, wait for artboards
$V h $RUN snapshot --selector main                    # accessibility tree, what a person sees
$V h $RUN click 'button[title="Comment (C)"]'
$V h $RUN click '[data-artboard] >>> h1' --shift      # Shift-click
$V h $RUN upload 'input[type=file]' card.html         # pick a file, as the OS picker would
$V h $RUN api GET /api/designs/<designId>             # the stored design, comments included
```

Use these stable handles. They're the app's accessible names and titles:

| Where            | Handle                                                                                                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Design list      | heading `Designs`, button `New design`, searchbox `Search designs by name`, one `link` per design card                                                                                                                 |
| Canvas top bar   | link `← Designs`, `button[title="CSS every artboard uses"]` (Shared CSS), `button[title="Every comment, open and resolved"]` (Comments, with the open count in its name), `Import`, `Export`, a chip per agent present |
| Canvas tools     | toolbar `Tools`: `button[title="Pointer (V)"]`, `button[title="Comment (C)"]`; keys `v`, `c`, `Shift+1` (fit), `=`/`-` (zoom)                                                                                          |
| Comment box      | textbox `Add a comment`, `button[title="Change your name"]`, `[data-selection-count]`, button `Send`, pins named `Comment: <first message>`                                                                            |
| Comment thread   | `[role=dialog]` named `Comment thread`: buttons `Delete`, `Resolve`/`Reopen`, `Close`, `Edit` on your newest message, textbox `Reply`                                                                                  |
| Panels           | `aside[aria-label=Comments]` with tabs `Open N` / `Resolved N`; `form[aria-label="Shared CSS"]`; `nav[aria-label=Pages]`; `[role=menu][aria-label=Export]`; `aside[aria-label=Import]` with a `status`                 |
| Artboard content | `[data-artboard="<artboardId>"] >>> <css>`; agents' `data-name` attributes survive into the DOM                                                                                                                        |

Prefer these to coordinates. Coordinates are only for sandboxed (script) artboards, which selectors can't reach. `click` takes CSS, not text, so buttons without a title are picked by position: `[role=dialog] button --nth 1`, with `query` listing the order.

Text entry has two traps. `type` appends to what a field holds, and `key Meta+a` doesn't select text through CDP. To replace a field's text, run `$V h $RUN eval "document.execCommand('selectAll')"` with the field focused, then `type`.

### Background calls

`wait_for_comments` blocks until a person comments, so it has to run while you drive the page:

```bash
$V bg $RUN 02-wait call wait_for_comments '{"designId":"<D>","timeoutSeconds":30}'
# ...drive the page...
$V await $RUN 02-wait 30      # blocks until the call returns, then prints .verify/<run>/02-wait.txt
```

Read the result with `await`, never by reading the file directly: the file only appears once the call has returned. The background call survives between tool calls.

## Evidence

Everything goes to `.verify/<run>/` in the checkout. `.gitignore` covers it, and cleanup keeps it.

```bash
$V save $RUN 01-comment-posted snapshot --selector main     # the command, its output and exit code
$V shot $RUN 02-canvas                                      # .verify/<run>/02-canvas.png
$V shot $RUN 03-panel --selector 'aside[aria-label=Comments]'
```

`save` takes any headless command, `call` included, and writes `<name>.txt` holding the command, its output and `[exit N]`. Number the names so the run reads in order. Read each PNG with the Read tool before you rely on it. `get_screenshot` images and any page screenshot taken without a path land in the session's temp folder. Cleanup copies them into `.verify/<run>/tool-images/`, and the server's log to `.verify/<run>/server.log`. Files you make as test input, like a file to import, go in `.verify/<run>/` too.

A proof meets these standards:

- **The real path.** A person's action goes through the page (click, key, type, upload), and an agent's action goes through an MCP `call`. Use the REST API only to read stored state. Writing through it skips the UI you're proving.
- **Action and result.** Save the step that does the thing and the state after it, not only a final screenshot.
- **Side effects.** Show the change stored as well as shown. `api GET /api/designs/<id>` returns `meta`, `nodes` and `comments` as the server saved them, and an agent's read tool (`get_comments`, `get_shared_css`, `get_tree_summary`) shows what the next agent will see.
- **Both directions for live features.** An agent's edit must appear in the page without a reload. A person's comment must reach a waiting agent.
- **No mocks.** The run uses the real server, the real browser and real MCP sessions.
- **A clean console.** End with `$V save $RUN <n>-console console`. An exception or failed request there spoils the proof.

## Before and after

A bug fix is proven when the same journey fails on the old code and passes on the new. Run both side by side:

```bash
$V launch --at main     # RUN=<before>: a temporary checkout of main, installed and built (about a minute)
$V launch               # RUN=<after>: this checkout
```

Drive the same steps in both, with the same evidence names. The before run must show the bug. If it doesn't, your journey doesn't reach the bug, and the after run proves nothing about the fix. `--at` takes any git ref: a branch, a tag, a commit, or `HEAD` when your fix isn't committed yet. The doctor names the ref and commit a run was built from. Cleanup removes the temporary checkout and keeps its evidence.

## Cleanup

```bash
$V cleanup $RUN
```

It stops this run's daemon. The daemon stops the server it spawned (SIGTERM, so designs save first) and the Chrome it launched, then deletes their temp data and profile. Then cleanup copies the server log and tool images into the evidence folder, removes the temporary checkout of an `--at` run, and lists what it kept. It touches nothing else, so other sessions, `vp run dev` and the desktop app keep running.

`$V list` prints this checkout's runs that are still running or left a checkout behind. Clean each one up with `$V cleanup <run>`, never `pkill`. `$V prune [days]` deletes the evidence of cleaned-up runs older than that many days (7 by default). Never prune a run whose evidence you're about to report.

## Report

End with one block per feature you drove:

```
<feature ID> via <entry point>: proven | skipped | failed
  evidence: .verify/<run>/<files>
  why (skipped or failed): <the command you ran and what was missing or wrong>
```

Then give the run ids, the doctor's output for each, and, for a fix, the before run's evidence that shows the bug. Report a skipped entry point as skipped, even when another entry point proved the same behavior.

## Helper

`scripts/verify.sh` takes these commands: `launch`, `doctor`, `h`, `save`, `shot`, `bg`, `await`, `cleanup`, `list` and `prune`. Run it with no arguments for their arguments. It's a thin layer over `e2e/headless.mjs`: the session is `verify-<run>`, and the evidence goes to `.verify/<run>/`.
