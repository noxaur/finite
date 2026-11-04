//! One design on this server: its lock, its state while loaded, and every
//! way to change it. Each change goes out to the design's viewers and onto
//! its save queue before the lock is released.

use std::{
    collections::{BTreeMap, HashMap, HashSet, VecDeque},
    io,
    ops::{Deref, DerefMut},
    sync::{Arc, Mutex, MutexGuard},
};

use finite_design::{
    ActorId, Change, Design, Document, NodeId, Op, Record, Snapshot, Transaction,
    comment::{Anchor, Audience, Author, AuthorKind, Comment, CommentError, Listening},
    components,
    edit::EditError,
    label,
    user_edit::{self, UserEdit},
};
use tokio::sync::{broadcast, watch};

use super::{
    Actor, COMPACT_AFTER, COMPACT_BYTES, DesignMessage, DesignSummary, EVENT_BUFFER, HISTORY_TTL,
    Listener, Missed, Outgoing, PRESENCE_TTL, Presence, RESUME_BYTES, RESUME_LIMIT, SESSION_ACTOR,
    Stamp, UNLOAD_AFTER, now_ms, random_id,
};
use crate::store::{Claim, Store, Stored, Token};

pub(super) struct DesignState {
    pub(super) design: Design,
    presence: BTreeMap<ActorId, Presence>,
    last_seen: HashMap<ActorId, u64>,
    /// When each agent last asked for comments. An agent that asked within
    /// [`PRESENCE_TTL`] is listening, so comments can go to it.
    listening: BTreeMap<ActorId, Listener>,
    /// Records not yet written to the store.
    pending: Vec<Record>,
    /// Records in the store's journal since the last snapshot.
    journaled: usize,
    /// About how many bytes those records and the pending ones take: the
    /// size of each change as sent to viewers.
    journal_bytes: usize,
    /// Set when the next save must be a full snapshot: a new design, or a failed write.
    pub(super) needs_snapshot: bool,
    /// A random name for this load of the design. Changes after a restart or
    /// a reload can reuse a `seq`, so a viewer may resume only within one epoch.
    epoch: String,
    /// The latest changes, so a viewer that reconnects can get just what it missed.
    recent: Recent,
    /// Fans each change out to the design's open sockets. It lives here, not
    /// on the handle, because its buffer is allocated up front (about 30 KB),
    /// and a design that isn't loaded has no sockets to send to.
    events: broadcast::Sender<Outgoing>,
    /// When the design was last opened through [`super::Hub::get`].
    last_used: u64,
    /// The fencing token from this server's claim on the design. Every write carries it.
    pub(super) token: Token,
    pub(super) life: Life,
}

/// Where a loaded design is in its life on this server.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Life {
    /// Served and saved as usual.
    Live,
    /// Another server owns it now. Its viewers were sent away, and its last
    /// snapshot is being saved before its lease is released.
    Retiring,
    /// Saved and released, or fenced off: this copy is out of date.
    Gone,
}

/// What the save task writes next, with the token to write it with.
pub(super) enum Save {
    Snapshot(Snapshot, Token),
    Append(String, Vec<Record>, Token),
    /// The last snapshot before this server lets the design go. The lease
    /// is released once it's saved.
    Last(Snapshot, Token),
}

/// The error a load gets while another server still holds the design's lease.
#[derive(Debug)]
pub struct Busy(pub String);

impl std::fmt::Display for Busy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.0.is_empty() {
            f.write_str("the design is moving between servers")
        } else {
            write!(f, "{} still holds the design", self.0)
        }
    }
}

impl std::error::Error for Busy {}

pub(super) fn is_busy(error: &io::Error) -> bool {
    error.get_ref().is_some_and(|e| e.is::<Busy>())
}

fn busy(holder: String) -> io::Error {
    io::Error::new(io::ErrorKind::WouldBlock, Busy(holder))
}

impl DesignState {
    pub(super) fn new(design: Design, needs_snapshot: bool) -> Self {
        Self {
            design,
            presence: BTreeMap::new(),
            last_seen: HashMap::new(),
            listening: BTreeMap::new(),
            pending: Vec::new(),
            journaled: 0,
            journal_bytes: 0,
            needs_snapshot,
            epoch: random_id(8),
            recent: Recent::default(),
            events: broadcast::channel(EVENT_BUFFER).0,
            last_used: now_ms(),
            token: 0,
            life: Life::Live,
        }
    }

    /// Ends every viewer's socket, so they reconnect, by then to the new owner.
    fn send_viewers_away(&mut self) {
        self.events = broadcast::channel(1).0;
    }

    /// Rebuilds a stored design. A replayed journal is compacted on the next
    /// save, and so is a design whose old shared CSS moved into tokens.
    pub(super) fn restore(stored: Stored) -> Self {
        let mut needs_snapshot = !stored.journal.is_empty();
        let mut design = Design::from_snapshot(stored.snapshot);
        // The journal doesn't say when its changes were made, so their actors
        // count as active now.
        let mut journaled = HashSet::new();
        for record in stored.journal {
            if let Record::Change { change }
            | Record::Import {
                change: Some(change),
                ..
            } = &record
            {
                journaled.insert(change.actor.clone());
            }
            design.replay(record);
        }
        let id = design.meta.id.clone();
        match design.migrate_css(now_ms(), &mut || random_id(8)) {
            Ok(migrated) => needs_snapshot |= migrated.is_some(),
            Err(error) => {
                tracing::error!(design = id, %error, "couldn't move shared CSS into tokens")
            }
        }
        let mut state = Self::new(design, needs_snapshot);
        let now = now_ms();
        let actors: Vec<ActorId> = state.design.actors().map(String::from).collect();
        for actor in actors {
            if actor.starts_with(SESSION_ACTOR) {
                // Restored after a restart, its session is gone, so nobody
                // can use this history. (A design with a live session's
                // history stays in memory; see `is_idle`.)
                state.design.forget_actor(&actor);
                continue;
            }
            // Restored histories expire on the clock they had when saved.
            let last_used = state.design.history(&actor).map_or(0, |h| h.last_used());
            let seen = if last_used == 0 || journaled.contains(&actor) {
                now
            } else {
                last_used
            };
            state.last_seen.insert(actor, seen);
        }
        state
    }

    /// A full snapshot for the store, with each history's last-use time.
    pub(super) fn snapshot_to_save(&mut self) -> Snapshot {
        for (actor, seen) in &self.last_seen {
            self.design.set_last_used(actor, *seen);
        }
        self.design.snapshot_to_save()
    }

    /// Every change after `since`, if this is its epoch and none have been
    /// dropped from `recent`.
    fn missed_since(&self, since: &Since) -> Option<Vec<Missed<'_>>> {
        let seq = self.design.seq();
        if since.epoch != self.epoch || since.seq > seq {
            return None;
        }
        let missed: Vec<Missed> = self
            .recent
            .changes
            .iter()
            .filter(|kept| kept.change.seq > since.seq)
            .map(|kept| Missed {
                change: &kept.change,
                actor_name: &kept.actor_name,
                mutation: kept.mutation.as_ref(),
            })
            .collect();
        // Seqs have no gaps, so a full set has exactly this many.
        (missed.len() as u64 == seq - since.seq).then_some(missed)
    }

    /// Whether the design can leave memory: unused for a while, nothing
    /// unsaved, nobody present, and its histories saved as they are now.
    ///
    /// A history comes back with its design, unless it belongs to an MCP
    /// session (see `restore`). So a live session's history keeps the design
    /// loaded, and other histories need a full snapshot first: the journal
    /// doesn't hold their last-use times.
    pub(super) fn is_idle(&self, now: u64) -> bool {
        self.unused(now) && self.histories_saved()
    }

    fn unused(&self, now: u64) -> bool {
        self.pending.is_empty()
            && !self.needs_snapshot
            && self.presence.is_empty()
            && !self.design.actors().any(|a| a.starts_with(SESSION_ACTOR))
            && now.saturating_sub(self.last_used) >= UNLOAD_AFTER.as_millis() as u64
    }

    fn histories_saved(&self) -> bool {
        !self.design.has_histories()
            || (self.journaled == 0
                && self.last_seen.iter().all(|(actor, seen)| {
                    self.design
                        .history(actor)
                        .is_none_or(|h| h.last_used() == *seen)
                }))
    }

    pub(super) fn presence_message(&self) -> Outgoing {
        let presence = self.presence.values().collect();
        let listening = self.listening.values().collect();
        Outgoing::new(
            None,
            &DesignMessage::Presence {
                presence,
                listening,
            },
        )
    }

    pub(super) fn touch(&mut self, actor: &Actor, now: u64) {
        self.last_seen.insert(actor.id.clone(), now);
        if let Some(p) = self.presence.get_mut(&actor.id) {
            p.updated_at = now;
        }
    }
}

/// Whether agent `id` listens for `comment`: it asked for comments within
/// [`PRESENCE_TTL`], about a part of the design that holds the comment.
fn listening_for(state: &DesignState, now: u64) -> impl Fn(&str, &Comment) -> bool + '_ {
    let ttl = PRESENCE_TTL.as_millis() as u64;
    move |id, comment| {
        state.listening.get(id).is_some_and(|l| {
            now.saturating_sub(l.at) < ttl && l.scope.admits(state.design.view(), comment, id)
        })
    }
}

/// One design. The hub keeps a handle for every design, but the state (the
/// document, comments and histories) is only in memory while the design is in
/// use: [`super::Hub::get`] loads it, and the hub's sweep unloads it once it's idle.
/// Every public method expects the state to be loaded, which holds for any
/// handle obtained from [`super::Hub::get`].
pub struct DesignHandle {
    id: String,
    store: Arc<dyn Store>,
    state: Mutex<Option<DesignState>>,
    pub(super) persistence: Mutex<()>,
    /// Kept current while loaded, so the design list never loads a design.
    summary: Mutex<DesignSummary>,
    /// Pinged on every change; the save task waits on it.
    pub(super) dirty: watch::Sender<()>,
    /// Wakes `wait_for_comments` callers when any comment changes.
    comments: tokio::sync::Notify,
}

/// A design's latest changes, oldest first. It keeps at most `RESUME_LIMIT`
/// of them, adding up to at most `RESUME_BYTES`, so a few huge edits can't
/// hold on to a lot of memory.
#[derive(Default)]
pub(super) struct Recent {
    changes: VecDeque<Kept>,
    bytes: usize,
}

struct Kept {
    change: Change,
    actor_name: String,
    mutation: Option<Stamp>,
    /// The size of its `change` message.
    bytes: usize,
}

impl Recent {
    fn push(&mut self, kept: Kept) {
        self.bytes += kept.bytes;
        self.changes.push_back(kept);
        while self.changes.len() > RESUME_LIMIT || self.bytes > RESUME_BYTES {
            let Some(dropped) = self.changes.pop_front() else {
                break;
            };
            self.bytes -= dropped.bytes;
        }
    }
}

/// Where a reconnecting viewer left off: the epoch from its snapshot and the
/// `seq` of the last change it applied.
#[derive(Clone, Debug)]
pub struct Since {
    pub epoch: String,
    pub seq: u64,
}

/// A locked, loaded design state.
pub(super) struct Loaded<'a>(MutexGuard<'a, Option<DesignState>>);

impl Deref for Loaded<'_> {
    type Target = DesignState;

    fn deref(&self) -> &DesignState {
        self.0
            .as_ref()
            .expect("design handles are only used after Hub::get loads them")
    }
}

impl DerefMut for Loaded<'_> {
    fn deref_mut(&mut self) -> &mut DesignState {
        self.0
            .as_mut()
            .expect("design handles are only used after Hub::get loads them")
    }
}

/// The result of an edit: the command's output and the change it produced
/// (`None` if the document was already in the requested state).
pub type Edited<T> = (T, Option<Change>);

impl DesignHandle {
    pub(super) fn new(
        store: Arc<dyn Store>,
        summary: DesignSummary,
        state: Option<DesignState>,
    ) -> Self {
        Self {
            id: summary.meta.id.clone(),
            store,
            state: Mutex::new(state),
            persistence: Mutex::new(()),
            summary: Mutex::new(summary),
            dirty: watch::channel(()).0,
            comments: tokio::sync::Notify::new(),
        }
    }

    /// Resolves the next time a comment is created or changes.
    pub fn comments_changed(&self) -> tokio::sync::futures::Notified<'_> {
        self.comments.notified()
    }

    /// The state, loaded or not. Hub-wide passes (sweep, flush) use this.
    pub(super) fn raw(&self) -> MutexGuard<'_, Option<DesignState>> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(super) fn lock(&self) -> Loaded<'_> {
        Loaded(self.raw())
    }

    /// Loads the state from the store if it isn't in memory.
    ///
    /// Loading takes the design's lease first, and only then reads it. From
    /// the claim on, no other server's write can land, so what's read is the
    /// latest. While another live server holds the lease, this fails with
    /// [`Busy`].
    pub(super) fn load(&self) -> io::Result<()> {
        let mut state = self.raw();
        if state.as_ref().is_some_and(|s| s.life != Life::Live) {
            return Err(busy(String::new()));
        }
        if state.is_none() {
            let missing =
                || io::Error::new(io::ErrorKind::NotFound, "design missing from the store");
            let token = match self.store.claim(&self.id)? {
                Claim::Granted(token) => token,
                Claim::Held(holder) => return Err(busy(holder)),
                Claim::Missing => return Err(missing()),
            };
            let stored = match self.store.load(&self.id) {
                Ok(Some(stored)) => stored,
                failed => {
                    // Don't sit on a lease without serving the design.
                    let _ = self.store.release(&self.id, token);
                    return Err(failed.err().unwrap_or_else(missing));
                }
            };
            let mut restored = DesignState::restore(stored);
            restored.token = token;
            if restored.needs_snapshot {
                self.dirty.send_replace(());
            }
            *state = Some(restored);
        }
        if let Some(state) = state.as_mut() {
            state.last_used = now_ms();
        }
        Ok(())
    }

    /// Drops the state from memory if it's idle. The caller makes sure nobody
    /// else holds this handle.
    pub(super) fn unload_if_idle(&self, now: u64) -> bool {
        let mut state = self.raw();
        let idle = state
            .as_ref()
            .is_some_and(|s| s.life == Life::Live && s.is_idle(now));
        if idle
            && state
                .as_ref()
                .is_some_and(|s| s.events.receiver_count() == 0)
        {
            *state = None;
            return true;
        }
        false
    }

    pub(super) fn is_loaded(&self) -> bool {
        self.raw().is_some()
    }

    /// The token and life of a loaded design.
    pub(super) fn lease(&self) -> Option<(Token, Life)> {
        self.raw().as_ref().map(|s| (s.token, s.life))
    }

    /// Starts letting the design go to another server: sends its viewers
    /// away and asks the save task for a last snapshot. Returns `false` if it
    /// isn't loaded, so there's nothing to save.
    pub(super) fn retire(&self) -> bool {
        let mut state = self.raw();
        let Some(state) = state.as_mut() else {
            return false;
        };
        if state.life == Life::Live {
            state.life = Life::Retiring;
            state.send_viewers_away();
            self.comments.notify_waiters();
            self.dirty.send_replace(());
        }
        true
    }

    /// Marks this copy out of date, after its last save or after another
    /// server fenced it off. Nothing about it is saved again.
    pub(super) fn end(&self) {
        if let Some(state) = self.raw().as_mut() {
            state.life = Life::Gone;
            state.pending.clear();
            state.send_viewers_away();
        }
        self.comments.notify_waiters();
    }

    pub(super) fn delete(&self) -> io::Result<()> {
        let _saving = self.persistence.lock().unwrap();
        let mut state = self.lock();
        if state.life != Life::Live {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "design is no longer available",
            ));
        }
        self.store.delete(&self.id, state.token)?;
        state.life = Life::Gone;
        state.pending.clear();
        state.send_viewers_away();
        self.comments.notify_waiters();
        Ok(())
    }

    pub fn read<T>(&self, f: impl FnOnce(&Design) -> T) -> T {
        f(&self.lock().design)
    }

    /// Like [`DesignHandle::read`], but only if the design is in memory.
    pub(super) fn read_loaded<T>(&self, f: impl FnOnce(&Design) -> T) -> Option<T> {
        self.raw().as_ref().map(|state| f(&state.design))
    }

    /// Works whether or not the design is loaded.
    pub fn summary(&self) -> DesignSummary {
        self.summary
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    pub fn presence(&self) -> Vec<Presence> {
        self.lock().presence.values().cloned().collect()
    }

    /// The current snapshot as a message, plus a receiver for everything after it.
    /// Subscribes a new viewer: a snapshot, then a receiver for what follows.
    pub fn subscribe(&self) -> (Outgoing, u64, broadcast::Receiver<Outgoing>) {
        self.subscribe_from(None)
    }

    /// Subscribes a viewer that may have been here before. If it was, in this
    /// epoch, and every change since its `seq` is still kept, it gets a
    /// `resume` with just those changes. Otherwise it gets a snapshot.
    pub fn subscribe_from(
        &self,
        since: Option<&Since>,
    ) -> (Outgoing, u64, broadcast::Receiver<Outgoing>) {
        // Subscribing under the lock means no change can slip between the first message and the stream.
        let state = self.lock();
        let rx = state.events.subscribe();
        let seq = state.design.seq();
        let presence = state.presence.values().collect();
        let listening = state.listening.values().collect();
        if let Some(missed) = since.and_then(|since| state.missed_since(since)) {
            let message = DesignMessage::Resume {
                changes: missed,
                comments: state.design.comments(),
                presence,
                listening,
                meta: &state.design.meta,
            };
            return (Outgoing::new(None, &message), seq, rx);
        }
        let snapshot = state.design.snapshot();
        let message = DesignMessage::Snapshot {
            snapshot: &snapshot,
            presence,
            listening,
            epoch: &state.epoch,
        };
        (Outgoing::new(None, &message), seq, rx)
    }

    pub(super) fn publish(
        &self,
        state: &mut DesignState,
        actor: &Actor,
        change: &Change,
        mutation: Option<&Stamp>,
    ) {
        self.broadcast(state, actor, change, mutation);
        self.record(
            state,
            Record::Change {
                change: change.clone(),
            },
        );
    }

    /// Sends a change to viewers and keeps it for those who resume, without
    /// saving it.
    fn broadcast(
        &self,
        state: &mut DesignState,
        actor: &Actor,
        change: &Change,
        mutation: Option<&Stamp>,
    ) {
        let message = DesignMessage::Change {
            change,
            actor_name: &actor.name,
            mutation,
        };
        let message = Outgoing::new(Some(change.seq), &message);
        state.recent.push(Kept {
            change: change.clone(),
            actor_name: actor.name.clone(),
            mutation: mutation.cloned(),
            bytes: message.json.len(),
        });
        state.journal_bytes += message.json.len();
        let _ = state.events.send(message);
    }

    /// Sends a change with the comments it moved, like pins whose artboard
    /// was deleted, and saves them all. A pin that lost its artboard is sent
    /// before the change and one that got it back after, so a viewer always
    /// has somewhere to draw it.
    pub(super) fn publish_with_comments(
        &self,
        state: &mut DesignState,
        actor: &Actor,
        change: &Change,
        mutation: Option<&Stamp>,
    ) {
        let (detached, reattached): (Vec<_>, Vec<_>) = state
            .design
            .take_comment_updates()
            .into_iter()
            .partition(|c| c.detached_at.is_some());
        let events = state.events.clone();
        let send = |comment: &Comment| {
            let message = DesignMessage::Comment { comment };
            let _ = events.send(Outgoing::new(None, &message));
        };
        detached.iter().for_each(send);
        self.publish(state, actor, change, mutation);
        reattached.iter().for_each(send);
        for comment in detached.into_iter().chain(reattached) {
            self.record(state, Record::Comment { comment });
        }
    }

    /// Queues `record` for the save task.
    pub(super) fn record(&self, state: &mut DesignState, record: Record) {
        state.pending.push(record);
        *self.summary.lock().unwrap_or_else(|e| e.into_inner()) = DesignSummary::of(&state.design);
        self.dirty.send_replace(());
    }

    /// Takes what the save task should write: the pending records, or a full
    /// snapshot when one is due. `None` when there's nothing to save.
    pub(super) fn take_save(&self) -> Option<Save> {
        let mut state = self.raw();
        let state = state.as_mut()?;
        match state.life {
            Life::Gone => return None,
            Life::Retiring => {
                state.pending.clear();
                state.needs_snapshot = false;
                return Some(Save::Last(state.snapshot_to_save(), state.token));
            }
            Life::Live => {}
        }
        if state.pending.is_empty() && !state.needs_snapshot {
            return None;
        }
        let mut records = std::mem::take(&mut state.pending);
        // Edits bump `updated_at`, which no other record carries.
        records.push(Record::Meta {
            meta: state.design.meta.clone(),
        });
        state.journaled += records.len();
        if state.needs_snapshot
            || state.journaled > COMPACT_AFTER
            || state.journal_bytes > COMPACT_BYTES
        {
            state.needs_snapshot = false;
            state.journaled = 0;
            state.journal_bytes = 0;
            return Some(Save::Snapshot(state.snapshot_to_save(), state.token));
        }
        Some(Save::Append(
            state.design.meta.id.clone(),
            records,
            state.token,
        ))
    }

    /// After a failed write, the next save rewrites the snapshot so nothing is lost.
    pub(super) fn save_failed(&self) {
        if let Some(state) = self.raw().as_mut() {
            state.needs_snapshot = true;
        }
    }

    /// A full snapshot, with the pending records counted as saved. `None` when
    /// the design isn't loaded, which means it's already saved.
    pub(super) fn compact(&self) -> Option<(Snapshot, Token)> {
        let mut state = self.raw();
        let state = state.as_mut().filter(|s| s.life != Life::Gone)?;
        state.pending.clear();
        state.journaled = 0;
        state.journal_bytes = 0;
        state.needs_snapshot = false;
        Some((state.snapshot_to_save(), state.token))
    }

    /// Builds ops from the current document with `build`, then commits them as
    /// one undo step for `actor`.
    ///
    /// `build` sees the document as it renders, with instances expanded
    /// (`Design::view`), so an edit can name a node inside an instance.
    /// `components::redirect` then turns those ops into overrides on the
    /// instance, or refuses them.
    pub fn edit<T>(
        &self,
        actor: &Actor,
        label: &str,
        build: impl FnOnce(&Document) -> Result<(Vec<Op>, T), EditError>,
    ) -> Result<Edited<T>, EditError> {
        self.edit_design(actor, label, |design| build(design.view()))
    }

    /// [`Self::edit`], with `build` seeing the whole design, for an edit
    /// that also reads its history, like a merged rewrite ([`Design::merge`]).
    pub fn edit_design<T>(
        &self,
        actor: &Actor,
        label: &str,
        build: impl FnOnce(&Design) -> Result<(Vec<Op>, T), EditError>,
    ) -> Result<Edited<T>, EditError> {
        let now = now_ms();
        let mut state = self.lock();
        state.touch(actor, now);
        let (ops, output) = build(&state.design)?;
        let doc = state.design.doc();
        let mut new_id = || loop {
            let id = random_id(8);
            if !doc.contains(&id) {
                return id;
            }
        };
        let ops = components::redirect(doc, ops, &mut new_id)?;
        let change = state.design.commit(&actor.id, label, &ops, now);
        if let Some(change) = &change {
            self.publish_with_comments(&mut state, actor, change, None);
        }
        Ok((output, change))
    }

    /// Runs `build` with [`Design::transact`] under one lock: everything it
    /// applies is one change and one undo step for `actor`, broadcast and
    /// journaled once, and if it fails nobody sees anything. Build ops
    /// against `tx.view()` and apply them with `tx.edit`, so edits inside
    /// an instance become its overrides, as with [`Self::edit`]. An import
    /// it records is journaled with the change in one record, so a crash
    /// can't keep one without the other; its bytes must already be stored.
    pub fn transact<T, E>(
        &self,
        actor: &Actor,
        label: &str,
        build: impl FnOnce(&mut Transaction<'_>) -> Result<T, E>,
    ) -> Result<Edited<T>, E> {
        let now = now_ms();
        let mut state = self.lock();
        state.touch(actor, now);
        let before = state.design.imports().len();
        let (change, output) = state.design.transact(&actor.id, label, now, build)?;
        let imports = state.design.imports()[before..].to_vec();
        if imports.is_empty() {
            if let Some(change) = &change {
                self.publish_with_comments(&mut state, actor, change, None);
            }
            return Ok((output, change));
        }
        if let Some(change) = &change {
            self.broadcast(&mut state, actor, change, None);
        }
        // The first record carries the change, and the rest only their imports.
        let mut change = change;
        let first = change.clone();
        for import in imports {
            let change = change.take();
            self.record(&mut state, Record::Import { import, change });
        }
        Ok((output, first))
    }

    /// Stages `build` with [`Design::dry_run`]: the ops it would apply,
    /// with the design left as it was and nothing sent or saved.
    pub fn dry_run<T, E>(
        &self,
        actor: &Actor,
        build: impl FnOnce(&mut Transaction<'_>) -> Result<T, E>,
    ) -> Result<(Vec<Op>, T), E> {
        self.lock().design.dry_run(&actor.id, build)
    }

    /// Commits a person's gesture, sent from a browser tab, as one undo step
    /// for `actor`. The edits are planned with [`user_edit::plan`], the same
    /// function the tab ran to show them, against the document as it is
    /// now, with the same new ids. The change carries `stamp`, so the tab
    /// knows it as its own.
    pub fn mutate(
        &self,
        actor: &Actor,
        stamp: &Stamp,
        edits: &[UserEdit],
    ) -> Result<Option<Change>, EditError> {
        let now = now_ms();
        let mut state = self.lock();
        state.touch(actor, now);
        let doc = state.design.doc();
        // The ids the tab made for its own copy of this edit.
        let ops = user_edit::plan(
            doc,
            state.design.view(),
            edits,
            &mut user_edit::new_ids(doc, &stamp.client, stamp.mid),
        )?;
        let change = state
            .design
            .commit(&actor.id, user_edit::label(edits), &ops, now);
        if let Some(change) = &change {
            self.publish_with_comments(&mut state, actor, change, Some(stamp));
        }
        Ok(change)
    }

    /// The `settled` message for a tab's mutation `mid` that changed nothing,
    /// with `error` saying why when it was refused.
    pub fn settled(&self, mid: u64, error: Option<String>) -> Outgoing {
        let seq = self.lock().design.seq();
        Outgoing::new(None, &DesignMessage::Settled { mid, seq, error })
    }

    pub fn undo(&self, actor: &Actor, mutation: Option<&Stamp>) -> Option<Change> {
        self.step(actor, Design::undo, mutation)
    }

    pub fn redo(&self, actor: &Actor, mutation: Option<&Stamp>) -> Option<Change> {
        self.step(actor, Design::redo, mutation)
    }

    pub(super) fn step(
        &self,
        actor: &Actor,
        f: fn(&mut Design, &str, u64) -> Option<Change>,
        mutation: Option<&Stamp>,
    ) -> Option<Change> {
        let now = now_ms();
        let mut state = self.lock();
        state.touch(actor, now);
        let change = f(&mut state.design, &actor.id, now)?;
        self.publish_with_comments(&mut state, actor, &change, mutation);
        Some(change)
    }

    /// `(undo labels, redo labels)`, most recent first.
    pub fn history(&self, actor: &Actor) -> (Vec<String>, Vec<String>) {
        let state = self.lock();
        state
            .design
            .history(&actor.id)
            .map_or_else(Default::default, |h| {
                (
                    h.undo_labels().map(Into::into).collect(),
                    h.redo_labels().map(Into::into).collect(),
                )
            })
    }

    pub fn rename(&self, name: String) {
        let name = label::clip(&name, label::DESIGN_NAME);
        let mut state = self.lock();
        state.design.meta.name = if name.is_empty() {
            "Untitled".into()
        } else {
            name
        };
        state.design.meta.updated_at = now_ms();
        let message = Outgoing::new(
            None,
            &DesignMessage::Meta {
                meta: &state.design.meta,
            },
        );
        let _ = state.events.send(message);
        let meta = state.design.meta.clone();
        self.record(&mut state, Record::Meta { meta });
    }

    pub fn comments(&self) -> Vec<Comment> {
        self.lock().design.comments().to_vec()
    }

    /// Pins a new comment. See [`Design::add_comment`].
    pub fn add_comment(
        &self,
        author: Author,
        anchor: Anchor,
        audience: Audience,
        body: &str,
    ) -> Result<Comment, CommentError> {
        self.update_comment(|design| {
            design.add_comment(
                author,
                anchor,
                audience,
                body,
                &mut || random_id(8),
                now_ms(),
            )
        })
    }

    /// Adds a reply. See [`Design::reply`].
    pub fn reply(
        &self,
        id: &str,
        author: Author,
        body: &str,
        resolve: Option<bool>,
    ) -> Result<Comment, CommentError> {
        self.update_comment(|design| design.reply(id, author, body, resolve, now_ms()))
    }

    pub fn set_resolved(&self, id: &str, resolved: bool) -> Result<Comment, CommentError> {
        self.update_comment(|design| design.set_resolved(id, resolved, now_ms()))
    }

    /// Edits the newest message. See [`Design::edit_message`].
    pub fn edit_message(
        &self,
        id: &str,
        author_id: &str,
        body: &str,
    ) -> Result<Comment, CommentError> {
        self.update_comment(|design| design.edit_message(id, author_id, body, now_ms()))
    }

    /// Changes who a comment is for. See [`Design::set_audience`].
    pub fn set_audience(&self, id: &str, audience: Audience) -> Result<Comment, CommentError> {
        self.update_comment(|design| design.set_audience(id, audience))
    }

    /// An agent steps back from a comment. See [`Design::pass`].
    pub fn pass(&self, id: &str, agent: Author) -> Result<Comment, CommentError> {
        self.update_comment(|design| design.pass(id, agent))
    }

    /// Deletes a comment, then tells viewers.
    pub fn delete_comment(&self, id: &str) -> Result<(), CommentError> {
        let mut state = self.lock();
        state.design.delete_comment(id)?;
        let message = DesignMessage::CommentDeleted { id };
        let _ = state.events.send(Outgoing::new(None, &message));
        self.record(&mut state, Record::CommentDeleted { id: id.to_owned() });
        self.comments.notify_waiters();
        Ok(())
    }

    /// Runs a comment update, then sends the whole comment to viewers.
    pub(super) fn update_comment(
        &self,
        f: impl FnOnce(&mut Design) -> Result<&Comment, CommentError>,
    ) -> Result<Comment, CommentError> {
        let mut state = self.lock();
        let comment = f(&mut state.design)?.clone();
        self.send_comment(&mut state, &comment);
        self.comments.notify_waiters();
        Ok(comment)
    }

    fn send_comment(&self, state: &mut DesignState, comment: &Comment) {
        let message = DesignMessage::Comment { comment };
        let _ = state.events.send(Outgoing::new(None, &message));
        let record = Record::Comment {
            comment: comment.clone(),
        };
        self.record(state, record);
    }

    /// Runs `f` with the design and whether an agent listens for a comment, to
    /// see where comments go. See [`Design::routed_to`].
    pub fn with_routes<T>(
        &self,
        f: impl FnOnce(&Design, &dyn Fn(&str, &Comment) -> bool) -> T,
    ) -> T {
        let state = self.lock();
        let listening = listening_for(&state, now_ms());
        f(&state.design, &listening)
    }

    /// Marks `agent` as listening to `scope`, then takes every comment in it
    /// waiting for that agent, oldest first, so no other agent gets them too.
    pub fn take_waiting(&self, agent: &Actor, scope: Listening) -> Vec<Comment> {
        let mut state = self.lock();
        let now = now_ms();
        state.touch(agent, now);
        let listener = Listener {
            actor: agent.id.clone(),
            name: agent.name.clone(),
            at: now,
            scope,
        };
        match state.listening.insert(agent.id.clone(), listener) {
            None => {
                let _ = state.events.send(state.presence_message());
            }
            // It listens to something else now, so comments it held may go
            // to agents already waiting.
            Some(before) if state.listening[&agent.id].scope != before.scope => {
                self.comments.notify_waiters();
            }
            Some(_) => {}
        }
        let ids: Vec<String> = {
            let listening = listening_for(&state, now);
            let design = &state.design;
            design
                .comments()
                .iter()
                .filter(|c| listening(&agent.id, c))
                .filter(|c| design.awaits(c, &agent.id, |id| listening(id, c)))
                .map(|c| c.id.clone())
                .collect()
        };
        let me = Author {
            id: agent.id.clone(),
            name: agent.name.clone(),
            kind: AuthorKind::Agent,
        };
        let mut taken = Vec::new();
        let mut changed = false;
        for id in ids {
            let Some(before) = state
                .design
                .comments()
                .iter()
                .find(|c| c.id == id)
                .map(|c| c.rev)
            else {
                continue;
            };
            let Ok(comment) = state.design.take(&id, me.clone()) else {
                continue;
            };
            let comment = comment.clone();
            if comment.rev != before {
                self.send_comment(&mut state, &comment);
                changed = true;
            }
            taken.push(comment);
        }
        if changed {
            self.comments.notify_waiters();
        }
        taken
    }

    pub fn set_presence(&self, actor: &Actor, node_ids: Vec<NodeId>, status: Option<String>) {
        let mut state = self.lock();
        let now = now_ms();
        state.touch(actor, now);
        state.presence.insert(
            actor.id.clone(),
            Presence {
                actor: actor.id.clone(),
                name: actor.name.clone(),
                node_ids,
                status: status
                    .map(|s| label::clip(&s, label::STATUS))
                    .filter(|s| !s.is_empty()),
                updated_at: now,
                automatic: false,
            },
        );
        let _ = state.events.send(state.presence_message());
    }

    /// Shows that `actor` is editing `node_ids` (usually artboards), unless
    /// it already said what it's working on with [`Self::set_presence`]. An
    /// indicator set this way lasts while the actor keeps editing, and
    /// expires [`super::AUTO_PRESENCE_TTL`] after its last edit.
    pub fn show_editing(&self, actor: &Actor, node_ids: Vec<NodeId>) {
        let mut state = self.lock();
        let now = now_ms();
        match state.presence.get_mut(&actor.id) {
            Some(p) if !p.automatic => return,
            Some(p) => {
                p.updated_at = now;
                let mut changed = false;
                for id in node_ids {
                    if !p.node_ids.contains(&id) && p.node_ids.len() < super::PRESENCE_NODES {
                        p.node_ids.push(id);
                        changed = true;
                    }
                }
                if !changed {
                    return;
                }
            }
            None => {
                state.presence.insert(
                    actor.id.clone(),
                    Presence {
                        actor: actor.id.clone(),
                        name: actor.name.clone(),
                        node_ids,
                        status: None,
                        updated_at: now,
                        automatic: true,
                    },
                );
            }
        }
        let _ = state.events.send(state.presence_message());
    }

    pub fn clear_presence(&self, actor: &str) {
        let mut state = self.lock();
        if state.presence.remove(actor).is_some() {
            let _ = state.events.send(state.presence_message());
        }
    }

    pub(super) fn forget(&self, actor: &str) {
        let mut state = self.raw();
        let Some(state) = state.as_mut() else { return };
        let present = state.presence.remove(actor).is_some();
        let listened = state.listening.remove(actor).is_some();
        if listened || present {
            let _ = state.events.send(state.presence_message());
        }
        if listened {
            // Its comments go to other agents now, and some may be waiting.
            self.comments.notify_waiters();
        }
        state.design.forget_actor(actor);
        state.last_seen.remove(actor);
    }

    /// Expires stale presence and the histories of long-idle actors. Asks for
    /// a full snapshot when the store's histories are out of date: one expired,
    /// or the design is otherwise ready to unload (see `is_idle`).
    pub(super) fn sweep(&self, now: u64) {
        let mut state = self.raw();
        let Some(state) = state.as_mut() else { return };
        let ttl = PRESENCE_TTL.as_millis() as u64;
        let auto_ttl = super::AUTO_PRESENCE_TTL.as_millis() as u64;
        let before = (state.presence.len(), state.listening.len());
        state.presence.retain(|_, p| {
            now.saturating_sub(p.updated_at) < if p.automatic { auto_ttl } else { ttl }
        });
        state
            .listening
            .retain(|_, l| now.saturating_sub(l.at) < ttl);
        if (state.presence.len(), state.listening.len()) != before {
            let _ = state.events.send(state.presence_message());
        }
        if state.listening.len() != before.1 {
            self.comments.notify_waiters();
        }
        let ttl = HISTORY_TTL.as_millis() as u64;
        let idle: Vec<ActorId> = state
            .last_seen
            .iter()
            .filter(|(_, seen)| now.saturating_sub(**seen) >= ttl)
            .map(|(actor, _)| actor.clone())
            .collect();
        let mut resave = false;
        for actor in idle {
            resave |= state.design.history(&actor).is_some();
            state.design.forget_actor(&actor);
            state.last_seen.remove(&actor);
        }
        resave |= state.unused(now) && !state.histories_saved();
        if resave {
            state.needs_snapshot = true;
            self.dirty.send_replace(());
        }
    }
}

#[cfg(test)]
mod tests {
    use finite_design::Origin;

    use super::*;

    fn kept(seq: u64, bytes: usize) -> Kept {
        Kept {
            change: Change {
                seq,
                actor: "agent".into(),
                origin: Origin::Edit,
                label: "Edit".into(),
                ops: Vec::new(),
            },
            actor_name: "Agent".into(),
            mutation: None,
            bytes,
        }
    }

    #[test]
    fn recent_changes_stay_within_their_byte_budget() {
        let mut recent = Recent::default();
        recent.push(kept(1, RESUME_BYTES / 2));
        recent.push(kept(2, RESUME_BYTES / 2));
        assert_eq!(recent.changes.len(), 2);
        // A third pushes the oldest out.
        recent.push(kept(3, 1));
        let seqs: Vec<u64> = recent.changes.iter().map(|k| k.change.seq).collect();
        assert_eq!(seqs, [2, 3]);
        assert_eq!(recent.bytes, RESUME_BYTES / 2 + 1);
        // One bigger than the whole budget leaves nothing, so viewers get a snapshot.
        recent.push(kept(4, RESUME_BYTES + 1));
        assert!(recent.changes.is_empty());
        assert_eq!(recent.bytes, 0);
    }
}
