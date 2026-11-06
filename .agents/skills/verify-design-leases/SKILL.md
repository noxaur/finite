---
name: verify-design-leases
description: Model-check how Finite servers that share a Postgres store hand a design between them (leases, fencing tokens, the save task, MCP edits) with the TLA+ model in crates/server/tla. Use when a change touches Hub::tick, let_go, drop_copy, discover, persist, DesignHandle::load/retire/end/take_save/edit/unload_if_idle, Members::lapsed, or the Store claim/save/append/release/held calls, or when asked whether an edit can be lost when a design moves between servers.
---

# Verify design leases

`crates/server/tla/DesignLeases.tla` is a TLA+ model of two Finite servers that share one store, and one design moving between them. TLC, the TLA+ model checker, tries every order of their steps within small bounds and checks two rules:

- **StoredEditsStay** (fencing): once the store accepts an edit, no stale copy on another server ever overwrites it. If this breaks, a server that stalled wakes up and wipes out edits the new owner saved.
- **AckedEditsStay**: an edit that an MCP tool reported as done is in the store, or in a copy that can still save it, unless its server crashed or its lease expired before the edit was saved. If this breaks, an agent is told its edit worked, and then the edit is gone. Viewers see it vanish, and nothing tells the agent.

The code today passes the first rule and breaks the second in four known ways. They're listed under "Known findings" below.

## Does your change touch this?

Yes, if it changes any function in this table. Each model step names the code it stands for, and a reviewer can open both side by side.

| Model step                                                                        | Code                                                                                                                                         |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `CallStarts`, `CallFindsHandle`, `CallLoads`, `CallEdits`, `CallReads`            | `mcp/mod.rs` `design`, `edit_checked`; `api.rs` `open`; `hub/mod.rs` `Hub::open`, `handle_for`; `hub/design.rs` `DesignHandle::load`, `edit` |
| `SaveTakes`, `SaveWrites`, `SaveFenced`, `SaveFails`, `SaveReleases`, `SaveDrops` | `hub/mod.rs` `persist`; `hub/design.rs` `take_save`, `save_failed`                                                                           |
| `Unload`                                                                          | `hub/mod.rs` `Hub::sweep`; `hub/design.rs` `unload_if_idle`, `is_idle`                                                                       |
| `TickRenews` … `TickDiscovers`                                                    | `hub/mod.rs` `Hub::tick`, `let_go`, `remove`, `drop_copy`, `discover`, `summaries`; `hub/design.rs` `retire`, `end`, `lease`                 |
| `Owns`, `LeaseLapses`, `HeartbeatExpires`                                         | `cluster.rs` `Members::now`, `lapsed`, `renewed`, `Cluster::owns`, `owner`                                                                   |
| `CanClaim`, `Claimed`, store writes                                               | `postgres/mod.rs` `claim`, `save`, `append`, `release`, `held`; `store.rs` `trait Store` (the in-memory shared store must match)             |
| `Start`, `Crash`                                                                  | `hub/mod.rs` `Hub::shared`                                                                                                                   |

Paths are under `crates/server/src/`.

**Sync commit: `6606714`.** That's the last commit at which the model was checked against this code. To see what changed in the covered code since then, run:

```sh
git diff 6606714 -- crates/server/src/hub crates/server/src/mcp/mod.rs crates/server/src/api.rs crates/server/src/cluster.rs crates/server/src/postgres/mod.rs crates/server/src/store.rs
```

If the diff touches a function in the table, re-read the model step next to it before you trust a pass. Move the sync commit forward, in this file, only after you've confirmed that each changed step still matches the code at the new commit.

## Run it

```sh
crates/server/tla/check.sh          # the everyday check, about 2 minutes
crates/server/tla/check.sh --full   # adds Finding4.cfg and AllFixes.cfg, about 3 minutes more
```

The script downloads TLC (`tla2tools.jar` v1.7.4, SHA-256 checked) into `~/.cache/finite` on its first run. You need Java 11 or newer. Each config prints `ok` when it gives the result recorded for the code today, and `FAIL` otherwise. When a rule breaks, TLC's output, with the shortest path to the break, is saved as `crates/server/tla/<config>.out`. Git ignores those files.

| Config             | Fixes on             | Bounds                                                   | Result today                       |
| ------------------ | -------------------- | -------------------------------------------------------- | ---------------------------------- |
| `Fencing.cfg`      | none                 | 1 edit, 1 read, 2 handles, every behavior up to 18 steps | pass, about 2.8M states, 2 minutes |
| `DesignLeases.cfg` | none                 | 1 edit, 2 handles                                        | finding 1, seconds                 |
| `Finding2.cfg`     | FixRetire            | 1 edit, 2 handles                                        | finding 2                          |
| `Finding3.cfg`     | FixRetire, FixOrphan | 2 edits, 2 handles                                       | finding 3                          |
| `Finding4.cfg`     | + FixStaleDrop       | 2 edits, 2 handles                                       | finding 4, about 1 minute          |
| `AllFixes.cfg`     | all four             | 2 edits, 2 handles                                       | pass, about 16M states, 2 minutes  |

Every config bounds the store's epoch at 3, and none includes a crash or a failed write. A read is a call that loads the design without editing it, like an MCP read tool or a viewer's socket. Fencing needs one, because a stale copy can only exist when two calls have loaded the design. Its full state space with that read didn't finish in 30 minutes, so `check.sh` runs it with TLC's iterative deepening (`-dfid 18`): every behavior of up to 18 steps. The shortest stale overwrite takes 17. The finding configs explore everything within their bounds. TLC stops at the first broken rule, so each finding config turns on the proposed fixes for the findings before it. The `Fix*` constants are what-if switches. With all of them `FALSE`, the model is the code as it is today.

## Read the result

Read each result with the `/statechart` skill. It turns TLC's shortest path to a broken rule into a numbered list of steps in plain words, and when a config passes, it draws a chart of how the design moves between servers.

When a config prints `FAIL`, decide whether the bug is in the code or in the model:

- **A real bug** gives a path you can replay in the code. Walk each step, open the function from the table, and check that the code allows that step in that order. Then report the path in the code's words, as the findings below do. Don't weaken a rule or a bound until the check passes, and don't change product code unless you've been asked to.
- **A modeling error** gives a step the code can't take. Examples: two steps that the code runs under one lock (the state mutex, the persistence mutex), split apart in the model; a model step without a guard that the code has; or a heartbeat that expires right after a renewal. Fix the model to match the code, and say what you fixed.
- A `Fencing.cfg` break comes from the depth-bounded run, whose path doesn't name its steps. To get a named shortest path, run the same config breadth-first: `cd crates/server/tla && java -cp ~/.cache/finite/tla2tools-1.7.4.jar tlc2.TLC -workers auto -config Fencing.cfg DesignLeases.tla`. It stops at the first break, which took about 6 seconds for the break under "When you change the covered code on purpose".
- **`error`** means TLC didn't finish: a parse error, or a variable that an action leaves unassigned. Read the `.out` file.

A `FAIL` where the code used to break the rule and now passes is good news. The findings table under "Known findings" shows how to record it.

## When you change the covered code on purpose

1. Change the model step in the same commit as the code, and keep the comment that names the function.
2. If your change fixes a finding, put the fix into the model as code, not as a switch: delete the `Fix*` constant, make the step behave as the new code does, and remove the switch from every config. The next finding's config becomes the default config, and `check.sh` gets the new expected results.
3. Before you trust a pass, break the code on purpose in a scratch copy, mirror the break in the model, and check that the config catches it. For example, if you drop `AND epoch = $3` from `PgStore::save` and drop `x.ptok = store.epoch` from `SaveWrites`, `Fencing.cfg` breaks StoredEditsStay. A check that you've never seen fail proves nothing.
4. Run `check.sh --full`, then move the sync commit forward.

## Known findings

Each is a race condition on the code at `6606714`. In each one, the agent's tool call returns success and the edit is gone.

1. **An edit lands on a copy that's already saving its last snapshot.** Server A has the design loaded, and an MCP call has passed `Hub::open`. Server B joins and wins the design (a lapsed lease on A does it too). A's tick calls `let_go`, so `retire` marks the copy `Retiring`. The save task's `take_save` takes the last snapshot. Then the call's `DesignHandle::edit` takes the lock and commits to the retiring copy, because `edit` never looks at `life`. The save task saves the snapshot without the edit, releases the lease, and `drop_copy` clears `pending`. B loads the design without the edit. To trigger it in the real app, edits must already be waiting on the design's lock when the tick runs, such as several agents running large `html` ops. Undo, redo, import and comment updates take the same path.
2. **An edit lands on a handle the hub already dropped from its list.** A call's `handle_for` returns a handle that isn't loaded. B joins, and A's `let_go` sees nothing loaded, so it calls `remove`. The call's `load` claims the lease and loads a copy on that handle. The next tick's `loaded` list comes from the hub's list, which no longer has this handle. So the tick releases the lease, and the copy's next save fails with `Fenced`. This needs no stall, only a server joining.
3. **The tick drops a copy that was loaded again after the tick read it.** One server, no membership change. The tick reads `lease()` (token 1). Then the design unloads, and a call loads it again (token 2) and commits an edit. The tick reads `held()` (token 2), sees that 2 ≠ 1, and calls `drop_copy`. `drop_copy` ends the new copy, pending edit and all. The window is two reads apart, so it's narrow, but it runs on every tick.
4. **A server that just renewed its lease serves its stale copy.** B stalls past its lease, A takes the design over and saves an edit. B wakes. Its tick renews the heartbeat, and from that moment `Members::now` counts B as live and the owner again. But the `let_go` loop hasn't run yet. A call on B loads the still-`Live` stale copy and commits an edit, which later fails with `Fenced`. It needs a stall first.

`AllFixes.cfg` checks one proposed fix for each finding: `edit` refuses a copy that isn't `Live` (1) or a handle that isn't listed (2). The tick drops a copy only if its token is the one it read (3). A server that renewed after a lapse counts itself out until it has let go (4). With all four, AckedEditsStay holds at these bounds.

## What this doesn't cover

- One design, two servers, MCP edits. Undo, redo, import, comments and rename take the same lock-and-commit path but aren't modeled on their own. Neither is `Hub::delete`.
- The file store and `FINITE_NODES` handoffs (`hand_off_one`, `adopt`), and the router.
- `Hub::flush` on shutdown, journal compaction thresholds (`COMPACT_AFTER`, `COMPACT_BYTES`), and `Recent`, the buffer behind viewer resume.
- Timing. TLC tries every order of steps, so the model shows that a race exists, not how often it happens. It assumes that a server's own lease timer (`Members::lapsed`) runs out no later than the database counts its heartbeat as expired. That holds when the two clocks run at the same rate.
- Bigger bounds. More edits, reads, handles or epochs, crashes and failed writes aren't in the everyday configs. `AllFixes.cfg` also passed with 1 edit, 1 crash and 1 failed write (3.4M states). Fencing past 18 steps hasn't finished: with 1 edit and 1 read it passed 50M distinct states and was still going. Don't trust an older Fencing pass with no read: one edit alone loads only one copy, so nothing can go stale.
