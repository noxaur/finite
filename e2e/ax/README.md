# AX: how agents do with Finite's MCP tools

This folder runs real agents against Finite's MCP tools on fixed tasks and measures how it went. Use it before you ship a new tool or change one. A tool that looks right can still cost agents extra calls, or leave them guessing.

Each run starts its own `finite-server` with an empty data folder and seeds a design. Then it runs `claude -p` (Sonnet 5.5 at medium effort by default) with only the Finite MCP server. Afterwards it checks the design, saves a screenshot, and resumes the same agent to ask what went wrong.

```bash
cargo build -p finite-server
node e2e/ax/run.mjs --task restyle,rebrand --runs 3 --label before
node e2e/ax/run.mjs --task restyle,rebrand --runs 3 --label after --bin /tmp/finite-server-new
node e2e/ax/grade.mjs              # blind 1-10 grades of each final screenshot
node e2e/ax/report.mjs --tools     # one row per label and task, plus calls per tool
```

Results go to `e2e/ax/results/<label>/<task>-<n>/`, which git ignores. Each run folder holds `transcript.jsonl`, `feedback.md` (the agent's own account), `metrics.json` and `final.png`. Runs cost real money and use your Claude plan, about $0.05 to $0.80 each. A full round of 18 runs per variant can reach a 5-hour usage limit. A run cut off by a limit is marked `api error` in `metrics.json`, and `report.mjs` leaves it out. `--budget` caps each run at $4 by default.

## Trying a tool design before building it

`--surface <spec>` shows the agent a mock tool surface instead of the server's own tools. `mock-surface.mjs` serves it over stdio and answers each call through the run's real `finite-server`. Seeds, checks, screenshots and metrics all work as in a normal run. A spec file names only what changes. Real tools it doesn't name pass through unchanged. It can:

- **Hide tools** with `drop`, and rewrite the instructions with `instructions: (real) => …`.
- **Rename or re-describe a tool** with `forward: "real_tool"`, and reshape its arguments and reply with `args` and `reply`.
- **Merge or split tools** with `run: async (args, real) => text`, a few lines that call real tools.
- **Fake a feature that doesn't exist** with a canned `text` reply, to see whether agents reach for it.

```bash
node e2e/ax/run.mjs --task rebrand --runs 3 --label no-search --surface e2e/ax/surfaces/no-search.mjs
node e2e/ax/run.mjs --task restyle --runs 3 --label cheap --surface e2e/ax/surfaces/example.mjs --model haiku --effort low
```

`surfaces/example.mjs` has one tool of each kind to copy from. `surfaces/no-search.mjs` drops the search tools, so a round on it against a round on the real server should repeat the first study's rebrand numbers below. Run that comparison before trusting a mock's results. A Haiku run at low effort costs about $0.01, so try designs on Haiku first and confirm the best ones on Sonnet.

Real tools keep the real server's argument checks. For a schema a spec writes, the mock checks required fields and top-level types and enums, accepts arrays and objects sent as JSON strings like the real server, and fails the call with "failed to deserialize parameters" as the real server does. It doesn't check nested schemas. It can only show what the real server can compute. A tool that needs data the server doesn't have yet has to answer with canned text, and then the task's check has nothing real to test, so judge it from the transcript and the feedback.

## Tasks

`tasks.mjs` defines them. Each one has a prompt, a seed and a check.

| Task                  | What the agent does                                                                 | What it tests                 |
| --------------------- | ----------------------------------------------------------------------------------- | ----------------------------- |
| `delete-design`       | Delete one design while keeping another                                             | Design deletion and discovery |
| `restyle`             | Swap a brand color on one landing page, round the buttons, fix a typo               | Finding things                |
| `rebrand`             | Swap the color across three artboards, including a `<style>` block and an rgba tint | Finding things at scale       |
| `mobile`              | Make a 390 px version of a desktop page                                             | Copying, layout, verifying    |
| `comments`            | Handle two pinned comments                                                          | The comment loop              |
| `screens`             | Build a consistent three-screen mobile flow                                         | Building, reuse               |
| `ui-states`           | Draw every state of Finite's own web app, from its source                           | A long session                |
| `pins`                | Put numbered pins over a button and a heading the agent didn't size                 | Finding where things rendered |
| `overlap`             | Fix a small badge overlapping the frame name above it                               | Spotting and fixing overlaps  |
| `sections`            | Fill a fixed-height artboard with six sections, one `write_html` call each          | Overflow after an edit        |
| `screens-change`      | Build three screens, then change their shared top bar in the same session           | Keeping a design up to date   |
| `import-page`         | Import a web page with scripts, handlers and an embed onto a named page             | Importing safely              |
| `screens-restructure` | `screens-change`, but the change adds elements to the bar, which shared CSS can't   | Components                    |
| `export-figma`        | Export a design as a file for the Finite Figma plugin                               | Getting a file out            |

## Trying an idea cheaply first

A full run costs about $0.30 and builds a design from nothing. Most ideas change one step, so `micro.mjs` seeds the design as it is just before that step, and any agent with a shell does the step through a small CLI that logs every call:

```bash
node e2e/ax/micro.mjs start /tmp/micro/a --scenario change-component
node e2e/ax/micro.mjs brief /tmp/micro/a     # the task, the server's instructions and every tool's schema
node e2e/ax/micro.mjs call /tmp/micro/a get_tree_summary '{"designId":"…"}'
node e2e/ax/micro.mjs check /tmp/micro/a     # the checks, and calls, edits and errors per phase
node e2e/ax/micro.mjs stop /tmp/micro/a
```

An idea goes through three steps, each cheaper to skip past than the next:

1. Walk the shortest path by hand with `call`. It costs nothing, and counts the calls an idea needs at best. For components, that's how a bug showed up: rewriting a component in one call made every screen lose its own title.
2. Hand the brief to a few agents of another model, like Codex, and compare the logged calls and edits. They take more calls than Claude agents, mostly status and re-reading, so compare edits, not totals.
3. Confirm the winner with `run.mjs` and real Claude agents.

The scenarios are `change-copies`, `change-component` and `build`. In the first comparison, changing three screens' top bar took 7 edits with copies, 3 with a component made by `create_component`, and 1 with a component named in the HTML and rewritten in place. Claude agents on `screens-restructure` then named the bar in their HTML in every run. In the first two runs, the change took 7 calls: the rewrite added a title element with no per-screen value yet, and the agents read the tree to find its id in each instance. Since edits name those ids, it took 4 and 5 calls, against 5 and 6 without components.

## What the metrics mean

- `calls` counts every tool call, including Claude Code's `ToolSearch`, which loads deferred MCP schemas.
- `errors` are failed tool calls.
- `outside` counts calls to anything but Finite, like `Bash`, which is how workarounds show up.
- `readKChars` is how much tool output the agent read, apart from images.
- `quality` and `fit` come from `grade.mjs`. It gives the task and a copy of the image to a grader that doesn't know the variant.

## What the first study found (November 2026)

Sonnet 5.5 at high effort compared Finite with Paper, Figma, Pencil, Penpot, Framer and Webflow. Then Sonnet 5.5 at medium effort ran each task 3 times on each variant: 18 runs per variant, about 130 in all. Every check passed in every variant, so the differences are in effort, not success.

| Task      | Before: calls / cost           | After: calls / cost     |
| --------- | ------------------------------ | ----------------------- |
| rebrand   | 11.3 / $0.11, read 11.8k chars | 5.7 / $0.05, read 4.0k  |
| screens   | 14.0 / $0.11                   | 6.3 / $0.08             |
| mobile    | 14.7 / $0.13                   | 8.3 / $0.10             |
| ui-states | 45.3 / $0.65, 0.3 errors       | 25.0 / $0.50, no errors |

"After" is the final build. Grades stayed level, at 7 to 8 for quality. What made the difference:

- **Search.** Before `find_nodes` and `replace_values`, agents read every artboard's HTML and picked out each color by eye. Every run's feedback asked for search, and nothing told them whether they'd found every use.
- **A screen in one call.** `create_artboard` takes `html` now. Agents used to call `find_placement`, `create_artboard`, `start_working_on_nodes` and `write_html` before any content existed.
- **A layout check under screenshots.** In every mobile run, agents guessed a height and clipped the footer, and saw it only in the image. The note names the clipped element and gives the exact `update_styles` call that fits it.
- **Accepting guessed argument shapes.** Claude Code defers MCP schemas, so agents often call a tool before they've loaded its schema. They send `{"nodeIds": "[\"a\"]", "styles": "{…}"}` instead of `updates`. In the first round, 6 of the 18 mobile and ui-states runs hit "failed to deserialize parameters". None did after the change.
- **Short instructions.** Claude Code keeps only the first 4,096 characters of a server's instructions. One round of runs added sections past that point, and agents never saw them. With the shared-styles section cut off, 0 of 3 agents used the tool. With it in, 3 of 3 did.

Smaller changes: edits name the nodes they changed instead of "Done.", `duplicate_nodes` returns its copies' outlines, comments include their element's HTML, `get_screenshot` takes up to 6 artboards per call, and edits show presence on their own.

Agents also asked for two features Finite didn't have:

- **Shared styles across artboards.** `set_shared_css` and `get_shared_css` (`crates/server/src/mcp/styles.rs`) started as a demo that kept the CSS in the server's memory. Now the CSS is part of the design ([issue #8](https://github.com/noxaur/finite/issues/8)), and every agent gets the tools (see below).
- **Components with instances.** Agents on `screens` and `ui-states` asked for them about as often as for shared styles. [Issue #11](https://github.com/noxaur/finite/issues/11) added them, with the tools behind `FINITE_MCP_EXTRA=components` at first; they load by default now, and doc6 has a `component` op. `screens-change` measures them: a task with a follow-up prompt runs it in the same session, and `report.mjs` shows its calls in the `change` column.

## What the second study found

The agent that drew Finite's UI states listed what cost it the most. First, it had to paste the same styles into every artboard. Second, it couldn't tell where things rendered, so it guessed coordinates for pins and outlines, took a screenshot and fixed them. Three pins and one outline were wrong on its first try. The `pins`, `overlap` and `screens-change` tasks test exactly those, again 3 runs per variant with Sonnet 5.5 at medium effort.

| Task                                   | Before          | After           |
| -------------------------------------- | --------------- | --------------- |
| `pins` calls / screenshots / fit grade | 8.0 / 2.3 / 7.7 | 6.0 / 0 / 9.0   |
| `overlap` calls / errors / screenshots | 8.3 / 1.0 / 3.0 | 7.0 / 0 / 0.3   |
| `screens-change`, calls for the change | 3 to 5          | 2, in every run |
| `ui-states` cost / time                | $0.53 / 145 s   | $0.41 / 111 s   |

What made the difference:

- **`get_layout`.** It lists every element with where it rendered, and flags content cut off by the artboard's edge, text overflowing its box, and text overlapping other text. It takes no picture and answers in about 0.4 s. Agents used it in every `pins` and `overlap` run and stopped taking screenshots to find positions. Its first version gave only element boxes. A heading's box can span the page while its text is 70 px wide, so agents centered pins on empty space. Now it also says where an element's text sits when that's much smaller than its box.
- **Shared CSS for every agent.** With the tools on, every `screens-change` agent put the top bar's styles in the shared CSS. The change was then one `set_shared_css` and one screenshot. Without them, agents edited each screen.
- **Accepting what agents meant.** `get_screenshot` and `get_layout` with only a `designId` now cover every artboard, which every `overlap` agent on the old build tried, and got an error. Passing the `designId` as a `nodeId` says so. `create_artboard` takes `class`, because two agents styled `.screen` in a `<style>` block and found the artboard itself had no class.

## What the third study found: six tools

Finite's ~35 tools cost an agent a call for nearly every element it touched. The redesign, doc6, has six: `designs`, `read`, `edit`, `render`, `comments` and `undo`. Elements are addressed with CSS selectors, and one `edit` call is a list of ops that apply all or nothing, as one change and one undo step. It was tried first as a mock surface (`--surface`, PR #41), against a 24-tool design with the same parameter names everywhere. doc6 took 123 calls to the other's 149 and today's 198 on Haiku, with level grades, so it was built (#75, #76, #78) and is now what `/mcp` serves. `--env FINITE_MCP_SURFACE=classic` runs today's tools instead, for comparisons.

On the real build, every task passed every check on both surfaces:

| Tasks                                       | Model         | Classic calls | doc6 calls   |
| ------------------------------------------- | ------------- | ------------- | ------------ |
| 9 small-design tasks × 2                    | Haiku low     | 181, 7 errors | 102, 1 error |
| 9 small-design tasks × 2                    | Sonnet medium | 143           | 91 (−36%)    |
| `big-edit` and `big-wiki` × 2 (large pages) | Sonnet medium | 156           | 56 (−64%)    |

The small tasks are the first study's six plus `delete-design`, `import-page` and `export-figma`. The gap is widest on large pages, because classic agents read and edit them element by element. One Haiku agent took 119 calls to change a word through the Wikipedia article, which is one `replace` op on doc6.

`big-edit` and `big-wiki` edit inside real websites saved as one HTML file each, with their CSS inlined: Stripe's home page (4,800 nodes, 560 KB of CSS) and Wikipedia's Typography article (6,700 nodes). Third-party pages aren't committed, so save your own and point `FINITE_AX_PAGES` at their folder. To save one, open the page in a browser, inline every `document.styleSheets` rule into one `<style>` (fetch cross-origin sheets yourself), and save `document.documentElement.outerHTML`.

What the rounds changed, each from a transcript or an agent's feedback:

- **A design's name works as its `designId`.** 2 of 3 `rebrand` agents on the first mock passed "Acme site" and got an error.
- **The layout check runs after every edit**, because agents asked for it on almost every edit. It waits up to 5 s for a cold browser: with a 1 s wait it often came back empty, and agents rendered to find out.
- **`dryRun`.** Four agents asked to preview a broad `replace` before applying it.
- **A rewrite keeps ids.** An `html` op with mode `inner` or `replace` updates the elements that keep their `data-id`, and keeps what another agent changed since this one read them (#68, #70, #73). Before, a rewrite gave every element a new id, left comment pins on deleted nodes, and could wipe another agent's newer change.
- **`replace` can look only in text.** A Sonnet agent renamed "typeface" through the article with `includeText`, which also rewrote 30 links, ids and titles. It spent 215 s and five `Bash` calls putting them back. With `in: "text"` (#79), the same task took 6 or 7 calls and 16 s.
- **A `remove` whose matches nest is refused.** `:has(…)` matches every ancestor of its target, and a dry run of one such remove would have deleted a whole imported page.
- **Large imports work.** Imported pages were cut to 900 px, lost their `html`/`body`/`:root` CSS, and returned 51 KB of diagnostics (#71).

When a mock and a real build disagree, read the transcripts before trusting either: the real build's first round was 13 calls worse than the mock, from the layout check's short wait and a missing overlap check, both found in transcripts.
