---
name: verify-frame-bridge
description: TLA+ model of the bridge between the canvas and each frame's iframe. Use when a change touches connectFrame in apps/web/src/canvas/bridge.ts, the effect in apps/web/src/canvas/FrameView.tsx, or port, post, receive and start in packages/vite-plugin/src/client/bridge.ts, or when a frame stops answering clicks, a canvas action hangs, or "The frame reloaded" or "The frame didn't answer" shows up.
---

# Verify the frame bridge

The model explores every order of these events for one iframe: hello, the iframe's `load`, reloads, unmounts, an effect re-run on the same iframe (off in `current.cfg`), and the canvas's requests. It checks each rule below in every reachable state.

## Check a change

1. Compare the diff with the coverage table. If it touches none of those functions, stop: this check says nothing about it.
2. Read the changed code against the matching actions in `model/FrameBridge.tla`. Each action is one synchronous run of code, so a new `await` or a moved line changes an action.
3. Make the model say what the code now does. A change that matches a toggle flips that toggle in `model/current.cfg`; anything else edits the action.
4. Run `.agents/skills/verify-frame-bridge/check.sh`. It takes about 25 seconds and exits 0 when every row of `model/expected.tsv` matches, 1 on a mismatch, 2 when TLC couldn't run. TLC 2.19 lives at `$HOME/.local/share/tlaplus/tla2tools.jar`; `TLA2TOOLS` overrides that.
5. Read each result with `/statechart`, using `model/FrameBridge.tla`, a config with the rule as an INVARIANT, and `model/view.ts`. It tells a counterexample as numbered steps in the canvas's words. `model/chart.cfg` draws the whole flow.

Done means `check.sh` exits 0 against a model that describes the new code, and the sync commit below is moved.

## Read a mismatch

| Output                                          | Meaning                                                        | Do                                                                                                                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current` rule expected holds, got breaks       | The change breaks the rule, or the model drifted from the code | Tell the two apart by replaying the counterexample against `connectFrame` with a fake iframe and fake `MessageChannel`, one call per step. If it reproduces, it's a real bug. |
| `current` rule expected breaks, got holds       | A known finding is fixed, or the model lost the path           | Confirm with the replay, then flip the row to `holds` and delete the finding below.                                                                                           |
| A broken-variant row expected breaks, got holds | The rule no longer catches what it guards                      | Fix the model before trusting any other row.                                                                                                                                  |
| `got error`                                     | TLA+ didn't parse or a constant is missing                     | Read the kept TLC output. Every `.cfg` needs every constant.                                                                                                                  |

Intended behaviour change: update the action, the rule's comment and `expected.tsv` together, and say in the PR which rule moved.

## Rules

| Rule                            | Promise                                                                          | Harm when broken                               | Today |
| ------------------------------- | -------------------------------------------------------------------------------- | ---------------------------------------------- | ----- |
| `ClosedBridgeStrandsNothing`    | `close()` leaves no promise that can never settle                                | A press on that frame never finishes           | holds |
| `RequestsMadeDuringAReloadWait` | A request made before the new hello waits for it (doc comment on `connectFrame`) | The request fails during every HMR full reload | holds |
| `OnlyARealReloadRefuses`        | "The frame reloaded" means the document changed                                  | A request fails with a false reason            | holds |
| `LiveFrameStaysReachable`       | An open bridge on a running page has a connection or a way to get one            | The frame ignores the canvas                   | holds |
| `EveryRequestSettles`           | Every request is answered, refused, timed out or rejected                        | Callers await forever                          | holds |
| `ReloadedRequestsAreRefused`    | Requests in flight at a new hello are refused                                    | Stale requests linger                          | holds |
| `NoBridgePageDoesNotHang`       | A page that never says hello still fails its requests on first mount             | A broken page hangs the canvas                 | holds |
| `BufferedErrorsFlushOnConnect`  | Errors before connect reach the canvas once connected                            | Agents miss early `frame_errors`               | holds |
| `ConnectReportsSize`            | Every connect is followed by a size report                                       | Hug frames stay the wrong height               | holds |

## Findings at the sync commit

None open. Checked in headless Chrome 157 with a cross-origin iframe: the parent got `load` before the frame's hello on every load, and `leaving` before the next `load` and hello on every navigation. `MessagePort` there has no `close` event, so the frame's message is the only way to learn it left.

## Variants

| File                      | What it changes                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current.cfg`             | The code as it stands: every fix on but `AskHelloOnRemount`, and `MaxRemounts = 0` since `FrameView.tsx` has no dep that re-runs the effect on a loaded iframe |
| `fixed.cfg`               | All five fixes on, one effect re-run; every rule holds                                                                                                         |
| `no-load-fallback.cfg`    | Removes the `load` fallback                                                                                                                                    |
| `no-drop-on-hello.cfg`    | Removes `dropPending` from `onHello`                                                                                                                           |
| `no-flush-on-connect.cfg` | Removes the buffer flush and forced size report                                                                                                                |
| `no-send-timer.cfg`       | `fixed`, minus the 5 s timer in `go()`                                                                                                                         |
| `chart.cfg`               | `current` with `ChartOnly`, one request and a `VIEW`, to fit the chart budget. Used for pictures only.                                                         |

## Bounds and what's left out

`current` is checked with 2 requests and 2 documents (one reload), about 2,500 states; `fixed` adds one effect re-run, about 11,000. A pass covers those bounds.

Left out: a page whose `load` never fires, which only the 5 s timer ends; a `load` that fires before the effect runs; port message ordering between channels, where a post is treated as delivered; the 100-message cap on the frame's buffer; origin checks; what each request computes; the preview overlay and the update-settle timers.

`NoticeUnload` treats the frame's `leaving` as arriving with the unload, which ignores the few milliseconds it takes to deliver. A page with no bridge, or one that never took the channel, can't send it, so `askedStale` doesn't count a request in that gap: it times out. `AskHelloOnRemount` is a sketch nothing in the code does.

## Coverage

Last synced: 4025ebd6712ebb76e092381adc0457c218cd56de. Move this forward only after confirming the model describes the code at the new commit. To see what changed since: `git diff <sha> -- <files below>`. To catch up after unchecked changes, use `/maintain-formal-verification-skill`.

| File                                        | Function                                                                                                       | Backs                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `apps/web/src/canvas/bridge.ts`             | `listen`                                                                                                       | `HelloHeard`, `HelloUnheard`                                                         |
| `apps/web/src/canvas/bridge.ts`             | `onHello`, `helloDue`                                                                                          | `OnHello`, `HelloHeard`, `ReloadedRequestsAreRefused`, `OnlyARealReloadRefuses`      |
| `apps/web/src/canvas/bridge.ts`             | `onLoad`                                                                                                       | `LoadFires`, `LoadAfterClose`, `NoBridgePageDoesNotHang`                             |
| `apps/web/src/canvas/bridge.ts`             | `send`, `go`                                                                                                   | `CanvasAsks`, `CanvasAsksClosed`, `RequestTimesOut`, `RequestsMadeDuringAReloadWait` |
| `apps/web/src/canvas/bridge.ts`             | `close`                                                                                                        | `BridgeCloses`, `ClosedBridgeStrandsNothing`                                         |
| `apps/web/src/canvas/bridge.ts`             | the `leaving` branch of `port.onmessage`                                                                       | `FrameReloads` (`NoticeUnload`), `RequestsMadeDuringAReloadWait`                     |
| `apps/web/src/canvas/FrameView.tsx`         | the `connectFrame` effect and its deps; a dep that can change on a loaded iframe needs `MaxRemounts = 1` again | `EffectConnects`, `EffectReruns`, `LiveFrameStaysReachable`                          |
| `apps/web/src/canvas/gestures.ts`           | `resizedFrame` (`hug`)                                                                                         | what would trigger `EffectReruns` if `hug` were a dep                                |
| `packages/vite-plugin/src/client/bridge.ts` | `post`, `reportError`                                                                                          | `FrameReportsError`, `BufferedErrorsFlushOnConnect`                                  |
| `packages/vite-plugin/src/client/bridge.ts` | `start`: the CONNECT listener, HELLO, `pagehide`                                                               | `BridgeSaysHello`, `FrameTakesConnect`, `ConnectReportsSize`, `FrameReloads`         |
| `packages/vite-plugin/src/client/bridge.ts` | `receive`                                                                                                      | `FrameAnswers`                                                                       |
| `packages/protocol/src/bridge.ts`           | `FrameMessage` (`leaving`), the request list                                                                   | `FrameReloads` (`NoticeUnload`), `FrameAnswers`                                      |
