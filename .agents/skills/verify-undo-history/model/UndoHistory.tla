---- MODULE UndoHistory ----
\* Per-actor undo for source edits and canvas patches, and the page's memory of which kind ⌘Z takes.
\* Source: apps/server/src/source/history.ts, source/index.ts. Canvas: apps/server/src/store/open.ts,
\* store/canvas.ts. Page: apps/web/src/canvas/undoOrder.ts, canvas/editor.ts.
\* One span per file; a value names the edit that wrote it, so "changed since" is value inequality.
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS
  YouEdits, YouMoves, OtherEdits_, OtherMoves_, OtherRemoves,
  FileLock,             \* files.ts:createLocks is first come, first served per file
  SwapChecks,           \* history.ts:swap refuses when the patch's text is gone
  DropsRefused,         \* history.ts:step and open.ts:undoCanvas pop before applying
  ClientForgetsRefused, \* undoOrder.ts:forget, the page takes a refused step back off its order
  OneRequestAtATime,    \* undoOrder.ts:inTurn, a page's undo, redo and edit requests run one after another
  CanvasChecksAfter     \* open.ts:apply, a canvas undo refuses when the value isn't the one it wrote

VARIABLES
  file, preLock, queue, srcUndo, srcRedo,       \* source
  frame, canUndo, canRedo,                      \* canvas
  done, undone, replies,                        \* page
  editsMade, movesMade, otherEdits, otherMoves, removals,
  outOfOrder, wiped, canvasWiped, refused, tookOlder \* ghosts for the rules

vars == <<file, preLock, queue, srcUndo, srcRedo, frame, canUndo, canRedo, done, undone, replies,
          editsMade, movesMade, otherEdits, otherMoves, removals,
          outOfOrder, wiped, canvasWiped, refused, tookOlder>>

Files == {"a", "b"}
Actors == {"you", "other"}
Base == <<"nobody", 0>>
CanvasBase == <<"nobody", 1>>
Author(v) == v[1]
FileOf(i) == IF i = 3 THEN "b" ELSE "a"   \* two edits share a file; the third is in another

Last(s) == s[Len(s)]
Pop(s) == SubSeq(s, 1, Len(s) - 1)
RemoveAt(s, i) == SubSeq(s, 1, i - 1) \o SubSeq(s, i + 1, Len(s))
Count(s, k) == Cardinality({i \in 1..Len(s) : s[i] = k})
Forget(s, k) ==
  IF Count(s, k) = 0 THEN s
  ELSE RemoveAt(s, CHOOSE i \in 1..Len(s) : s[i] = k /\ \A j \in (i + 1)..Len(s) : s[j] # k)

Busy == (\E f \in Files : queue[f] # <<>>) \/ preLock # {} \/ replies # <<>>
Quiescent == ~Busy
MayRequest == ~OneRequestAtATime \/ ~Busy
\* An edit of yours the undo can't take: not on the server's stack yet, or the page picked another kind.
EditNotYetTakeable ==
  \/ preLock # {}
  \/ \E f \in Files : \E i \in 1..Len(queue[f]) : queue[f][i].kind = "edit"
  \/ (done # <<>> /\ replies # <<>> /\ Last(done) # Last(replies))

Init ==
  /\ file = [f \in Files |-> Base]
  /\ preLock = {}
  /\ queue = [f \in Files |-> <<>>]
  /\ srcUndo = [a \in Actors |-> <<>>]
  /\ srcRedo = [a \in Actors |-> <<>>]
  /\ frame = [exists |-> TRUE, x |-> CanvasBase]
  /\ canUndo = [a \in Actors |-> <<>>]
  /\ canRedo = [a \in Actors |-> <<>>]
  /\ done = <<>> /\ undone = <<>> /\ replies = <<>>
  /\ editsMade = 0 /\ movesMade = 0 /\ otherEdits = 0 /\ otherMoves = 0 /\ removals = 0
  /\ outOfOrder = FALSE /\ wiped = FALSE /\ canvasWiped = FALSE
  /\ refused = {} /\ tookOlder = FALSE

\* ---- Source requests: source/index.ts:apply ----

\* source/index.ts:240-256. The request has arrived; theme and CSS-module reads are awaited before the lock.
YouStartEdit ==
  /\ editsMade < YouEdits
  /\ MayRequest
  /\ editsMade' = editsMade + 1
  /\ preLock' = preLock \cup {<<"you", editsMade + 1>>}
  /\ UNCHANGED <<file, queue, srcUndo, srcRedo, frame, canUndo, canRedo, done, undone, replies,
                 movesMade, otherEdits, otherMoves, removals, outOfOrder, wiped, canvasWiped,
                 refused, tookOlder>>

\* source/index.ts:265 transact, files.ts:lockOne takes its place in the file's line synchronously.
EditReachesLock ==
  \E id \in preLock :
    /\ preLock' = preLock \ {id}
    /\ queue' = [queue EXCEPT ![FileOf(id[2])] = Append(@, [kind |-> "edit", id |-> id])]
    /\ UNCHANGED <<file, srcUndo, srcRedo, frame, canUndo, canRedo, done, undone, replies,
                   editsMade, movesMade, otherEdits, otherMoves, removals, outOfOrder, wiped,
                   canvasWiped, refused, tookOlder>>

Turn(f) == IF FileLock THEN (IF queue[f] = <<>> THEN {} ELSE {1}) ELSE 1..Len(queue[f])

\* source/index.ts:165-189 then :290. No macrotask separates the last write from history.push, and
\* the lock excludes other writers, so the whole locked section plus the push is one step.
EditLands ==
  \E f \in Files, i \in 1..2 :
    /\ i \in Turn(f)
    /\ queue[f][i].kind = "edit"
    /\ LET id == queue[f][i].id IN
         /\ file' = [file EXCEPT ![f] = id]
         /\ srcUndo' = [srcUndo EXCEPT !["you"] =
              Append(@, [id |-> id, f |-> f, before |-> file[f], after |-> id, gen |-> 0])]
         /\ srcRedo' = [srcRedo EXCEPT !["you"] = <<>>]   \* history.ts:push
         /\ queue' = [queue EXCEPT ![f] = RemoveAt(@, i)]
         /\ replies' = Append(replies, "S")
    /\ UNCHANGED <<preLock, frame, canUndo, canRedo, done, undone, editsMade, movesMade, otherEdits,
                   otherMoves, removals, outOfOrder, wiped, canvasWiped, refused, tookOlder>>

\* ---- Source undo and redo: history.ts:step, source/index.ts:step ----

\* history.ts:89-90 pops synchronously; run -> transact -> lockOne joins the file's line in the same tick.
SourcePress(dir) ==
  LET st == IF dir = "undo" THEN srcUndo["you"] ELSE srcRedo["you"] IN
  IF st = <<>> THEN UNCHANGED <<queue, srcUndo, srcRedo>>
  ELSE LET e == Last(st) IN
    /\ queue' = [queue EXCEPT ![e.f] = Append(@,
         [kind |-> "step", dir |-> dir, entry |-> e, gen |-> editsMade])]
    /\ IF dir = "undo"
       THEN srcUndo' = [srcUndo EXCEPT !["you"] = Pop(@)] /\ UNCHANGED srcRedo
       ELSE srcRedo' = [srcRedo EXCEPT !["you"] = Pop(@)] /\ UNCHANGED srcUndo

From(e, dir) == IF dir = "undo" THEN e.after ELSE e.before
To(e, dir) == IF dir = "undo" THEN e.before ELSE e.after
Fits(f, e, dir) == ~SwapChecks \/ file[f] = From(e, dir)
Overwrites(v, who) == Author(v) \notin {who, "nobody"}

\* source/index.ts:454-475 then history.ts:92, one step for the same reason as EditLands.
StepLands ==
  \E f \in Files, i \in 1..2 :
    /\ i \in Turn(f)
    /\ queue[f][i].kind = "step"
    /\ LET t == queue[f][i] IN
       /\ Fits(f, t.entry, t.dir)
       /\ file' = [file EXCEPT ![f] = To(t.entry, t.dir)]
       /\ wiped' = (wiped \/ (t.dir = "undo" /\ Overwrites(file[f], "you")))
       /\ outOfOrder' = (outOfOrder \/ \E j \in 1..(i - 1) : queue[f][j].kind = "step")
       /\ queue' = [queue EXCEPT ![f] = RemoveAt(@, i)]
       /\ IF t.dir = "undo"
          THEN srcRedo' = [srcRedo EXCEPT !["you"] =
                 Append(@, [t.entry EXCEPT !.gen = t.gen])] /\ UNCHANGED srcUndo
          ELSE srcUndo' = [srcUndo EXCEPT !["you"] =
                 Append(@, [t.entry EXCEPT !.gen = 0])] /\ UNCHANGED srcRedo
    /\ UNCHANGED <<preLock, frame, canUndo, canRedo, done, undone, replies, editsMade, movesMade,
                   otherEdits, otherMoves, removals, canvasWiped, refused, tookOlder>>

\* history.ts:stepPatches throws Refused "stale"; history.ts:91 never pushes, so the entry is gone.
StepRefused ==
  \E f \in Files, i \in 1..2 :
    /\ i \in Turn(f)
    /\ queue[f][i].kind = "step"
    /\ LET t == queue[f][i] IN
       /\ ~Fits(f, t.entry, t.dir)
       /\ refused' = refused \cup {t.entry.id}
       /\ outOfOrder' = (outOfOrder \/ \E j \in 1..(i - 1) : queue[f][j].kind = "step")
       /\ queue' = [queue EXCEPT ![f] = RemoveAt(@, i)]
       /\ IF DropsRefused THEN UNCHANGED <<srcUndo, srcRedo>>
          ELSE IF t.dir = "undo"
               THEN srcUndo' = [srcUndo EXCEPT !["you"] = Append(@, t.entry)] /\ UNCHANGED srcRedo
               ELSE srcRedo' = [srcRedo EXCEPT !["you"] = Append(@, t.entry)] /\ UNCHANGED srcUndo
       /\ IF ~ClientForgetsRefused THEN UNCHANGED <<done, undone>>
          ELSE IF t.dir = "undo"
               THEN undone' = Forget(undone, "S") /\ UNCHANGED done
               ELSE done' = Forget(done, "S") /\ UNCHANGED undone
    /\ UNCHANGED <<file, preLock, frame, canUndo, canRedo, replies, editsMade, movesMade, otherEdits,
                   otherMoves, removals, wiped, canvasWiped, tookOlder>>

\* ---- Canvas undo and redo: store/open.ts:undoCanvas, inside serial run ----

CanvasStack(dir) == IF dir = "undo" THEN canUndo["you"] ELSE canRedo["you"]
CanvasFits(s) == frame.exists /\ (~CanvasChecksAfter \/ frame.x = s.after)

\* open.ts:267-291. `run` is first come, first served per design, so a canvas request is one step.
\* canvas.ts:inversePatch records the old value, canvas.ts:overwritten what it should find there.
CanvasPress(dir) ==
  IF CanvasStack(dir) = <<>> THEN UNCHANGED <<frame, canUndo, canRedo, canvasWiped, refused>>
  ELSE LET s == Last(CanvasStack(dir))
           inverse == [id |-> s.id, to |-> frame.x, after |-> s.to]
       IN IF CanvasFits(s)
          THEN /\ frame' = [frame EXCEPT !.x = s.to]
               /\ canvasWiped' = (canvasWiped \/ (dir = "undo" /\ Overwrites(frame.x, "you")))
               /\ UNCHANGED refused
               /\ IF dir = "undo"
                  THEN /\ canUndo' = [canUndo EXCEPT !["you"] = Pop(@)]
                       /\ canRedo' = [canRedo EXCEPT !["you"] = Append(@, inverse)]
                  ELSE /\ canRedo' = [canRedo EXCEPT !["you"] = Pop(@)]
                       /\ canUndo' = [canUndo EXCEPT !["you"] = Append(@, inverse)]
          ELSE /\ refused' = refused \cup {s.id}   \* open.ts:272 popped it; nothing pushes it back
               /\ UNCHANGED <<frame, canvasWiped>>
               /\ IF dir = "undo"
                  THEN canUndo' = [canUndo EXCEPT !["you"] = Pop(@)] /\ UNCHANGED canRedo
                  ELSE canRedo' = [canRedo EXCEPT !["you"] = Pop(@)] /\ UNCHANGED canUndo

\* ---- The page's order: undoOrder.ts, editor.ts:862-887 ----

KindOf(s) == IF s = <<>> THEN "S" ELSE Last(s)   \* editor.ts:867, `?? {kind: "source"}`

\* The fix variant only: a canvas step the server will refuse never reaches the other side.
ForgetsNow(dir, k) ==
  /\ ClientForgetsRefused
  /\ k = "C"
  /\ CanvasStack(dir) # <<>>
  /\ ~CanvasFits(Last(CanvasStack(dir)))

\* undoOrder.ts:undo moves the step before editor.ts:870 sends the request. One WebSocket keeps
\* one person's requests in order, so the key press and the server's pop are one step.
PressStep(dir) ==
  LET from == IF dir = "undo" THEN done ELSE undone
      k == KindOf(from)
      moved == IF ForgetsNow(dir, k) THEN <<>> ELSE <<k>>
  IN
  /\ IF dir = "undo"
     THEN IF done = <<>> THEN UNCHANGED <<done, undone>>
          ELSE done' = Pop(done) /\ undone' = undone \o moved
     ELSE IF undone = <<>> THEN UNCHANGED <<done, undone>>
          ELSE undone' = Pop(undone) /\ done' = done \o moved
  /\ IF k = "S"
     THEN SourcePress(dir) /\ UNCHANGED <<frame, canUndo, canRedo, canvasWiped, refused>>
     ELSE CanvasPress(dir) /\ UNCHANGED <<queue, srcUndo, srcRedo>>
  /\ UNCHANGED <<file, preLock, replies, editsMade, movesMade, otherEdits, otherMoves, removals,
                 outOfOrder, wiped>>

YouPressUndo ==
  /\ MayRequest
  /\ done # <<>> \/ srcUndo["you"] # <<>>
  /\ tookOlder' = (tookOlder \/ EditNotYetTakeable)
  /\ PressStep("undo")

YouPressRedo ==
  /\ MayRequest
  /\ undone # <<>> \/ srcRedo["you"] # <<>>
  /\ UNCHANGED tookOlder
  /\ PressStep("redo")

\* editor.ts:984 and :1029 call did only after the reply, inside inTurn.
ReplyArrives ==
  /\ replies # <<>>
  /\ done' = Append(done, Head(replies))
  /\ undone' = <<>>
  /\ replies' = Tail(replies)
  /\ UNCHANGED <<file, preLock, queue, srcUndo, srcRedo, frame, canUndo, canRedo, editsMade,
                 movesMade, otherEdits, otherMoves, removals, outOfOrder, wiped, canvasWiped,
                 refused, tookOlder>>

\* open.ts:patchCanvas, one step inside `run`.
YouMoveFrame ==
  /\ movesMade < YouMoves
  /\ MayRequest
  /\ frame.exists
  /\ LET v == <<"you", 10 + movesMade + 1>> IN
     /\ frame' = [frame EXCEPT !.x = v]
     /\ canUndo' = [canUndo EXCEPT !["you"] = Append(@, [id |-> v, to |-> frame.x, after |-> v])]
     /\ canRedo' = [canRedo EXCEPT !["you"] = <<>>]
  /\ movesMade' = movesMade + 1
  /\ replies' = Append(replies, "C")
  /\ UNCHANGED <<file, preLock, queue, srcUndo, srcRedo, done, undone, editsMade, otherEdits,
                 otherMoves, removals, outOfOrder, wiped, canvasWiped, refused, tookOlder>>

\* ---- Someone else, whose requests are one step each: any timing against yours is another order ----

OtherEdits ==
  /\ otherEdits < OtherEdits_
  /\ LET v == <<"other", otherEdits + 1>> IN
     /\ file' = [file EXCEPT !["a"] = v]
     /\ srcUndo' = [srcUndo EXCEPT !["other"] =
          Append(@, [id |-> v, f |-> "a", before |-> file["a"], after |-> v, gen |-> 0])]
     /\ srcRedo' = [srcRedo EXCEPT !["other"] = <<>>]
  /\ otherEdits' = otherEdits + 1
  /\ UNCHANGED <<preLock, queue, frame, canUndo, canRedo, done, undone, replies, editsMade,
                 movesMade, otherMoves, removals, outOfOrder, wiped, canvasWiped, refused, tookOlder>>

OtherUndoes ==
  /\ srcUndo["other"] # <<>>
  /\ LET e == Last(srcUndo["other"]) IN
     IF Fits(e.f, e, "undo")
     THEN /\ file' = [file EXCEPT ![e.f] = e.before]
          /\ wiped' = (wiped \/ Overwrites(file[e.f], "other"))
          /\ srcUndo' = [srcUndo EXCEPT !["other"] = Pop(@)]
          /\ srcRedo' = [srcRedo EXCEPT !["other"] = Append(@, e)]
          /\ UNCHANGED refused
     ELSE /\ refused' = refused \cup {e.id}
          /\ srcUndo' = IF DropsRefused THEN [srcUndo EXCEPT !["other"] = Pop(@)] ELSE srcUndo
          /\ UNCHANGED <<file, wiped, srcRedo>>
  /\ UNCHANGED <<preLock, queue, frame, canUndo, canRedo, done, undone, replies, editsMade, movesMade,
                 otherEdits, otherMoves, removals, outOfOrder, canvasWiped, tookOlder>>

OtherMovesFrame ==
  /\ otherMoves < OtherMoves_
  /\ frame.exists
  /\ LET v == <<"other", 10 + otherMoves + 1>> IN
     /\ frame' = [frame EXCEPT !.x = v]
     /\ canUndo' = [canUndo EXCEPT !["other"] = Append(@, [id |-> v, to |-> frame.x, after |-> v])]
     /\ canRedo' = [canRedo EXCEPT !["other"] = <<>>]
  /\ otherMoves' = otherMoves + 1
  /\ UNCHANGED <<file, preLock, queue, srcUndo, srcRedo, done, undone, replies, editsMade, movesMade,
                 otherEdits, removals, outOfOrder, wiped, canvasWiped, refused, tookOlder>>

OtherRemovesFrame ==
  /\ removals < OtherRemoves
  /\ frame.exists
  /\ frame' = [frame EXCEPT !.exists = FALSE]
  /\ removals' = removals + 1
  /\ UNCHANGED <<file, preLock, queue, srcUndo, srcRedo, canUndo, canRedo, done, undone, replies,
                 editsMade, movesMade, otherEdits, otherMoves, outOfOrder, wiped, canvasWiped,
                 refused, tookOlder>>

\* Everything settled; only here so a finished history isn't a deadlock.
Settled == Quiescent /\ UNCHANGED vars

Next ==
  \/ YouStartEdit \/ EditReachesLock \/ EditLands \/ StepLands \/ StepRefused
  \/ YouPressUndo \/ YouPressRedo \/ ReplyArrives \/ YouMoveFrame
  \/ OtherEdits \/ OtherUndoes \/ OtherMovesFrame \/ OtherRemovesFrame
  \/ Settled

Spec == Init /\ [][Next]_vars

\* ---- Rules ----

\* A new edit you asked for after an undo leaves nothing to redo.
NewEditClearsRedo ==
  Quiescent => \A i \in 1..Len(srcRedo["you"]) : srcRedo["you"][i].gen = editsMade

\* Every step the page offers to undo or redo is one the server still has.
PageMatchesServer ==
  Quiescent =>
    /\ Count(done, "S") <= Len(srcUndo["you"])
    /\ Count(done, "C") <= Len(canUndo["you"])
    /\ Count(undone, "S") <= Len(srcRedo["you"])
    /\ Count(undone, "C") <= Len(canRedo["you"])

\* Quick undos of one file apply in the order you pressed.
UndosApplyInPressOrder == ~outOfOrder

\* ⌘Z takes back the edit you just made, even while it is still saving.
UndoTakesNewestEdit == ~tookOlder

\* A source undo never overwrites text someone else wrote since.
SourceUndoKeepsOthersWork == ~wiped

\* A canvas undo never overwrites a value someone else set since.
CanvasUndoKeepsOthersWork == ~canvasWiped

\* A refused step leaves both stacks, so the next undo reaches further back.
RefusedStepIsDropped ==
  \A id \in refused : \A a \in Actors :
    /\ \A i \in 1..Len(srcUndo[a]) : srcUndo[a][i].id # id
    /\ \A i \in 1..Len(srcRedo[a]) : srcRedo[a][i].id # id
    /\ \A i \in 1..Len(canUndo[a]) : canUndo[a][i].id # id
    /\ \A i \in 1..Len(canRedo[a]) : canRedo[a][i].id # id
====
