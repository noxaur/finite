# Finite verification map

This folder is the maintained source for proving Finite's user-facing behavior. Read this index before you drive the app, then follow the matching feature file as the recipe. Every command runs through `.agents/skills/verify-finite/scripts/verify.sh` (`$V` below), from the checkout root.

## Baseline preconditions

- A run launched with `$V launch`, and its `RUN` id in hand.
- `$V doctor $RUN` prints only `ok` lines.
- The data folder starts empty, and there's no seed data. Each recipe creates the design it needs with `call designs`.
- The page starts on the design list at `/`.

## Driving conventions

- An agent's action is `$V h $RUN call <tool> '<json>'`. A person's action is a `click`, `key`, `type` or `upload` in the page.
- Find elements by accessible name, `title` or `aria-label`, as the SKILL.md table lists them. Find artboard content with `[data-artboard="<id>"] >>> <css>`.
- Read the ids (designId, artboardId, nodeId, commentId) from each tool's reply. They're random on every run.
- Wait on a state with `$V h $RUN wait '<js>'`, not a fixed `sleep`, except where a gotcha says the page has no state to wait on.
- To run `comments` with `wait` while a person comments, start it with `$V bg`, drive the page, then read it with `$V await`.

## Proof and skip reporting

- Save the action and the resulting state with `$V save` and `$V shot`, numbered in order, under `.verify/<run>/`.
- A stored change needs a second view of it: `api GET /api/designs/<id>` or an agent's read tool.
- A live change needs no reload between the agent's call and the page's check.
- End every proof with `$V save $RUN <n>-console console`. It must show no exceptions or failed requests.
- Name the feature ID and entry point for each artifact in your report.
- Report an entry point you couldn't reach as skipped, with the command you tried and the unmet precondition. Don't count it as proven through a different entry point.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph on what a person or agent sees. Four H2s follow, in this order:

1. `Sub-features`: short IDs, one line each.
2. `How to get to it (user POV)`: every entry point.
3. `Driving it with verify.sh`: `Preconditions:`, then labeled bullets that pair each action with an exact command and the observable result.
4. `Gotchas`: traps that waste or spoil a run.

## Which features a change touches

Run every feature your diff's paths point to. A path in more than one row needs every feature in those rows.

| Changed path                                                                        | Features to run                                                                                                                    |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `crates/server/src/mcp/` (a tool, its params, its result text)                      | The feature that uses the tool (search this folder's files for the tool's name, or the op's), plus [Live canvas](./live-canvas.md) |
| `crates/server/src/mcp/instructions.md`                                             | None in this map: measure it with an AX run (`e2e/ax`)                                                                             |
| `crates/design/src/edit.rs`, `node.rs`, `document.rs`, `html.rs`, `fractional.rs`   | [Live canvas](./live-canvas.md)                                                                                                    |
| `crates/design/src/history.rs`, `design.rs`                                         | [Live canvas](./live-canvas.md) (`canvas-undo`)                                                                                    |
| `crates/design/src/comment.rs`                                                      | [Comments](./comments.md)                                                                                                          |
| `crates/design/src/search.rs`, `crates/server/src/mcp/search.rs`                    | [Live canvas](./live-canvas.md), with `read` `contains` and `replace` op calls                                                     |
| `crates/design/src/tokens.rs`, `crates/server/src/mcp/tokens.rs`                    | [Tokens](./tokens.md)                                                                                                              |
| `crates/wasm/`, `apps/web/src/design/` (socket, session, replica, renderer, camera) | [Live canvas](./live-canvas.md), [Comments](./comments.md)                                                                         |
| `crates/server/src/hub/`, `store.rs`                                                | [Live canvas](./live-canvas.md), [Design list](./design-list.md)                                                                   |
| `crates/server/src/api.rs`, `guard.rs`, `heartbeat.rs`                              | [Design list](./design-list.md), [Comments](./comments.md), [Tokens](./tokens.md), [Import and export](./import-export.md)         |
| `crates/server/src/screenshot/`                                                     | [Live canvas](./live-canvas.md) (`canvas-screenshot`)                                                                              |
| `crates/transfer/`, `crates/server/src/transfer.rs`                                 | [Import and export](./import-export.md)                                                                                            |
| `apps/web/src/components/DesignGrid.tsx`, `Thumbnail.tsx`, `app/page.tsx`           | [Design list](./design-list.md)                                                                                                    |
| `apps/web/src/components/DesignCanvas.tsx`, `app/design/`                           | [Live canvas](./live-canvas.md), [Comments](./comments.md)                                                                         |
| `apps/web/src/components/Comments.tsx`, `CommentsPanel.tsx`, `PinIcon.tsx`          | [Comments](./comments.md)                                                                                                          |
| `apps/web/src/components/TokensPanel.tsx`                                           | [Tokens](./tokens.md)                                                                                                              |
| `apps/web/src/components/PagesSidebar.tsx`                                          | [Pages](./pages.md)                                                                                                                |
| `apps/web/src/components/Transfer.tsx`                                              | [Import and export](./import-export.md)                                                                                            |
| `apps/web/src/styles/`                                                              | Every feature with a screen: take a `shot` of each                                                                                 |

## Not covered yet

This map has no recipe for these. Report them as not covered, and say what you checked instead:

- The desktop app (`apps/desktop`): restarts, updates and its own data folder.
- The Figma plugin (`apps/figma-plugin`).
- Several servers (`cluster.rs`, `router.rs`, `relay.rs`) and the Postgres store.
- Sandboxed (script) artboards, beyond what `render` shows.

## Features

- [Design list](./design-list.md): browse, create and open designs, and search them by name.
- [Live canvas](./live-canvas.md): an agent's edits appear on a person's canvas as they happen, with presence chips and undo per agent.
- [Comments](./comments.md): a person pins a comment to one or more elements, an agent waiting on it answers and resolves it, and the person edits, reopens or deletes it.
- [Tokens](./tokens.md): CSS variables every artboard uses, with a value per mode, edited by a person in the panel or by an agent.
- [Pages](./pages.md): an agent splits a design into pages, and a person switches between them in the sidebar.
- [Import and export](./import-export.md): a person imports a file as artboards and downloads an artboard or the whole design, and agents do the same over MCP.
