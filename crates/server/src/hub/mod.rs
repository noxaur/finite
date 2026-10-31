//! The hub owns every live design. Each design sits behind its own lock, so
//! agents editing different designs never wait on each other, and edits to the
//! same design are applied one at a time in a single order that every viewer sees.
//!
//! - `messages.rs`: what goes out to viewers and the design list.
//! - `design.rs`: one design ([`DesignHandle`]) and everything that changes it.
//! - This file: [`Hub`], which finds, creates, loads, unloads, saves and hands
//!   off designs.

mod design;
mod messages;

use std::{
    collections::HashMap,
    io,
    sync::{Arc, RwLock, Weak},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use finite_design::{Design, DesignMeta, Snapshot};
use tokio::sync::{broadcast, watch};

use crate::{cluster::Cluster, store::Store};
pub use design::{DesignHandle, Edited, Since};
use design::{DesignState, Save};
pub use messages::{
    Actor, DesignMessage, DesignSummary, LobbyMessage, Missed, Outgoing, Presence, SESSION_ACTOR,
};

/// How long an agent's "working on" indicator lasts without activity.
const PRESENCE_TTL: Duration = Duration::from_secs(5 * 60);
/// How long an idle actor's undo history is kept.
const HISTORY_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// Edits are written to disk at most this often per design.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(250);
/// How long a failed save waits before its first retry. Each retry waits twice as long...
const RETRY_AFTER: Duration = Duration::from_secs(1);
/// ...up to this.
const RETRY_MAX: Duration = Duration::from_secs(60);
/// A design's journal is compacted into a fresh snapshot after this many records.
const COMPACT_AFTER: usize = 1000;
/// How long an unused design stays in memory before it's unloaded.
const UNLOAD_AFTER: Duration = Duration::from_secs(5 * 60);
/// How many recent changes a design keeps for viewers that reconnect...
const RESUME_LIMIT: usize = 256;
/// ...and how much they may add up to, as JSON.
const RESUME_BYTES: usize = 4 << 20;

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

/// Every design, plus the design list's subscribers.
///
/// Designs work like rooms in a multiplayer server: a design's state is
/// loaded the first time someone opens it and unloaded after it has sat
/// unused for `UNLOAD_AFTER` (five minutes), so memory grows with the designs in use, not
/// with every design ever made.
pub struct Hub {
    designs: RwLock<HashMap<String, Arc<DesignHandle>>>,
    store: Arc<dyn Store>,
    lobby: broadcast::Sender<Outgoing>,
    /// Which designs this server owns, when several run side by side.
    cluster: Cluster,
}

impl Hub {
    /// Indexes every stored design, one at a time, so startup never holds them
    /// all in memory. A design with a journal is compacted into a fresh
    /// snapshot. Must run inside a Tokio runtime: each design gets a
    /// background task that saves it after edits.
    pub fn new(store: Arc<dyn Store>) -> io::Result<Arc<Self>> {
        Self::with_cluster(store, Cluster::default())
    }

    /// Like [`Hub::new`], for one server among several. This server only
    /// creates and serves the designs `cluster` says it owns.
    pub fn with_cluster(store: Arc<dyn Store>, cluster: Cluster) -> io::Result<Arc<Self>> {
        let hub = Arc::new(Self {
            designs: RwLock::new(HashMap::new()),
            store,
            lobby: broadcast::channel(256).0,
            cluster,
        });
        let mut foreign = Vec::new();
        for id in hub.store.ids()? {
            if let Some(owner) = hub.cluster.elsewhere(&id) {
                tracing::info!(
                    id,
                    owner,
                    "another server owns this design now; handing it off"
                );
                foreign.push(id);
                continue;
            }
            let Some(stored) = hub.store.load(&id)? else {
                continue;
            };
            let state = DesignState::restore(stored);
            if state.needs_snapshot {
                hub.store.save(&state.design.snapshot_to_save())?;
            }
            hub.insert(DesignSummary::of(&state.design), None);
        }
        if !foreign.is_empty() {
            tokio::spawn(hand_off(Arc::downgrade(&hub), foreign));
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

    /// Opens a design from async code. A design that isn't in memory is read
    /// on Tokio's blocking pool, so a large design never stalls the requests
    /// sharing this worker thread. `None` if there's no such design or it
    /// can't be read.
    pub async fn open(&self, id: &str) -> Option<Arc<DesignHandle>> {
        let handle = self.designs.read().unwrap().get(id).cloned()?;
        // Holding a reference keeps the design from unloading from here on.
        let result = if handle.is_loaded() {
            handle.load()
        } else {
            let loading = handle.clone();
            tokio::task::spawn_blocking(move || loading.load())
                .await
                .unwrap_or_else(|e| Err(io::Error::other(e)))
        };
        match result {
            Ok(()) => Some(handle),
            Err(error) => {
                tracing::error!(id, %error, "failed to load design");
                None
            }
        }
    }

    /// A design's snapshot, for a one-off read like a thumbnail. A design in
    /// memory is read from there. A cold one is read from the store and not
    /// kept, so browsing the design list doesn't load every design.
    pub async fn peek(&self, id: &str) -> Option<Snapshot> {
        let handle = self.designs.read().unwrap().get(id).cloned()?;
        if let Some(snapshot) = handle.read_loaded(Design::snapshot) {
            return Some(snapshot);
        }
        let (store, key) = (self.store.clone(), id.to_owned());
        let read = tokio::task::spawn_blocking(move || store.load(&key)).await;
        match read.unwrap_or_else(|e| Err(io::Error::other(e))) {
            Ok(Some(stored)) => Some(DesignState::restore(stored).design.snapshot()),
            Ok(None) => None,
            Err(error) => {
                tracing::error!(id, %error, "failed to read design");
                None
            }
        }
    }

    /// Like [`Hub::open`], but reads a cold design on the calling thread.
    /// For tests and code that isn't async.
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

    pub fn cluster(&self) -> &Cluster {
        &self.cluster
    }

    /// The base URL of the server that owns `id`, if it isn't this one.
    pub fn elsewhere(&self, id: &str) -> Option<&str> {
        self.cluster.elsewhere(id)
    }

    pub fn create(self: &Arc<Self>, name: &str) -> DesignSummary {
        let now = now_ms();
        let name = finite_design::label::clip(name, finite_design::label::DESIGN_NAME);
        // Only ids this server owns, so the design is reachable where it's created.
        let id = std::iter::repeat_with(|| random_id(10))
            .find(|id| self.cluster.owns(id))
            .expect("some id hashes to this server");
        let design = Design::new(DesignMeta {
            id,
            name: if name.is_empty() {
                "Untitled".into()
            } else {
                name
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

    /// Takes over a design another server handed off, after the cluster
    /// changed. It's saved before this returns, so the sender can delete its
    /// copy as soon as it hears back.
    pub fn adopt(self: &Arc<Self>, snapshot: Snapshot) -> Result<DesignSummary, AdoptError> {
        let id = snapshot.meta.id.clone();
        if let Some(owner) = self.cluster.elsewhere(&id) {
            return Err(AdoptError::NotOwner(owner.to_owned()));
        }
        if self.designs.read().unwrap().contains_key(&id) {
            return Err(AdoptError::Exists);
        }
        self.store.save(&snapshot).map_err(AdoptError::Io)?;
        let design = Design::from_snapshot(snapshot);
        let summary = DesignSummary::of(&design);
        self.insert(summary.clone(), None);
        let _ = self.lobby.send(Outgoing::new(
            None,
            &LobbyMessage::Design { design: &summary },
        ));
        Ok(summary)
    }

    /// Sends one stored design to the server that owns it now, and deletes
    /// the local copy once that server has saved it.
    async fn hand_off_one(&self, http: &reqwest::Client, id: &str) -> Result<(), String> {
        let Some(owner) = self.cluster.elsewhere(id) else {
            return Ok(());
        };
        let store = self.store.clone();
        let key = id.to_owned();
        let stored = tokio::task::spawn_blocking(move || store.load(&key))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let Some(stored) = stored else { return Ok(()) };
        let snapshot = DesignState::restore(stored).design.snapshot_to_save();
        let res = http
            .put(format!("{owner}/api/designs/{id}/handoff"))
            .json(&snapshot)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        match res.status().as_u16() {
            201 => {
                self.store.remove(id).map_err(|e| e.to_string())?;
                tracing::info!(id, owner, "handed off design");
                Ok(())
            }
            409 => {
                // Never delete a copy the owner might not have; keep ours for a person to check.
                tracing::warn!(
                    id,
                    owner,
                    "the owner already has this design; keeping the local copy"
                );
                Ok(())
            }
            status => Err(format!("{owner} answered {status}")),
        }
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

/// Why [`Hub::adopt`] refused a design.
#[derive(Debug)]
pub enum AdoptError {
    /// Another server owns it; this is that server's base URL.
    NotOwner(String),
    /// This server already has a design with that id.
    Exists,
    Io(io::Error),
}

/// Hands off stored designs this server no longer owns, retrying every 30
/// seconds for any whose owner can't be reached yet.
async fn hand_off(hub: Weak<Hub>, mut ids: Vec<String>) {
    let http = reqwest::Client::new();
    loop {
        let Some(strong) = hub.upgrade() else { return };
        let mut left = Vec::new();
        for id in ids {
            if let Err(error) = strong.hand_off_one(&http, &id).await {
                tracing::warn!(id, error, "couldn't hand off design yet; will retry");
                left.push(id);
            }
        }
        drop(strong);
        if left.is_empty() {
            return;
        }
        ids = left;
        tokio::time::sleep(Duration::from_secs(30)).await;
    }
}

/// Saves a design shortly after it changes, then tells the design list.
/// Usually that appends the new records to its journal; every
/// [`COMPACT_AFTER`] records it writes a full snapshot instead. It holds the
/// design weakly, so it never keeps a design from unloading.
///
/// A failed write is retried with **exponential backoff**: after 1 second,
/// then 2, 4 and so on up to `RETRY_MAX`, until it succeeds or another edit
/// triggers a save sooner. The retry writes a full snapshot, so the records
/// of the failed append aren't lost.
async fn persist(hub: Weak<Hub>, design: Weak<DesignHandle>, mut dirty: watch::Receiver<()>) {
    let mut failures: u32 = 0;
    while dirty.changed().await.is_ok() {
        tokio::time::sleep(SAVE_DEBOUNCE).await;
        dirty.mark_unchanged();
        let retry = {
            let (Some(hub), Some(handle)) = (hub.upgrade(), design.upgrade()) else {
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
            let retry = match saved.map_err(io::Error::other) {
                Ok(Ok(())) => {
                    failures = 0;
                    None
                }
                Ok(Err(error)) | Err(error) => {
                    let wait = RETRY_AFTER
                        .saturating_mul(1 << failures.min(10))
                        .min(RETRY_MAX);
                    failures += 1;
                    tracing::error!(%error, ?wait, "failed to save design; will retry");
                    handle.save_failed();
                    Some(wait)
                }
            };
            let summary = handle.summary();
            let _ = hub.lobby.send(Outgoing::new(
                None,
                &LobbyMessage::Design { design: &summary },
            ));
            retry
        };
        // Wait without holding the design, then ask for another save.
        if let Some(wait) = retry {
            tokio::time::sleep(wait).await;
            let Some(handle) = design.upgrade() else {
                break;
            };
            handle.dirty.send_replace(());
        }
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use finite_design::comment::{Anchor, Author};

    use super::*;
    use crate::store::MemoryStore;
    use finite_design::comment::AuthorKind;

    /// Every viewer shows design names and statuses, so long ones are cut.
    #[tokio::test]
    async fn long_names_and_statuses_are_cut() {
        let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
        let long = "x".repeat(500);
        let summary = hub.create(&long);
        assert_eq!(summary.meta.name.len(), finite_design::label::DESIGN_NAME);
        let handle = hub.get(&summary.meta.id).unwrap();
        handle.rename("   ".into());
        assert_eq!(handle.summary().meta.name, "Untitled");
        let agent = Actor {
            id: "agent".into(),
            name: "Agent".into(),
        };
        handle.set_presence(&agent, Vec::new(), Some(long));
        let status = handle.presence()[0].status.clone().unwrap();
        assert_eq!(status.len(), finite_design::label::STATUS);
    }

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

    /// A viewer never sees a pin with nowhere to go: its new place arrives
    /// before the artboard goes, and is cleared only after it comes back.
    #[tokio::test]
    async fn pins_move_in_step_with_their_artboard() {
        use finite_design::edit::{self, NewArtboard};

        let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
        let handle = hub.get(&hub.create("Test").meta.id).unwrap();
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

        let (_, _, mut rx) = handle.subscribe();
        let mut sent = || -> Vec<(String, bool)> {
            std::iter::from_fn(|| rx.try_recv().ok())
                .map(|m| {
                    let v: serde_json::Value = serde_json::from_str(&m.json).unwrap();
                    let detached = !v["comment"]["detachedAt"].is_null();
                    (v["type"].as_str().unwrap().to_owned(), detached)
                })
                .collect()
        };
        handle
            .edit(&agent, "Delete", |doc| {
                Ok((edit::delete(doc, &["board".into()])?, ()))
            })
            .unwrap();
        assert_eq!(sent(), [("comment".into(), true), ("change".into(), false)]);
        handle.undo(&agent).unwrap();
        assert_eq!(
            sent(),
            [("change".into(), false), ("comment".into(), false)]
        );
    }

    /// A viewer that reconnects gets only what it missed, but a snapshot if
    /// it comes from another epoch or missed more than the server kept.
    #[tokio::test]
    async fn reconnecting_viewers_resume_where_they_left_off() {
        use finite_design::edit::{self, NewArtboard};

        let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
        let handle = hub.get(&hub.create("Test").meta.id).unwrap();
        let agent = Actor {
            id: "agent".into(),
            name: "Agent".into(),
        };
        let change = |n: usize| {
            handle
                .edit(&agent, "Rename", |doc| {
                    let ops = if n == 0 {
                        let spec = NewArtboard {
                            name: "Home".into(),
                            width: 100.0,
                            height: 100.0,
                            position: None,
                            styles: BTreeMap::new(),
                        };
                        edit::create_artboard(doc, "board".into(), spec)?
                    } else {
                        edit::rename(doc, "board", Some(&format!("Home {n}")))?
                    };
                    Ok((ops, ()))
                })
                .unwrap();
        };
        let first = |since: Option<&Since>| -> serde_json::Value {
            let (message, _, _) = handle.subscribe_from(since);
            serde_json::from_str(&message.json).unwrap()
        };
        let epoch = first(None)["epoch"].as_str().unwrap().to_owned();
        for n in 0..3 {
            change(n);
        }
        let since = |seq| Since {
            epoch: epoch.clone(),
            seq,
        };

        let resumed = first(Some(&since(1)));
        assert_eq!(resumed["type"], "resume");
        let seqs: Vec<_> = resumed["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["change"]["seq"].as_u64().unwrap())
            .collect();
        assert_eq!(seqs, [2, 3]);
        assert_eq!(first(Some(&since(3)))["changes"], serde_json::json!([]));

        // From another epoch, such as before a restart, or from the future.
        let other = Since {
            epoch: "other".into(),
            seq: 1,
        };
        assert_eq!(first(Some(&other))["type"], "snapshot");
        assert_eq!(first(Some(&since(9)))["type"], "snapshot");

        // Once more changes than the server keeps have gone by.
        for n in 3..RESUME_LIMIT + 4 {
            change(n);
        }
        assert_eq!(first(Some(&since(1)))["type"], "snapshot");
        assert_eq!(first(Some(&since(10)))["type"], "resume");
    }

    /// A store whose first `failures` writes fail, like a full disk that
    /// gets some room back.
    struct Flaky {
        inner: MemoryStore,
        failures: std::sync::atomic::AtomicUsize,
    }

    impl Flaky {
        fn write(&self) -> io::Result<()> {
            use std::sync::atomic::Ordering;
            let left = self.failures.load(Ordering::SeqCst);
            if left == 0 {
                return Ok(());
            }
            self.failures.store(left - 1, Ordering::SeqCst);
            Err(io::Error::other("disk full"))
        }
    }

    impl Store for Flaky {
        fn ids(&self) -> io::Result<Vec<String>> {
            self.inner.ids()
        }
        fn load(&self, id: &str) -> io::Result<Option<crate::store::Stored>> {
            self.inner.load(id)
        }
        fn save(&self, snapshot: &Snapshot) -> io::Result<()> {
            self.write()?;
            self.inner.save(snapshot)
        }
        fn append(&self, id: &str, records: &[finite_design::Record]) -> io::Result<()> {
            self.write()?;
            self.inner.append(id, records)
        }
        fn remove(&self, id: &str) -> io::Result<()> {
            self.inner.remove(id)
        }
    }

    /// A failed save is retried on its own, without waiting for another edit.
    #[tokio::test]
    async fn failed_saves_are_retried() {
        let store = Arc::new(Flaky {
            inner: MemoryStore::default(),
            failures: 2.into(),
        });
        let hub = Hub::new(store.clone()).unwrap();
        let id = hub.create("Test").meta.id;
        // Fails at once, then after 1 s, and succeeds after 2 s more.
        for _ in 0..50 {
            if store.inner.ids().unwrap().contains(&id) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("the design was never saved");
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

        // A one-off read, like a thumbnail's, doesn't load it.
        let peeked = hub.peek(&id).await.unwrap();
        assert_eq!(hub.loaded(), 0);
        assert_eq!((peeked.seq, &peeked.nodes), (before.seq, &before.nodes));

        // Reopening reads it back on the blocking pool.
        let after = hub.open(&id).await.unwrap().read(Design::snapshot);
        assert_eq!(hub.loaded(), 1);
        assert_eq!((after.seq, after.nodes), (before.seq, before.nodes));
    }

    #[tokio::test]
    async fn a_named_agent_can_undo_after_a_clean_restart() {
        use finite_design::edit::{self, NewArtboard};

        let store = Arc::new(MemoryStore::default());
        let hub = Hub::new(store.clone()).unwrap();
        let id = hub.create("Test").meta.id;
        let agent = Actor {
            id: "agent:Claude".into(),
            name: "Claude".into(),
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
        hub.flush();

        let restarted = Hub::new(store.clone()).unwrap();
        let handle = restarted.open(&id).await.unwrap();
        assert_eq!(handle.history(&agent).0, ["Create artboard"]);
        assert!(handle.undo(&agent).is_some());
        assert_eq!(handle.read(|d| d.doc().len()), 0);
    }

    /// An agent known only by its MCP session can't come back after a
    /// restart, so its history isn't restored and doesn't keep the design in memory.
    #[tokio::test]
    async fn session_only_histories_end_with_the_server() {
        use finite_design::edit;

        let store = Arc::new(MemoryStore::default());
        let hub = Hub::new(store.clone()).unwrap();
        let id = hub.create("Test").meta.id;
        let session = Actor {
            id: format!("{SESSION_ACTOR}abc"),
            name: "Claude · abc".into(),
        };
        let named = Actor {
            id: "agent:Claude".into(),
            name: "Claude".into(),
        };
        let handle = hub.get(&id).unwrap();
        for (actor, board) in [(&session, "one"), (&named, "two")] {
            handle
                .edit(actor, "Create artboard", |doc| {
                    let spec = edit::NewArtboard {
                        name: board.into(),
                        width: 100.0,
                        height: 100.0,
                        position: None,
                        styles: BTreeMap::new(),
                    };
                    Ok((edit::create_artboard(doc, board.into(), spec)?, ()))
                })
                .unwrap();
        }
        hub.flush();

        let restarted = Hub::new(store.clone()).unwrap();
        let handle = restarted.open(&id).await.unwrap();
        assert!(handle.history(&session).0.is_empty());
        assert_eq!(handle.history(&named).0, ["Create artboard"]);
    }

    /// After a crash, the edits since the last snapshot are only in the
    /// journal. Replaying it rebuilds the agent's undo history too.
    #[tokio::test]
    async fn a_named_agent_can_undo_after_a_crash() {
        use finite_design::edit;

        let store = Arc::new(MemoryStore::default());
        let hub = Hub::new(store.clone()).unwrap();
        let id = hub.create("Test").meta.id;
        let agent = Actor {
            id: "agent:Claude".into(),
            name: "Claude".into(),
        };
        // The new design's snapshot is saved first.
        tokio::time::sleep(SAVE_DEBOUNCE * 2).await;
        let handle = hub.get(&id).unwrap();
        handle
            .edit(&agent, "Create artboard", |doc| {
                let spec = edit::NewArtboard {
                    name: "Home".into(),
                    width: 100.0,
                    height: 100.0,
                    position: None,
                    styles: BTreeMap::new(),
                };
                Ok((edit::create_artboard(doc, "board".into(), spec)?, ()))
            })
            .unwrap();
        handle
            .edit(&agent, "Rename", |doc| {
                Ok((edit::rename(doc, "board", Some("Landing"))?, ()))
            })
            .unwrap();
        handle.undo(&agent).unwrap();
        // The save task appends those to the journal; then the server dies
        // without a final snapshot.
        tokio::time::sleep(SAVE_DEBOUNCE * 2).await;
        assert!(store.journal_len(&id) > 0);

        let restarted = Hub::new(store.clone()).unwrap();
        let handle = restarted.open(&id).await.unwrap();
        assert_eq!(
            handle.history(&agent),
            (vec!["Create artboard".into()], vec!["Rename".into()])
        );
        assert!(handle.redo(&agent).is_some());
        assert_eq!(
            handle.read(|d| d.doc().get("board").unwrap().name.clone()),
            Some("Landing".into())
        );
    }
}
