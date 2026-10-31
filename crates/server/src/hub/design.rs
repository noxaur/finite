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
    ActorId, Change, Design, Document, NodeId, Op, Record, Snapshot,
    comment::{Anchor, Author, Comment, CommentError},
    edit::EditError,
    label,
};
use tokio::sync::{broadcast, watch};

use super::{
    Actor, COMPACT_AFTER, DesignMessage, DesignSummary, EVENT_BUFFER, HISTORY_TTL, Missed,
    Outgoing, PRESENCE_TTL, Presence, RESUME_BYTES, RESUME_LIMIT, SESSION_ACTOR, UNLOAD_AFTER,
    now_ms, random_id,
};
use crate::store::{Store, Stored};

pub(super) struct DesignState {
    pub(super) design: Design,
    presence: BTreeMap<ActorId, Presence>,
    last_seen: HashMap<ActorId, u64>,
    /// Records not yet written to the store.
    pending: Vec<Record>,
    /// Records in the store's journal since the last snapshot.
    journaled: usize,
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
}

/// What the save task writes next.
pub(super) enum Save {
    Snapshot(Snapshot),
    Append(String, Vec<Record>),
}

impl DesignState {
    pub(super) fn new(design: Design, needs_snapshot: bool) -> Self {
        Self {
            design,
            presence: BTreeMap::new(),
            last_seen: HashMap::new(),
            pending: Vec::new(),
            journaled: 0,
            needs_snapshot,
            epoch: random_id(8),
            recent: Recent::default(),
            events: broadcast::channel(EVENT_BUFFER).0,
            last_used: now_ms(),
        }
    }

    /// Rebuilds a stored design. A replayed journal is compacted on the next save.
    pub(super) fn restore(stored: Stored) -> Self {
        let needs_snapshot = !stored.journal.is_empty();
        let mut design = Design::from_snapshot(stored.snapshot);
        // The journal doesn't say when its changes were made, so their actors
        // count as active now.
        let mut journaled = HashSet::new();
        for record in stored.journal {
            if let Record::Change { change } = &record {
                journaled.insert(change.actor.clone());
            }
            design.replay(record);
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
        Outgoing::new(None, &DesignMessage::Presence { presence })
    }

    pub(super) fn touch(&mut self, actor: &Actor, now: u64) {
        self.last_seen.insert(actor.id.clone(), now);
        if let Some(p) = self.presence.get_mut(&actor.id) {
            p.updated_at = now;
        }
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
    pub(super) fn load(&self) -> io::Result<()> {
        let mut state = self.raw();
        if state.is_none() {
            let stored = self.store.load(&self.id)?.ok_or_else(|| {
                io::Error::new(io::ErrorKind::NotFound, "design missing from the store")
            })?;
            let restored = DesignState::restore(stored);
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
        let idle = state.as_ref().is_some_and(|s| s.is_idle(now));
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
        if let Some(missed) = since.and_then(|since| state.missed_since(since)) {
            let message = DesignMessage::Resume {
                changes: missed,
                comments: state.design.comments(),
                presence,
                meta: &state.design.meta,
            };
            return (Outgoing::new(None, &message), seq, rx);
        }
        let snapshot = state.design.snapshot();
        let message = DesignMessage::Snapshot {
            snapshot: &snapshot,
            presence,
            epoch: &state.epoch,
        };
        (Outgoing::new(None, &message), seq, rx)
    }

    pub(super) fn publish(&self, state: &mut DesignState, actor: &Actor, change: &Change) {
        let message = DesignMessage::Change {
            change,
            actor_name: &actor.name,
        };
        let message = Outgoing::new(Some(change.seq), &message);
        state.recent.push(Kept {
            change: change.clone(),
            actor_name: actor.name.clone(),
            bytes: message.json.len(),
        });
        let _ = state.events.send(message);
        self.record(
            state,
            Record::Change {
                change: change.clone(),
            },
        );
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
        self.publish(state, actor, change);
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
        if state.pending.is_empty() && !state.needs_snapshot {
            return None;
        }
        let mut records = std::mem::take(&mut state.pending);
        // Edits bump `updated_at`, which no other record carries.
        records.push(Record::Meta {
            meta: state.design.meta.clone(),
        });
        state.journaled += records.len();
        if state.needs_snapshot || state.journaled > COMPACT_AFTER {
            state.needs_snapshot = false;
            state.journaled = 0;
            return Some(Save::Snapshot(state.snapshot_to_save()));
        }
        Some(Save::Append(state.design.meta.id.clone(), records))
    }

    /// After a failed write, the next save rewrites the snapshot so nothing is lost.
    pub(super) fn save_failed(&self) {
        if let Some(state) = self.raw().as_mut() {
            state.needs_snapshot = true;
        }
    }

    /// A full snapshot, with the pending records counted as saved. `None` when
    /// the design isn't loaded, which means it's already saved.
    pub(super) fn compact(&self) -> Option<Snapshot> {
        let mut state = self.raw();
        let state = state.as_mut()?;
        state.pending.clear();
        state.journaled = 0;
        state.needs_snapshot = false;
        Some(state.snapshot_to_save())
    }

    /// Builds ops from the current document with `build`, then commits them as
    /// one undo step for `actor`.
    pub fn edit<T>(
        &self,
        actor: &Actor,
        label: &str,
        build: impl FnOnce(&Document) -> Result<(Vec<Op>, T), EditError>,
    ) -> Result<Edited<T>, EditError> {
        let now = now_ms();
        let mut state = self.lock();
        state.touch(actor, now);
        let (ops, output) = build(state.design.doc())?;
        let change = state.design.commit(&actor.id, label, &ops, now);
        if let Some(change) = &change {
            self.publish_with_comments(&mut state, actor, change);
        }
        Ok((output, change))
    }

    pub fn undo(&self, actor: &Actor) -> Option<Change> {
        self.step(actor, Design::undo)
    }

    pub fn redo(&self, actor: &Actor) -> Option<Change> {
        self.step(actor, Design::redo)
    }

    pub(super) fn step(
        &self,
        actor: &Actor,
        f: fn(&mut Design, &str, u64) -> Option<Change>,
    ) -> Option<Change> {
        let now = now_ms();
        let mut state = self.lock();
        state.touch(actor, now);
        let change = f(&mut state.design, &actor.id, now)?;
        self.publish_with_comments(&mut state, actor, &change);
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
        body: &str,
    ) -> Result<Comment, CommentError> {
        self.update_comment(|design| {
            design.add_comment(author, anchor, body, &mut || random_id(8), now_ms())
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
        self.update_comment(|design| design.set_resolved(id, resolved))
    }

    /// Runs a comment update, then sends the whole comment to viewers.
    pub(super) fn update_comment(
        &self,
        f: impl FnOnce(&mut Design) -> Result<&Comment, CommentError>,
    ) -> Result<Comment, CommentError> {
        let mut state = self.lock();
        let comment = f(&mut state.design)?.clone();
        let message = DesignMessage::Comment { comment: &comment };
        let _ = state.events.send(Outgoing::new(None, &message));
        let record = Record::Comment {
            comment: comment.clone(),
        };
        self.record(&mut state, record);
        self.comments.notify_waiters();
        Ok(comment)
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
            },
        );
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
        if state.presence.remove(actor).is_some() {
            let _ = state.events.send(state.presence_message());
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
        let before = state.presence.len();
        state
            .presence
            .retain(|_, p| now.saturating_sub(p.updated_at) < ttl);
        if state.presence.len() != before {
            let _ = state.events.send(state.presence_message());
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
