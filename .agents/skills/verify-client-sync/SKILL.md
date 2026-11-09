---
name: verify-client-sync
description: TLA+ model of the page's connection to the Finite server. Use when a change touches apps/web/src/client/finite.ts (connect, retry, resume, request, track, overdue, askAgain, subscribeDesign, holdDesign, loadThread, appendThreadEvent), the hello, subscribe or unsubscribe handlers, apps/server/src/hub.ts socket handling, or apps/server/src/replies.ts, or when reconnects, stale subscriptions, lost requests or stuck streaming text are reported.
---

# Verify client sync

`model/ClientSync.tla` holds every order of socket events, page moves and server replies for one design, one thread and one request. TLC checks the rules below in all of those orders.

## Run

```bash
.agents/skills/verify-client-sync/check.sh
```

It takes about 40 seconds and needs Java and TLC 2.19, at `$HOME/.local/share/tlaplus/tla2tools.jar` or wherever `TLA2TOOLS` points. Each row of `model/expected.tsv` is one TLC run of one rule on one variant.

- Exit 0: every rule matches the record, including the known bugs.
- Exit 1: a `MISMATCH` row names the rule and the file with TLC's trace.
- Exit 2: TLC couldn't finish, usually a model error or a deadlock. Read the kept output.

Read every result with `/statechart`: it turns a violation into its shortest path in plain words and draws the states when the rules hold. `model/view.ts` is its view for the flow "Your connection drops while you work", and `model/chart.cfg` is the config for it: the request alone with small budgets, to fit the chart limit.

## Rules

| Rule                         | In plain words                                                   | Harm if broken                                                           | Today |
| ---------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ | ----- |
| `BackoffGrows`               | The retry delay grows while connections keep failing             | The page hammers a failing server every 250 ms                           | holds |
| `ReleasedDesignUnsubscribed` | A design nobody shows isn't subscribed once the page settles     | The server keeps sending its events and keeps its dev server from idling | holds |
| `FailedMeansNotApplied`      | A request the page calls failed did not run                      | "Try again" sends a message twice                                        | holds |
| `AtMostOnce`                 | However often the page asks, the server runs a request once      | A reconnect sends a message twice                                        | holds |
| `NoStaleStreaming`           | A finished turn's partial text doesn't sit beside its final text | The thread shows the reply twice, one copy cut off                       | holds |
| `LoadedMeansHistory`         | A thread with messages never shows as loaded and empty           | The thread looks empty                                                   | holds |
| `HeldDesignSubscribed`       | A design on screen is subscribed once the page settles           | The design stops updating after a reconnect                              | holds |
| `NoRequestBeforeHello`       | The server never gets a request before hello                     | The server refuses it with "send hello first"                            | holds |
| `RequestSettles`             | A request settles once the server is back                        | A caller waits forever                                                   | holds |

`RequestSettles` assumes the server comes back. With the server gone for good, a queued request waits forever; the header of `finite.ts` promises that. `FailedMeansNotApplied` stays true because a request that may have run settles as unknown: the page asks again after a reconnect, and says "may have gone through" only when hello shows the server's memory changed or the request got too old to ask about.

## Does your change touch this?

Compare with the sync commit:

```bash
git diff 4025ebd6712ebb76e092381adc0457c218cd56de -- apps/web/src/client/finite.ts apps/server/src/hub.ts apps/server/src/replies.ts apps/server/src/handlers.ts
```

Changes in `handlers.ts` matter only inside `hello` (its `memory`), `subscribe` and `unsubscribe`. An empty or unrelated diff needs no model change, so run the check only if you edited the model.

## When the code changed

1. Find the actions the change affects in the coverage table. An action is one synchronous run: a new `await` or socket callback splits it into two.
2. Edit the action in `ClientSync.tla` so it says what the code now says, before you look at any rule.
3. Run the check. For a mismatch, read the trace with `/statechart`, then replay it step by step on the real client, in `finite.test.ts` with its `FakeSocket`.
   - The replay reproduces it: the code has a bug. Report it, or fix it and flip the row.
   - The replay doesn't reproduce it: the model is wrong. Fix the action to match the code.
4. For an intended behaviour change, update the rule and its plain-words row together. Every rule keeps a row that shows it failing: a `fixed` variant for today's bugs, or a broken variant.
5. Move `Last synced` forward only after you've confirmed every row of the coverage table against the new commit. `/maintain-formal-verification-skill` brings the model back in line after changes that skipped this.

Keep a rule's meaning when it goes red. Weakening a rule to pass hides the bug it found.

## Coverage

Last synced: `4025ebd6712ebb76e092381adc0457c218cd56de`

| File                            | Function                          | Actions                                                                 | Rules                                                             |
| ------------------------------- | --------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `apps/web/src/client/finite.ts` | `connect`, `ws.onopen`            | `SocketOpens`, `HelloAccepted`, `HelloRefused`                          | `BackoffGrows`, `NoRequestBeforeHello`                            |
| `apps/web/src/client/finite.ts` | `ws.onclose`, `retry`             | `ConnectionDrops`, `ClosingCompletes`, `RetryFires`                     | `BackoffGrows`, `FailedMeansNotApplied`, `LoadedMeansHistory`     |
| `apps/web/src/client/finite.ts` | `resume`                          | `HelloAccepted`                                                         | `HeldDesignSubscribed`, `NoStaleStreaming`                        |
| `apps/web/src/client/finite.ts` | `request`, `track`, `receive`     | `YouSendRequest`, `ReplyArrives`                                        | `RequestSettles`, `FailedMeansNotApplied`, `NoRequestBeforeHello` |
| `apps/web/src/client/finite.ts` | `overdue`, `askAgain`             | `RequestTimesOut`, `RequestGivesUp`, `HelloAccepted`                    | `AtMostOnce`, `FailedMeansNotApplied`, `RequestSettles`           |
| `apps/server/src/hub.ts`        | `receive`                         | `ServerReceivesRequest`                                                 | `AtMostOnce`, `RequestSettles`                                    |
| `apps/server/src/replies.ts`    | `ask`, `finish`                   | `ServerReceivesRequest`, `ServerFinishes`, `ServerForgets`              | `AtMostOnce`, `RequestSettles`                                    |
| `apps/web/src/client/finite.ts` | `holdDesign` and its release      | `PageHolds`, `PageReleases`, `LingerExpires`                            | `HeldDesignSubscribed`, `ReleasedDesignUnsubscribed`              |
| `apps/web/src/client/finite.ts` | `subscribeDesign`                 | `SnapshotArrives`                                                       | `ReleasedDesignUnsubscribed`                                      |
| `apps/web/src/client/finite.ts` | `loadThread`, `appendThreadEvent` | `HistoryArrives`, `HistoryRefused`, `ServerStreamsText`, `TurnFinishes` | `NoStaleStreaming`, `LoadedMeansHistory`                          |
| `apps/server/src/hub.ts`        | `connect` (message and close)     | `ServerReceivesSubscribe`, `ServerReceivesUnsubscribe`, `Closed`        | `HeldDesignSubscribed`, `ReleasedDesignUnsubscribed`              |
| `apps/server/src/handlers.ts`   | `hello`                           | `HelloAccepted`, `ServerForgets`, `ServerRestarts`                      | `AtMostOnce`, `FailedMeansNotApplied`                             |
| `apps/server/src/handlers.ts`   | `subscribe`, `unsubscribe`        | `ServerAddsSubscription`, `ServerReceivesUnsubscribe`                   | `ReleasedDesignUnsubscribed`                                      |

## Bounds and what's left out

`current.cfg` allows 3 failures (dropped connections, refused hellos or refused history loads) and 4 page moves, on one design, one thread with one streamed chunk, and one request. A pass covers those bounds.

- **One hold at a time.** `holds` above 1 is arithmetic on the same path.
- **`designs.list`, `settings.get`, `claude.status`.** They follow `request` and `resume` without more states.
- **Buffered design events** in `buffers`, and JSON de-duplication in `loadThread`.
- **`thread.history`'s read and reply are one step.** A turn that finishes between them is covered only by the live event path.
- **The history read racing the re-subscribe** after a reconnect. `subscribe` adds the subscription a tick after `hub.open`, before the history read finishes.
- **A socket that is closing but hasn't fired `onclose`**, where `request` re-queues itself.
- **`close()`**, which only tests call.
- **Requests the server refuses**, apart from hello and history.
- **The server forgetting a reply by count while a copy of the request or its reply is travelling.** That takes 1000 later replies inside one trip. A request asked again after that is refused, because it carries the memory name it was asked under and the name changes when a reply is pushed out early (`replies.ts`, not modelled). Only an original copy still on its way could run again.
- **Forgetting by age**, which only happens after the page has stopped asking: `GIVE_UP_MS` is 10 minutes under `REPLY_KEPT_MS`, and the model's `RequestGivesUp` stands in for it.
- **The server's `running` answer**, which only restarts the page's timer.
