//! The hub owns every live design. Each design sits behind its own lock, so
//! agents editing different designs never wait on each other, and edits to the
//! same design are applied one at a time in a single order that every viewer sees.

use std::{
    collections::{BTreeMap, HashMap},
    io,
    ops::{Deref, DerefMut},
    sync::{Arc, Mutex, MutexGuard, RwLock, Weak},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use finite_design::{
    ActorId, Change, Design, DesignMeta, Document, NodeId, Op, Record, Snapshot,
    comment::{Anchor, Author, Comment, CommentError},
    edit::EditError,
};
use serde::Serialize;
use tokio::sync::{broadcast, watch};

use crate::store::{Store, Stored};

/// How long an agent's "working on" indicator lasts without activity.
const PRESENCE_TTL: Duration = Duration::from_secs(5 * 60);
/// How long an idle actor's undo history is kept.
const HISTORY_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// Edits are written to disk at most this often per design.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(250);
/// A design's journal is compacted into a fresh snapshot after this many records.
const COMPACT_AFTER: usize = 1000;
/// How long an unused design stays in memory before it's unloaded.
const UNLOAD_AFTER: Duration = Duration::from_secs(5 * 60);

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
}

/// A short random id: lowercase letters and digits.
pub fn random_id(len: usize) -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = String::with_capacity(len);
    while out.len() < len {
        for byte in uuid::Uuid::new_v4().into_bytes() {
            if out.len() == len {
                break;
            }
            out.push(ALPHABET[byte as usize % ALPHABET.len()] as char);
        }
    }
    out
}

/// Whoever is making a change, with a name to show in the UI.
#[derive(Clone, Debug, Serialize)]
pub struct Actor {
    pub id: ActorId,
    pub name: String,
}

/// Shows what an actor is working on, like an agent's indicator on an artboard.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub actor: ActorId,
    pub name: String,
    pub node_ids: Vec<NodeId>,
    pub status: Option<String>,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignSummary {
    #[serde(flatten)]
    pub meta: DesignMeta,
    pub seq: u64,
    pub artboard_count: usize,
    pub node_count: usize,
}

impl DesignSummary {
    fn of(design: &Design) -> Self {
        Self {
            meta: design.meta.clone(),
            seq: design.seq(),
            artboard_count: design.doc().artboards().len(),
            node_count: design.doc().len(),
        }
    }
}

/// Messages pushed to design viewers over WebSocket.
#[derive(Serialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum DesignMessage<'a> {
    Snapshot {
        snapshot: &'a Snapshot,
        presence: Vec<&'a Presence>,
    },
    Change {
        change: &'a Change,
        /// Display name of `change.actor`.
        actor_name: &'a str,
    },
    Presence {
        presence: Vec<&'a Presence>,
    },
    Meta {
        meta: &'a DesignMeta,
    },
    /// A comment was created or its thread changed. Replaces any comment with the same id.
    Comment {
        comment: &'a Comment,
    },
}

/// Messages pushed to the design list over WebSocket.
#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LobbyMessage<'a> {
    Designs { designs: &'a [DesignSummary] },
    Design { design: &'a DesignSummary },
}

/// A serialized message. `seq` is set for changes, so a subscriber can drop
/// the ones already included in the snapshot it started from.
#[derive(Clone, Debug)]
pub struct Outgoing {
    pub seq: Option<u64>,
    pub json: Arc<str>,
}

impl Outgoing {
    fn new(seq: Option<u64>, message: &impl Serialize) -> Self {
        let json = serde_json::to_string(message).expect("messages serialize");
        Self {
            seq,
            json: json.into(),
        }
    }
}

struct DesignState {
    design: Design,
    presence: BTreeMap<ActorId, Presence>,
    last_seen: HashMap<ActorId, u64>,
    /// Records not yet written to the store.
    pending: Vec<Record>,
    /// Records in the store's journal since the last snapshot.
    journaled: usize,
    /// Set when the next save must be a full snapshot: a new design, or a failed write.
    needs_snapshot: bool,
    /// When the design was last opened through [`Hub::get`].
    last_used: u64,
}

/// What the save task writes next.
enum Save {
    Snapshot(Snapshot),
    Append(String, Vec<Record>),
}

impl DesignState {
    fn new(design: Design, needs_snapshot: bool) -> Self {
        Self {
            design,
            presence: BTreeMap::new(),
            last_seen: HashMap::new(),
            pending: Vec::new(),
            journaled: 0,
            needs_snapshot,
            last_used: now_ms(),
        }
    }

    /// Rebuilds a stored design. A replayed journal is compacted on the next save.
    fn restore(stored: Stored) -> Self {
        let needs_snapshot = !stored.journal.is_empty();
        let mut design = Design::from_snapshot(stored.snapshot);
        for record in stored.journal {
            design.replay(record);
        }
        Self::new(design, needs_snapshot)
    }

    /// Whether the design can leave memory: nothing unsaved, and nobody with
    /// presence or undo history in it.
    fn is_idle(&self, now: u64) -> bool {
        self.pending.is_empty()
            && !self.needs_snapshot
            && self.presence.is_empty()
            && !self.design.has_histories()
            && now.saturating_sub(self.last_used) >= UNLOAD_AFTER.as_millis() as u64
    }

    fn presence_message(&self) -> Outgoing {
        let presence = self.presence.values().collect();
        Outgoing::new(None, &DesignMessage::Presence { presence })
    }

    fn touch(&mut self, actor: &Actor, now: u64) {
        self.last_seen.insert(actor.id.clone(), now);
        if let Some(p) = self.presence.get_mut(&actor.id) {
            p.updated_at = now;
        }
    }
}

/// One design. The hub keeps a handle for every design, but the state (the
/// document, comments and histories) is only in memory while the design is in
/// use: [`Hub::get`] loads it, and the hub's sweep unloads it once it's idle.
/// Every public method expects the state to be loaded, which holds for any
/// handle obtained from [`Hub::get`].
pub struct DesignHandle {
    id: String,
    store: Arc<dyn Store>,
    state: Mutex<Option<DesignState>>,
    /// Kept current while loaded, so the design list never loads a design.
    summary: Mutex<DesignSummary>,
    events: broadcast::Sender<Outgoing>,
    dirty: watch::Sender<()>,
}

/// A locked, loaded design state.
struct Loaded<'a>(MutexGuard<'a, Option<DesignState>>);

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
    fn new(store: Arc<dyn Store>, summary: DesignSummary, state: Option<DesignState>) -> Self {
        Self {
            id: summary.meta.id.clone(),
            store,
            state: Mutex::new(state),
            summary: Mutex::new(summary),
            events: broadcast::channel(1024).0,
            dirty: watch::channel(()).0,
        }
    }

    /// The state, loaded or not. Hub-wide passes (sweep, flush) use this.
    fn raw(&self) -> MutexGuard<'_, Option<DesignState>> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn lock(&self) -> Loaded<'_> {
        Loaded(self.raw())
    }

    /// Loads the state from the store if it isn't in memory.
    fn load(&self) -> io::Result<()> {
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
    fn unload_if_idle(&self, now: u64) -> bool {
        let mut state = self.raw();
        let idle = state.as_ref().is_some_and(|s| s.is_idle(now));
        if idle && self.events.receiver_count() == 0 {
            *state = None;
            return true;
        }
        false
    }

    fn is_loaded(&self) -> bool {
        self.raw().is_some()
    }

    pub fn read<T>(&self, f: impl FnOnce(&Design) -> T) -> T {
        f(&self.lock().design)
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
    pub fn subscribe(&self) -> (Outgoing, u64, broadcast::Receiver<Outgoing>) {
        // Subscribing under the lock means no change can slip between the snapshot and the stream.
        let state = self.lock();
        let rx = self.events.subscribe();
        let snapshot = state.design.snapshot();
        let presence = state.presence.values().collect();
        let message = Outgoing::new(
            None,
            &DesignMessage::Snapshot {
                snapshot: &snapshot,
                presence,
            },
        );
        (message, snapshot.seq, rx)
    }

    fn publish(&self, state: &mut DesignState, actor: &Actor, change: &Change) {
        let message = DesignMessage::Change {
            change,
            actor_name: &actor.name,
        };
        let _ = self.events.send(Outgoing::new(Some(change.seq), &message));
        self.record(
            state,
            Record::Change {
                change: change.clone(),
            },
        );
    }

    /// Queues `record` for the save task.
    fn record(&self, state: &mut DesignState, record: Record) {
        state.pending.push(record);
        *self.summary.lock().unwrap_or_else(|e| e.into_inner()) = DesignSummary::of(&state.design);
        self.dirty.send_replace(());
    }

    /// Takes what the save task should write: the pending records, or a full
    /// snapshot when one is due. `None` when there's nothing to save.
    fn take_save(&self) -> Option<Save> {
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
            return Some(Save::Snapshot(state.design.snapshot()));
        }
        Some(Save::Append(state.design.meta.id.clone(), records))
    }

    /// After a failed write, the next save rewrites the snapshot so nothing is lost.
    fn save_failed(&self) {
        if let Some(state) = self.raw().as_mut() {
            state.needs_snapshot = true;
        }
    }

    /// A full snapshot, with the pending records counted as saved. `None` when
    /// the design isn't loaded, which means it's already saved.
    fn compact(&self) -> Option<Snapshot> {
        let mut state = self.raw();
        let state = state.as_mut()?;
        state.pending.clear();
        state.journaled = 0;
        state.needs_snapshot = false;
        Some(state.design.snapshot())
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
            self.publish(&mut state, actor, change);
        }
        Ok((output, change))
    }

    pub fn undo(&self, actor: &Actor) -> Option<Change> {
        self.step(actor, Design::undo)
    }

    pub fn redo(&self, actor: &Actor) -> Option<Change> {
        self.step(actor, Design::redo)
    }

    fn step(
        &self,
        actor: &Actor,
        f: fn(&mut Design, &str, u64) -> Option<Change>,
    ) -> Option<Change> {
        let now = now_ms();
        let mut state = self.lock();
        state.touch(actor, now);
        let change = f(&mut state.design, &actor.id, now)?;
        self.publish(&mut state, actor, &change);
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
        let mut state = self.lock();
        state.design.meta.name = name;
        state.design.meta.updated_at = now_ms();
        let message = Outgoing::new(
            None,
            &DesignMessage::Meta {
                meta: &state.design.meta,
            },
        );
        let _ = self.events.send(message);
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
    fn update_comment(
        &self,
        f: impl FnOnce(&mut Design) -> Result<&Comment, CommentError>,
    ) -> Result<Comment, CommentError> {
        let mut state = self.lock();
        let comment = f(&mut state.design)?.clone();
        let message = DesignMessage::Comment { comment: &comment };
        let _ = self.events.send(Outgoing::new(None, &message));
        let record = Record::Comment {
            comment: comment.clone(),
        };
        self.record(&mut state, record);
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
                status,
                updated_at: now,
            },
        );
        let _ = self.events.send(state.presence_message());
    }

    pub fn clear_presence(&self, actor: &str) {
        let mut state = self.lock();
        if state.presence.remove(actor).is_some() {
            let _ = self.events.send(state.presence_message());
        }
    }

    fn forget(&self, actor: &str) {
        let mut state = self.raw();
        let Some(state) = state.as_mut() else { return };
        if state.presence.remove(actor).is_some() {
            let _ = self.events.send(state.presence_message());
        }
        state.design.forget_actor(actor);
        state.last_seen.remove(actor);
    }

    /// Expires stale presence and the histories of long-idle actors.
    fn sweep(&self, now: u64) {
        let mut state = self.raw();
        let Some(state) = state.as_mut() else { return };
        let ttl = PRESENCE_TTL.as_millis() as u64;
        let before = state.presence.len();
        state
            .presence
            .retain(|_, p| now.saturating_sub(p.updated_at) < ttl);
        if state.presence.len() != before {
            let _ = self.events.send(state.presence_message());
        }
        let ttl = HISTORY_TTL.as_millis() as u64;
        let idle: Vec<ActorId> = state
            .last_seen
            .iter()
            .filter(|(_, seen)| now.saturating_sub(**seen) >= ttl)
            .map(|(actor, _)| actor.clone())
            .collect();
        for actor in idle {
            state.design.forget_actor(&actor);
            state.last_seen.remove(&actor);
        }
    }
}

/// Every design, plus the design list's subscribers.
///
/// Designs work like rooms in a multiplayer server: a design's state is
/// loaded the first time someone opens it and unloaded after it has sat
/// unused for [`UNLOAD_AFTER`], so memory grows with the designs in use, not
/// with every design ever made.
pub struct Hub {
    designs: RwLock<HashMap<String, Arc<DesignHandle>>>,
    store: Arc<dyn Store>,
    lobby: broadcast::Sender<Outgoing>,
}

impl Hub {
    /// Indexes every stored design, one at a time, so startup never holds them
    /// all in memory. A design with a journal is compacted into a fresh
    /// snapshot. Must run inside a Tokio runtime: each design gets a
    /// background task that saves it after edits.
    pub fn new(store: Arc<dyn Store>) -> io::Result<Arc<Self>> {
        let hub = Arc::new(Self {
            designs: RwLock::new(HashMap::new()),
            store,
            lobby: broadcast::channel(256).0,
        });
        for id in hub.store.ids()? {
            let Some(stored) = hub.store.load(&id)? else {
                continue;
            };
            let state = DesignState::restore(stored);
            if state.needs_snapshot {
                hub.store.save(&state.design.snapshot())?;
            }
            hub.insert(DesignSummary::of(&state.design), None);
        }
        let weak = Arc::downgrade(&hub);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(30));
            loop {
                tick.tick().await;
                let Some(hub) = weak.upgrade() else { break };
                hub.sweep(now_ms());
            }
        });
        Ok(hub)
    }

    fn insert(
        self: &Arc<Self>,
        summary: DesignSummary,
        state: Option<DesignState>,
    ) -> Arc<DesignHandle> {
        let id = summary.meta.id.clone();
        let handle = Arc::new(DesignHandle::new(self.store.clone(), summary, state));
        self.designs.write().unwrap().insert(id, handle.clone());
        tokio::spawn(persist(
            Arc::downgrade(self),
            Arc::downgrade(&handle),
            handle.dirty.subscribe(),
        ));
        handle
    }

    fn handles(&self) -> Vec<Arc<DesignHandle>> {
        self.designs.read().unwrap().values().cloned().collect()
    }

    /// Opens a design, loading it from the store if it isn't in memory.
    /// `None` if there's no such design or it can't be read.
    pub fn get(&self, id: &str) -> Option<Arc<DesignHandle>> {
        let handle = self.designs.read().unwrap().get(id).cloned()?;
        match handle.load() {
            Ok(()) => Some(handle),
            Err(error) => {
                tracing::error!(id, %error, "failed to load design");
                None
            }
        }
    }

    /// How many designs are in memory right now.
    pub fn loaded(&self) -> usize {
        self.handles().iter().filter(|h| h.is_loaded()).count()
    }

    /// Every design, most recently edited first. Doesn't load any of them.
    pub fn list(&self) -> Vec<DesignSummary> {
        let mut designs: Vec<DesignSummary> = self.handles().iter().map(|h| h.summary()).collect();
        designs.sort_by_key(|d| std::cmp::Reverse(d.meta.updated_at));
        designs
    }

    pub fn create(self: &Arc<Self>, name: &str) -> DesignSummary {
        let now = now_ms();
        let name = name.trim();
        let design = Design::new(DesignMeta {
            id: random_id(10),
            name: if name.is_empty() {
                "Untitled".into()
            } else {
                name.into()
            },
            created_at: now,
            updated_at: now,
        });
        let summary = DesignSummary::of(&design);
        let handle = self.insert(summary.clone(), Some(DesignState::new(design, true)));
        handle.dirty.send_replace(());
        let _ = self.lobby.send(Outgoing::new(
            None,
            &LobbyMessage::Design { design: &summary },
        ));
        summary
    }

    pub fn subscribe_lobby(&self) -> (Outgoing, broadcast::Receiver<Outgoing>) {
        let rx = self.lobby.subscribe();
        let designs = self.list();
        (
            Outgoing::new(None, &LobbyMessage::Designs { designs: &designs }),
            rx,
        )
    }

    /// Drops an actor's presence and histories everywhere, when its session ends.
    pub fn forget_actor(&self, actor: &str) {
        for handle in self.handles() {
            handle.forget(actor);
        }
    }

    /// Expires stale presence and histories, then unloads idle designs.
    pub fn sweep(&self, now: u64) {
        for handle in self.handles() {
            handle.sweep(now);
        }
        // The write lock is the point: it stops `get` from handing out new
        // references, so a count of one means nobody else is using the handle.
        #[allow(clippy::readonly_write_lock)]
        let designs = self.designs.write().unwrap();
        for handle in designs.values() {
            if Arc::strong_count(handle) == 1 {
                handle.unload_if_idle(now);
            }
        }
    }

    /// Writes every loaded design to the store as a full snapshot. Called on shutdown.
    pub fn flush(&self) {
        for handle in self.handles() {
            let Some(snapshot) = handle.compact() else {
                continue;
            };
            if let Err(error) = self.store.save(&snapshot) {
                tracing::error!(id = snapshot.meta.id, %error, "failed to save design");
            }
        }
    }
}

/// Saves a design shortly after it changes, then tells the design list.
/// Usually that appends the new records to its journal; every
/// [`COMPACT_AFTER`] records it writes a full snapshot instead. It holds the
/// design weakly, so it never keeps a design from unloading.
async fn persist(hub: Weak<Hub>, handle: Weak<DesignHandle>, mut dirty: watch::Receiver<()>) {
    while dirty.changed().await.is_ok() {
        tokio::time::sleep(SAVE_DEBOUNCE).await;
        dirty.mark_unchanged();
        let (Some(hub), Some(handle)) = (hub.upgrade(), handle.upgrade()) else {
            break;
        };
        let Some(save) = handle.take_save() else {
            continue;
        };
        let store = hub.store.clone();
        let saved = tokio::task::spawn_blocking(move || match save {
            Save::Snapshot(snapshot) => store.save(&snapshot),
            Save::Append(id, records) => store.append(&id, &records),
        })
        .await;
        if let Ok(Err(error)) | Err(error) = saved.map_err(io::Error::other) {
            tracing::error!(%error, "failed to save design");
            handle.save_failed();
        }
        let summary = handle.summary();
        let _ = hub.lobby.send(Outgoing::new(
            None,
            &LobbyMessage::Design { design: &summary },
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::MemoryStore;
    use finite_design::comment::AuthorKind;

    #[tokio::test]
    async fn comment_updates_reach_viewers() {
        let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
        let handle = hub.get(&hub.create("Test").meta.id).unwrap();
        let (_, _, mut rx) = handle.subscribe();
        let author = Author {
            id: "user:1".into(),
            name: "Guest".into(),
            kind: AuthorKind::User,
        };
        let anchor = Anchor {
            artboard_id: None,
            node_id: None,
            x: 1.0,
            y: 2.0,
        };
        let comment = handle.add_comment(author, anchor, "Hello").unwrap();
        let message: serde_json::Value =
            serde_json::from_str(&rx.try_recv().unwrap().json).unwrap();
        assert_eq!(message["type"], "comment");
        assert_eq!(message["comment"]["id"], comment.id.as_str());
    }

    #[tokio::test]
    async fn edits_are_journaled_and_survive_a_restart() {
        use finite_design::edit::{self, NewArtboard};

        let store = Arc::new(MemoryStore::default());
        let hub = Hub::new(store.clone()).unwrap();
        let id = hub.create("Test").meta.id;
        let handle = hub.get(&id).unwrap();
        let settle = || tokio::time::sleep(SAVE_DEBOUNCE * 2);
        settle().await;
        assert_eq!(
            store.journal_len(&id),
            0,
            "a new design starts as a snapshot"
        );

        let agent = Actor {
            id: "agent".into(),
            name: "Agent".into(),
        };
        handle
            .edit(&agent, "Create artboard", |doc| {
                let spec = NewArtboard {
                    name: "Home".into(),
                    width: 100.0,
                    height: 100.0,
                    position: None,
                    styles: BTreeMap::new(),
                };
                Ok((edit::create_artboard(doc, "board".into(), spec)?, ()))
            })
            .unwrap();
        let author = Author {
            id: "user:1".into(),
            name: "Guest".into(),
            kind: AuthorKind::User,
        };
        let anchor = Anchor {
            artboard_id: Some("board".into()),
            node_id: None,
            x: 1.0,
            y: 2.0,
        };
        handle.add_comment(author, anchor, "Hello").unwrap();
        handle.rename("Renamed".into());
        settle().await;
        assert!(
            store.journal_len(&id) > 0,
            "edits are appended, not rewritten"
        );

        let before = handle.read(Design::snapshot);
        let restarted = Hub::new(store.clone()).unwrap();
        let after = restarted.get(&id).unwrap().read(Design::snapshot);
        assert_eq!(after.seq, before.seq);
        assert_eq!(after.nodes, before.nodes);
        assert_eq!(after.comments, before.comments);
        assert_eq!(after.meta, before.meta);
        assert_eq!(store.journal_len(&id), 0, "loading compacts the journal");
    }

    #[tokio::test]
    async fn idle_designs_unload_and_reload() {
        use finite_design::edit::{self, NewArtboard};

        let store = Arc::new(MemoryStore::default());
        let hub = Hub::new(store.clone()).unwrap();
        let id = hub.create("Test").meta.id;
        let agent = Actor {
            id: "agent".into(),
            name: "Agent".into(),
        };
        hub.get(&id)
            .unwrap()
            .edit(&agent, "Create artboard", |doc| {
                let spec = NewArtboard {
                    name: "Home".into(),
                    width: 100.0,
                    height: 100.0,
                    position: None,
                    styles: BTreeMap::new(),
                };
                Ok((edit::create_artboard(doc, "board".into(), spec)?, ()))
            })
            .unwrap();
        let before = hub.get(&id).unwrap().read(Design::snapshot);
        tokio::time::sleep(SAVE_DEBOUNCE * 2).await;
        let later = now_ms() + UNLOAD_AFTER.as_millis() as u64;

        // The agent can still undo, so the design stays in memory.
        hub.sweep(later);
        assert_eq!(hub.loaded(), 1);

        // So does a design someone is watching.
        hub.forget_actor("agent");
        let viewer = hub.get(&id).unwrap().subscribe();
        hub.sweep(later + 1);
        assert_eq!(hub.loaded(), 1);
        drop(viewer);

        hub.sweep(now_ms() + UNLOAD_AFTER.as_millis() as u64);
        assert_eq!(hub.loaded(), 0);
        // The design list still knows it without loading it.
        assert_eq!(hub.list()[0].artboard_count, 1);
        assert_eq!(hub.loaded(), 0);

        let after = hub.get(&id).unwrap().read(Design::snapshot);
        assert_eq!(hub.loaded(), 1);
        assert_eq!((after.seq, after.nodes), (before.seq, before.nodes));
    }
}
