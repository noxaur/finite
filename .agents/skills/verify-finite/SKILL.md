---
name: verify-finite
description: Prove a Finite feature works in the real app and keep the evidence. Starts an isolated headless run (Node server, web app, headless Chrome), drives it the way a person and an agent would, and saves screenshots and transcripts to .verify/<run>/. Use before saying a change to the canvas, inspector, design list, prototypes, threads, comments, tokens or the agent's tools works, before saying a bug is fixed, or when asked to verify, prove or demo one.
---

# Verify Finite

Finite has two actors, and most features need both. A **person** works in the page: the design list at `/`, a design at `/design/?id=<designId>` with its Design and Prototypes tabs. An **agent** works through a thread: the local `claude` CLI, running Finite's canvas tools and Claude Code's file tools on the design's project. A proof drives one actor and checks what the other sees.

The harness is the `finite-headless` skill. Read `.agents/skills/finite-headless/SKILL.md` before your first drive: it has the commands, the selectors and how to click inside a frame.

```bash
RUN=$(date +%m%d-%H%M)-<feature>   # pick once, reuse in every call
f() { node .agents/skills/finite-headless/scripts/finite.mjs "$@" --session verify-$RUN; }
mkdir -p .verify/$RUN
```

## Steps

1. **Pick features.** List every row of the feature map below that your diff's paths touch.
2. **Start** with `f start` (a build of apps/web, about a minute cold; `--no-build` when apps/web didn't change). It prints the URL once the server and the page answer. The data folder starts empty.
3. **Drive** every entry point of each picked feature, saving evidence after each step (see "Evidence").
4. **Stop** with `f stop`. Run `ps aux | grep -E 'apps/server/src/main.ts|vite-host'` and confirm nothing of yours is left.
5. **Report** in the format under "Report".

You're done when every entry point of every picked feature is proven, skipped with a reason, or failed with its evidence.

## Feature map

| Changed path                                                    | Feature and its entry points                                                                                                                                                                                                    |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/store/`, `DesignGrid.tsx`                      | **Design list**: create blank (page), connect a fixture (`f fixture rr-spa`, then the Connect form or `design.connect`), import (page; starts a thread), remove. A connected root must survive removal.                         |
| `packages/vite-plugin/`, `apps/server/src/preview/`             | **Preview**: blank install then `ready`; routes for each fixture (`rr-spa`, `rr-framework`, `tanstack`): `f watch` shows `routes`, the Routes page shows one frame per route; an edit to a file on disk hot-reloads the frame.  |
| `apps/server/src/source/`, `apps/web/src/canvas/`, `inspector/` | **Hand edits**: select in a frame, change style, text, order, remove, duplicate; check the TSX on disk follows the project's convention (Tailwind classes, CSS module rule, inline style); undo and redo; a stale edit refuses. |
| `apps/server/src/source/tokens.ts`, `TokensPanel.tsx`           | **Tokens**: edit a value in the panel and see the CSS file and the frame change; `tokens.get` agrees.                                                                                                                           |
| `apps/server/src/agent/`, `Composer.tsx`, `ThreadList.tsx`      | **Threads**: send from the Prototypes composer (needs a logged-in `claude`); steer and queue while running; snooze, settle, revive by messaging; the thread's frames, labels and comments appear without a reload.              |
| `apps/server/src/agent/policy.ts`, `tools.ts`                   | **Agent fence and tools**: a prototype write lands under `.finite/boards/`; a production write is refused until `move_to_prod`; `screenshot` and `frame_errors` return results.                                                 |
| `Comments.tsx`, `CommentsPanel.tsx`, comment handlers           | **Comments**: a person pins one on an element, an agent's `comment` tool pins one; both show at the element's top-right, and fall back to the frame's corner when the element is gone.                                          |
| `StarMenu.tsx`, `LeftSidebar.tsx`, `DesignScreen.tsx`           | **Shell**: Design / Prototypes switch, pages (create, rename, remove, restore), ✱ menu on a selected frame (Explore directions, Ask about this, Export zip).                                                                    |
| `apps/web/src/styles/`                                          | Every screen above: take a `shot` of each, in each state you changed.                                                                                                                                                           |

Hit every surface the change reaches: both tabs, a blank and a connected design, each router fixture the change can affect, and the reverse state (undo, remove, wake, reopen). A feature an agent can change is proven when a person sees it, and the reverse.

Threads run the real `claude` on the user's subscription. Keep prompts small, and say in the report when `claude.status` showed it logged out and you skipped them.

## Evidence

Everything goes to `.verify/$RUN/`, which `.gitignore` covers. Number names so the run reads in order:

```bash
f shot .verify/$RUN/01-selected.png
f call tokens.get '{"designId":"<id>"}' > .verify/$RUN/02-tokens.txt
cp <root>/src/routes/Home.tsx .verify/$RUN/03-Home.after.tsx
f console > .verify/$RUN/09-console.txt
```

Read each PNG before you rely on it. A proof meets these standards:

- **The real path.** A person's action goes through the page (click, key, type). An agent's action goes through a thread (`f send`) or the composer. Use `call` to read state, or to set up what the feature under test doesn't cover.
- **Action and result.** Save the step that does the thing and the state after it.
- **Stored as well as shown.** A hand edit shows in the TSX on disk; a canvas change in `.finite/canvases/<id>.json`; a thread in `.finite/threads/`.
- **Live in both directions.** An agent's frame appears in the page without a reload, and a person's edit reaches the next `f watch`.
- **A clean console.** End with the console file. A page error there spoils the proof.

## Before and after

A bug fix is proven when the same journey fails on the old code and passes on the new. Make a worktree of the old commit (`git worktree add $TMPDIR/finite-before <ref>`, then `vp install` there), run its own `finite.mjs` with `--session before-$RUN`, and drive the same steps with the same evidence names. If the before run doesn't show the bug, your journey doesn't reach it. Remove the worktree after.

## Report

One block per feature you drove:

```
<feature> via <entry point>: proven | skipped | failed
  evidence: .verify/<run>/<files>
  why (skipped or failed): <the command you ran and what was missing or wrong>
```

Then the run id and, for a fix, the before run's evidence that shows the bug.
