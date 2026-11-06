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
    collections::{BTreeSet, HashMap},
    io,
    sync::{Arc, OnceLock, RwLock, Weak},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use finite_design::{Design, DesignMeta, Snapshot, version};
use tokio::sync::{broadcast, watch};

use crate::{
    blob::BlobHash,
    cluster::{Cluster, Lease, Members, Place},
    config::Settings,
    id::{is_stored_id, random_id},
    store::{Claim, Refusal, Registry, Store, Token},
};
pub use design::{DesignHandle, Edited, Since};
use design::{DesignState, Life, Save};
pub use messages::{
    Actor, ClientMessage, DesignMessage, DesignSummary, Listener, LobbyMessage, Missed, Outgoing,
    Presence, Stamp, UserAuthor,
};

/// How long an agent's "working on" indicator lasts without activity.
const PRESENCE_TTL: Duration = Duration::from_secs(5 * 60);
/// How long an indicator an edit set lasts after the actor's last edit. The
/// hub sweeps every 30 seconds, so it goes within 60 to 90 seconds.
const AUTO_PRESENCE_TTL: Duration = Duration::from_secs(60);
/// The most nodes one actor's indicator names.
pub(crate) const PRESENCE_NODES: usize = 100;
/// How long an idle actor's undo history is kept.
const HISTORY_TTL: Duration = Duration::from_secs(6 * 60 * 60);
/// Edits are written to disk at most this often per design.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(250);
/// How long a failed save waits before its first retry. Each retry waits twice as long...
const RETRY_AFTER: Duration = Duration::from_secs(1);
/// ...up to this.
const RETRY_MAX: Duration = Duration::from_secs(60);
/// A design's journal is compacted into a fresh snapshot after this many records...
const COMPACT_AFTER: usize = 1000;
/// ...or once its changes add up to this many bytes. One `write_html` can be
/// tens of MB of ops, so a count alone could let a journal reach gigabytes,
/// all of it read back when the design loads.
const COMPACT_BYTES: usize = 16 << 20;
/// How long an unused design stays in memory before it's unloaded.
const UNLOAD_AFTER: Duration = Duration::from_secs(5 * 60);
/// How many designs the design list's socket starts with. With more, the
/// page offers a search.
pub const LOBBY_LIMIT: usize = 200;
/// How many messages a slow viewer can fall behind before it gets a fresh snapshot.
const EVENT_BUFFER: usize = 1024;
/// How many recent changes a design keeps for viewers that reconnect...
const RESUME_LIMIT: usize = 256;
/// ...and how much they may add up to, as JSON.
const RESUME_BYTES: usize = 4 << 20;

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as u64)
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
    members: Arc<Members>,
    /// Set when this server shares its store with others.
    shared: Option<Shared>,
    /// What the operator configured, set once by [`Hub::configure`].
    settings: OnceLock<Settings>,
}

/// What a server sharing its store needs: where it records its heartbeat,
/// the URL others reach it at, and how long a heartbeat counts.
struct Shared {
    registry: Arc<dyn Registry>,
    me: String,
    lease: Lease,
    /// When the hub last looked for designs it owns but doesn't know yet.
    scanned: std::sync::Mutex<Instant>,
    /// Set by [`Hub::flush`] at shutdown, so the server doesn't join again.
    stopped: std::sync::atomic::AtomicBool,
}

/// How often a server sharing its store looks for designs it owns but
/// doesn't know yet, like ones another server created under an older list.
const RESCAN_EVERY: Duration = Duration::from_secs(30);

/// Why [`Hub::open`] couldn't open a design.
#[derive(Debug)]
pub enum OpenError {
    NotFound,
    /// Another server owns the design. Its base URL is `owner`.
    Elsewhere {
        id: String,
        owner: String,
    },
    /// No server is serving designs right now.
    Nowhere,
    /// Another server still holds it, while it moves here. Try again shortly.
    Busy(String),
    Failed(io::Error),
}

impl std::fmt::Display for OpenError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound => f.write_str("design not found"),
            Self::Elsewhere { id, owner } => {
                write!(f, "design {id:?} lives on another Finite server: {owner}")
            }
            Self::Nowhere => f.write_str(crate::wire::NO_SERVER),
            Self::Busy(holder) if holder.is_empty() => {
                f.write_str("the design is moving between servers; try again in a few seconds")
            }
            Self::Busy(holder) => write!(
                f,
                "the design is moving here from {holder}; try again in a few seconds"
            ),
            Self::Failed(error) => write!(f, "couldn't load the design: {error}"),
        }
    }
}

/// Gives up a lease. A failure is only logged: the lease lapses by itself.
pub(super) fn release_lease(store: &dyn Store, id: &str, token: Token) {
    if let Err(error) = store.release(id, token) {
        tracing::warn!(id, %error, "couldn't release a lease");
    }
}

impl Hub {
    /// Indexes every stored design, one at a time, so startup never holds them
    /// all in memory. A design with a journal is compacted into a fresh
    /// snapshot. Must run inside a Tokio runtime: each design gets a
    /// background task that saves it after edits.
    pub fn new(store: Arc<dyn Store>) -> io::Result<Arc<Self>> {
        Self::with_cluster(store, Cluster::default())
    }

    /// Like [`Hub::new`], for one server among several with a fixed list
    /// (`FINITE_NODES`), each with its own store. This server only creates
    /// and serves the designs `cluster` says it owns, and hands the others
    /// off to their owners.
    pub fn with_cluster(store: Arc<dyn Store>, cluster: Cluster) -> io::Result<Arc<Self>> {
        let hub = Self::build(store, Members::fixed(cluster), None);
        let cluster = hub.cluster();
        let (foreign, own): (Vec<String>, Vec<String>) = hub
            .store
            .ids()?
            .into_iter()
            .partition(|id| cluster.elsewhere(id).is_some());
        for id in &foreign {
            let owner = cluster.elsewhere(id);
            tracing::info!(
                id,
                owner,
                "another server owns this design now; handing it off"
            );
        }
        for summary in summaries(hub.store.as_ref(), &own, false)? {
            hub.insert(summary, None);
        }
        if !foreign.is_empty() {
            tokio::spawn(hand_off(Arc::downgrade(&hub), foreign));
        }
        Ok(hub)
    }

    /// One server among several that share `store`. The server at `me`
    /// heartbeats in `registry`, and owns the designs that rendezvous
    /// hashing gives it among the live servers. Every `lease / 5` it renews
    /// its heartbeat and reads the list again. Then it lets go of designs
    /// another server owns now, and picks up the ones it owns.
    pub fn shared(
        store: Arc<dyn Store>,
        registry: Arc<dyn Registry>,
        me: &str,
        lease: Lease,
    ) -> io::Result<Arc<Self>> {
        let started = Instant::now();
        let joined = registry.heartbeat();
        if let Err(error) = &joined {
            tracing::warn!(%error, "couldn't join the cluster yet; will keep trying");
        }
        let members = Members::heartbeating(Cluster::live(registry.live()?, me), lease);
        if joined.is_err() {
            members.renewed(started.checked_sub(lease.0).unwrap_or(started));
        }
        let shared = Shared {
            registry,
            me: me.to_owned(),
            lease,
            scanned: std::sync::Mutex::new(Instant::now()),
            stopped: false.into(),
        };
        let hub = Self::build(store, members, Some(shared));
        let cluster = hub.cluster();
        let own: Vec<String> = hub
            .store
            .ids()?
            .into_iter()
            .filter(|id| cluster.owns(id))
            .collect();
        for summary in summaries(hub.store.as_ref(), &own, true)? {
            hub.insert(summary, None);
        }
        let weak = Arc::downgrade(&hub);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(lease.every());
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tick.tick().await;
                let Some(hub) = weak.upgrade() else { break };
                let _ = tokio::task::spawn_blocking(move || hub.tick()).await;
            }
        });
        Ok(hub)
    }

    fn build(store: Arc<dyn Store>, members: Members, shared: Option<Shared>) -> Arc<Self> {
        let hub = Arc::new(Self {
            designs: RwLock::new(HashMap::new()),
            store,
            lobby: broadcast::channel(256).0,
            members: Arc::new(members),
            shared,
            settings: OnceLock::new(),
        });
        let weak = Arc::downgrade(&hub);
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_secs(30));
            loop {
                tick.tick().await;
                let Some(hub) = weak.upgrade() else { break };
                hub.sweep(now_ms());
            }
        });
        hub
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

    /// The handle for `id`. With a shared store, a design this server owns
    /// but doesn't know yet, say one another server just let go, is looked
    /// up in the store.
    async fn handle_for(self: &Arc<Self>, id: &str) -> Option<Arc<DesignHandle>> {
        if let Some(handle) = self.designs.read().unwrap().get(id).cloned() {
            return Some(handle);
        }
        if self.shared.is_none() || !self.cluster().owns(id) || !is_stored_id(id) {
            return None;
        }
        let hub = self.clone();
        let ids = vec![id.to_owned()];
        tokio::task::spawn_blocking(move || hub.discover(&ids))
            .await
            .ok()?;
        self.designs.read().unwrap().get(id).cloned()
    }

    /// Opens a design from async code. A design that isn't in memory is read
    /// on Tokio's blocking pool, so a large design never stalls the requests
    /// sharing this worker thread.
    ///
    /// With a shared store, a design that's moving here may still be held by
    /// its last owner for a moment, while it saves its last snapshot. Then
    /// this waits, up to one lease, for the lease to be released.
    ///
    /// A design another server owns is refused with [`OpenError::Elsewhere`],
    /// so a route can't serve one by forgetting to check.
    pub async fn open(self: &Arc<Self>, id: &str) -> Result<Arc<DesignHandle>, OpenError> {
        self.require_here(id)?;
        let wait = self.shared.as_ref().map_or(Duration::ZERO, |s| s.lease.0);
        let deadline = tokio::time::Instant::now() + wait;
        loop {
            let handle = self.handle_for(id).await.ok_or(OpenError::NotFound)?;
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
                Ok(()) => return Ok(handle),
                Err(error) if matches!(Refusal::of(&error), Some(Refusal::Held(_))) => {
                    if tokio::time::Instant::now() >= deadline {
                        let Some(Refusal::Held(holder)) = Refusal::of(&error) else {
                            unreachable!("matched above")
                        };
                        return Err(OpenError::Busy(holder.clone()));
                    }
                    tokio::time::sleep(Duration::from_millis(100)).await;
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    return Err(OpenError::NotFound);
                }
                Err(error) => {
                    tracing::error!(id, %error, "failed to load design");
                    return Err(OpenError::Failed(error));
                }
            }
        }
    }

    /// A design's snapshot, for a one-off read like a thumbnail. A design in
    /// memory is read from there. A cold one is read from the store and not
    /// kept, so browsing the design list doesn't load every design.
    pub async fn peek(&self, id: &str) -> Result<Snapshot, OpenError> {
        self.require_here(id)?;
        self.peek_here(id).await.ok_or(OpenError::NotFound)
    }

    async fn peek_here(&self, id: &str) -> Option<Snapshot> {
        let handle = self.designs.read().unwrap().get(id).cloned();
        if let Some(snapshot) = handle
            .as_ref()
            .and_then(|h| h.read_loaded(Design::snapshot))
        {
            return Some(snapshot);
        }
        let shared_and_mine = self.shared.is_some() && self.cluster().owns(id);
        if handle.is_none() && !(shared_and_mine && is_stored_id(id)) {
            return None;
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

    /// Like [`Hub::open`] without the ownership check, but reads a cold design
    /// on the calling thread. For tests and code that isn't async.
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

    /// The store designs and blobs persist in.
    pub fn store(&self) -> Arc<dyn Store> {
        self.store.clone()
    }

    /// The servers as this one sees them now.
    pub fn cluster(&self) -> Arc<Cluster> {
        self.members.now()
    }

    /// Applies the operator's settings. Call once, before serving; a hub
    /// without them uses the defaults.
    pub fn configure(&self, settings: Settings) {
        assert!(
            self.settings.set(settings).is_ok(),
            "the hub was configured twice"
        );
    }

    fn settings(&self) -> &Settings {
        self.settings.get_or_init(Settings::default)
    }

    /// How long an edit waits for its layout check before it answers without one.
    pub fn layout_wait(&self) -> Duration {
        self.settings().layout_wait
    }

    /// The `Host` values this server accepts (see [`Cluster::allowed_hosts`]),
    /// including its own URL when it shares a store.
    pub fn allowed_hosts(&self) -> Vec<String> {
        let mut nodes = self.cluster().nodes().to_vec();
        if let Some(shared) = &self.shared {
            nodes.push(shared.me.clone());
        }
        Cluster::observer(nodes).allowed_hosts(&self.settings().allowed_hosts)
    }

    /// Refuses a design another server owns, or that no server can serve now.
    pub fn require_here(&self, id: &str) -> Result<(), OpenError> {
        match self.cluster().place(id) {
            Place::Here => Ok(()),
            Place::Elsewhere(owner) => Err(OpenError::Elsewhere {
                id: id.into(),
                owner,
            }),
            Place::Nowhere => Err(OpenError::Nowhere),
        }
    }

    /// The base URL of the server that owns `id`, if it isn't this one.
    pub fn elsewhere(&self, id: &str) -> Option<String> {
        self.cluster().elsewhere(id).map(String::from)
    }

    /// [`Hub::try_create`] for tests and code that has no way to fail: it
    /// panics where that would return an error. Routes use `try_create`.
    pub fn create(self: &Arc<Self>, name: &str) -> DesignSummary {
        self.try_create(name).expect("the design was created")
    }

    /// Creates an empty design with an id this server owns. Fails if the
    /// store can't be reached, or this server isn't in the cluster right now.
    pub fn try_create(self: &Arc<Self>, name: &str) -> io::Result<DesignSummary> {
        let cluster = self.cluster();
        if !cluster.has_me() {
            return Err(io::Error::other(
                "this server isn't in the cluster right now",
            ));
        }
        let now = now_ms();
        let name = finite_design::label::clip(name, finite_design::label::DESIGN_NAME);
        let name = if name.is_empty() {
            "Untitled".into()
        } else {
            name
        };
        let candidates = std::iter::repeat_with(|| random_id(finite_design::id::DESIGN_LEN));
        // The store refuses an id another server already used.
        for id in self.fresh_ids(&cluster, candidates).take(100) {
            let design = Design::new(DesignMeta {
                id,
                name: name.clone(),
                created_at: now,
                updated_at: now,
            });
            let Some(token) = self.store.create(&design.snapshot_to_save())? else {
                continue;
            };
            let summary = DesignSummary::of(&design);
            let mut state = DesignState::new(design, true);
            state.token = token;
            let handle = self.insert(summary.clone(), Some(state));
            handle.dirty.send_replace(());
            let _ = self.lobby.send(Outgoing::new(
                None,
                &LobbyMessage::Design { design: &summary },
            ));
            return Ok(summary);
        }
        Err(io::Error::other("couldn't find a free design id"))
    }

    pub fn delete(&self, handle: &Arc<DesignHandle>) -> io::Result<()> {
        handle.delete()?;
        self.remove(handle);
        let (message, _) = self.subscribe_lobby();
        let _ = self.lobby.send(message);
        Ok(())
    }

    /// The `candidates` that this server owns, so the design is reachable
    /// where it's created, and that no design here has yet. A repeat would
    /// replace that design, in memory and on disk. With 36¹⁰ possible ids,
    /// the chance is tiny but grows with the number of designs.
    fn fresh_ids<'a>(
        &'a self,
        cluster: &'a Cluster,
        candidates: impl Iterator<Item = String> + 'a,
    ) -> impl Iterator<Item = String> + 'a {
        candidates
            .filter(move |id| cluster.owns(id) && !self.designs.read().unwrap().contains_key(id))
    }

    #[cfg(test)]
    fn fresh_id(&self, candidates: impl Iterator<Item = String>) -> String {
        let cluster = self.cluster();
        self.fresh_ids(&cluster, candidates)
            .next()
            .expect("some id is free and hashes to this server")
    }

    /// The design list's socket: the newest `LOBBY_LIMIT` designs and the
    /// total, then each design's updates.
    pub fn subscribe_lobby(&self) -> (Outgoing, broadcast::Receiver<Outgoing>) {
        let rx = self.lobby.subscribe();
        let mut designs = self.list();
        let total = designs.len();
        designs.truncate(LOBBY_LIMIT);
        let message = LobbyMessage::Designs {
            designs: &designs,
            total,
        };
        (Outgoing::new(None, &message), rx)
    }

    /// Designs whose name contains `query` (ignoring case), newest first, at
    /// most `limit` of them. The design list's search and `list_designs` use it.
    pub fn find(&self, query: Option<&str>, limit: usize) -> Vec<DesignSummary> {
        let query = query.map(str::to_lowercase);
        let mut designs = self.list();
        if let Some(query) = query.filter(|q| !q.is_empty()) {
            designs.retain(|d| d.meta.name.to_lowercase().contains(&query));
        }
        designs.truncate(limit);
        designs
    }

    /// Takes over a design another server handed off, after the cluster
    /// changed. It's saved before this returns, so the sender can delete its
    /// copy as soon as it hears back.
    pub fn adopt(self: &Arc<Self>, snapshot: Snapshot) -> Result<DesignSummary, AdoptError> {
        let id = snapshot.meta.id.clone();
        if self.shared.is_some() {
            return Err(AdoptError::Shared);
        }
        if let Some(owner) = self.elsewhere(&id) {
            return Err(AdoptError::NotOwner(owner));
        }
        if self.designs.read().unwrap().contains_key(&id) {
            return Err(AdoptError::Exists);
        }
        self.store.save(&snapshot, 0).map_err(AdoptError::Io)?;
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
    /// the local copy once that server has saved it. The blobs its imports
    /// point at go first, so the new owner never has a record without its
    /// bytes. A blob that fails fails the handoff, and the local copy stays.
    async fn hand_off_one(&self, http: &reqwest::Client, id: &str) -> Result<(), String> {
        let Some(owner) = self.elsewhere(id) else {
            return Ok(());
        };
        let store = self.store.clone();
        let key = id.to_owned();
        let stored = tokio::task::spawn_blocking(move || store.load(&key))
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let Some(stored) = stored else { return Ok(()) };
        let snapshot = DesignState::restore(stored).snapshot_to_save();
        for hash in referenced_blobs(&snapshot) {
            let store = self.store.clone();
            let key = hash.clone();
            let bytes = tokio::task::spawn_blocking(move || store.get_blob(&key))
                .await
                .map_err(|e| e.to_string())?
                .map_err(|e| e.to_string())?;
            let Some(bytes) = bytes else { continue };
            let res = http
                .put(format!("{owner}/api/designs/{id}/assets/{hash}"))
                .body(bytes)
                .send()
                .await
                .map_err(|e| e.to_string())?;
            if !res.status().is_success() {
                return Err(format!("{owner} answered {} for blob {hash}", res.status()));
            }
        }
        let body = version::SNAPSHOT
            .encode(&snapshot)
            .map_err(|e| e.to_string())?;
        let res = http
            .put(format!("{owner}/api/designs/{id}/handoff"))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        match res.status().as_u16() {
            201 => {
                // Deleting takes the lease first, like any other write.
                match self.store.claim(id).map_err(|e| e.to_string())? {
                    Claim::Granted(token) => {
                        self.store.delete(id, token).map_err(|e| e.to_string())?;
                    }
                    Claim::Held(holder) => return Err(format!("{holder} holds the design")),
                    Claim::Missing => {}
                }
                tracing::info!(id, owner, "handed off design");
                Ok(())
            }
            409 => {
                // Never delete a copy the owner might not have; keep ours for a person to check.
                let reason = res.text().await.unwrap_or_default();
                tracing::warn!(
                    id,
                    owner,
                    reason,
                    "the owner didn't take this design; keeping the local copy"
                );
                Ok(())
            }
            status => Err(format!("{owner} answered {status}")),
        }
    }

    /// One round of membership, for a server sharing its store. It runs
    /// every `lease / 5`:
    ///
    /// 1. Renew this server's heartbeat, and read which servers are live.
    /// 2. Let go of every design another server owns now. After this
    ///    server's own lease lapsed, let go of every design: others may have
    ///    changed them meanwhile, so the copies here may be out of date.
    /// 3. Release leases this server holds on designs it neither owns nor
    ///    has loaded, and drop any loaded copy whose lease another server took.
    /// 4. Pick up designs this server owns but doesn't know yet.
    fn tick(self: &Arc<Self>) {
        let Some(shared) = &self.shared else { return };
        if shared.stopped.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let lapsed = self.members.lapsed();
        let started = Instant::now();
        match shared.registry.heartbeat() {
            Ok(()) => self.members.renewed(started),
            Err(error) => tracing::warn!(%error, "couldn't renew this server's heartbeat"),
        }
        let changed = match shared.registry.live() {
            Ok(live) => self.members.set(Cluster::live(live, &shared.me)),
            Err(error) => {
                tracing::warn!(%error, "couldn't read the list of servers");
                false
            }
        };
        let cluster = self.cluster();
        if changed {
            tracing::info!(servers = ?cluster.nodes(), "the servers changed");
        }
        if lapsed {
            tracing::warn!("this server's heartbeat lapsed; reloading every design from the store");
        }
        let handles: Vec<(String, Arc<DesignHandle>)> = self
            .designs
            .read()
            .unwrap()
            .iter()
            .map(|(id, h)| (id.clone(), h.clone()))
            .collect();
        for (id, handle) in &handles {
            if lapsed || !cluster.owns(id) {
                self.let_go(id, handle);
            }
        }

        // Which leases this server should hold, read before asking the store
        // which it does. A design loaded after this isn't checked this round.
        let loaded: HashMap<&str, (Token, Life)> = handles
            .iter()
            .filter_map(|(id, h)| Some((id.as_str(), h.lease()?)))
            .filter(|(_, (_, life))| *life != Life::Gone)
            .collect();
        match self.store.held() {
            Ok(held) => {
                let held: HashMap<String, Token> = held.into_iter().collect();
                for (id, token) in &held {
                    if !cluster.owns(id) && !loaded.contains_key(id.as_str()) {
                        release_lease(&*self.store, id, *token);
                    }
                }
                for (id, handle) in &handles {
                    if let Some((token, Life::Live)) = loaded.get(id.as_str())
                        && held.get(id) != Some(token)
                    {
                        tracing::warn!(
                            id,
                            "another server took over this design; dropping the copy here"
                        );
                        self.drop_copy(handle);
                    }
                }
            }
            Err(error) => tracing::warn!(%error, "couldn't read this server's leases"),
        }

        let due = shared.scanned.lock().unwrap().elapsed() >= RESCAN_EVERY;
        if changed || due {
            *shared.scanned.lock().unwrap() = Instant::now();
            match self.store.ids() {
                Ok(ids) => {
                    let new: Vec<String> = {
                        let designs = self.designs.read().unwrap();
                        ids.into_iter()
                            .filter(|id| cluster.owns(id) && !designs.contains_key(id))
                            .collect()
                    };
                    self.discover(&new);
                }
                Err(error) => tracing::warn!(%error, "couldn't list the stored designs"),
            }
        }
    }

    /// Adds designs from the store to this server's list, without loading
    /// them, and tells the design list.
    fn discover(self: &Arc<Self>, ids: &[String]) {
        if ids.is_empty() {
            return;
        }
        match summaries(self.store.as_ref(), ids, true) {
            Ok(found) => {
                for summary in found {
                    if self.designs.read().unwrap().contains_key(&summary.meta.id) {
                        continue;
                    }
                    tracing::info!(id = summary.meta.id, "this server owns the design now");
                    self.insert(summary.clone(), None);
                    let _ = self.lobby.send(Outgoing::new(
                        None,
                        &LobbyMessage::Design { design: &summary },
                    ));
                }
            }
            Err(error) => tracing::warn!(%error, "couldn't read designs this server owns now"),
        }
    }

    /// Lets another server have `id`. A loaded design retires: its viewers
    /// are sent away to reconnect, and its save task writes a last snapshot,
    /// releases the lease and drops it. One that isn't loaded is dropped at once.
    fn let_go(&self, id: &str, handle: &Arc<DesignHandle>) {
        if !handle.retire() {
            tracing::info!(id, "another server owns this design now");
            self.remove(handle);
        }
    }

    /// Removes `handle` from the list, if it's still the one there.
    fn remove(&self, handle: &Arc<DesignHandle>) {
        let mut designs = self.designs.write().unwrap();
        let id = handle.summary().meta.id;
        if designs.get(&id).is_some_and(|h| Arc::ptr_eq(h, handle)) {
            designs.remove(&id);
        }
    }

    /// Drops this server's copy of a design for good: after its last save,
    /// or once another server has taken its lease.
    fn drop_copy(&self, handle: &Arc<DesignHandle>) {
        handle.end();
        self.remove(handle);
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

    /// Writes every loaded design to the store as a full snapshot. Called on
    /// shutdown. A server sharing its store then releases its leases and
    /// leaves the cluster, so the others take over its designs at once
    /// rather than after a lease.
    pub fn flush(&self) {
        if let Some(shared) = &self.shared {
            shared
                .stopped
                .store(true, std::sync::atomic::Ordering::SeqCst);
        }
        for handle in self.handles() {
            let _saving = handle.persistence.lock().unwrap();
            let Some((snapshot, token)) = handle.compact() else {
                continue;
            };
            let id = snapshot.meta.id.clone();
            if let Err(error) = self.store.save(&snapshot, token) {
                tracing::error!(id, %error, "failed to save design");
            } else if self.shared.is_some() {
                release_lease(&*self.store, &id, token);
            }
        }
        if let Some(shared) = &self.shared {
            if let Ok(held) = self.store.held() {
                for (id, token) in held {
                    release_lease(&*self.store, &id, token);
                }
            }
            if let Err(error) = shared.registry.leave() {
                tracing::warn!(%error, "couldn't leave the cluster");
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
    /// Servers that share a store never hand designs off.
    Shared,
    Io(io::Error),
}

/// Reads every design in `ids` for the design list, compacting any whose
/// journal had to be replayed, and drops each one again. Designs don't depend
/// on each other, so the work is split across a thread per core.
///
/// Compacting is a write, so it needs the design's lease. A design another
/// live server holds is left as it is; its holder compacts it. In a `shared`
/// store, a write may land between the first read and the claim, so the
/// design is read again after it.
fn summaries(store: &dyn Store, ids: &[String], shared: bool) -> io::Result<Vec<DesignSummary>> {
    let threads = std::thread::available_parallelism().map_or(1, |n| n.get());
    let chunk = ids.len().div_ceil(threads).max(1);
    let read = |id: &String| -> io::Result<Option<DesignSummary>> {
        let Some(stored) = store.load(id)? else {
            return Ok(None);
        };
        let mut state = DesignState::restore(stored);
        if state.needs_snapshot
            && let Claim::Granted(token) = store.claim(id)?
        {
            if shared && let Some(stored) = store.load(id)? {
                state = DesignState::restore(stored);
            }
            store.save(&state.snapshot_to_save(), token)?;
        }
        Ok(Some(DesignSummary::of(&state.design)))
    };
    std::thread::scope(|scope| {
        let workers: Vec<_> = ids
            .chunks(chunk)
            .map(|ids| scope.spawn(move || ids.iter().map(read).collect::<io::Result<Vec<_>>>()))
            .collect();
        let mut summaries = Vec::with_capacity(ids.len());
        for worker in workers {
            let read = worker
                .join()
                .map_err(|_| io::Error::other("a startup reader panicked"))?;
            summaries.extend(read?.into_iter().flatten());
        }
        Ok(summaries)
    })
}

/// The blobs a snapshot's imports point at: each artifact and each fetched
/// dependency, once.
fn referenced_blobs(snapshot: &Snapshot) -> BTreeSet<BlobHash> {
    let mut hashes = BTreeSet::new();
    for import in &snapshot.imports {
        hashes.insert(import.artifact.clone());
        hashes.extend(import.dependencies.iter().filter_map(|d| d.blob.clone()));
    }
    hashes
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
/// [`COMPACT_AFTER`] records or [`COMPACT_BYTES`] it writes a full snapshot instead. It holds the
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
            let saving = handle.clone();
            let store = hub.store.clone();
            let saved = tokio::task::spawn_blocking(move || {
                let _saving = saving.persistence.lock().unwrap();
                let save = saving.take_save()?;
                let last = matches!(save, Save::Last(..));
                let result = match save {
                    Save::Snapshot(snapshot, token) => store.save(&snapshot, token),
                    Save::Append(id, records, token) => store.append(&id, &records, token),
                    Save::Last(snapshot, token) => store
                        .save(&snapshot, token)
                        .and_then(|()| store.release(&snapshot.meta.id, token)),
                };
                Some((last, result))
            })
            .await;
            let (last, saved) = match saved {
                Ok(Some((last, saved))) => (last, Ok(saved)),
                Ok(None) => continue,
                Err(error) => (false, Err(error)),
            };
            let mut ended = last;
            let retry = match saved.map_err(io::Error::other) {
                Ok(Ok(())) => {
                    failures = 0;
                    if last {
                        tracing::info!(
                            id = handle.summary().meta.id,
                            "saved and let go of the design"
                        );
                        hub.drop_copy(&handle);
                    }
                    None
                }
                Ok(Err(error)) if Refusal::of(&error) == Some(&Refusal::Fenced) => {
                    // The edits since the last save are lost: another
                    // server holds the design now, and its copy wins.
                    tracing::warn!(
                        id = handle.summary().meta.id,
                        "another server took over this design; dropping the copy here"
                    );
                    hub.drop_copy(&handle);
                    ended = true;
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
            let state = handle.raw();
            if !ended && state.as_ref().is_some_and(|s| s.life != Life::Gone) {
                let summary = handle.summary();
                let _ = hub.lobby.send(Outgoing::new(
                    None,
                    &LobbyMessage::Design { design: &summary },
                ));
            }
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

    use finite_design::comment::{Anchor, Audience, Author};

    use super::*;
    use crate::{blob::BlobHash, store::MemoryStore};
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

    /// The design list's socket starts with the newest designs and the
    /// total; a search finds the others by name.
    #[tokio::test]
    async fn the_design_list_starts_with_the_newest_and_searches_the_rest() {
        let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
        for i in 0..LOBBY_LIMIT + 5 {
            hub.create(&format!("Design {i}"));
        }
        hub.create("Checkout flow");
        let (first, _) = hub.subscribe_lobby();
        let first: serde_json::Value = serde_json::from_str(&first.json).unwrap();
        assert_eq!(first["designs"].as_array().unwrap().len(), LOBBY_LIMIT);
        assert_eq!(first["total"], LOBBY_LIMIT + 6);

        let found = hub.find(Some("CHECKOUT"), 10);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].meta.name, "Checkout flow");
        assert_eq!(hub.find(None, 3).len(), 3);
        assert_eq!(hub.find(Some(""), 1000).len(), LOBBY_LIMIT + 6);
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
            extra_node_ids: Vec::new(),
            x: 1.0,
            y: 2.0,
        };
        let comment = handle
            .add_comment(author, anchor, Audience::Agents, "Hello")
            .unwrap();
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
                    height: Some(100.0),
                    position: None,
                    page: None,
                    styles: BTreeMap::new(),
                    ..Default::default()
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
            extra_node_ids: Vec::new(),
            x: 1.0,
            y: 2.0,
        };
        handle
            .add_comment(author, anchor, Audience::Agents, "Hello")
            .unwrap();

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
        handle.undo(&agent, None).unwrap();
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
                            height: Some(100.0),
                            position: None,
                            page: None,
                            styles: BTreeMap::new(),
                            ..Default::default()
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
        fn save(&self, snapshot: &Snapshot, token: Token) -> io::Result<()> {
            self.write()?;
            self.inner.save(snapshot, token)
        }
        fn append(
            &self,
            id: &str,
            records: &[finite_design::Record],
            token: Token,
        ) -> io::Result<()> {
            self.write()?;
            self.inner.append(id, records, token)
        }
        fn delete(&self, id: &str, token: Token) -> io::Result<()> {
            self.inner.delete(id, token)
        }
        fn create(&self, snapshot: &Snapshot) -> io::Result<Option<Token>> {
            self.inner.create(snapshot)
        }
        fn claim(&self, id: &str) -> io::Result<Claim> {
            self.inner.claim(id)
        }
        fn put_blob(&self, bytes: &[u8]) -> io::Result<BlobHash> {
            self.inner.put_blob(bytes)
        }
        fn get_blob(&self, hash: &BlobHash) -> io::Result<Option<Vec<u8>>> {
            self.inner.get_blob(hash)
        }
        fn has_blob(&self, hash: &BlobHash) -> io::Result<bool> {
            self.inner.has_blob(hash)
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
                    height: Some(100.0),
                    position: None,
                    page: None,
                    styles: BTreeMap::new(),
                    ..Default::default()
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
            extra_node_ids: Vec::new(),
            x: 1.0,
            y: 2.0,
        };
        handle
            .add_comment(author, anchor, Audience::Agents, "Hello")
            .unwrap();
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

    /// A few huge edits compact the journal, as many small ones do.
    #[tokio::test]
    async fn a_new_design_never_reuses_an_id() {
        let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
        let taken = hub.create("Existing").meta.id;
        let candidates = [taken.clone(), taken.clone(), "fresh0001".to_owned()];
        assert_eq!(hub.fresh_id(candidates.into_iter()), "fresh0001");
    }

    #[tokio::test]
    async fn big_edits_compact_the_journal() {
        use finite_design::edit::{self, NewArtboard, WriteMode};

        let store = Arc::new(MemoryStore::default());
        let hub = Hub::new(store.clone()).unwrap();
        let id = hub.create("Test").meta.id;
        let agent = Actor {
            id: "agent:big".into(),
            name: "Big".into(),
        };
        let handle = hub.get(&id).unwrap();
        handle
            .edit(&agent, "Create artboard", |doc| {
                let spec = NewArtboard {
                    name: "Home".into(),
                    width: 100.0,
                    height: Some(100.0),
                    position: None,
                    page: None,
                    styles: BTreeMap::new(),
                    ..Default::default()
                };
                Ok((edit::create_artboard(doc, "board".into(), spec)?, ()))
            })
            .unwrap();
        tokio::time::sleep(SAVE_DEBOUNCE * 2).await;
        let mut n = 0;
        let mut write_mb = |count: usize| {
            for _ in 0..count {
                let html = format!("<p>{}</p>", "x".repeat(1 << 20));
                handle
                    .edit(&agent, "Write", |doc| {
                        let mut new_id = || {
                            n += 1;
                            format!("n{n}")
                        };
                        let (ops, _) = edit::write_html(
                            doc,
                            "board",
                            &html,
                            WriteMode::Append,
                            None,
                            &mut new_id,
                        )?;
                        Ok((ops, ()))
                    })
                    .unwrap();
            }
        };
        // 10 MB of changes go into the journal...
        write_mb(10);
        tokio::time::sleep(SAVE_DEBOUNCE * 2).await;
        assert!(store.journal_len(&id) > 0);
        // ...and past 16 MB, they're compacted into a snapshot, though that's
        // far fewer than 1,000 records.
        write_mb(10);
        tokio::time::sleep(SAVE_DEBOUNCE * 2).await;
        assert_eq!(store.journal_len(&id), 0);
    }

    #[tokio::test]
    async fn idle_designs_unload_and_reload() {
        use finite_design::edit::{self, NewArtboard};

        let store = Arc::new(MemoryStore::default());
        let hub = Hub::new(store.clone()).unwrap();
        let id = hub.create("Test").meta.id;
        let agent = Actor {
            id: finite_design::actor::session("abc"),
            name: "Agent".into(),
        };
        hub.get(&id)
            .unwrap()
            .edit(&agent, "Create artboard", |doc| {
                let spec = NewArtboard {
                    name: "Home".into(),
                    width: 100.0,
                    height: Some(100.0),
                    position: None,
                    page: None,
                    styles: BTreeMap::new(),
                    ..Default::default()
                };
                Ok((edit::create_artboard(doc, "board".into(), spec)?, ()))
            })
            .unwrap();
        let before = hub.get(&id).unwrap().read(Design::snapshot);
        tokio::time::sleep(SAVE_DEBOUNCE * 2).await;
        let later = now_ms() + UNLOAD_AFTER.as_millis() as u64;

        // The agent's session can still undo, and its history wouldn't come
        // back from the store, so the design stays in memory.
        hub.sweep(later);
        assert_eq!(hub.loaded(), 1);

        // So does a design someone is watching.
        hub.forget_actor(&agent.id);
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

    /// A named agent's history is in the store, so it doesn't keep the design
    /// in memory. It comes back with the design, and still expires six hours
    /// after the agent last used it.
    #[tokio::test]
    async fn named_histories_unload_and_still_expire() {
        use finite_design::edit::{self, NewArtboard};

        let store = Arc::new(MemoryStore::default());
        let hub = Hub::new(store.clone()).unwrap();
        let id = hub.create("Test").meta.id;
        tokio::time::sleep(SAVE_DEBOUNCE * 2).await;
        let agent = Actor {
            id: "agent:Claude".into(),
            name: "Claude".into(),
        };
        let edited = now_ms();
        hub.get(&id)
            .unwrap()
            .edit(&agent, "Create artboard", |doc| {
                let spec = NewArtboard {
                    name: "Home".into(),
                    width: 100.0,
                    height: Some(100.0),
                    position: None,
                    page: None,
                    styles: BTreeMap::new(),
                    ..Default::default()
                };
                Ok((edit::create_artboard(doc, "board".into(), spec)?, ()))
            })
            .unwrap();
        tokio::time::sleep(SAVE_DEBOUNCE * 2).await;
        assert!(!store.load(&id).unwrap().unwrap().journal.is_empty());
        let unused = now_ms() + UNLOAD_AFTER.as_millis() as u64;

        // The edit is only in the journal, which doesn't record when it was
        // made. So the first sweep asks for a full snapshot, and the next unloads.
        hub.sweep(unused);
        assert_eq!(hub.loaded(), 1);
        tokio::time::sleep(SAVE_DEBOUNCE * 2).await;
        assert!(store.load(&id).unwrap().unwrap().journal.is_empty());
        hub.sweep(unused);
        assert_eq!(hub.loaded(), 0);

        // Reopened, the agent can still undo.
        let handle = hub.open(&id).await.unwrap();
        assert_eq!(handle.history(&agent).0, ["Create artboard"]);
        drop(handle);

        // Six hours after the edit, not after the reload, the history expires,
        // and the store forgets it too.
        let expired = edited + HISTORY_TTL.as_millis() as u64 + 1000;
        hub.sweep(expired);
        let handle = hub.get(&id).unwrap();
        assert!(handle.history(&agent).0.is_empty());
        drop(handle);
        tokio::time::sleep(SAVE_DEBOUNCE * 2).await;
        hub.sweep(expired);
        assert_eq!(hub.loaded(), 0);
        let handle = hub.open(&id).await.unwrap();
        assert!(handle.history(&agent).0.is_empty());
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
                    height: Some(100.0),
                    position: None,
                    page: None,
                    styles: BTreeMap::new(),
                    ..Default::default()
                };
                Ok((edit::create_artboard(doc, "board".into(), spec)?, ()))
            })
            .unwrap();
        hub.flush();

        let restarted = Hub::new(store.clone()).unwrap();
        let handle = restarted.open(&id).await.unwrap();
        assert_eq!(handle.history(&agent).0, ["Create artboard"]);
        assert!(handle.undo(&agent, None).is_some());
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
            id: finite_design::actor::session("abc"),
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
                        height: Some(100.0),
                        position: None,
                        page: None,
                        styles: BTreeMap::new(),
                        ..Default::default()
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
                    height: Some(100.0),
                    position: None,
                    page: None,
                    styles: BTreeMap::new(),
                    ..Default::default()
                };
                Ok((edit::create_artboard(doc, "board".into(), spec)?, ()))
            })
            .unwrap();
        handle
            .edit(&agent, "Rename", |doc| {
                Ok((edit::rename(doc, "board", Some("Landing"))?, ()))
            })
            .unwrap();
        handle.undo(&agent, None).unwrap();
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
        assert!(handle.redo(&agent, None).is_some());
        assert_eq!(
            handle.read(|d| d.doc().get("board").unwrap().name.clone()),
            Some("Landing".into())
        );
    }
}
