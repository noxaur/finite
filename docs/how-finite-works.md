# How Finite works

Finite is a design canvas that only agents edit. An agent connects over MCP and sends tool calls like "write this HTML into that artboard". The Rust server turns each call into a few small edits and applies them to the one true copy of the design. Then it streams those edits to every browser that has the design open. Each browser keeps its own copy, applies the same edits with the same Rust code compiled to WebAssembly, and patches the page.

If you remember two ideas, make it these. The rest of this guide builds on them.

- **Every change is a list of ops.** An op is one tiny edit, like "set this node's `color` to red". Applying an op hands back its inverse, the op that undoes it. Undo, live updates and the comment links are all built from ops.
- **The server is the single source of truth.** Each design has a lock, so its edits happen one at a time in one order. Every browser applies the same ops in the same order, so every copy ends up the same.

How far you read depends on what you want:

- **To understand Finite,** read through "Following one edit end to end". That covers the document, undo, the server and one edit's whole trip.
- **To change the browser side,** read "The viewer" and "Comments". "The viewer" ends with how a browser reconnects without starting over, and how each end notices a connection that died silently.
- **To run it for real,** read "Saving and recovering". It covers what's saved, when, and what survives a crash, undo included.
- **To test a change the way a person sees it,** read "The end-to-end test".
- **To look up a limit,** like how many nodes a design holds, see "Limits at a glance" near the end.
- **To run more than one server,** read "Running more than one server" at the end. It covers servers that share a Postgres database and fail over to each other. One server is the default, and you can skip that section until you need it.

"Words used in the code" at the very end is a glossary for when a term isn't clear.

## The big picture

```
 Agent (Claude, Cursor, …)                      Browser
        │  MCP tool call                           ▲  WebSocket: snapshot, then changes
        ▼                                          │
 ┌─────────────── finite-server (Rust, axum) ──────┴──────────┐
 │  mcp/     tool → edit command → ops                        │
 │  hub/     lock the design, commit, broadcast, save later   │
 │  api.rs   REST + WebSockets for the web app                │
 │  store.rs snapshot + append-only journal per design        │
 └────────────────────────────────────────────────────────────┘
        uses
 ┌─────────── finite-design (Rust, no I/O) ───────────┐
 │  node, document, design, history, edit, html, …    │
 └────────────────────────────────────────────────────┘
        compiled to WebAssembly by crates/wasm, so the browser runs it too
```

That's one server, which is the default. With several, a router sits in front, and each server holds a share of the designs (see "Running more than one server").

You can think of the code as three layers:

| Layer          | Where                 | What it knows                                                         |
| -------------- | --------------------- | --------------------------------------------------------------------- |
| Document model | `crates/design`       | Nodes, ops, undo stacks, edit rules, HTML. No network, no disk.       |
| Browser build  | `crates/wasm`         | The document model as `finite.wasm`, with a small API for the viewer. |
| Server         | `crates/server`       | Who is calling, locking, broadcasting, saving, screenshots.           |
| Viewer         | `apps/web/src/design` | A copy of the document, the DOM it draws, and the pan-and-zoom view.  |

The document model has no I/O on purpose. You can test it with plain function calls, and it compiles to WebAssembly, so the browser runs the exact same rules. "One set of rules for server and browser" explains how.

## A design is a flat map of nodes

A design holds artboards, and artboards hold ordinary HTML. Finite stores that tree as a flat map from node id to node, where each node points at its parent:

```json
{
  "id": "4biyjm26",
  "parent": "k2n0d9xa",
  "index": "V",
  "type": "element",
  "tag": "button",
  "name": "Primary CTA",
  "styles": { "background-color": "#111" },
  "attrs": {}
}
```

A few rules shape everything else:

- A node with `parent: null` is an artboard. Only artboards have a canvas position (`x`, `y`).
- A node is either an element (a tag, styles and attributes) or a text node (a string).
- Sibling order comes from `index`, a short string such as `"V"` or `"Vk"`. Siblings sort by it. This is **fractional indexing**. To put a node between `"V"` and `"W"`, you give it a key like `"VV"`. A move rewrites only the moved node. `crates/design/src/fractional.rs` implements it.
- A **property** is one addressable value on a node: `name`, `text`, `x`, `y`, `style:<css-property>` or `attr:<attribute>`. Properties are the unit of conflict. If two agents set the same property, the later write wins. If they set different properties on the same node, both stick.

`Document` in `crates/design/src/document.rs` holds the map. `Node` and `PropKey` are in `node.rs`.

Next to the map, `Document` keeps a **child index**: for each parent, its children's ids sorted by `(index, id)`. Every create, delete and move updates it. Without it, listing a node's children meant scanning the whole design, so deleting a big artboard took quadratic time. You can measure it with `cargo run --release -p finite-design --example big_design`. On a 20,201-node artboard, the delete dropped from 428 ms to 13 ms. That matters because an edit holds the design's lock, so every other agent and viewer waits for it.

## Ops and their inverses

There are only five ops:

| Op       | What it does                               | Its inverse                    |
| -------- | ------------------------------------------ | ------------------------------ |
| `create` | Inserts one node                           | `delete` that node             |
| `delete` | Removes a node and its whole subtree       | `create` every removed node    |
| `set`    | Sets or clears one property                | `set` it back to the old value |
| `move`   | Gives a node a new parent and/or index     | `move` it back                 |
| `css`    | Replaces or clears the design's shared CSS | `css` with the old stylesheet  |

The **shared CSS** is one stylesheet for the whole design, so agents define classes like `.btn` and variables like `--brand` once instead of in every artboard. It's the only op that targets the design rather than a node, so `Op::id` is empty for it. The document holds it next to the nodes, and snapshots carry it as `css`, so it's saved, sent to viewers and undone like any edit. Every artboard renders with it inside a **cascade layer**, `finite-shared`. Styles outside any layer beat layered ones whatever their specificity, so an artboard's own `<style>` blocks and inline styles override the shared CSS, even a more specific shared selector. The cascade reverses that for `!important`, so a shared `!important` beats the artboard's. Leading `@import`s can't go inside a layer block, so they get `layer(finite-shared)` instead. The base styles sit in an earlier layer, `finite-base`, so the shared CSS can override them, like the font a shadow root's `all: initial` resets.

`html::shared_style` writes the stylesheet out, and screenshots, the viewer's shadow roots and sandboxed iframes, and thumbnails all use it, the viewer through WebAssembly. It breaks up any `</style` so the CSS can't end its element, whichever way it reached the document. In a shadow root, `:root` matches nothing, so there it writes `:root` selectors as `:host`, and variables like `--brand` still reach the artboard. `set_shared_css` and the web API refuse CSS over 100,000 characters or with `</style` in it (`edit::set_css`).

`Document::apply` runs one op and returns its inverse, read from the document at that moment. This is the **command pattern**.

An op that no longer makes sense is skipped. A `set` on a deleted node does nothing. So does a `create` under a missing parent, or a `move` that would put a node inside itself. Skipping instead of failing is what keeps undo safe when other agents have changed things in the meantime.

## A design: the document plus everyone's history

`Design` in `crates/design/src/design.rs` wraps the document with three more things:

- **`seq`**, a counter that goes up by one for every change. It's how browsers know they're up to date.
- **One history per actor.** An actor is whoever made a change. Today that's an agent: its `X-Finite-Agent` header if it sends one, otherwise its MCP session id. A `History` (`history.rs`) is an undo stack and a redo stack of inverse ops.
- **Comment threads**, and a **change log** of the last 512 changes. Both are covered under Comments below.

All edits go through three methods. Each returns a `Change`, or `None` if nothing changed. A change holds the seq, the actor, a label and the ops that took effect.

- `commit(actor, label, ops)` applies the ops and pushes their inverse onto that actor's undo stack.
- `undo(actor)` pops the actor's latest undo entry and applies it as a new change. The inverse of _that_ goes on the redo stack.
- `redo(actor)` does the same in the other direction.

Undo applies inverses as new changes. It never rolls the document back to an old snapshot, so it can't erase another agent's work. This follows Liveblocks' design for [multiplayer undo](https://liveblocks.io/blog/how-to-build-undo-redo-in-a-multiplayer-environment).

Each stack keeps at most 200 steps and about 32 MB of ops (`History::LIMIT` and `History::BYTE_LIMIT`), and older steps fall off the bottom. The size estimate, `Op::size`, adds up an op's strings plus a fixed amount, so it's cheap enough to run on every step. The byte limit matters because undoing a big delete recreates every node in it. Two hundred steps that each replaced a large artboard could hold millions of nodes, in memory and in every saved snapshot. The newest step is always kept, even if it's bigger than the limit on its own, so any edit can be undone at least once.

### Undo with two agents, step by step

Say Alice and Bob are both agents on one design:

1. Alice creates artboard `a`. Her undo stack: `[delete a]`.
2. Bob creates `b` inside `a`. His undo stack: `[delete b]`.
3. Alice colors `b` red. Her undo stack: `[delete a, set b.color = none]`.
4. Bob undoes. `b` is deleted. Alice's red is gone with it, which is correct because the node is gone.
5. Alice undoes. Her top entry, `set b.color = none`, targets a node that no longer exists, so it's skipped and dropped. Undo falls through to `delete a`.

The test `undo_only_reverses_own_changes` in `design.rs` runs exactly this.

### One set of rules for server and browser

The browser applies ops too, and it used to do that with a TypeScript copy of the rules. The copies drifted. The first test that compared them found three ways the browser disagreed. It cleared `x` when an op set it to the string `"10"`. It also accepted invalid indexes like `"V0"`, and moves to where a node already was. HTML export drifted too. Screenshots used the indented export, so `<b>Bold</b><i>Italic</i>` showed as "Bold Italic" in a screenshot but "BoldItalic" in the browser.

Now there's one copy. `crates/wasm` compiles `finite-design` to WebAssembly, and the viewer loads it as `finite.wasm`.

`Replica` applies ops by calling the Rust `Document::apply`. Sandboxed artboards render `html::export_for_viewer`, which is the screenshot export plus each element's node id. The renderer checks attributes with `html::is_safe_attr`, and it takes the base CSS and the content policy from `html.rs`. "The viewer" below covers how a call into WebAssembly works.

To change a rule, you change the Rust code. When you run `vp test`, it rebuilds `finite.wasm` before the web tests run, so they test the code you just wrote.

A **golden file** records expected results, and a test compares against it. Once the browser ran the Rust code, comparing two copies of a rule proved nothing, so each golden file now has a narrower job:

- **`crates/design/fixtures/apply.json`** lists op cases: starting nodes, a list of ops, and the expected nodes and sibling order. `crates/design/tests/conformance.rs` checks the Rust rules against it, so a change that alters a result shows up as a diff. `apps/web/src/design/conformance.test.ts` runs the same cases through WebAssembly, one op at a time and as one change. It checks that the viewer's cache of nodes and sibling order ends up where the Rust side does. No Rust test can see that cache.
- **`crates/design/fixtures/export.json`** records the HTML that screenshots render. `html.test.ts` runs it through the module. One case uses text outside ASCII, so it also checks that text survives the trip as UTF-8.
- **`crates/design/fixtures/limits.json`** holds the comment limits: 4,000 characters for a comment or reply, and 48 for a person's name. `crates/design/tests/limits.rs` records the Rust constants, and `apps/web/src/lib/limits.test.ts` checks the web app's copies. Those copies are still TypeScript, so this file still guards a real copy. The comment box stops at the same length the server accepts. Before, a longer comment just failed to post.

Two golden files are gone. The attribute cases are a plain table in `crates/design/tests/attributes.rs` now, because there's no second copy to compare. And `export.json` no longer records the base CSS and content policy, because the browser reads them from Rust.

To regenerate a file after you change a rule, run its test with `FINITE_UPDATE_FIXTURES=1`:

```bash
FINITE_UPDATE_FIXTURES=1 cargo test -p finite-design --test conformance
```

The formatter skips `crates/*/fixtures`, so a regenerated file only changes where the results did.

## Edit commands: from a tool call to ops

Agents don't send ops. They call tools with friendlier arguments, and `crates/design/src/edit.rs` translates them. If you want to add a tool, you start here. Each command reads the current document, checks the request, and returns ops. It never changes the document itself.

Some of the work these commands do:

- `write_html` parses HTML with `html.rs`, drops anything unsafe (`on*` attributes, `javascript:` URLs, `<iframe>` and the like), and emits one `create` per node. `set_attributes` refuses the same attributes using the same rule (`html::is_safe_attr`). It also refuses names that aren't valid attribute names, because exports write names as they are, and a name like `x" onload="…` would break out of its tag.

A script URL is refused anywhere in a value, not just at its start. SVG animation can set an `href` while the page runs, from a list like `<animate attributeName="href" values="0;javascript:…">`, and an artboard without a script renders in a shadow root on the app's own origin. So a check that only looked at the start of the value let that through, and a click would have run the script as the app. The viewer's renderer checks attributes again before it sets them, with the same function through WebAssembly. The end-to-end test writes that SVG and checks the attribute never reaches the page.

- `update_styles` accepts `backgroundColor` or `background-color`. When you set a shorthand like `padding`, it also clears `padding-top` and friends. Styles are stored as a map, not as ordered CSS, so a leftover longhand would otherwise win.
- `move_nodes` and `duplicate` pick free canvas space for anything that becomes a new artboard.
- `delete_nodes`, `move_nodes` and `duplicate` first drop ids that are inside another id in the same call, and repeats (`top_level`). Each node walks up its ancestors instead of being compared with every other id. The comparison was quadratic, and it kept repeats, so deleting 10,000 cards with 100 of them listed twice made 10,050 deletes.
- `duplicate` puts each copy right after its original, so it asks `Document::index_after` for the next sibling's index once per copy. That used to build the whole sibling list and scan it each time. Now it's a range lookup in the child index, which is sorted. Duplicating 10,000 siblings took 24.7 seconds in a debug build. The whole test now runs in 0.4 seconds.

Nodes can nest at most 256 levels deep (`MAX_DEPTH` in `document.rs`). An artboard is at depth 0, its children at 1, and so on. `write_html` and `move_nodes`, the only commands that can make a tree deeper, refuse anything that would pass the limit and say why. The limit exists because exports, the outline and the browser's renderer walk the tree recursively. Before it, `write_html` with 5,000 nested `<div>`s, about 50 KB, overflowed the stack and aborted the whole server, taking every design and viewer with it. Chrome's HTML parser has a similar limit and stops nesting at 512 levels.

Deep HTML is also slow to parse. html5ever, the HTML parser behind `scraper`, takes time quadratic in the nesting depth: 10,000 levels took 0.13 seconds in a release build, and 100,000 took 10. Parsing doesn't need the document, so the `write_html` tool parses on Tokio's blocking pool before it takes the design's lock (`edit::parse_html`, then `edit::write_fragments` under the lock). For 3 MB of ordinary HTML, parsing took 36 ms and building the ops 8 ms, so most of that work no longer holds up other agents and viewers.

Still, parsing thousands of levels would tie up a thread, so `html::parse` first runs a one-pass scan that counts start tags minus end tags. If that count passes 4,096, sixteen times the limit, it refuses the HTML without parsing it. The count can be too high, for example when a `<p>` is left open and the parser closes it at the next `<p>`. It's never too low, and that margin keeps ordinary HTML from being refused by mistake.

A test in `edit.rs` writes 1,000,000 levels on a thread with a Tokio worker's 2 MiB stack and gets the error in well under 2 seconds. It also checks that a tree at the limit still exports on that stack in a debug build.

A design also holds at most 100,000 nodes (`MAX_NODES`), and `write_html` and `duplicate` refuse edits that would pass it. When `write_html` replaces nodes, the ones it removes count against what it adds. For scale, the `big_design` example's 20,201-node artboard is already a big design. Without a limit, the largest `write_html` one MCP call can carry, 4 MB of `<i></i>`, made about 600,000 nodes. Its ops came to 92 MB of JSON, which the server journals and sends to every viewer, and an agent stuck in a loop could keep going. `cargo run --release -p finite-design --example big_design` now shows that write refused in about 0.2 seconds, most of it parsing.

## The server

### The hub

The hub lives in `crates/server/src/hub/`, in three files:

- `mod.rs` has `Hub`, the registry of designs. It finds, creates, loads, unloads, saves and hands off designs.
- `design.rs` has `DesignHandle`, one design and every way to change it.
- `messages.rs` has what goes out on the WebSockets: `Actor`, `Presence`, `DesignSummary` and the message types.

The hub holds a `DesignHandle` for every design. Each handle has:

- a **mutex** around the design's state, so edits to one design run one at a time and edits to different designs never wait on each other;
- a **save queue**: every change, comment update and rename is queued as a record, and a background task writes the queue 250 ms after the last edit.

While the design is loaded, its state also holds a **broadcast channel**, which fans each change out to every open WebSocket, and the latest changes for browsers that reconnect. Each message is turned into JSON once, as reference-counted bytes (`Outgoing` in `hub/messages.rs`), so sending it to another socket copies a pointer, not the message. Before, each send copied the whole string, so a 15 MB change sent to ten viewers made ten 15 MB copies.

`DesignHandle::edit` is the path almost every tool call takes:

1. Lock the design.
2. Run the edit command against the current document to get ops.
3. `Design::commit` them. This also logs the change for comments.
4. Broadcast the change, keep it for browsers that reconnect, and mark the design dirty.

Because steps 2 and 3 happen under one lock, no other edit can sneak in between reading the document and writing to it.

### Designs load and unload like rooms

A multiplayer server usually treats each document as a **room**: it's loaded into memory when someone joins, and unloaded when everyone has left. Finite's hub works the same way, so memory grows with the designs in use, not with every design ever made.

- **Loading:** `Hub::open` is the way in for requests. If the design's state isn't in memory, it reads the snapshot and journal and replays them. That read runs on Tokio's **blocking pool**, a separate set of threads for slow work like disk reads, so opening a large design never stalls other requests. `Hub::get` does the same on the calling thread, for tests and code that isn't async.
- **Unloading:** every 30 seconds, the hub's sweep looks for designs to drop. A design unloads only when all of these hold:
  - nothing is waiting to be saved;
  - nobody is watching it;
  - no agent has presence in it;
  - no live MCP session has undo history in it;
  - it hasn't been opened for five minutes.

  Other undo histories don't keep a design in memory, because they come back with it from the store (see "Undo across restarts"). The sweep first asks for a full snapshot, so the store has each history as it is now, then unloads the design on its next pass.

- **Peeking:** some reads don't need the design kept in memory. The design list draws a thumbnail for each card, and each thumbnail fetches the design's snapshot with `GET /api/designs/{id}`. That request uses `Hub::peek`: a loaded design is read from memory, and a cold one is read from the store and dropped again. Without it, scrolling through the list would load every design for five minutes.
- **What stays:** the handle itself stays, with a cached `DesignSummary`. That's what the design list shows, so listing designs never loads one. The broadcast channel that feeds the design's sockets is part of the loaded state, not the handle. Its buffer is allocated up front, about 30 KB, and a design that isn't loaded has no sockets. With 20,000 stored designs and none open, a design costs about 2 KB of memory, down from 35 KB when the channel lived on the handle. `cargo run --release -p finite-server --example cold_designs` measures it.

Unloading can't race with loading. The sweep holds the hub's write lock, which blocks `Hub::get`, and only unloads a handle when the hub holds the only reference to it. Anything using a design got it from `Hub::open` or `Hub::get`, so it holds a reference, and the design stays loaded until it's done. The save task holds only a weak reference, so it never keeps a design in memory.

On startup, the hub reads every stored design to build the list, then drops each one, so startup never holds every design in memory either. Designs don't depend on each other, so the reading is split across one thread per core (`summaries` in `hub/mod.rs`). With 5,000 designs of about 11 KB each, a 10-core Mac starts in about 0.1 seconds instead of 0.4. `cargo run --release -p finite-server --example startup` measures it.

### MCP

`crates/server/src/mcp/` is the agent-facing side, served at `/mcp` over Streamable HTTP with the `rmcp` crate. It has six files:

- `mod.rs` defines most tools and works out which actor is calling.
- `params.rs` holds each tool's arguments. `rmcp` turns them into the JSON schemas agents see. Batched edits also accept the shapes agents guess before their client loads a schema: lists and objects sent as JSON strings, a flat `nodeIds` and `styles` instead of `updates`, and `nodeId` for `nodeIds`. Before, a third of the longer AX runs hit "failed to deserialize parameters" at least once.
- `format.rs` writes the compact outlines that tools like `get_tree_summary` return, and the layout notes under screenshots.
- `search.rs` has `find_nodes` and `replace_values`, over `finite_design::search`. They shipped behind a flag first, until AX runs showed they help.
- `styles.rs` has `set_shared_css` and `get_shared_css`, for the design's shared CSS. They shipped behind `FINITE_MCP_EXTRA=shared-styles` until AX runs showed agents use them, and now every agent gets them. `get_html` notes when a design has shared CSS, since HTML copied elsewhere would lose it.
- `instructions.md` is the text agents read when they connect. It's plain Markdown, so you can edit the workflow without touching Rust. Keep it short: Claude Code keeps the first 4,096 characters of a server's instructions and silently drops the rest. A test checks that the instructions, with every extra group's section added, stay under 4,000.

`e2e/ax` measures how real agents do with the tools (see its README). Every change to a tool's shape, description or result is worth a run there before and after.

`crates/server/tests/mcp.rs` drives the endpoint the way an agent does. It opens a session, builds and styles a design, undoes, and answers a user's comment. If you change a tool, run it with `cargo test -p finite-server --test mcp`. The tool names follow [Paper's MCP server](https://paper.design/docs/mcp). Every tool except `list_designs` and `create_design` takes a `designId`. `list_designs` returns the 50 most recently edited designs, or up to 200 with a `limit`, and a `query` finds designs by name. Names are cut at 120 characters, so 200 entries always fit in one result. The maximum used to be 500, which could come to about 115,000 characters.

#### Keeping tool results short

Every tool's result now fits in one budget of 60,000 characters, or says how to get the rest. The tools below were changed to make that true. The rest return a fixed sentence or a short list, like `get_history`'s 400 labels at most.

A long list in a tool result fills the agent's context, so a list that stops short ends with a note saying how many there are. The same goes for the tree: `get_tree_summary`, `get_html` and `write_html`'s report return at most 60,000 characters, about 15,000 tokens (`OUTPUT_LIMIT` in `mcp/format.rs`). Claude Code cuts MCP results at 25,000 tokens by default, wherever that falls, so Finite cuts first, at the end of a line, and says how to see the rest: "… cut off after 1738 of 6001 lines. Pass the nodeId of one part, or a smaller depth, to see the rest."

How each tool stays within it:

- **`get_html`:** cut HTML would be broken HTML, so a result that's too long returns the node's outline and asks for `get_html` on a child instead. For a node with no children that's still too long, like an image with inline data, it points to `get_node_info` instead. `get_html` itself never shortens values, because an agent that wrote the HTML back would replace the real data with the shortened text.
- **`get_basic_info`:** lists the first 200 artboards next to an `artboardCount`.
- **`duplicate_nodes`:** lists each copy's outline, three levels deep, so agents can edit inside a copy without reading it again. `cut` stops between lines.
- **`get_children`:** returns 200 children at a time and says how to get the next ones: "Showing children 1 to 200 of 3000. Pass offset 200 for the next ones."
- **`get_node_info`:** returns the first nodes that fit and says how many more were asked for. Within one node, a value longer than 2,000 characters comes back as its first 200 and its length, because an image's inline `data:` URL can be megabytes of base64. `childIds` lists the first 200 children next to a `childCount`.

A test in `tests/mcp.rs` builds an artboard of 3,000 cards and checks all five. Writing the `get_node_info` check found a bug in how `fit` sizes lists: it measured each item on its own, but inside the pretty-printed array every line is indented two more spaces. So 1,000 nodes came back as 67,306 characters, over the budget. The count now includes that indent.

#### Locks, presence and sessions

Read tools (`get_tree_summary`, `get_node_info`, `get_html`, `get_screenshot`) lock the design just long enough to copy what they need. `get_screenshot` calls `screenshot::plan` under the lock, which writes each artboard it needs as a standalone HTML page. Then `screenshot::capture` renders the pages without the lock. It starts headless Chrome and drives it over the **Chrome DevTools Protocol** (CDP) (`screenshot/cdp.rs`), a WebSocket API for controlling the browser. Chrome's `--screenshot` flag can only capture the whole window, and CDP can crop. The page carries each element's node id as `data-finite-id`, so `capture` measures the element's box with `getBoundingClientRect` and passes it to `Page.captureScreenshot` as the clip. One call can take up to 10 shots: whole artboards, nodes, regions of a node, with padding. It can also hide or outline nodes, leave out backgrounds, and show content that overflows the artboard. Each capture starts its own browser, so a **semaphore** caps how many run at once: half the CPU cores, between 1 and 4. Further captures wait their turn. On a 10-core Mac, six agents asking at once got their screenshots in about 5 seconds, and at most 4 browsers ran together.

A page with scripts or animations runs for 3 seconds before its capture. A static page is captured once its images and fonts load. Each image comes with text that says where the shot sits in the artboard and what the node's box is. The text also says whether the shot was cut off at the artboard's edge, and how far the content overflows the artboard.

A screenshot's longer side is at most 3,000 pixels (`MAX_OUTPUT_SIDE`). The Claude API refuses images over 8,000 pixels on a side, and once a request holds more than 20 images, a stricter limit applies to every image in it. An agent checking its work passes 20 screenshots quickly, and [Anthropic's vision docs](https://platform.claude.com/docs/en/build-with-claude/vision) suggest at most 3,000 pixels a side to stay under that limit everywhere. So a 1440 × 8000 artboard at scale 2 comes back at 0.375×, 540 × 3000, with a note saying so. Before, it would have been 2880 × 16000.

Chrome doesn't render below a device scale of 1 here, so a smaller shot renders at 1 and shrinks with the `scale` of the capture's clip. `tests/screenshot.rs` checks cropping, padding, regions, the options and the scales against real pixels. One test captures a tall page with a black band along its bottom edge. It checks that the image is 3,000 pixels tall and that the band is in it, so the page was shrunk rather than cropped. The tests need Chrome, and without one they say so and pass.

`get_html` can show part of a subtree. `html::export_with` takes a depth, can leave out styles, can shorten long values, and can start with the artboard's `<style>` blocks. When the whole subtree doesn't fit in one result, `html::export_within` binary-searches for the greatest depth that fits. Elements below that depth hold a `<!-- N child elements not shown -->` comment.

When a shot is a whole artboard, the capture also measures every element in it, in the same pass that finds the shots' boxes (`measure` in `screenshot/mod.rs`). `layout_notes` in `mcp/format.rs` turns those boxes into a note: content cut off by the artboard's edge, the height that would fit it, and text wider or taller than its own box. Agents used to find clipped footers only by looking at the image, and often didn't.

`start_working_on_nodes` sets **presence**: a note that an agent is busy on some nodes. Browsers show it as a badge on the artboard. It names at most 100 nodes, and repeats count once. Every viewer gets the whole list on each update, and naming a parent covers its children. Most agents skipped that call, so any edit now shows its artboards too, unless the agent set its own presence. Presence set that way expires a minute after the agent's last edit. Presence an agent set itself expires after five minutes without activity, and an actor's undo history is dropped after six idle hours or when its MCP session ends.

A session ends when its agent disconnects, or after an hour without a call (`SESSION_IDLE` in `mcp/mod.rs`). An agent that sends `X-Finite-Agent` keeps its history across sessions. The server cuts its id to 64 characters, as it does people's ids, because it stores the id with every change and reply the agent makes. Before, the server copied a header of a few KB into each of them. One that doesn't is known by its session, so its undo lasts only as long as the session.

rmcp closes idle sessions after five minutes by default, which is a short pause for an agent waiting on a person. Then the client gets `404`, opens a new session, and comes back as a different actor with nothing to undo. A test in `tests/mcp.rs` pauses Tokio's clock, waits 20 minutes, and undoes. With the default, the session was already gone. The router's relay uses the same setting.

Every viewer shows the names and notes agents write, so they're cut to a fixed length rather than refused (`finite_design::label`). Layer names, design names and presence notes keep 120 characters. An agent's display name keeps 48, the same as a person's. Surrounding spaces are trimmed, and an empty design name becomes "Untitled".

### The web API

`crates/server/src/api.rs` serves the browser:

| Route                                                             | What it's for                                       |
| ----------------------------------------------------------------- | --------------------------------------------------- |
| `GET /api/designs?q=…&limit=…`, `POST /api/designs`               | Search designs by name, create an empty one         |
| `GET /api/designs/{id}`                                           | One snapshot (used by thumbnails)                   |
| `GET /api/designs/ws`                                             | WebSocket: the 200 newest designs, then updates     |
| `GET /api/designs/{id}/ws`                                        | WebSocket: one design's snapshot, then every change |
| `GET /api/designs/{id}/ws?epoch=…&since=…`                        | The same socket, resuming after a reconnect         |
| `POST …/comments`, `…/replies`, `PATCH …/comments/{cid}`          | Comment, reply, resolve                             |
| `PATCH …/comments/{cid}/messages/last`, `DELETE …/comments/{cid}` | Edit your newest message, delete a comment          |
| `PUT /api/designs/{id}/css`                                       | Replace the shared CSS, as the person's own edit    |

The messages on these sockets are Rust types on the server and Effect schemas in `apps/web/src/design/schema.ts`. Another golden file keeps those in step. `crates/server/tests/wire.rs` drives a real hub through an edit, an undo, presence, a comment, an agent reply and a rename, and records every message it broadcasts in `crates/server/fixtures/messages.json`. Then `apps/web/src/design/wire.test.ts` decodes each one with the web schemas. If you rename a field on the Rust side, `cargo test` fails until you regenerate the file, and then `vp test` fails until you update the schema.

The API only answers pages that belong to it (`guard.rs`). Browsers don't apply the same-origin policy to WebSockets, so without a check, any website you visit could open `ws://127.0.0.1:4100/api/designs/ws` and read every design live. That's **cross-site WebSocket hijacking**. With **DNS rebinding**, a site can also point its own name at your machine, which makes its requests count as same-origin. So `/api` refuses a request with `403` unless its `Host`, and its `Origin` if it has one, is a host the server knows: a loopback name, a server in `FINITE_NODES`, or one in `FINITE_ALLOWED_HOSTS`. That's the same list MCP checks `Host` against, and the guard sits in front of `/mcp` too, so a web page can't start an agent session either. Clients that send no `Origin`, like `curl`, agents or another server, aren't affected. A test opens the design list's socket from `https://evil.example` and gets `403`; without the check, it got the list.

When a browser opens a design's socket, the server takes the lock first. Under that lock, it subscribes the socket to the broadcast channel and builds a snapshot. That way no change can land between the snapshot and the stream. If a slow browser falls more than 1024 messages behind, it gets a fresh snapshot instead of the missed changes.

## Following one edit end to end

Say an agent makes a button orange:

```
update_styles({ "designId": "k7jo11y14e",
  "updates": [{ "nodeIds": ["4biyjm26"], "styles": { "backgroundColor": "#ff5a1f" } }] })
```

1. `mcp/mod.rs` works out the actor (`agent:Claude`, from the header) and calls `DesignHandle::edit` with the label "Update styles".
2. `edit::update_styles` normalizes the name and returns one op: `set 4biyjm26 style:background-color "#ff5a1f"`.
3. `Design::commit` applies it, gets back `set … "#111"` as the inverse, pushes that onto Claude's undo stack, and bumps `seq` to 13. It also records the change in the change log, so Claude's next reply to a comment on this artboard can link it.
4. The hub broadcasts this message to every browser on the design, and keeps a copy for any browser that reconnects later:

   ```json
   {
     "type": "change",
     "actorName": "Claude",
     "change": {
       "seq": 13,
       "actor": "agent:Claude",
       "origin": "edit",
       "label": "Update styles",
       "ops": [
         { "op": "set", "id": "4biyjm26", "key": "style:background-color", "value": "#ff5a1f" }
       ]
     }
   }
   ```

5. 250 ms later, the change is appended to the design's journal on disk.
6. In each browser, `Replica` applies the op through WebAssembly, and `Renderer` calls `style.setProperty("background-color", "#ff5a1f")` on that one button.

## The viewer

The browser side lives in `apps/web/src/design`. It's plain TypeScript classes, and React only hosts them. Here they are in the order a message flows through them:

- **`socket.ts`** opens the WebSocket, decodes each message with the Effect schemas in `schema.ts`, pings the server to check the connection still works, and reconnects with backoff. A new connection starts with a snapshot. A reconnect asks to resume and usually gets only what it missed (see "Reconnecting without starting over" below).
- **`DesignSession`** (`session.ts`) owns one open design. It feeds each socket message to the replica, hands every applied op to the renderer, and keeps what the page shows around the canvas: the design's name, presence badges, comments, the activity list and the connection status. It holds all of that in one immutable state object, and `DesignCanvas` re-renders when it changes. The renderer plugs in through a three-method interface (`DesignView`), so `session.test.ts` runs it in Node with a fake renderer.
- **`Replica`** (`replica.ts`) is the browser's copy of the document. The document itself lives in the module, so `apply` runs the Rust `Document::apply`. Next to it, `Replica` keeps a read cache for the renderer: each node by id, and each parent's children in sibling order. It changes the cache only as the Rust side reports. Loading returns the sibling order, and a create or move says which sibling the node now sits before, so the cache never compares indexes.

  A whole change goes into the module in one call (`applyAll`), however many ops it holds. Then the cache catches up one op at a time. The renderer patches the DOM after each op, so it sees the tree as it was right after that op.

  Finding where a node goes used to be slow. The renderer asks once per created node, to find where its element goes. When the cache sorted the siblings on every call, writing N siblings cost about N² log N. A write of 10,000 cards took 1.5 seconds just for those lookups.

  Now the Rust side says where each node goes. The cache finds that sibling by searching forward from where it last looked, because a write works through siblings in order. `replica.test.ts` adds 10,000 siblings in a shuffled order, deletes and moves some, and checks the order against a plain sort.

- **`wasm.ts`** loads `finite.wasm` and wraps its exports, which are a plain C ABI. To call one, it writes the inputs as UTF-8 into a buffer in the module's memory. Then it calls it with their byte lengths and reads the result from an output buffer. Most inputs and results are JSON. A Rust panic aborts the call, so the wrapper reads the panic message and refuses any later call.

  `wasm.test.ts` checks the boundary: long text outside ASCII, two inputs in one buffer, errors, and freeing a document. Each `Replica` owns a document in the module's memory, which isn't garbage collected, so the canvas and thumbnails free theirs when they close.

  It doesn't use wasm-bindgen, the usual tool for calling Rust from JavaScript. Every call passes strings, so its generated bindings would add little. Its command-line tool must match the crate's version exactly. It also generates the JavaScript and TypeScript, so on a fresh checkout `vp check` would fail until a build ran. Here the only build output is the `.wasm` file, and the glue is one TypeScript file written by hand.

  To add a call, say an edit command for when people can edit, you add an export in `crates/wasm/src/lib.rs` and a method in `wasm.ts`. The inputs are JSON, so that's all the glue a new command needs.

- **`Renderer`** (`renderer.ts`) draws each artboard and patches only the DOM nodes an op touched. An artboard normally renders inside a **shadow root**, which scopes its `<style>` blocks to it and keeps the app's CSS out. An artboard that contains a `<script>` renders in a **sandboxed iframe** instead (`sandbox="allow-scripts"`), with a content security policy that blocks network requests. Iframes can't be patched from outside, so they reload 150 ms after a burst of edits. Designs are view-only, so the renderer cancels clicks and submits on the whole canvas, and a design's links and forms do nothing. One case needs more: `submit` doesn't cross a shadow root's boundary, and a form with a single text field and no button submits on Enter without a click. So each shadow root cancels `submit` itself. The end-to-end test presses Enter in such a form and checks that nothing navigates.
- **`Camera`** (`camera.ts`) handles pan and zoom with one CSS transform on the canvas. It also converts page coordinates to canvas coordinates (`toWorld`).

How big a design the canvas handles: `vp run bench` measures it in headless Chrome against a release server. On a Mac, a design of 90,480 nodes across 240 artboards draws in about 640 ms and pans at about 59 frames per second. So the canvas still draws every artboard, including those off screen. Skipping off-screen ones with CSS `content-visibility` would also break "fit to view" for artboards without a fixed height, because the camera measures each artboard's rendered size.

Running the rules in WebAssembly costs time, because the document now exists twice: in the module and in the cache. With the old TypeScript rules, that design drew in 526 ms, so it's about 115 ms slower now. Most of that is the Rust side reading 14 MB of node JSON and building its document, about 85 ms. Copying the JSON into the module takes another 25 ms.

A `write_html` of 30,000 nodes went from 249 ms to 316 ms, and a 5,000-node thumbnail from 28 ms to 33 ms of main-thread time. The module adds 239 KB to the download, 94 KB gzipped. Panning didn't change. One fix along the way helped the server too. The code serde derives for tagged and flattened types reads each op twice, so `Op` and `Node` now read their fields by hand. That made parsing a change's ops a third faster.

`components/DesignCanvas.tsx` wires these together and adds what's specific to the page: the comment tool, hover outlines, the zoom controls and keyboard shortcuts.

The design list page (`DesignGrid.tsx`) uses the lobby socket. It starts with the 200 most recently edited designs and the total, because every design at about 200 bytes each would be 20 MB for 100,000 of them. When there are more, the page says how many it shows and offers a search box, which calls `GET /api/designs?q=`. Through the router, both the search and the lobby's total cover every server. While the search runs, the page filters the designs it already has by the same rule (name contains the query, ignoring case), so typing shows matches at once. If the search fails, the page keeps those matches and says it couldn't search every design. Before, it showed the whole unfiltered list, as if the search had matched everything.

Each update moves a design to the front, and the list keeps the 200 newest (`mergeLobby` in `lib/lobby.ts`). Before, every update for a design not on the list added it, so a tab left open on a busy server kept growing, and each new card's thumbnail fetched its design. Until the first list arrives, a dropped socket shows "Can't reach the Finite server. Retrying…", and a design that can't be created says so instead of silently re-enabling the button.

Each card's `Thumbnail` renders a static copy of the design with scripts off. A thumbnail refetches after an agent's edit, once the edits pause for 300 ms, and at most every 2 seconds while they keep coming. In the end-to-end test, six edits 400 ms apart usually cause two fetches instead of six, and the test accepts one to three.

A design with more than 5,000 nodes shows its size instead of a preview (`PREVIEW_NODES` in `Thumbnail.tsx`). A preview fetches the whole snapshot and builds every node, and while agents edit, it refetches every 2 seconds. For a 100,000-node design, that would be about 15 MB each time. The end-to-end test writes 6,001 nodes, checks that the card says so, and checks that three more edits fetch nothing.

### Reconnecting without starting over

Connections drop: a laptop sleeps, Wi-Fi blinks, a proxy times out. The browser reconnects with backoff (`socket.ts`). A fresh snapshot after every drop would be wasteful. It would also rebuild every artboard and reload every sandboxed one, so the canvas would flicker and animations would restart. So the socket supports **resume**, the way chat and multiplayer protocols do: the browser says where it left off, and the server sends only what it missed.

1. Every snapshot message carries an `epoch`. The epoch is a random id the server picks each time it loads the design into memory.
2. Each loaded design keeps its latest changes, with their actors' names (`Recent` in `hub/design.rs`). It keeps up to 256, and drops the oldest sooner if together they pass 4 MB of JSON, so a few huge `write_html` calls can't hold on to much memory.
3. On reconnect, `DesignSession` opens `…/ws?epoch=<epoch>&since=<seq>`, where `seq` is the last change it applied.
4. If the epoch matches and every change after `since` is still kept, the server answers with a `resume` message. It holds those changes, plus the current comments, presence and name, which are small enough to send whole. The browser applies the changes as if they had arrived live.
5. Otherwise the server sends a snapshot, as for a new viewer.

The epoch is what makes this safe. A server that crashed may have lost its last few unsaved changes, so after the restart it can hand out the same `seq` again for a different change. And after any reload, the kept changes are gone. A new epoch means the browser's `seq` no longer names the same state, so it gets a snapshot. The router passes the query on to the owner, so resuming works there too.

### Noticing dead connections

Some drops never announce themselves. A laptop that sleeps or changes networks can leave a **half-open connection**: one end still looks open, but nothing gets through and no close ever arrives. Both ends need to notice.

**The server's end.** A design unloads only once nobody is subscribed to it, so one half-open socket would keep its design in memory for as long as the server runs. So every socket that faces a browser sends a WebSocket **ping** every 20 seconds (`heartbeat.rs`). Browsers answer pings with a pong by themselves, without any app code. A socket that hears nothing for 60 seconds closes.

Each send also gives up after 60 seconds. A browser that stopped reading fills the connection's buffers, and then a send waits forever. The pings also keep proxies such as nginx from closing a quiet design's viewers, since nginx closes a connection that's silent for a minute by default.

On a router, the router pings the browser itself and answers the server's pings, so the server's pings stop at the router. `tests/heartbeat.rs` runs with Tokio's clock paused, so a minute passes in an instant. Against a server and a router, it checks that a client that stops reading is closed and one that keeps reading stays open. Without the pings, the silent client stayed open. The test also caught a bug: the router's design list relay ended at the first frame that wasn't text. So the first ping from a server would have cut off every browser's design list.

The server's pings also tell the router a server is still there. A design's socket doesn't need that, because the browser's own ping goes through to the server, and no answer means it reconnects. But the router answers the design list's pings itself, so a server that vanished without closing, like a machine that lost power, would leave the browser's list quietly missing its updates. So the router closes the list's socket when a server has sent nothing, pings included, for 60 seconds, and the browser reconnects to a fresh list.

One trap if you write such a test: a paused clock jumps to the next timer whenever every task is waiting on a socket. Then the router's 5-second limit on connecting to a server runs out at once. So the tests connect with the clock running and pause it only for the long wait.

**The browser's end.** After a laptop wakes up on another network, its socket can look open while nothing arrives, and the canvas just stops updating. Browsers answer the server's pings without telling the page, so the page can't use them. So the web app runs its own **heartbeat**, the way Phoenix channels and Socket.IO do:

1. Every 20 seconds, `socket.ts` sends the message `{"type":"ping"}`.
2. The server answers `{"type":"pong"}`. On a router, a design's socket passes the ping on to the server. The design list's socket answers it itself, because that list merges several servers.
3. Any message counts as an answer. If none arrives within 10 seconds, the page drops the socket and reconnects, and the reconnect resumes as usual. It doesn't wait for the old socket's `close` event, which on a dead connection can take minutes.

`socket.test.ts` drives this with a fake socket and fake timers. When the 10-second deadline was switched off, the test that expects a reconnect failed.

## Comments

You can't edit a design yourself, but you can pin comments, and agents act on them. A comment is a thread of messages anchored to an artboard and to the element the person clicked.

Here's what happened in the demo you saw:

1. In comment mode, the canvas asks `Renderer.hitTest` what's under the pointer. It finds the deepest element with `elementFromPoint` inside the artboard's shadow root, and outlines it.

   An artboard with a script is a sandboxed iframe, and the page can't look inside it. So the renderer asks instead. The iframe's document tags every element with its node id (`data-finite-id`), and the small runtime inside answers two questions by `postMessage`: what's at this point, and where is this node. Answers arrive a moment later, so `hitTest` returns the latest one and the renderer's `onLayout` callback tells the canvas to look again. The artboard's own scripts can post messages too, so the renderer only accepts ids of nodes in that same artboard.

2. A click opens a box for the comment. It starts with "Commenting as Guest". Click the name to set your own, which `lib/user.ts` saves in the browser's local storage next to a random id. There are no accounts, so that id and name are all the server knows about you. Sending posts the comment over REST. It sends the artboard id, the node id, and the click's offset from the artboard's corner, so the pin moves with the artboard.
3. The agent sees `openComments: 1` in `get_basic_info`, reads the thread with `get_comments`, edits, and answers with `reply_to_comment`.
4. `Design` keeps a **change log**: the last 512 changes, each with its actor, the artboards it touched, and the elements it changed. Every commit, undo and redo goes through one function (`Design::finish`) that writes to the log, so no path can skip it. When an agent replies, `Design::reply` attaches that agent's changes to the comment's artboard since the thread's previous message. Those become the "Show what changed" buttons. The log is saved in full snapshots next to the undo histories, and journal replay adds to it, so a reply still links edits made before a restart or a crash.

   Each entry keeps the outermost elements a change touched, up to 24. Finding them used to compare every touched node with every other, so committing a big write was quadratic. A write of 99,000 nodes held the design's lock for 5 seconds, all but 0.08 of it in the change log. Now a set records which nodes were touched, and each node walks up its ancestors, at most 256 of them, to check whether an outer one was touched too. The same commit takes about 0.11 seconds. `cargo run --release -p finite-design --example big_design` measures it.

5. Your reply reopens a resolved comment, so you can keep steering in one thread.

A resolved pin fades out and leaves the canvas a minute after it was resolved (`DECAY_MS` in `components/Comments.tsx`). The server stamps `resolvedAt` when a comment goes from open to resolved, and the viewer fades the pin with a CSS animation whose negative delay is that age. The delay is read once, when the pin mounts. Setting it again on a later render would shift the running animation by the time already passed, and an early version faded twice as fast for that reason. A comment resolved before `resolvedAt` existed counts as long ago, so it's hidden at once. The **Comments** button in the top bar opens a side panel that lists every comment, open and resolved, newest first. Picking one centers its pin and opens the thread, even after the pin has left the canvas.

You can edit your own message while it's the newest in its thread (`Design::edit_message`). Once an agent answers, the message is part of the record and stays as it was. `get_comments` marks an edited message with `edited: true`. Anyone can delete a comment with its whole thread (`Design::delete_comment`). The hub broadcasts `commentDeleted` and journals a `CommentDeleted` record. A REST answer for that comment can still arrive after the delete, so `DesignSession` remembers deleted ids and ignores late copies.

A thread opens up and to the right of its pin. Near the window's right edge it opens to the left, and near the top bar it hangs below the pin instead (`Popover` in `components/Comments.tsx`).

If a comment or reply can't be sent, say the connection dropped, the box keeps the text and shows "Couldn't send" under it, so you can try again. The end-to-end test blocks the comments endpoint to check this, and does the same for creating a design.

An agent doesn't have to check for comments on a timer. `wait_for_comments` is a **long poll**: the tool call stays open until a comment is waiting for an agent, then returns it. A comment is waiting when it's open and a person wrote the last message (`Comment::awaits_agent`). Each design has a `Notify`, a Tokio primitive that wakes every task waiting on it, and every comment update fires it. On the demo server, a waiting agent woke 30 ms after a comment was posted. The call gives up after `timeoutSeconds` (60 by default, 300 at most), so an agent can call it in a loop.

Both comment tools stay within the 60,000-character budget too. A comment can hold 4,000 characters, so 40 open comments would already be 160,000. `get_comments` returns the oldest comments that fit, always at least one, and ends with "Showing comments 1 to 13 of 40, oldest first. Pass offset 13 for the rest." `wait_for_comments` says how many more are waiting. Within one comment, a thread can hold 200 messages of 4,000 characters, so agents see its first message, which is the request, and its latest 10, with `messagesNotShown` counting the rest. Comments the agent replies to stop waiting, so its next call returns the rest. A test in `tests/mcp.rs` posts 40 such comments and pages through them, checking that each comes back once, in order.

There are no accounts, so anyone who can open a design can comment on it, and every comment is saved, sent to every viewer and loaded with the design. So a design holds at most 500 open comments, and a thread at most 200 messages (`MAX_OPEN` and `MAX_MESSAGES` in `comment.rs`). Reopening a resolved comment counts as opening one, by a button or by a person's reply, or the limit could be dodged by resolving and reopening. The server refuses with `422` and a reason in plain text. The web app turns that into a `Refused` error (`api/Api.ts`), and the comment box shows the reason, such as "This design has 500 open comments, the most it can have; resolve some first." Other failures still say "Couldn't send. Check the connection and try again." The end-to-end test fills a design to 500 open comments and checks that the box shows that reason.

If an agent deletes an artboard that has comments, the pins don't vanish. Before the change applies, `Design` notes where the artboard is. Afterwards, every comment on it gets a `detachedAt` canvas position, and viewers pin it there. If an undo brings the artboard back, `detachedAt` is cleared and the pin follows the artboard again. `get_comments` marks such comments with `artboardDeleted`.

The order of the messages matters here. A viewer draws a pin at its artboard if the artboard exists, and at `detachedAt` if not. If the delete arrived first, there'd be a moment with neither, and the pin would blink out. So the hub sends a pin that lost its artboard before the change that deletes it, and a pin that got it back after the change that restores it (`publish_with_comments` in `hub/design.rs`). The end-to-end test found this blink.

Comments live beside the document, not inside it, so undo never touches them. They're saved with the design, in its snapshot and journal.

Each comment carries a **revision number**, `rev`. It starts at 0 and goes up by one with every change: a reply, a resolve, an edit, or a pin moving because its artboard went or came back. A browser can get the same comment twice. The server broadcasts it on the socket, and the REST call that changed it also returns it. The two can arrive in either order, and another change can land in between. Say you reply, and an agent answers at once. The agent's reply can reach your socket before the REST answer to your own reply. So `DesignSession.upsertComment` keeps whichever copy has the higher `rev`, and drops an older copy that arrives late.

All the thread rules live in `crates/design`: `comment.rs` defines the types and checks, and `Design::add_comment`, `reply`, `set_resolved`, `edit_message` and `delete_comment` apply them. The hub only takes the lock, calls one of those, and broadcasts the updated comment. That means you can test a comment rule with a plain function call, like the tests at the bottom of `design.rs`.

## Saving and recovering

Everything above happens in memory. This section covers what reaches the disk, when, and what comes back after a restart or a crash.

### Storage

Saving is a **write-ahead journal with compaction**, the same idea databases use. Each design has two files in `FINITE_DATA_DIR/designs/` (`crates/server/data` in dev):

- `<id>.json` is the last full snapshot.
- `<id>.log` is the journal: one JSON record per line for everything since that snapshot. A record is a change, the new state of a comment, a deleted comment's id, or the design's name and timestamps (`Record` in `crates/design/src/design.rs`).

After a burst of edits, the save task appends the new records to the log. That costs the same for a ten-node design as for a ten-thousand-node one. In the demo, one style change appended 305 bytes instead of rewriting the 11 KB snapshot. Every 1,000 records, or once the log's changes add up to 16 MB, the task writes a fresh snapshot instead and deletes the log. That step is **compaction**.

The size rule matters because one `write_html` can be tens of MB of ops, so 1,000 records alone could let a log reach gigabytes, and all of it is read back when the design loads. The size is an estimate that costs nothing: each change's JSON is already built to send to viewers, so its length is known. A hub test writes 20 changes of 1 MB each and checks that the task compacts the log. With only the count rule, the log still held all 22 records.

On startup, the server loads each snapshot, replays its log with `Design::replay`, and compacts right away. Replaying is safe to repeat: changes at or below the snapshot's `seq` are skipped, and comments and meta just overwrite. So a crash at any point loses at most the last 250 ms of edits:

- **Mid-append:** the log ends in a torn line. Loading stops at it, and the startup compaction drops it for good.
- **Mid-compaction:** the new snapshot is written to a temporary file and renamed into place, so it's either all there or not at all. If the old log survives next to the new snapshot, replaying it changes nothing. A temporary file left behind is deleted the next time the store opens.
- **Power cut:** a process crash keeps whatever the operating system had buffered, but a power cut loses it, and the disk may write things in a different order than the program did. So every write is **fsynced** (forced to the disk) before the next one depends on it. An append syncs the log. A snapshot syncs its temporary file before the rename, then syncs the folder so the rename itself is on disk, and only then deletes the old log. Without that order, a power cut could leave an empty snapshot and no log.

A write can also fail without a crash, say on a full disk. Then the design stays in memory, and the save task retries with **exponential backoff**: after 1 second, then 2, 4 and so on, up to a minute between tries. The retry writes a full snapshot, which holds everything the failed append had. A new edit triggers a save sooner. A test store that fails its first two writes checks that the design reaches it with no further edits.

Only one server can use a data folder at a time. The file store takes an exclusive lock on `FINITE_DATA_DIR/lock` when it opens, and a second server on the same folder exits with `another Finite server is using …`. Without the lock, two servers would each load a design and overwrite the other's edits. The operating system releases the lock when the process exits, even after a crash.

A design's id becomes its file name, and ids arrive in URLs, so the file store refuses any id that isn't a design id: 1 to 64 letters, digits, `-` or `_` (`is_design_id` in `hub/mod.rs`). Every id the server makes, with `random_id`, passes. The handoff route checks too, and answers `422` instead. Before, a handoff to `PUT /api/designs/..%2F..%2Fescaped/handoff` saved the design as `escaped.json` two folders above the store, because axum decodes `%2F` into `/`. A test sends that request to a server with a real data folder. It got `201 Created` before the check and gets `422` now.

A new design's id is 10 random letters and digits, and the server makes sure no design it holds has it yet (`Hub::fresh_id`). Before, it only checked that the id hashed to this server. A repeat would have replaced the older design, in memory and on disk. There are 36¹⁰ possible ids, about 3.7 × 10¹⁵. That makes a repeat rare for any one design, about 1 in 3.7 billion with a million designs already there. But by the birthday bound, the chance that some repeat happens while a server creates its first million designs is about 1 in 7,000.

On Ctrl-C or SIGTERM, the server stops accepting connections and writes every loaded design as a full snapshot before it exits. SIGTERM is how Docker, systemd and the desktop app stop it. Until this was handled, the desktop app could lose the last moment of edits when it quit. The app now also waits for the server to exit, up to 5 seconds, before it quits itself.

In the desktop app, Electron runs the server as a child process and acts as its **supervisor**, the way systemd's `Restart=` setting does with a rate limit. If the server stops on its own, say the system killed it to free memory, Electron starts it again on the same port. Open pages reconnect there and resume, and the journal brings back anything not yet in a snapshot. If it stops three times within a minute, a restart won't fix it, so the app shows an error and quits (`afterStop` in `apps/desktop/src/restarts.ts`). Before, a server that crashed made the app quit without a word, and one that was killed left the window saying "Retrying…" forever. Killing the app's server with `kill -9` brought a new one up on port 4100 within a second, and quitting the app afterwards still saved and stopped it.

The hub saves through the `Store` trait in `store.rs`. Five methods read and write designs: `ids`, `load`, `save`, `append` and `remove`. Four more let several servers share one store: `create`, `claim`, `release` and `held` (see "A shared store"). They hand out a **fencing token** that every `save` and `append` carries. The file store keeps the defaults: a claim always succeeds, and it ignores the token, because the folder lock already keeps other servers out.

Three stores implement the trait. `FileStore` is the default. `PgStore` keeps the same snapshot and journal in Postgres, when you set `FINITE_DATABASE_URL`. `MemoryStore` is for tests. To check a new store, run `store::contract::check` on it. It's a **contract test**: the same suite of rules every store must follow, such as "the journal keeps append order" and "save clears the journal". A store that servers share must also pass `store::contract::check_shared`. Every store runs the contracts it needs in `cargo test`.

### Undo across restarts

Undo histories are saved, but only in full snapshots, which the server writes when it shuts down, compacts or hands a design off. So an agent that connects with an `X-Finite-Agent` header can undo after a normal restart. (An agent without one is identified by its MCP session, which ends with the restart. So when a design is restored after a restart, histories of `mcp:` actors are dropped, since nobody could use them. For the same reason, a live session's history keeps its design in memory: unloading would lose it.) The journal doesn't hold histories, but it doesn't need to. After a crash, `Design::replay` rebuilds them from the journaled changes, because each change says who made it and whether it was an edit, an undo or a redo:

- **An edit** is applied, and its inverse goes on its actor's undo stack, as `Design::commit` does.
- **An undo or redo** takes the entry the live call took: the first one from the top of the stack that still applies. That entry must produce exactly the ops in the journal. Then its reverse goes on the other stack.

This works because undo is **deterministic**. The same document and the same stacks always pick the same entry and produce the same ops. A `Design` test replays a journal of edits, undos and redos by two actors, and checks that every later undo matches the live design's. If an entry ever produces other ops, say a saved history from a different timeline, replay puts it back, applies the journaled ops as they are, and drops the histories. An undo step that doesn't fit the document could undo the wrong thing, so dropping them is safer.

Viewers never receive histories: `Design::snapshot` leaves them out, and only `Design::snapshot_to_save` includes them.

A history expires six hours after its actor was last active, and that clock has to survive the design leaving memory. Otherwise a design reopened every few hours would keep its histories forever, and so would the store. So each saved history carries `lastUsed`, the time its actor was last active, and a restored history counts down from there.

The journal doesn't record when its changes were made, so an actor with changes in the journal counts as active at load time. That's why a design with histories needs a full snapshot before it unloads. When a history expires, the server writes a full snapshot too, so the store forgets it as well. Before, the store kept expired histories, and they came back on the next load.

A hub test edits as a named agent. It checks that the design unloads and comes back with its undo, and that the history expires six hours after the edit, not after the reload. When restored histories started their clocks at load time, as before, that last check failed.

## The end-to-end test

The unit tests and golden files check each side on its own. `vp run e2e` checks what a person sees. `vp run e2e:router` runs the same checks through a router in front of two servers, so relayed sockets, the merged design list and refusals passing through the router are covered too. `vp run e2e:shared` runs them through a router in front of two servers that share one Postgres. CI runs all three.

`e2e:shared` takes the database from `E2E_DATABASE_URL` or `FINITE_TEST_DATABASE_URL`. Without either, it prints `SKIP` and passes. Each run keeps its tables in a new schema named `finite_e2e_…` and leaves it there, so give it a test database.

It first waits until the router sees both servers. When I switched that list off in the router, this check failed, and so did the agent's first call. `vp run` never caches the task, which `vite.config.ts` sets up. A cached task only gets the variables it lists, so it wouldn't see the URL. The script lives in `e2e/run.mjs` and has three parts:

1. It builds the server, `finite.wasm` and the web app. `E2E_SKIP_BUILD=1` reuses the last builds, so after a plain run, `e2e:shared` needs its own build: its servers need the `postgres` feature. Then it starts the server on a free port with a throwaway data folder.
2. It connects an agent over MCP (`e2e/mcp.mjs`) and builds a design: one plain artboard and one with a script, so it renders in a sandbox.
3. It opens the design in headless Chrome and drives it with the Chrome DevTools Protocol (`e2e/cdp.mjs`): it moves the mouse, clicks, types and reads the page.

The checks follow the comment demo. The agent edits and undoes, and the page follows. A person hovers a button, comments on it under their own name, and the agent picks the comment up with `wait_for_comments`. The agent changes the button and replies, and the person jumps to the change. Then the same happens inside the sandboxed artboard. Then a pin stays in place while its artboard is deleted and brought back. Last comes the design list. A design too big to preview shows its size instead, and the page doesn't fetch it. With 200 more designs, the list says how many it shows, and a search finds an older one. With the network blocked, creating a design and searching each say they failed. Each check prints `PASS` or `FAIL`, and the script exits with 1 if any failed. On a failure it saves a screenshot to `finite-e2e-failure.png` in the temp folder.

It needs Chrome. Set `FINITE_CHROME` to its path if it isn't in the usual place. It isn't part of `vp test`, because it builds the whole app first. CI runs it after `vp run ready` (`.github/workflows/ci.yml`). With `E2E_SKIP_BUILD=1`, a run takes about 6 seconds. The end-to-end runs and `vp run bench` are tasks in `vite.config.ts` with caching off. A cached task would replay an old pass without opening a browser, and it gets only the environment variables it lists. Before, as `package.json` scripts, they never saw `E2E_SKIP_BUILD`, so CI's router run rebuilt everything.

One trap is worth knowing if you add a check. Comment mode sets `pointer-events: none` on sandboxed iframes, so the page gets the mouse. But Chrome's **input routing** hit-tests the last frame it drew to choose which frame gets the mouse. Until it draws again, the moves still go to the iframe, and the page never sees them. People move the mouse all the time, so they never notice. A script that presses `c` and moves at once does, so the test waits two animation frames first.

`e2e/headless.mjs` uses the same two clients for testing by hand, one command at a time. `start` builds and starts a server on a free port with a throwaway data folder, opens headless Chrome, then leaves a background process running that holds both, along with one MCP session per agent name. It writes the process's port and a random token to `state.json` in a folder under the temp directory, named for the checkout, so agents in different worktrees never share a session. Each later command, like `call`, `click` or `screenshot`, is an HTTP request to that process. It runs the commands one at a time, so two shells can't interleave their clicks. Selectors reach into shadow roots, since that's where artboards render. After 30 minutes without a command, the process stops itself, along with the server and Chrome, so a forgotten session doesn't keep them running.

The requests are plain JSON over HTTP, so other languages can send them too. `e2e/finite_headless.py` is the Python client. It runs `headless.mjs state` once to learn the port and token, then sends each command directly. Every reply carries the text the CLI prints, and commands with data to hand back, like `eval`, `query` and `call`, also send it as `value`.

## Running more than one server

Each design lives on exactly one server at a time, its **owner**. The owner holds it in memory and saves it, so two servers never edit the same design at once. You can run several servers in two ways:

- **With a shared store.** Every server keeps its designs in one Postgres database. A design can move to another server without copying anything, and the list of servers follows which ones are alive. If you can, use this one.
- **With separate folders.** Each server keeps its designs in its own data folder, and you give every server the same fixed list. To move a design, the old owner sends it to the new one over HTTP.

### Who owns a design

`crates/server/src/cluster.rs` decides, the same way in both setups. It uses **rendezvous hashing** (also called highest random weight). Every server scores the design id, and the highest score wins. The answer depends only on the id and the list of servers, so any server, proxy or load balancer that has the list gets the same answer. Adding a fifth server to four moves only the designs the new server wins, about a fifth of them. Plain `hash % n` would move almost all of them.

Each server then behaves like this:

- **Creating:** it only picks ids it owns, so a design is always reachable on the server that made it.
- **Wrong server:** a request for a design another server owns gets `421 Misdirected Request` with a `Finite-Owner` header naming the owner. An MCP tool call gets an error telling the agent which `/mcp` endpoint to use.
- **Asking:** `GET /api/owner/{id}` on any server returns `{"owner": "http://…"}`, or `null` when it's that server.

The hash is FNV-1a with a final mix. It's spelled out in `cluster.rs` so you can port it. A test pins one score, which a Python version reproduces exactly. With neither a shared store nor `FINITE_NODES`, there's one server, and it owns everything.

### A shared store

The Postgres store sits behind a cargo feature, `postgres`, which is off by default. So build the servers and the router with it:

```bash
cargo build --release -p finite-server --features postgres
```

Then point every server and the router at the same database, and tell each server the URL the others reach it at:

```bash
export FINITE_DATABASE_URL=postgres://finite@db.internal/finite
FINITE_NODE_URL=http://10.0.0.1:4100 finite-server   # on the first machine
FINITE_NODE_URL=http://10.0.0.2:4100 finite-server   # on the second
finite-server router
```

The server creates its three tables on first start (`crates/server/src/postgres/mod.rs`). `finite_designs` holds each design's snapshot as JSON, plus two columns for ownership. `finite_journal` holds the journal records, one row each. `finite_nodes` holds one row per server.

The tables go in the database's default schema. In a development build, `FINITE_DATABASE_SCHEMA` names another, which Finite makes if it's missing. Each `vp run e2e:shared` uses it to get empty tables in the shared test database. A release build refuses the setting and stops, so a deployment's tables can't quietly end up somewhere its operator didn't mean.

The file store stays the default, so the desktop app and a single server never need a database. They don't even compile a database client, because `vp run dev` and the desktop build leave the feature off.

If you set `FINITE_DATABASE_URL` for a build without the feature, it exits with `this finite-server was built without Postgres`. It won't start on a folder of its own, because its designs would never reach the other servers. `tests/no_postgres.rs` checks the server and the router. `FINITE_NODES` and `FINITE_DATABASE_URL` don't mix either, and a server refuses to start if you set both.

Three mechanisms make this safe. Each has a textbook name.

**Heartbeats decide who's alive.** Each server writes the time into its row in `finite_nodes` every 2 seconds. That's its **heartbeat**. A server counts as alive while its last heartbeat is younger than the **lease**, 10 seconds by default (`FINITE_LEASE_MS`). The database's clock does the comparing, so the servers' clocks don't have to agree.

Ownership is rendezvous hashing over the live servers, so when one stops heartbeating, its designs belong to the others. Each server reads the list again after every heartbeat.

**A lease on each design says who may write it.** Before a server loads a design, it claims the design's lease: it writes its own URL in the `holder` column and raises the `epoch` column by one, in one statement. The claim only succeeds if nobody holds the lease, the server holds it already, or the holder's heartbeat is out of date. Otherwise the server waits for the holder to let go, for up to one lease. After that it answers `503 Service Unavailable`, and the browser or agent tries again.

**The epoch is a fencing token.** The server keeps the epoch it got, and every save and append carries it. The store refuses a write whose epoch isn't the latest, in the same transaction that would change the design. That's the guard against a server that stalled, say for a long garbage collection, a full disk or `SIGSTOP`. It wakes up still believing it owns its designs, and tries to save. Without the token, its stale copy would overwrite the new owner's edits. With it, the save fails with `Fenced`, and the server drops its copy.

A claim and a stale write can't both succeed, because they touch the same row: whichever runs second sees the other's change. You can read the rule in two SQL statements in `postgres/mod.rs`. `save` updates the row only `WHERE epoch = token`, and `claim` sets `epoch = epoch + 1`.

Here's what happens in each case:

- **A server dies.** Its heartbeat stops. Once its lease runs out, the survivors drop it from their lists, and each design it owned now hashes to one of them. The first request for a design makes its new owner claim it, which works because the holder is gone, and load it from the database. No server copies anything. The edits the dead server hadn't saved yet are lost, which is at most the last 250 ms, the same as a crash with one server.
- **A server joins, or comes back.** The others see it on their next read, about 2 seconds later. Each one lets go of the designs the newcomer now owns. Letting go means sending the design's viewers away, saving a last snapshot, and releasing the lease. Viewers reconnect through the router and land on the new owner, which loads what was just saved. No edits are lost.
- **A server pauses past its lease.** The others take its designs over, as if it had died. When it wakes, the store fences off every save it tries. It also knows its own lease lapsed, because it times its heartbeats. Until it renews, it counts itself out of the list, so it serves nothing and answers `421`. Then it lets go of every design it had loaded, because the copies may be out of date, and loads them again on the next request.
- **A server shuts down cleanly.** On SIGTERM it saves every design, releases its leases and deletes its heartbeat row. The others take over on their next read, without waiting for the lease.

The router follows the same heartbeats. With `FINITE_DATABASE_URL`, it reads the list of live servers every 2 seconds and sends each request to the owner on that list. For the moment when the router's list lags behind, servers' `421` answers point it to the right one, as below. When the list changes, the router closes every browser's design list socket, so the browser reconnects to a list with each design under its new owner.

The tests cover each case:

- `store::contract::check_shared` is the contract a shared store must pass. Both the Postgres store and the in-memory store pass it. It checks that only one server can create a given id, that nobody can take a live server's lease, and that the store refuses a write with an old token.
- `tests/shared.rs` runs two servers in one process over the in-memory store, and over Postgres too when it's configured. It checks that two servers share designs, that a dead server's designs move with every saved edit, that a paused owner can't overwrite the new owner, and that the router follows a moved design. With the token check removed from the stores, the fencing test failed: the store kept the paused server's copy, and the new owner's edit was gone.
- `tests/failover.rs` does the same with real processes and signals. One test sends `kill -9` to a server, and another freezes the owner with `SIGSTOP` and thaws it with `SIGCONT`. It needs Postgres. After the kill, the router served the design from the other server 1.2 seconds later, with a 1-second lease. Without the token check, the thawed server overwrote the new owner's edit here too.

The Postgres tests need the feature and `FINITE_TEST_DATABASE_URL`. Without the variable they print a note and pass. Each test makes its own schema, so they can run at once. CI runs them against a Postgres service (`.github/workflows/ci.yml`).

To run them on a Mac, `brew install postgresql@17` and start it. Then run `FINITE_TEST_DATABASE_URL=postgres://localhost/postgres cargo test -p finite-server --features postgres`.

#### Connecting with TLS

Managed databases like RDS, Cloud SQL and Supabase only take TLS. You set TLS the way you would for `psql`, with `sslmode` in the URL, and Finite reads it the way libpq does (`crates/server/src/postgres/tls.rs`):

| `sslmode`         | Encrypted                  | What it checks                              |
| ----------------- | -------------------------- | ------------------------------------------- |
| `disable`         | Never                      | Nothing                                     |
| `allow`, `prefer` | When the server offers TLS | Nothing                                     |
| `require`         | Always                     | Nothing, unless you give `sslrootcert`      |
| `verify-ca`       | Always                     | That a CA you trust signed the certificate  |
| `verify-full`     | Always                     | That, and that it names the host you dialed |

`prefer` is the default, so a local Postgres without TLS works as it did. For a managed database, use `verify-full` and point `sslrootcert` at its CA file:

```bash
FINITE_DATABASE_URL='postgres://finite@db.example.com/finite?sslmode=verify-full&sslrootcert=/etc/finite/rds-ca.pem'
```

`require` stops someone from reading the traffic, but not from posing as the database, because it takes any key. That's libpq's meaning too. Without `sslrootcert`, `verify-ca` and `verify-full` trust the Mozilla list of public CAs built into Finite. That's enough for a provider that gets its keys signed by a public CA, like Let's Encrypt. RDS and Cloud SQL sign with CAs of their own, so you need their CA file. Client certificates (`sslcert`, `sslkey`) aren't supported yet.

The TLS code is rustls, through `tokio-postgres-rustls`, with the `ring` crypto backend. It's all Rust, so a build needs no OpenSSL and no C compiler. `tokio-postgres` only knows three modes and no `sslrootcert`, so Finite takes both settings out of the URL and sets up the check itself.

A test in `postgres/mod.rs` runs a TLS front for the test database, the way a managed Postgres looks. It has a CA of its own, and it serves as `localhost`. The test checks each mode against it. `verify-full` refuses it as `127.0.0.1`, a name it doesn't have, and `verify-ca` takes it. A failed check says why, like `invalid peer certificate: UnknownIssuer`. With plain connections, as before this change, the TLS tests failed with `no TLS implementation configured`.

### Separate folders

To run three servers that each keep their own data folder, give each the same list and its own position:

```bash
FINITE_NODES=http://10.0.0.1:4100,http://10.0.0.2:4100,http://10.0.0.3:4100 \
FINITE_NODE=0 FINITE_DATA_DIR=/data/finite finite-server
```

The list doesn't change on its own, so a server that dies takes its designs with it until you bring it back.

When you change the list, some designs get a new owner, but their files are still in the old owner's data folder. So on startup, each server checks its stored designs. It sends each one it no longer owns to the new owner with `PUT /api/designs/{id}/handoff`. The new owner saves it before it answers `201 Created`, and only then does the old server delete its copy. A crash at any point leaves a copy on at least one server. Servers that share a store never hand off, and refuse a handoff with `409 Conflict`.

If the new owner is down, the old server keeps the design and tries again every 30 seconds. If the new owner already has a design with that id, it answers `409 Conflict`. The old server then keeps its copy and logs a warning, because deleting it could lose edits the owner doesn't have. The handoff carries the whole design, undo histories included, so it takes bodies up to 256 MB. Other API routes keep axum's default limit of 2 MB, which is plenty for a comment or a new design's name. Before, the handoff had that limit too, so a design that had grown past 2 MB got `413 Payload Too Large` and could never move. One MCP call alone can add 4 MB. `tests/cluster.rs` covers a second server joining, an owner that can't be reached, and a design of more than 3 MB moving.

### The router

`finite-server router` is the front door. Browsers talk to it as if it were one server, and it sends each request on to the right one. It's in `crates/server/src/router.rs`.

- **One design:** anything under `/api/designs/{id}` goes to the design's owner. That includes the design's WebSocket, which the router relays in both directions. A server sends a design's snapshot as one WebSocket frame. tungstenite, the WebSocket library the router uses to connect to servers, refuses frames over 16 MB by default, so a larger design couldn't open through the router. Browsers have no such limit, so the router lifts it for its connections to servers. A test opens a design of more than 18 MB through the router. With the default limit, the router dropped the connection.
- **New designs:** `POST /api/designs` takes turns between servers. Each server picks an id it owns, so the design lands where the hash says it belongs. If the server whose turn it is refuses the connection, the next one takes the design. A refused connection never reached the server, so nothing is created twice. The relay's `create_design` does the same when it can't open a session with a server.
- **A server that says it's elsewhere:** when the servers change, the router's list may lag behind for a moment. That happens when you update `FINITE_NODES`, or with a shared store, when a server joins or dies. Then it sends a design that now belongs to the new server to an old one, which answers `421 Misdirected Request` with a `Finite-Owner` header. The router follows that header once, for requests and design sockets alike. The relay does the same for tool calls: the server's error carries the owner in its `_meta` (`finite/owner`), and the call didn't run, so sending it to the owner is safe. The owner comes from a server the router trusts, but it must still be a plain `http(s)://host:port` (`cluster::is_base_url`).
- **The design list:** `GET /api/designs` asks every server and merges the answers, newest first. The list's WebSocket subscribes to every server's list and relays their updates. The router keeps each server's latest full list. A server whose socket fell behind sends its whole list again, and that replaces only its own part of the merge. Before, the router passed it on as it was, and the browser, which replaces its list on a full list, lost every other server's designs until it reconnected. A test in `tests/router.rs` uses two scripted servers, one of which resends, and checks the other's design stays. If one server drops, the router closes the socket, and the browser reconnects and gets a fresh merged list. A server that's down is left out of both, so the others' designs still show. If no server answers, `GET /api/designs` fails with `502 Bad Gateway`. It used to answer an empty list, which said there were no designs at all. A socket that's missing a server closes after 15 seconds, so the browser reconnects and the router tries that server again.
- **A stuck server:** a server that's paused or too busy to answer still accepts connections, because the operating system queues them. The router gives each server 5 seconds (`UPSTREAM_TIMEOUT`) to connect, accept a WebSocket and send its design list, then leaves it out like a server that's down. Creating a design on a stuck server's turn answers `504 Gateway Timeout` after those 5 seconds. The router can't send that create to the next server, because the stuck one may have created the design. The next try goes to the next server. Before, one stuck server held up every browser's design list for good, and every create on its turn. A test in `tests/router.rs` puts a listener that never accepts in front as a server. Any other request the router passes on fails with `502` once the server has sent nothing for 30 seconds. That's a limit on silence, not on the whole request (reqwest's **read timeout**), so a large design still downloads however long it takes. Before, a new comment on a stuck server's design waited forever.

Apart from relayed MCP sessions (below), the router keeps no state. Here's a two-server setup on one machine:

```bash
export FINITE_NODES=http://127.0.0.1:4101,http://127.0.0.1:4102
FINITE_NODE=0 FINITE_PORT=4101 FINITE_DATA_DIR=data/a finite-server &
FINITE_NODE=1 FINITE_PORT=4102 FINITE_DATA_DIR=data/b finite-server &
FINITE_PORT=4100 FINITE_STATIC_DIR=apps/web/out finite-server router
```

With a shared store, the router takes `FINITE_DATABASE_URL` instead of `FINITE_NODES`, and the servers drop `FINITE_NODES` and `FINITE_NODE`. `crates/server/tests/router.rs` runs the fixed-list setup over real sockets. It checks that new designs spread across both servers, that every design's requests and WebSocket reach its owner, and that the list merges both. `vp run e2e:router` runs the whole end-to-end test through a router in front of two servers, so live edits, undo, comments and the design list are checked there in a browser too.

The router relays MCP too (`crates/server/src/relay.rs`), so you can point an agent at the router's `/mcp` and reach every design. The router is an MCP server itself. For each agent session, it opens one session on each Finite server the first time it needs it, and sends each tool call to the server that owns the call's `designId`. An agent always uses the same session on a given server, so undo there works exactly as if it had connected directly. `list_designs` asks every server at once and merges the lists, and `create_design` takes turns. `tests/router.rs` runs one agent session that creates a design on each server, then edits and undoes on both.

When a server goes down, the relay keeps going. Calls for that server's designs fail with "didn't answer". The relay sends each call **at most once**: it doesn't retry, because a call may have run before the connection broke. `list_designs` still lists everyone else's designs and names the missing servers after the list. A server that answers with an error counts as missing too. If none answers, the call fails rather than return an empty list. Every server offers the same tools, so the relay asks each in turn for the tool list until one answers. Before, it asked only the first server, so with that one down an agent connecting to the router got no tools at all. A test in `tests/router.rs` lists tools through a router whose first server isn't running. When the server comes back, it has forgotten its MCP sessions. rmcp's client sees the `404` and opens a new session by itself, and the relay also opens a new one if the old one closed.

Each server has its own lock in the relay, so a slow server holds up only calls to that server. Opening a session, listing tools and `list_designs` each give a server the same 5 seconds, so a stuck server costs an agent a few seconds, not every call. Other tool calls have no limit, because `wait_for_comments` can rightly wait for minutes. `tests/router.rs` stops a server mid-session and restarts it on the same port, and the same agent session reaches it again.

Those relayed sessions are the router's only state, and they can be shared. Give every router the same `FINITE_SESSION_DIR` (a shared volume), and any router can serve any agent's session, so the load balancer doesn't have to pin sessions. The directory holds one small file per session with what its `initialize` request said, and that's all a router needs to resume a session it has never seen (`DirSessionStore` in `relay.rs`, plugged into rmcp's `SessionStore` hook). Each file is written to a temporary file with a random name, synced and renamed into place, so it's always whole, even if two routers save the same session at once. If one still can't be read, the router treats it as no session. That gets the agent a `404`, and its client starts a new session. An error would fail every request in that session instead.

Undo has to survive that move too, so the backends must see the same actor whichever router relays the call. An agent that sends `X-Finite-Agent` keeps that name. An agent that doesn't is identified by its router session id (`relay:<id>`), which every router sees the same way, and is shown under its client's name. `tests/router.rs` moves one session from one router to another mid-conversation and undoes, on the second router, an edit made through the first. With the identity switched off, that same test finds "Nothing to undo". Without a shared directory, a second router answers `404` for a session it doesn't know, and MCP clients respond by starting a new session.

MCP rejects requests whose `Host` header it doesn't know, to block **DNS rebinding**: a trick where a web page gets a browser to send requests to a server on your machine. By default it only accepts `localhost`, `127.0.0.1` and `::1`. Servers and routers also accept every host in `FINITE_NODES`, and any names you list in `FINITE_ALLOWED_HOSTS`, such as `finite.example.com`. Without that, a server at `10.0.0.2` would reject the router's calls.

## Limits at a glance

The guide explains each limit where it applies. This is the list in one place. Most are one constant, so changing one is a one-line edit plus its test.

| What                                   | Limit                                                             | Where it's set                             | Why                                                         |
| -------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| Nodes in a design                      | 100,000                                                           | `MAX_NODES` in `document.rs`               | Every node is journaled, held in memory and sent to viewers |
| Nesting depth                          | 256 levels                                                        | `MAX_DEPTH` in `document.rs`               | Tree walks are recursive; deeper overflowed the stack       |
| HTML nesting before parsing            | 4,096 by a quick count                                            | `html::parse`                              | html5ever is quadratic in depth                             |
| Undo steps per actor and stack         | 200 steps, about 32 MB                                            | `History::LIMIT`, `History::BYTE_LIMIT`    | Undoing a big delete recreates every node in it             |
| Undo for a named agent                 | 6 idle hours                                                      | `HISTORY_TTL` in `hub/mod.rs`              | Histories keep memory and snapshots busy                    |
| Idle MCP session                       | 1 hour                                                            | `SESSION_IDLE` in `mcp/mod.rs`             | An unnamed agent's undo ends with its session               |
| Open comments per design               | 500                                                               | `MAX_OPEN` in `comment.rs`                 | Anyone who can see a design can comment                     |
| Messages per comment thread            | 200                                                               | `MAX_MESSAGES` in `comment.rs`             | Same reason                                                 |
| Comment length, author name            | 4,000 and 48 characters                                           | `MAX_BODY`, `MAX_NAME` in `comment.rs`     | Shared with the web app through a golden file               |
| Agent id from `X-Finite-Agent`         | 64 characters                                                     | `MAX_USER_ID` in `comment.rs`              | Stored with every change and reply the agent makes          |
| Layer, design and status names         | 120 characters                                                    | `label.rs`                                 | Every viewer shows them; cut rather than refused            |
| Presence                               | 100 nodes, 5 idle minutes                                         | `PRESENCE_NODES`, `PRESENCE_TTL`           | Every viewer gets the list on each update                   |
| One tool result                        | 60,000 characters                                                 | `OUTPUT_LIMIT` in `mcp/format.rs`          | Claude Code cuts at 25,000 tokens wherever that falls       |
| `list_designs`, `get_children` pages   | 200 entries                                                       | `ListParams`, `ChildrenParams`             | 200 always fit in one result                                |
| Screenshot size                        | 3,000 pixels on the longer side                                   | `MAX_OUTPUT_SIDE` in `screenshot.rs`       | The Claude API's limit once a request has 20+ images        |
| Browsers rendering screenshots at once | Half the cores, 1 to 4                                            | `browsers()` in `screenshot.rs`            | Each capture starts its own Chrome                          |
| Journal before compaction              | 1,000 records or 16 MB                                            | `COMPACT_AFTER`, `COMPACT_BYTES`           | A load replays the whole journal                            |
| Handoff body                           | 256 MB                                                            | `HANDOFF_LIMIT` in `api.rs`                | A handoff carries a whole design; other routes keep 2 MB    |
| Server lease, with a shared store      | 10 s, renewed every 2 s                                           | `FINITE_LEASE_MS`, `Lease` in `cluster.rs` | How long a silent server keeps its designs                  |
| Waiting for a design that's moving     | Up to one lease, then `503`                                       | `Hub::open`                                | The old owner saves a last snapshot before it lets go       |
| Design list in the browser             | 200 newest                                                        | `LOBBY_LIMIT`, `mergeLobby`                | The rest are a search away                                  |
| Silent WebSocket                       | Closed after 60 s; the page gives up after 10 s without an answer | `heartbeat.rs`, `socket.ts`                | Half-open connections never close on their own              |

## Words used in the code

| Word          | Meaning                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| Design        | One canvas. Also called a canvas in the MCP tools.                               |
| Artboard      | A top-level node: a fixed-size frame placed on the canvas.                       |
| Node          | One element or text node.                                                        |
| Op            | The smallest edit: `create`, `delete`, `set` or `move`.                          |
| Change        | The ops from one commit, undo or redo, with a `seq`, actor and label.            |
| Actor         | Whoever made a change: an agent, by its `X-Finite-Agent` name or its session.    |
| Snapshot      | Everything needed to rebuild a design. Saved to disk and sent on connect.        |
| Journal       | The records appended to `<id>.log` since the last snapshot.                      |
| Compaction    | Writing a fresh snapshot and deleting the journal, every 1,000 records or 16 MB. |
| Replica       | The browser's copy of a design: the Rust document in WebAssembly, plus a cache.  |
| WebAssembly   | A binary format browsers run. `crates/wasm` compiles the document model to it.   |
| Golden file   | A recorded expected result that a test compares against, like `apply.json`.      |
| Presence      | "Agent X is working on these nodes", shown as a badge.                           |
| Hub           | The server's index of designs, with the ones in use loaded in memory.            |
| Room          | The model for loading: a design is in memory only while someone uses it.         |
| Long poll     | A request that stays open until there's news, like `wait_for_comments`.          |
| Epoch         | One load of a design on a server. A viewer can resume only within the same one.  |
| Revision      | A comment's `rev`: it goes up with each change, so the higher copy is newer.     |
| Owner         | The one server that holds a design, picked by hashing its id over the servers.   |
| Heartbeat     | The time a server writes to the shared store every 2 s, to show it's alive.      |
| Lease         | How long a heartbeat, or a claim on a design, counts. 10 s by default.           |
| Claim         | Taking a design's lease before loading it. It raises the design's fencing token. |
| Fencing token | The design's `epoch`. The store refuses a write with an older one.               |
| Fenced        | What a stale server's write gets: another server took the design over.           |
| Router        | `finite-server router`: the front door that sends requests to each owner.        |
