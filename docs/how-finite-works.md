# How Finite works

Finite is a design canvas that only agents edit. An agent connects over MCP and sends tool calls like "write this HTML into that artboard". The Rust server turns each call into a few small edits and applies them to the one true copy of the design. Then it streams those edits to every browser that has the design open. Each browser keeps its own copy, applies the same edits, and patches the page.

If you remember two ideas, make it these. The rest of this guide builds on them.

- **Every change is a list of ops.** An op is one tiny edit, like "set this node's `color` to red". Applying an op hands back its inverse, the op that undoes it. Undo, live updates and the comment links are all built from ops.
- **The server is the single source of truth.** Each design has a lock, so its edits happen one at a time in one order. Every browser applies the same ops in the same order, so every copy ends up the same.

## The big picture

```
 Agent (Claude, Cursor, …)                      Browser
        │  MCP tool call                           ▲  WebSocket: snapshot, then changes
        ▼                                          │
 ┌─────────────── finite-server (Rust, axum) ──────┴──────────┐
 │  mcp.rs   tool → edit command → ops                        │
 │  hub.rs   lock the design, commit, broadcast, save later   │
 │  api.rs   REST + WebSockets for the web app                │
 │  store.rs snapshot + append-only journal per design        │
 └────────────────────────────────────────────────────────────┘
        uses
 ┌─────────── finite-design (Rust, no I/O) ───────────┐
 │  node, document, op, design, history, edit, html   │
 └────────────────────────────────────────────────────┘
```

You can think of the code as three layers:

| Layer          | Where                 | What it knows                                                        |
| -------------- | --------------------- | -------------------------------------------------------------------- |
| Document model | `crates/design`       | Nodes, ops, undo stacks, edit rules, HTML. No network, no disk.      |
| Server         | `crates/server`       | Who is calling, locking, broadcasting, saving, screenshots.          |
| Viewer         | `apps/web/src/design` | A copy of the document, the DOM it draws, and the pan-and-zoom view. |

The document model has no I/O on purpose. You can test it with plain function calls, and it could later compile to WebAssembly so a browser runs the exact same rules.

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

There are only four ops:

| Op       | What it does                           | Its inverse                    |
| -------- | -------------------------------------- | ------------------------------ |
| `create` | Inserts one node                       | `delete` that node             |
| `delete` | Removes a node and its whole subtree   | `create` every removed node    |
| `set`    | Sets or clears one property            | `set` it back to the old value |
| `move`   | Gives a node a new parent and/or index | `move` it back                 |

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

### Undo with two agents, step by step

Say Alice and Bob are both agents on one design:

1. Alice creates artboard `a`. Her undo stack: `[delete a]`.
2. Bob creates `b` inside `a`. His undo stack: `[delete b]`.
3. Alice colors `b` red. Her undo stack: `[delete a, set b.color = none]`.
4. Bob undoes. `b` is deleted. Alice's red is gone with it, which is correct because the node is gone.
5. Alice undoes. Her top entry, `set b.color = none`, targets a node that no longer exists, so it's skipped and dropped. Undo falls through to `delete a`.

The test `undo_only_reverses_own_changes` in `design.rs` runs exactly this.

### The same rules in two languages

The browser applies ops too, in `Replica` (`apps/web/src/design/replica.ts`), so the rules exist twice: once in Rust and once in TypeScript. A shared **golden file** keeps them in step. `crates/design/fixtures/apply.json` lists cases: starting nodes, a list of ops, and the expected result. The Rust test (`crates/design/tests/conformance.rs`) and the TypeScript test (`apps/web/src/design/conformance.test.ts`) both run every case.

The expected results come from the Rust rules. To change a rule, you change `document.rs`, add or edit a case in the fixture, and regenerate:

```bash
FINITE_UPDATE_FIXTURES=1 cargo test -p finite-design --test conformance
```

Then `vp test` tells you whether `Replica` agrees. On its first run, it caught three ways it didn't: the browser cleared `x` when an op set it to the string `"10"` (Rust rejects it), and it accepted invalid indexes like `"V0"` and moves to where a node already was.

The formatter skips `crates/*/fixtures`, so a regenerated file only changes where the results did.

## Edit commands: from a tool call to ops

Agents don't send ops. They call tools with friendlier arguments, and `crates/design/src/edit.rs` translates them. If you want to add a tool, you start here. Each command reads the current document, checks the request, and returns ops. It never changes the document itself.

Some of the work these commands do:

- `write_html` parses HTML with `html.rs`, drops anything unsafe (`on*` attributes, `javascript:` URLs, `<iframe>` and the like), and emits one `create` per node.
- `update_styles` accepts `backgroundColor` or `background-color`. When you set a shorthand like `padding`, it also clears `padding-top` and friends. Styles are stored as a map, not as ordered CSS, so a leftover longhand would otherwise win.
- `move_nodes` and `duplicate` pick free canvas space for anything that becomes a new artboard.

## The server

### The hub

`crates/server/src/hub.rs` holds a `DesignHandle` for every design. Each handle has:

- a **mutex** around the design's state, so edits to one design run one at a time and edits to different designs never wait on each other;
- a **broadcast channel**, which fans each change out to every open WebSocket;
- a **save queue**: every change, comment update and rename is queued as a record, and a background task writes the queue 250 ms after the last edit.

`DesignHandle::edit` is the path almost every tool call takes:

1. Lock the design.
2. Run the edit command against the current document to get ops.
3. `Design::commit` them. This also logs the change for comments.
4. Broadcast the change and mark the design dirty.

Because steps 2 and 3 happen under one lock, no other edit can sneak in between reading the document and writing to it.

### Designs load and unload like rooms

A multiplayer server usually treats each document as a **room**: it's loaded into memory when someone joins, and unloaded when everyone has left. Finite's hub works the same way, so memory grows with the designs in use, not with every design ever made.

- **Loading:** `Hub::get` is the only way in. If the design's state isn't in memory, it reads the snapshot and journal from the store and replays them.
- **Unloading:** every 30 seconds, the hub's sweep looks for designs to drop. A design unloads only when all of these hold: nothing is waiting to be saved, nobody is watching it, no agent has presence or undo history in it, and it hasn't been opened for five minutes.
- **What stays:** the handle itself stays, with its channels and a cached `DesignSummary`. That's what the design list shows, so listing designs never loads one.

Unloading can't race with loading. The sweep holds the hub's write lock, which blocks `Hub::get`, and only unloads a handle when the hub holds the only reference to it. Anything using a design got it from `Hub::get`, so it holds a reference, and the design stays loaded until it's done. The save task holds only a weak reference, so it never keeps a design in memory.

On startup, the hub reads designs one at a time to build the list, then drops each one. So startup never holds every design in memory either.

### MCP

`crates/server/src/mcp.rs` is the agent-facing side, served at `/mcp` over Streamable HTTP with the `rmcp` crate. It defines every tool, the instructions agents see when they connect, and how a caller maps to an actor. The tool names follow [Paper's MCP server](https://paper.design/docs/mcp). Every tool except `list_designs` and `create_design` takes a `designId`.

Read tools (`get_tree_summary`, `get_node_info`, `get_html`, `get_screenshot`) lock the design just long enough to copy what they need. `get_screenshot` writes the artboard to a temporary HTML file and runs headless Chrome on it (`screenshot.rs`).

`start_working_on_nodes` sets **presence**: a note that an agent is busy on some nodes. Browsers show it as a badge on the artboard. Presence expires after five minutes without activity, and an actor's undo history is dropped after six idle hours or when its MCP session ends.

### The web API

`crates/server/src/api.rs` serves the browser:

| Route                                                    | What it's for                                       |
| -------------------------------------------------------- | --------------------------------------------------- |
| `GET /api/designs`, `POST /api/designs`                  | List designs, create an empty one                   |
| `GET /api/designs/{id}`                                  | One snapshot (used by thumbnails)                   |
| `GET /api/designs/ws`                                    | WebSocket: the design list, then updates            |
| `GET /api/designs/{id}/ws`                               | WebSocket: one design's snapshot, then every change |
| `POST …/comments`, `…/replies`, `PATCH …/comments/{cid}` | Comment, reply, resolve                             |

The messages on these sockets are Rust types on the server and Effect schemas in `apps/web/src/design/schema.ts`. A second golden file keeps those in step. `crates/server/tests/wire.rs` drives a real hub through an edit, an undo, presence, a comment, an agent reply and a rename, and records every message it broadcasts in `crates/server/fixtures/messages.json`. Then `apps/web/src/design/wire.test.ts` decodes each one with the web schemas. If you rename a field on the Rust side, `cargo test` fails until you regenerate the file, and then `vp test` fails until you update the schema.

When a browser opens a design's socket, the server takes the lock first. Under that lock, it subscribes the socket to the broadcast channel and builds a snapshot. That way no change can land between the snapshot and the stream. If a slow browser falls more than 1024 messages behind, it gets a fresh snapshot instead of the missed changes.

### Storage

Saving is a **write-ahead journal with compaction**, the same idea databases use. Each design has two files in `FINITE_DATA_DIR/designs/` (`crates/server/data` in dev):

- `<id>.json` is the last full snapshot.
- `<id>.log` is the journal: one JSON record per line for everything since that snapshot. A record is a change, the new state of a comment, or the design's name and timestamps (`Record` in `crates/design/src/design.rs`).

After a burst of edits, the save task appends the new records to the log. That costs the same for a ten-node design as for a ten-thousand-node one. In the demo, one style change appended 305 bytes instead of rewriting the 11 KB snapshot. Every 1000 records, the task writes a fresh snapshot instead and deletes the log. That step is **compaction**.

On startup, the server loads each snapshot, replays its log with `Design::replay`, and compacts right away. Replaying is safe to repeat: changes at or below the snapshot's `seq` are skipped, and comments and meta just overwrite. So a crash at any point loses at most the last 250 ms of edits:

- **Mid-append:** the log ends in a torn line. Loading stops at it, and the startup compaction drops it for good.
- **Mid-compaction:** the new snapshot is written to a temporary file and renamed into place, so it's either all there or not at all. If the old log survives next to the new snapshot, replaying it changes nothing.

The hub only calls four methods on the `Store` trait in `store.rs`: `ids`, `load`, `save` and `append`. A database could replace the files behind them. To check a new store, run `store::contract::check` on it. It's a **contract test**: the same suite of rules every store must follow, such as "the journal keeps append order" and "save clears the journal". The file store and the memory store both run it in `cargo test`. Undo histories aren't saved, so a restart clears them.

## Following one edit end to end

Say an agent makes a button orange:

```
update_styles({ "designId": "k7jo11y14e",
  "updates": [{ "nodeIds": ["4biyjm26"], "styles": { "backgroundColor": "#ff5a1f" } }] })
```

1. `mcp.rs` works out the actor (`agent:Claude`, from the header) and calls `DesignHandle::edit` with the label "Update styles".
2. `edit::update_styles` normalizes the name and returns one op: `set 4biyjm26 style:background-color "#ff5a1f"`.
3. `Design::commit` applies it, gets back `set … "#111"` as the inverse, pushes that onto Claude's undo stack, and bumps `seq` to 13.
4. The hub broadcasts this message to every browser on the design:

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
6. In each browser, `Replica` applies the op, and `Renderer` calls `style.setProperty("background-color", "#ff5a1f")` on that one button.

## The viewer

The browser side lives in `apps/web/src/design`. It's plain TypeScript classes, and React only hosts them. Here they are in the order a message flows through them:

- **`socket.ts`** opens the WebSocket, decodes each message with the Effect schemas in `schema.ts`, and reconnects with backoff. Every connection starts with a snapshot, so a reconnect needs no special catch-up logic.
- **`DesignSession`** (`session.ts`) owns one open design. It feeds each socket message to the replica, hands every applied op to the renderer, and keeps what the page shows around the canvas: the design's name, presence badges, comments, the activity list and the connection status. It holds all of that in one immutable state object, and `DesignCanvas` re-renders when it changes. The renderer plugs in through a three-method interface (`DesignView`), so `session.test.ts` runs it in Node with a fake renderer.
- **`Replica`** (`replica.ts`) is the browser's copy of the document. Its `apply` follows the same rules as the Rust `Document::apply`, op for op. It returns what it touched, for the renderer.
- **`Renderer`** (`renderer.ts`) draws each artboard and patches only the DOM nodes an op touched. An artboard normally renders inside a **shadow root**, which scopes its `<style>` blocks to it and keeps the app's CSS out. An artboard that contains a `<script>` renders in a **sandboxed iframe** instead (`sandbox="allow-scripts"`), with a content security policy that blocks network requests. Iframes can't be patched from outside, so they reload 150 ms after a burst of edits.
- **`Camera`** (`camera.ts`) handles pan and zoom with one CSS transform on the canvas. It also converts page coordinates to canvas coordinates (`toWorld`).

`components/DesignCanvas.tsx` wires these together and adds what's specific to the page: the comment tool, hover outlines, the zoom controls and keyboard shortcuts.

The design list page (`DesignGrid.tsx`) uses the lobby socket, and each card's `Thumbnail` renders a static copy of the design with scripts off.

## Comments

You can't edit a design yourself, but you can pin comments, and agents act on them. A comment is a thread of messages anchored to an artboard and to the element the person clicked.

Here's what happened in the demo you saw:

1. In comment mode, the canvas asks `Renderer.hitTest` what's under the pointer. It finds the deepest element with `elementFromPoint` inside the artboard's shadow root, and outlines it.
2. A click posts the comment over REST. It sends the artboard id, the node id, and the click's offset from the artboard's corner, so the pin moves with the artboard.
3. The agent sees `openComments: 1` in `get_basic_info`, reads the thread with `get_comments`, edits, and answers with `reply_to_comment`.
4. `Design` keeps a **change log**: the last 512 changes, each with its actor, the artboards it touched, and the elements it changed. Every commit, undo and redo goes through one function (`Design::finish`) that writes to the log, so no path can skip it. When an agent replies, `Design::reply` attaches that agent's changes to the comment's artboard since the thread's previous message. Those become the "Show what changed" buttons.
5. Your reply reopens a resolved comment, so you can keep steering in one thread.

Comments live beside the document, not inside it, so undo never touches them. They're saved in the same JSON file as the design.

All the thread rules live in `crates/design`: `comment.rs` defines the types and checks, and `Design::add_comment`, `reply` and `set_resolved` apply them. The hub only takes the lock, calls one of those, and broadcasts the updated comment. That means you can test a comment rule with a plain function call, like the tests at the bottom of `design.rs`.

## Words used in the code

| Word     | Meaning                                                                   |
| -------- | ------------------------------------------------------------------------- |
| Design   | One canvas. Also called a canvas in the MCP tools.                        |
| Artboard | A top-level node: a fixed-size frame placed on the canvas.                |
| Node     | One element or text node.                                                 |
| Op       | The smallest edit: `create`, `delete`, `set` or `move`.                   |
| Change   | The ops from one commit, undo or redo, with a `seq`, actor and label.     |
| Actor    | Whoever made a change: an agent session today.                            |
| Snapshot | Everything needed to rebuild a design. Saved to disk and sent on connect. |
| Replica  | The browser's copy of a design.                                           |
| Presence | "Agent X is working on these nodes", shown as a badge.                    |
| Hub      | The server's index of designs, with the ones in use loaded in memory.     |

## Running more than one server

One server process can now hold many designs, because only the ones in use are in memory. Running several servers is the next step, and the rooms model sets it up. A design is only ever loaded in one place, so if each design lived on exactly one server, nothing in the hub would need to change. Three pieces are still missing:

- **A router.** A load balancer would have to send every request for a design to the same server, by hashing the design id from the URL path (`/api/designs/{id}/…`). MCP is harder. The design id sits inside each tool call's JSON body, and one MCP session can work on designs that live on different servers. So MCP would need its own front server that keeps the session and forwards each tool call to the server that owns its design.
- **A shared store.** Every server would need to see the same designs, so the files in `FINITE_DATA_DIR` would move to a database behind the `Store` trait.
- **A shared design list.** Each server's lobby socket only hears about its own designs. The list updates would have to go through something every server can read, such as Redis pub/sub or Postgres `LISTEN`/`NOTIFY`.
