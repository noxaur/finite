---
name: verify-ops
description: Exhaustively check that every op's inverse puts the document back exactly, and that undo and redo stacks rebuilt after a restart match the live ones. Use when a change touches Document::try_apply, apply_all, insert or remove in crates/design/src/document.rs, Node::get/set in node.rs, History in history.rs, or Design::commit, undo, redo, step, finish, replay, replay_change, replay_with_history, snapshot_to_save or from_snapshot in design.rs, or when asked whether undo can corrupt a design or stop working after a restart.
---

# Verify ops

Undo, redo, transaction rollback, `dry_run` and crash replay all rely on one rule: applying an op hands back ops that put the document back exactly as it was. `crates/design/tests/ops_exhaustive.rs` checks that rule against the real `Document::try_apply`, and checks that a restarted server rebuilds the same undo and redo stacks. It runs every input within small bounds instead of sampling.

- **`every_op_undoes_exactly`.** Starting from an empty document, it visits every document reachable in up to 3 ops from a list of 254 ops (37,785 documents), and tries all 254 ops on each one (9.6M checks). After each op, the tree is well formed: every parent exists and can hold children, there are no cycles, and the child and instance indexes match the nodes. An op that's skipped or rejected leaves the document unchanged. An op that reports a change really changes something. Every inverse op applies, the inverse restores the document exactly, and the inverse's own inverse brings the change back. If this breaks, an agent's undo leaves the design different from before its edit, a failed transaction leaves part of itself behind, or undo silently does nothing.
- **`undo_survives_a_restart`.** It runs every sequence of up to 6 steps, where each step is one of 2 actors making one of 11 edits, undoing, or redoing (2,263,276 sequences that change something). It saves a snapshot before each step and journals each change, as the server does. Then it restarts from every snapshot and replays the journal after it, with both going through JSON as the stores write them. The rebuilt design must have the same document, seq, and undo and redo stacks as the live one. If this breaks, the first undo after a restart reverses the wrong change, or an agent finds it can no longer undo at all.

The code today passes the second check and breaks the first in two known ways, listed under "Known findings". The test expects them and fails if either one disappears.

## Does your change touch this?

Yes, if it changes a function in this table.

| Check                     | Code                                                                                                                                                                                                                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `every_op_undoes_exactly` | `document.rs`: `Document::try_apply`, `apply`, `apply_all`, `insert`, `remove`, `can_parent`, `subtree`, `is_ancestor`, `link_instance`, `unlink_instance`. `node.rs`: `Node::get`, `Node::set`. `fractional::is_valid`. `tokens::check_name`, `check_value`                                                                           |
| `undo_survives_a_restart` | `design.rs`: `Design::commit`, `undo`, `redo`, `step`, `finish`, `replay`, `replay_change`, `replay_with_history`, `snapshot_to_save`, `from_snapshot`, `history_mut`. `history.rs`: `History::record`, `push`, `trim`, and the pop and push methods. The serde derives on `Snapshot`, `Record`, `Change`, `History`, `Entry` and `Op` |

Paths are under `crates/design/src/`. The server calls these from `DesignState::restore` and `DesignHandle::edit` in `crates/server/src/hub/design.rs`, but the check runs only the design crate.

**Sync commit: `f52aa74`.** That's the last commit at which the check was confirmed to describe this code. To see what changed since then, run:

```sh
git diff f52aa74 -- crates/design/src/document.rs crates/design/src/node.rs crates/design/src/design.rs crates/design/src/history.rs crates/design/src/fractional.rs
```

If the diff touches a function in the table, read the check's op lists (`ops()` and `edits()`) next to it before you trust a pass. A new `Op` variant, a new `PropKey`, or a new validation rule in `try_apply` needs new entries in `ops()`, or the check won't try it. Move the sync commit forward, in this file, only after you've confirmed that the op lists still cover the code at the new commit.

## Run it

```sh
python3 .agents/skills/verify-ops/check.py              # both checks, about 7 minutes
python3 .agents/skills/verify-ops/check.py --mutations  # also proves each check can fail, about 3 minutes in all
```

It uses Cargo and the versions in `Cargo.lock`, and needs nothing else. Both tests are `#[ignore]`d, because CI's debug `cargo test -p finite-design` would spend many minutes on them, so CI doesn't run them; `check.py` runs them in release with `--include-ignored`. Last run with rustc 1.99.0 (b940084d7 2026-09-28). Each check prints its counts. The ops check also prints each known finding with the shortest path that reaches it.

`--mutations` copies `crates/` into a temporary folder, breaks one guarded step at a time (a `Move` inverse that forgets the old parent, a `Delete` inverse that recreates only the root, inverses applied in the wrong order, replay that stops at a stale undo entry, snapshots without histories, and three more), and requires the matching check to fail. It sets `FINITE_FAIL_FAST`, so a broken copy stops at its first new break. It prints `CAUGHT:` for each one. `mutation drift` means the code changed and the text that `check.py` replaces no longer appears exactly once, so update `MUTATIONS` in `check.py`.

## Read the result

A failure in `every_op_undoes_exactly` prints `NEW: <rule>`, the detail, the ops from an empty document that lead to the break, and the op that breaks it. A failure in `undo_survives_a_restart` prints `BROKEN: a restart changes the <document | seq | histories>`, the steps, which snapshot the restart started from, and both sets of stacks.

Decide whether the bug is in the code or in the check:

- **A real bug** gives a path that the code can take. Replay it in a unit test with the same ops, and report it in the code's words: which op, on which document, and what undo did. Don't remove ops from the lists or loosen a rule until it passes, and don't change product code unless you've been asked to.
- **A check error** gives something the code never claims. Examples: `state()` misses a field that changed, so two different documents look equal; `well_formed` demands a rule the document doesn't promise; or an entry in `edits()` builds an op that no edit command would. Fix the check, and say what you fixed.
- **`fixed? [...] no longer happens`** means a known finding is gone. If you meant to fix it, remove it from `KNOWN` and `known()` in the test and from "Known findings" below. If you didn't, your change hid it: find out how.

## When you change the covered code on purpose

1. If you add an `Op` variant, a `PropKey` or a new kind of node, add it to `ops()`, including a value that `try_apply` should refuse. If edit commands can build it, add it to `edits()` as well.
2. If you add state to `Document` or `History`, add it to `state()` or `histories()`. A field the check doesn't compare is a field it doesn't check.
3. Break your new code on purpose in a scratch copy and check that the test fails. Add the break to `MUTATIONS` in `check.py` if it guards a new step.
4. Run `check.py --mutations`, then move the sync commit forward.

## Known findings

Both are on the code at `f52aa74`. Neither is reachable from today's edit commands, which build sibling indexes with `fractional::keys_between` and positions with `Value::from(f64)`. Each is a rule that `Document::try_apply` lets through, so a future caller, or a snapshot written by older code, could hit it.

1. **`Create` keeps a sibling index that `Move` refuses, so moving the node can't be undone.** Create artboard `a` with `index: "0"`. `Create` doesn't call `fractional::is_valid`, so it's accepted. Move `a` to index `"V"`. The inverse is `Move a to "0"`, and `Move` refuses `"0"` because it ends in `0`. Undo skips it, and `a` stays moved. Snapshots load nodes with `Document::from_nodes`, which doesn't check indexes either.
2. **An integer position counts as a change.** Set `a.x` to `1`. The node stores `1.0`, and `Node::get` reads it back as the JSON number `1.0`. Setting `a.x` to `1` again compares `1.0` with `1`, which `serde_json` says differ, so `try_apply` reports a change that changed nothing. `Design::commit` then takes a seq, broadcasts it, and clears the actor's redo stack.

## What this doesn't cover

- Bigger documents and longer runs: at most 3 node ids (`a`, `b`, `c`), 3 indexes, 3 ops deep for the ops check, and 6 steps for the restart check. Documents start empty, so stored states that no sequence of ops builds, like a token value that fails `check_value` today, aren't tried.
- Ops outside the lists: other style and attribute keys, `y` except through finding 2's matcher, `name` and `mode` beyond one value, more than one page, mode or token, and the token and mode limits (`MAX_TOKENS`, `MAX_MODES`).
- In the restart check, only single-op edits through `commit`. `transact`, `import`, batches (`begin_batch`, which aren't saved), comments, `migrate_css`, and `History::LIMIT` and `BYTE_LIMIT` aren't run. The history's `lastUsed` clock isn't compared.
- Whether undo is the right thing to do with other actors' work. The check proves inverses are exact, not that last-writer-wins is what a person wants.
- The server, the stores, the Wasm `Replica`, `user_edit::plan`, and `Design::merge`. The leases model (`/verify-design-leases`) covers saving across servers.
