---------------------------- MODULE DesignLeases ----------------------------
(***************************************************************************)
(* Two Finite servers sharing one store, and one design moving between     *)
(* them. It models the lease, the fencing token, the save task and an MCP  *)
(* edit, step by step, as the code runs them:                              *)
(*                                                                         *)
(*   crates/server/src/hub/mod.rs     Hub::open, handle_for, tick, let_go, *)
(*                                    drop_copy, discover, summaries,      *)
(*                                    sweep, persist                       *)
(*   crates/server/src/hub/design.rs  DesignHandle::load, retire, end,     *)
(*                                    take_save, save_failed, edit,        *)
(*                                    unload_if_idle                       *)
(*   crates/server/src/mcp/mod.rs     FiniteServer::design, edit_checked   *)
(*   crates/server/src/cluster.rs     Members::now, lapsed, Cluster::owns  *)
(*   crates/server/src/postgres/mod.rs  claim, save, append, release, held *)
(*                                                                         *)
(* An edit is an id in 1..MaxEdits. A copy of the design is the set of     *)
(* edits it holds. The store holds a snapshot and a journal, each a set.   *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS
    MaxEdits,    \* edits agents send, in all
    MaxHandles,  \* DesignHandles created, across both servers and restarts
    MaxEpoch,    \* bound on the store's epoch column
    MaxCrashes,  \* kill -9s, across both servers
    MaxFails,    \* store writes that fail with an I/O error
    MaxReads,    \* calls that open the design without editing it
    \* What-if switches for proposed fixes. All FALSE is the code today.
    FixRetire,   \* an edit is refused unless its copy is Live            (finding 1)
    FixOrphan,   \* an edit is refused unless its handle is still listed  (finding 2)
    FixStaleDrop,\* the tick drops a copy only if its token is the one it read (finding 3)
    FixRenew     \* after a lapse, the server counts itself out until it has let go (finding 4)

\* Rendezvous hashing for this one design id: "B" wins whenever it is in the
\* list, so "B" joining takes the design from "A" (cluster.rs, Cluster::owner).
Servers == {"A", "B"}
Owner(view) == IF "B" \in view THEN "B" ELSE IF "A" \in view THEN "A" ELSE "none"
None == "none"
Edits == 1..MaxEdits
HIds == 1..MaxHandles

VARIABLES
    store,     \* finite_designs row + finite_journal: [snap, journal, epoch, holder]
    dbAlive,   \* finite_nodes: whose heartbeat is younger than the lease
    status,    \* "running", or "off" (not started, or killed). A stalled process
               \* (SIGSTOP, a long GC) needs no state of its own: TLC already tries
               \* every order, including one where a server takes no step for a while.
    lapsed,    \* Members::lapsed: this server's own lease ran out since its last renewal
    view,      \* the live list this server read last (Members.view)
    holdOut,   \* FixRenew only: renewed after a lapse, but hasn't let go yet
    map,       \* Hub.designs: the handle this server lists for the design, or 0
    h,         \* every DesignHandle, by id
    nextH,     \* handles created so far
    req,       \* one MCP edit call in flight per server
    tk,        \* Hub::tick, one step per store call or lock
    nextEdit,  \* the next edit id an agent sends
    acked,     \* edits whose tool call returned success
    excused,   \* edits Finite may lose: unsaved when their server crashed or its lease expired
    everStored,\* every edit a store write ever accepted
    crashes, fails,
    reads      \* read calls so far

vars == <<store, dbAlive, status, lapsed, view, holdOut, map, h, nextH, req, tk,
          nextEdit, acked, excused, everStored, crashes, fails, reads>>

StoreEdits == store.snap \cup store.journal

\* Members::now and Cluster::owns: a lapsed server counts itself out of the list.
Owns(s) == ~lapsed[s] /\ ~holdOut[s] /\ Owner(view[s]) = s

NoHandle == [srv |-> None, alive |-> FALSE, loaded |-> FALSE, edits |-> {},
             pending |-> {}, token |-> 0, life |-> "Live", needsSnap |-> FALSE,
             ppc |-> "idle", kind |-> "none", payload |-> {}, ptok |-> 0]
IdleReq == [pc |-> "idle", e |-> 0, hid |-> 0, tainted |-> FALSE]
IdleTick == [pc |-> "heartbeat", lapsedNow |-> FALSE, owns |-> FALSE, hid |-> 0,
             loaded |-> [hid |-> 0, token |-> 0, life |-> "Gone"], held |-> -1]

Init ==
    /\ store = [snap |-> {}, journal |-> {}, epoch |-> 0, holder |-> None]
    /\ dbAlive = [s \in Servers |-> s = "A"]
    /\ status = [s \in Servers |-> IF s = "A" THEN "running" ELSE "off"]
    /\ lapsed = [s \in Servers |-> FALSE]
    /\ view = [s \in Servers |-> IF s = "A" THEN {"A"} ELSE {}]
    /\ holdOut = [s \in Servers |-> FALSE]
    /\ map = [s \in Servers |-> 0]
    /\ h = [i \in HIds |-> NoHandle]
    /\ nextH = 0
    /\ req = [s \in Servers |-> IdleReq]
    /\ tk = [s \in Servers |-> IdleTick]
    /\ nextEdit = 1
    /\ acked = {}
    /\ excused = {}
    /\ everStored = {}
    /\ crashes = 0
    /\ fails = 0
    /\ reads = 0

Running(s) == status[s] = "running"

(* postgres/mod.rs claim: holder IS NULL, or this server, or a holder whose *)
(* heartbeat is out of date. Raises epoch by one.                           *)
CanClaim(s) == \/ store.holder \in {None, s}
               \/ store.holder \in Servers /\ ~dbAlive[store.holder]
Claimed(s) == [store EXCEPT !.epoch = @ + 1, !.holder = s]

(* Hub::discover -> summaries: a design whose journal must be replayed is   *)
(* compacted under a claim of its own, then a fresh, unloaded handle is     *)
(* listed (Hub::insert). The claim's token is not kept.                     *)
Discover(s) ==
    /\ nextH < MaxHandles
    /\ map[s] = 0
    /\ IF store.journal # {} /\ CanClaim(s)
         THEN store' = [Claimed(s) EXCEPT !.snap = StoreEdits, !.journal = {}]
         ELSE UNCHANGED store
    /\ nextH' = nextH + 1
    /\ h' = [h EXCEPT ![nextH + 1] = [NoHandle EXCEPT !.srv = s, !.alive = TRUE]]
    /\ map' = [map EXCEPT ![s] = nextH + 1]

\* Hub::drop_copy: DesignHandle::end, then Hub::remove if it's still the one listed.
DropCopy(i) ==
    /\ h' = [h EXCEPT ![i].life = "Gone", ![i].pending = {}]
    /\ map' = [map EXCEPT ![h[i].srv] = IF @ = i THEN 0 ELSE @]

-----------------------------------------------------------------------------
(* A call that opens the design: an MCP edit (FiniteServer::edit_checked),  *)
(* or a read that loads it, like an MCP read tool or a viewer's socket      *)
(* (api.rs open). A read has edit id 0.                                    *)

\* FiniteServer::design or api.rs `here`: this server owns the design.
CallStarts(s) ==
    /\ Running(s) /\ req[s].pc = "idle"
    /\ Owns(s)
    /\ \/ /\ nextEdit <= MaxEdits
          /\ req' = [req EXCEPT ![s] = [pc |-> "checked", e |-> nextEdit, hid |-> 0, tainted |-> FALSE]]
          /\ nextEdit' = nextEdit + 1
          /\ UNCHANGED reads
       \/ /\ reads < MaxReads
          /\ req' = [req EXCEPT ![s] = [pc |-> "checked", e |-> 0, hid |-> 0, tainted |-> FALSE]]
          /\ reads' = reads + 1
          /\ UNCHANGED nextEdit
    /\ UNCHANGED <<holdOut, store, dbAlive, status, lapsed, view, map, h, nextH, tk,
                   acked, excused, everStored, crashes, fails>>

\* Hub::handle_for: the listed handle, or one discovered now if this server owns the design.
CallFindsHandle(s) ==
    /\ Running(s) /\ req[s].pc = "checked"
    /\ \/ /\ map[s] # 0
          /\ req' = [req EXCEPT ![s].pc = "found", ![s].hid = map[s]]
          /\ UNCHANGED <<store, map, h, nextH>>
       \/ /\ map[s] = 0 /\ Owns(s)
          /\ Discover(s)
          /\ req' = [req EXCEPT ![s].pc = "found", ![s].hid = nextH + 1]
       \/ /\ map[s] = 0 /\ ~Owns(s)
          /\ req' = [req EXCEPT ![s] = IdleReq]            \* "not found"
          /\ UNCHANGED <<store, map, h, nextH>>
    /\ UNCHANGED <<holdOut, dbAlive, status, lapsed, view, tk, nextEdit, acked, excused,
                   everStored, crashes, fails, reads>>

(* DesignHandle::load, under the state mutex the whole time, so it is one  *)
(* step here. Once the claim succeeds no other server can write, so the    *)
(* claim and the read that follows it can't be split by another server.   *)
CallLoads(s) ==
    LET i == req[s].hid IN
    /\ Running(s) /\ req[s].pc = "found"
    /\ \/ /\ h[i].loaded /\ h[i].life = "Live"
          /\ req' = [req EXCEPT ![s].pc = "opened"]
          /\ UNCHANGED <<store, h>>
       \/ /\ ~h[i].loaded /\ CanClaim(s) /\ store.epoch < MaxEpoch
          /\ store' = Claimed(s)
          /\ h' = [h EXCEPT ![i].loaded = TRUE, ![i].edits = StoreEdits,
                            ![i].pending = {}, ![i].token = store.epoch + 1,
                            ![i].life = "Live", ![i].needsSnap = store.journal # {}]
          /\ req' = [req EXCEPT ![s].pc = "opened"]
       \* Busy: Hub::open sleeps and calls handle_for again, or gives up after a lease.
       \/ /\ (h[i].loaded /\ h[i].life # "Live") \/ (~h[i].loaded /\ ~CanClaim(s))
          /\ \/ req' = [req EXCEPT ![s].pc = "checked", ![s].hid = 0]
             \/ req' = [req EXCEPT ![s] = IdleReq]
          /\ UNCHANGED <<store, h>>
    /\ UNCHANGED <<holdOut, dbAlive, status, lapsed, view, map, nextH, tk, nextEdit,
                   acked, excused, everStored, crashes, fails, reads>>

(* DesignHandle::edit commits to whatever copy the handle holds, under the *)
(* state mutex, and the tool call reports success. It doesn't look at life.*)
(* FixRetire and FixOrphan make it refuse instead.                         *)
CallEdits(s) ==
    LET i == req[s].hid
        e == req[s].e IN
    /\ Running(s) /\ req[s].pc = "opened" /\ e # 0
    /\ IF (FixRetire /\ h[i].life # "Live") \/ (FixOrphan /\ map[s] # i)
         THEN /\ req' = [req EXCEPT ![s] = IdleReq]
              /\ UNCHANGED <<h, acked, excused>>
         ELSE /\ h' = [h EXCEPT ![i].edits = @ \cup {e}, ![i].pending = @ \cup {e}]
              /\ acked' = acked \cup {e}
              /\ excused' = IF req[s].tainted THEN excused \cup {e} ELSE excused
              /\ req' = [req EXCEPT ![s] = IdleReq]
    /\ UNCHANGED <<holdOut, store, dbAlive, status, lapsed, view, map, nextH, tk, nextEdit,
                   everStored, crashes, fails, reads>>

\* A read is done once the design is open.
CallReads(s) ==
    /\ Running(s) /\ req[s].pc = "opened" /\ req[s].e = 0
    /\ req' = [req EXCEPT ![s] = IdleReq]
    /\ UNCHANGED <<holdOut, store, dbAlive, status, lapsed, view, map, h, nextH, tk,
                   nextEdit, acked, excused, everStored, crashes, fails, reads>>

-----------------------------------------------------------------------------
(* The save task for one handle: hub/mod.rs persist.                        *)

\* DesignHandle::take_save, under the persistence lock and the state mutex.
SaveTakes(i) ==
    LET x == h[i] IN
    /\ x.alive /\ Running(x.srv) /\ x.loaded /\ x.ppc = "idle"
    /\ \/ /\ x.life = "Retiring"
          /\ h' = [h EXCEPT ![i].kind = "last", ![i].payload = x.edits, ![i].ptok = x.token,
                            ![i].pending = {}, ![i].needsSnap = FALSE, ![i].ppc = "write"]
       \/ /\ x.life = "Live" /\ (x.pending # {} \/ x.needsSnap)
          /\ h' = [h EXCEPT ![i].kind = IF x.needsSnap THEN "snap" ELSE "append",
                            ![i].payload = IF x.needsSnap THEN x.edits ELSE x.pending,
                            ![i].ptok = x.token, ![i].pending = {},
                            ![i].needsSnap = FALSE, ![i].ppc = "write"]
    /\ UNCHANGED <<holdOut, store, dbAlive, status, lapsed, view, map, nextH, req, tk,
                   nextEdit, acked, excused, everStored, crashes, fails, reads>>

\* Store::save or Store::append, refused with Fenced unless epoch = token.
SaveWrites(i) ==
    LET x == h[i] IN
    /\ x.alive /\ Running(x.srv) /\ x.ppc = "write"
    /\ x.ptok = store.epoch
    /\ store' = IF x.kind = "append"
                  THEN [store EXCEPT !.journal = @ \cup x.payload]
                  ELSE [store EXCEPT !.snap = x.payload, !.journal = {}]
    /\ everStored' = everStored \cup x.payload
    /\ h' = [h EXCEPT ![i].ppc = IF x.kind = "last" THEN "release" ELSE "idle"]
    /\ UNCHANGED <<holdOut, dbAlive, status, lapsed, view, map, nextH, req, tk,
                   nextEdit, acked, excused, crashes, fails, reads>>

\* Fenced: another server holds the design now; persist drops the copy.
SaveFenced(i) ==
    LET x == h[i] IN
    /\ x.alive /\ Running(x.srv) /\ x.ppc = "write"
    /\ x.ptok # store.epoch
    /\ h' = [h EXCEPT ![i].ppc = "drop"]
    /\ UNCHANGED <<holdOut, store, dbAlive, status, lapsed, view, map, nextH, req, tk,
                   nextEdit, acked, excused, everStored, crashes, fails, reads>>

\* An I/O error: DesignHandle::save_failed, so the retry writes a full snapshot.
SaveFails(i) ==
    LET x == h[i] IN
    /\ x.alive /\ Running(x.srv) /\ x.ppc = "write" /\ fails < MaxFails
    /\ h' = [h EXCEPT ![i].needsSnap = TRUE, ![i].ppc = "idle"]
    /\ fails' = fails + 1
    /\ UNCHANGED <<holdOut, store, dbAlive, status, lapsed, view, map, nextH, req, tk,
                   nextEdit, acked, excused, everStored, crashes, reads>>

\* Save::Last: after the snapshot, Store::release (does nothing on a stale token).
SaveReleases(i) ==
    LET x == h[i] IN
    /\ x.alive /\ Running(x.srv) /\ x.ppc = "release"
    /\ store' = IF store.epoch = x.ptok /\ store.holder = x.srv
                  THEN [store EXCEPT !.holder = None, !.epoch = @ + 1]
                  ELSE store
    /\ h' = [h EXCEPT ![i].ppc = "drop"]
    /\ UNCHANGED <<holdOut, dbAlive, status, lapsed, view, map, nextH, req, tk,
                   nextEdit, acked, excused, everStored, crashes, fails, reads>>

\* Back in persist after the blocking task: hub.drop_copy.
SaveDrops(i) ==
    LET x == h[i] IN
    /\ x.alive /\ Running(x.srv) /\ x.ppc = "drop"
    /\ DropCopy(i)
    /\ UNCHANGED <<holdOut, store, dbAlive, status, lapsed, view, nextH, req, tk,
                   nextEdit, acked, excused, everStored, crashes, fails, reads>>

\* Hub::sweep -> unload_if_idle: nobody else holds the handle, nothing unsaved.
Unload(i) ==
    LET x == h[i] IN
    /\ x.alive /\ Running(x.srv) /\ map[x.srv] = i
    /\ x.loaded /\ x.life = "Live" /\ x.pending = {} /\ ~x.needsSnap /\ x.ppc = "idle"
    /\ \A s \in Servers : req[s].hid # i
    /\ h' = [h EXCEPT ![i].loaded = FALSE, ![i].edits = {}]
    /\ UNCHANGED <<holdOut, store, dbAlive, status, lapsed, view, map, nextH, req, tk,
                   nextEdit, acked, excused, everStored, crashes, fails, reads>>

-----------------------------------------------------------------------------
(* Hub::tick, every lease / 5. Each step is one store call or one lock.     *)

\* Read Members::lapsed, renew the heartbeat, read the live list, then
\* `let cluster = self.cluster()`.
TickRenews(s) ==
    /\ Running(s) /\ tk[s].pc = "heartbeat"
    /\ dbAlive' = [dbAlive EXCEPT ![s] = TRUE]
    /\ lapsed' = [lapsed EXCEPT ![s] = FALSE]
    /\ holdOut' = [holdOut EXCEPT ![s] = FixRenew /\ lapsed[s]]
    /\ view' = [view EXCEPT ![s] = {t \in Servers : dbAlive'[t]}]
    /\ tk' = [tk EXCEPT ![s].pc = "letgo", ![s].lapsedNow = lapsed[s],
                        ![s].owns = (Owner(view'[s]) = s), ![s].hid = map[s]]
    /\ UNCHANGED <<store, status, map, h, nextH, req, nextEdit, acked, excused,
                   everStored, crashes, fails, reads>>

\* Hub::let_go for a design this server doesn't own, or every design after a lapse.
TickLetsGo(s) ==
    LET i == tk[s].hid IN
    /\ Running(s) /\ tk[s].pc = "letgo"
    /\ IF i # 0 /\ (tk[s].lapsedNow \/ ~tk[s].owns)
         THEN IF h[i].loaded
                THEN /\ h' = [h EXCEPT ![i].life = IF @ = "Live" THEN "Retiring" ELSE @]
                     /\ UNCHANGED map
                ELSE /\ map' = [map EXCEPT ![s] = IF @ = i THEN 0 ELSE @]
                     /\ UNCHANGED h
         ELSE UNCHANGED <<h, map>>
    /\ tk' = [tk EXCEPT ![s].pc = "lease"]
    /\ holdOut' = [holdOut EXCEPT ![s] = FALSE]
    /\ UNCHANGED <<holdOut, store, dbAlive, status, lapsed, view, nextH, req, nextEdit,
                   acked, excused, everStored, crashes, fails, reads>>

\* `loaded`: each listed handle's DesignHandle::lease, unless Gone.
TickReadsLoaded(s) ==
    LET i == tk[s].hid IN
    /\ Running(s) /\ tk[s].pc = "lease"
    /\ tk' = [tk EXCEPT ![s].pc = "held",
                        ![s].loaded = IF i # 0 /\ h[i].loaded /\ h[i].life # "Gone"
                                        THEN [hid |-> i, token |-> h[i].token, life |-> h[i].life]
                                        ELSE [hid |-> 0, token |-> 0, life |-> "Gone"]]
    /\ UNCHANGED <<holdOut, store, dbAlive, status, lapsed, view, map, h, nextH, req, nextEdit,
                   acked, excused, everStored, crashes, fails, reads>>

\* Store::held.
TickReadsHeld(s) ==
    /\ Running(s) /\ tk[s].pc = "held"
    /\ tk' = [tk EXCEPT ![s].pc = "release",
                        ![s].held = IF store.holder = s THEN store.epoch ELSE -1]
    /\ UNCHANGED <<holdOut, store, dbAlive, status, lapsed, view, map, h, nextH, req, nextEdit,
                   acked, excused, everStored, crashes, fails, reads>>

\* Release a lease this server holds on a design it neither owns nor has loaded.
TickReleases(s) ==
    /\ Running(s) /\ tk[s].pc = "release"
    /\ store' = IF /\ tk[s].held # -1 /\ ~tk[s].owns /\ tk[s].loaded.hid = 0
                   /\ store.epoch = tk[s].held /\ store.holder = s
                  THEN [store EXCEPT !.holder = None, !.epoch = @ + 1]
                  ELSE store
    /\ tk' = [tk EXCEPT ![s].pc = "drop"]
    /\ UNCHANGED <<holdOut, dbAlive, status, lapsed, view, map, h, nextH, req, nextEdit,
                   acked, excused, everStored, crashes, fails, reads>>

\* Drop a Live copy whose lease another server took.
TickDrops(s) ==
    LET l == tk[s].loaded IN
    /\ Running(s) /\ tk[s].pc = "drop"
    /\ IF /\ l.hid # 0 /\ l.life = "Live" /\ tk[s].held # l.token
          \* The fix: only the load whose token was read, not a later one.
          /\ FixStaleDrop => h[l.hid].loaded /\ h[l.hid].token = l.token
         THEN DropCopy(l.hid)
         ELSE UNCHANGED <<h, map>>
    /\ tk' = [tk EXCEPT ![s].pc = "discover"]
    /\ UNCHANGED <<holdOut, store, dbAlive, status, lapsed, view, nextH, req, nextEdit,
                   acked, excused, everStored, crashes, fails, reads>>

\* When the list changed, or every RESCAN_EVERY: list designs this server owns now.
TickDiscovers(s) ==
    /\ Running(s) /\ tk[s].pc = "discover"
    /\ \/ /\ tk[s].owns /\ map[s] = 0
          /\ Discover(s)
       \/ UNCHANGED <<store, map, h, nextH>>
    /\ tk' = [tk EXCEPT ![s] = IdleTick]
    /\ UNCHANGED <<holdOut, dbAlive, status, lapsed, view, req, nextEdit,
                   acked, excused, everStored, crashes, fails, reads>>

-----------------------------------------------------------------------------
(* What happens to a server from outside.                                   *)

\* Unsaved edits of `s`, which a crash or an expired lease may lose.
Unsaved(s) == UNION {h[i].edits : i \in {j \in HIds : h[j].alive /\ h[j].srv = s /\ h[j].loaded}}
              \ StoreEdits

\* Time passes without a renewal (a stall, or a heartbeat stuck on the database).
LeaseLapses(s) ==
    /\ Running(s) /\ ~lapsed[s]
    /\ lapsed' = [lapsed EXCEPT ![s] = TRUE]
    /\ UNCHANGED <<holdOut, store, dbAlive, status, view, map, h, nextH, req, tk, nextEdit,
                   acked, excused, everStored, crashes, fails, reads>>

\* The database's clock passes the lease too, so others may claim. The
\* server's unsaved edits, and the call it was running, may now be lost.
HeartbeatExpires(s) ==
    /\ lapsed[s] /\ dbAlive[s]
    /\ dbAlive' = [dbAlive EXCEPT ![s] = FALSE]
    /\ excused' = excused \cup Unsaved(s) \cup (IF req[s].e # 0 THEN {req[s].e} ELSE {})
    /\ req' = [req EXCEPT ![s].tainted = (req[s].pc # "idle")]
    /\ UNCHANGED <<holdOut, store, status, lapsed, view, map, h, nextH, tk, nextEdit,
                   acked, everStored, crashes, fails, reads>>

\* kill -9: memory is gone; the heartbeat row and the lease stay until they expire.
Crash(s) ==
    /\ status[s] # "off" /\ crashes < MaxCrashes
    /\ status' = [status EXCEPT ![s] = "off"]
    /\ excused' = excused \cup Unsaved(s)
    /\ h' = [i \in HIds |-> IF h[i].srv = s THEN [h[i] EXCEPT !.alive = FALSE] ELSE h[i]]
    /\ map' = [map EXCEPT ![s] = 0]
    /\ req' = [req EXCEPT ![s] = IdleReq]
    /\ tk' = [tk EXCEPT ![s] = IdleTick]
    /\ lapsed' = [lapsed EXCEPT ![s] = TRUE]          \* nothing renews it now
    /\ holdOut' = [holdOut EXCEPT ![s] = FALSE]
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<store, dbAlive, view, nextH, nextEdit, acked,
                   everStored, fails, reads>>

\* Hub::shared: heartbeat, read the list, list the designs it owns.
Start(s) ==
    /\ status[s] = "off"
    /\ status' = [status EXCEPT ![s] = "running"]
    /\ dbAlive' = [dbAlive EXCEPT ![s] = TRUE]
    /\ lapsed' = [lapsed EXCEPT ![s] = FALSE]
    /\ view' = [view EXCEPT ![s] = {t \in Servers : dbAlive'[t]}]
    /\ UNCHANGED <<holdOut, store, map, h, nextH, req, tk, nextEdit, acked, excused,
                   everStored, crashes, fails, reads>>

-----------------------------------------------------------------------------

Next ==
    \/ \E s \in Servers :
        \/ CallStarts(s) \/ CallFindsHandle(s) \/ CallLoads(s) \/ CallEdits(s) \/ CallReads(s)
        \/ TickRenews(s) \/ TickLetsGo(s) \/ TickReadsLoaded(s) \/ TickReadsHeld(s)
        \/ TickReleases(s) \/ TickDrops(s) \/ TickDiscovers(s)
        \/ LeaseLapses(s) \/ HeartbeatExpires(s)
        \/ Crash(s) \/ Start(s)
    \/ \E i \in HIds :
        \/ SaveTakes(i) \/ SaveWrites(i) \/ SaveFenced(i) \/ SaveFails(i)
        \/ SaveReleases(i) \/ SaveDrops(i) \/ Unload(i)

Spec == Init /\ [][Next]_vars

\* Keeps the model finite: claims and releases raise the epoch.
Bounds == store.epoch <= MaxEpoch

-----------------------------------------------------------------------------
(* The rules.                                                               *)

\* A copy that can still save: listed or not, its token is the store's.
CanSave(i) == /\ h[i].alive /\ h[i].loaded /\ h[i].life # "Gone"
              /\ h[i].token = store.epoch /\ store.holder = h[i].srv

\* Fencing: a write the store accepted is never overwritten by a stale copy.
StoredEditsStay == everStored \subseteq StoreEdits

\* An edit an agent was told succeeded is in the store, or in a copy that can
\* still save it, unless its server crashed or its lease expired first.
AckedEditsStay ==
    \A e \in acked \ excused :
        e \in StoreEdits \/ \E i \in HIds : CanSave(i) /\ e \in h[i].edits
=============================================================================
