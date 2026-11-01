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

Pass `--env FINITE_MCP_EXTRA=shared-styles` to try a tool group that's off by default. Results go to `e2e/ax/results/<label>/<task>-<n>/`, which git ignores. Each run folder holds `transcript.jsonl`, `feedback.md` (the agent's own account), `metrics.json` and `final.png`. Runs cost real money and use your Claude plan, about $0.05 to $0.80 each. A full round of 18 runs per variant can reach a 5-hour usage limit. A run cut off by a limit is marked `api error` in `metrics.json`, and `report.mjs` leaves it out. `--budget` caps each run at $4 by default.

## Tasks

`tasks.mjs` defines them. Each one has a prompt, a seed and a check.

| Task        | What the agent does                                                                 | What it tests              |
| ----------- | ----------------------------------------------------------------------------------- | -------------------------- |
| `restyle`   | Swap a brand color on one landing page, round the buttons, fix a typo               | Finding things             |
| `rebrand`   | Swap the color across three artboards, including a `<style>` block and an rgba tint | Finding things at scale    |
| `mobile`    | Make a 390 px version of a desktop page                                             | Copying, layout, verifying |
| `comments`  | Handle two pinned comments                                                          | The comment loop           |
| `screens`   | Build a consistent three-screen mobile flow                                         | Building, reuse            |
| `ui-states` | Draw every state of Finite's own web app, from its source                           | A long session             |

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
| ui-states | 45.3 / $0.65, 0.3 errors       | 32.0 / $0.61, no errors |

"After" is the final build. Its ui-states row comes from the round before the instructions fix, with the same tools. Grades stayed level, at 7 to 8 for quality. What made the difference:

- **Search.** Before `find_nodes` and `replace_values`, agents read every artboard's HTML and picked out each color by eye. Every run's feedback asked for search, and nothing told them whether they'd found every use.
- **A screen in one call.** `create_artboard` takes `html` now. Agents used to call `find_placement`, `create_artboard`, `start_working_on_nodes` and `write_html` before any content existed.
- **A layout check under screenshots.** In every mobile run, agents guessed a height and clipped the footer, and saw it only in the image. The note names the clipped element and gives the exact `update_styles` call that fits it.
- **Accepting guessed argument shapes.** Claude Code defers MCP schemas, so agents often call a tool before they've loaded its schema. They send `{"nodeIds": "[\"a\"]", "styles": "{…}"}` instead of `updates`. In the first round, 6 of the 18 mobile and ui-states runs hit "failed to deserialize parameters". None did after the change.
- **Short instructions.** Claude Code keeps only the first 4,096 characters of a server's instructions. One round of runs added sections past that point, and agents never saw them. With the shared-styles section cut off, 0 of 3 agents used the tool. With it in, 3 of 3 did.

Smaller changes: edits name the nodes they changed instead of "Done.", `duplicate_nodes` returns its copies' outlines, comments include their element's HTML, `get_screenshot` takes up to 6 artboards per call, and edits show presence on their own.

Agents also asked for two features Finite doesn't have yet:

- **Shared styles across artboards.** `FINITE_MCP_EXTRA=shared-styles` demos the agent's side (`crates/server/src/mcp/demo.rs`), and [issue #8](https://github.com/noxaur/finite/issues/8) tracks the real feature.
- **Components with instances.** Agents on `screens` and `ui-states` asked for them about as often as for shared styles. There's no demo yet.
