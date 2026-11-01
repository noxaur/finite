//! Which server owns which design, when several run side by side.
//!
//! Every design lives on exactly one server, which holds it in memory and
//! saves it to its own store (see the rooms model in `hub/mod.rs`). The owner is
//! a pure function of the design id and the list of servers, computed with
//! rendezvous hashing (highest random weight): each server scores the id, and
//! the highest score wins. Any server, proxy or load balancer that knows the
//! list computes the same answer, so routing needs no shared state.
//!
//! Adding or removing a server only moves the designs it wins or loses,
//! about 1/n of them, unlike `hash % n`, which reshuffles almost everything.
//!
//! The list is fixed (`FINITE_NODES`) when each server keeps its designs in
//! its own folder. With a shared store, it's every server whose heartbeat is
//! current (see [`Members`]).

use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use tokio::sync::watch;

use crate::store::Registry;

/// The servers in a deployment, and which one this is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cluster {
    /// Each server's base URL, like `http://10.0.0.2:4100`. Every server must
    /// be given the same list.
    nodes: Vec<String>,
    /// This server's position, or `None` for a router, or for a server that
    /// isn't in the list, like one whose heartbeat lapsed.
    me: Option<usize>,
}

impl Default for Cluster {
    /// A single server that owns every design.
    fn default() -> Self {
        Self {
            nodes: vec![String::new()],
            me: Some(0),
        }
    }
}

/// Where a design is served, as one server sees it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Place {
    Here,
    /// On the server with this base URL.
    Elsewhere(String),
    /// On no server: none is live.
    Nowhere,
}

impl Cluster {
    /// `nodes` lists every server's base URL; `me` is this server's position in it.
    pub fn new(nodes: Vec<String>, me: usize) -> Result<Self, String> {
        if me >= nodes.len() {
            return Err(format!(
                "this server is node {me}, but only {} nodes are listed",
                nodes.len()
            ));
        }
        Ok(Self {
            nodes,
            me: Some(me),
        })
    }

    /// The servers in `nodes`, seen from outside, like the router does.
    pub fn observer(nodes: Vec<String>) -> Self {
        Self { nodes, me: None }
    }

    /// The live servers in `nodes`, sorted, seen by the server at `me`, which
    /// may be missing from the list.
    pub fn live(mut nodes: Vec<String>, me: &str) -> Self {
        nodes.sort();
        nodes.dedup();
        let me = nodes.iter().position(|n| n == me);
        Self { nodes, me }
    }

    /// The same servers without this one, which then owns nothing.
    pub fn without_me(&self) -> Self {
        let mut nodes = self.nodes.clone();
        if let Some(me) = self.me {
            nodes.remove(me);
        }
        Self { nodes, me: None }
    }

    /// Whether this server is in the list.
    pub fn has_me(&self) -> bool {
        self.me.is_some()
    }

    /// The base URLs in `FINITE_NODES` (comma-separated), if it's set.
    pub fn nodes_from_env() -> Option<Vec<String>> {
        let list = std::env::var("FINITE_NODES").ok()?;
        Some(
            list.split(',')
                .map(|n| n.trim().trim_end_matches('/').to_owned())
                .filter(|n| !n.is_empty())
                .collect(),
        )
    }

    /// Reads `FINITE_NODES` (comma-separated base URLs) and `FINITE_NODE`
    /// (this server's 0-based position). Without them, it's a single server.
    pub fn from_env() -> Result<Self, String> {
        let Some(nodes) = Self::nodes_from_env() else {
            return Ok(Self::default());
        };
        let me = std::env::var("FINITE_NODE")
            .map_err(|_| "FINITE_NODES is set, so FINITE_NODE must be too".to_owned())?
            .parse()
            .map_err(|_| "FINITE_NODE must be a number".to_owned())?;
        Self::new(nodes, me)
    }

    pub fn nodes(&self) -> &[String] {
        &self.nodes
    }

    /// The base URL of the server that owns `design_id`, if any server is listed.
    pub fn owner_url(&self, design_id: &str) -> Option<&str> {
        self.owner(design_id).map(|n| self.nodes[n].as_str())
    }

    /// The `Host` values MCP accepts. MCP rejects unknown hosts to block DNS
    /// rebinding, so this is localhost, every server in the cluster, and any
    /// extra names in `FINITE_ALLOWED_HOSTS` (comma-separated, like
    /// `finite.example.com`).
    pub fn allowed_hosts(&self) -> Vec<String> {
        let mut hosts: Vec<String> = ["localhost", "127.0.0.1", "::1"].map(String::from).to_vec();
        for node in &self.nodes {
            let authority = node.split("://").nth(1).unwrap_or(node);
            let authority = authority.split('/').next().unwrap_or(authority);
            if !authority.is_empty() {
                hosts.push(authority.to_owned());
            }
        }
        if let Ok(extra) = std::env::var("FINITE_ALLOWED_HOSTS") {
            hosts.extend(
                extra
                    .split(',')
                    .map(str::trim)
                    .filter(|h| !h.is_empty())
                    .map(String::from),
            );
        }
        hosts
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// The position of the server that owns `design_id`. `None` when no
    /// server is listed.
    pub fn owner(&self, design_id: &str) -> Option<usize> {
        (0..self.nodes.len()).max_by_key(|&node| score(&self.nodes[node], design_id))
    }

    pub fn owns(&self, design_id: &str) -> bool {
        self.me.is_some() && self.owner(design_id) == self.me
    }

    pub fn place(&self, design_id: &str) -> Place {
        match self.owner(design_id) {
            None => Place::Nowhere,
            Some(owner) if Some(owner) == self.me => Place::Here,
            Some(owner) => Place::Elsewhere(self.nodes[owner].clone()),
        }
    }

    /// The owner's base URL when another server owns `design_id`.
    pub fn elsewhere(&self, design_id: &str) -> Option<&str> {
        let owner = self.owner(design_id)?;
        (Some(owner) != self.me).then(|| self.nodes[owner].as_str())
    }
}

/// How long a server's heartbeat counts, from `FINITE_LEASE_MS` (10 seconds
/// by default). A server renews it five times per lease, so it takes several
/// missed heartbeats in a row to be counted as gone.
#[derive(Clone, Copy, Debug)]
pub struct Lease(pub Duration);

impl Lease {
    pub fn from_env() -> Result<Self, String> {
        match std::env::var("FINITE_LEASE_MS") {
            Err(_) => Ok(Self(Duration::from_secs(10))),
            Ok(ms) => ms
                .parse()
                .ok()
                .filter(|&ms| ms >= 100)
                .map(|ms| Self(Duration::from_millis(ms)))
                .ok_or_else(|| {
                    "FINITE_LEASE_MS must be a number of milliseconds, 100 or more".into()
                }),
        }
    }

    /// How often a server renews its heartbeat and checks the list.
    pub fn every(&self) -> Duration {
        self.0 / 5
    }
}

/// The servers as this process sees them right now. With a fixed list
/// (`FINITE_NODES`), that never changes. With a shared store, the list comes
/// from the [`Registry`] and changes as servers come and go.
///
/// A server that heartbeats holds a **lease** on its own membership: if it
/// hasn't renewed in time, say because it was paused, the others may already
/// have taken over its designs. From then until it renews, it counts itself
/// out of the list, so it serves nothing, without waiting to hear from the
/// store.
pub struct Members {
    view: watch::Sender<Arc<Cluster>>,
    /// When this server's last renewal started, and how long a renewal lasts.
    lease: Option<(Mutex<Instant>, Duration)>,
}

impl Members {
    pub fn fixed(cluster: Cluster) -> Self {
        Self {
            view: watch::channel(Arc::new(cluster)).0,
            lease: None,
        }
    }

    /// The view of a server that has just renewed its heartbeat.
    pub fn heartbeating(cluster: Cluster, lease: Lease) -> Self {
        Self {
            view: watch::channel(Arc::new(cluster)).0,
            lease: Some((Mutex::new(Instant::now()), lease.0)),
        }
    }

    /// The servers now. A server whose lease lapsed counts itself out.
    pub fn now(&self) -> Arc<Cluster> {
        let view = self.view.borrow().clone();
        if self.lapsed() && view.has_me() {
            return Arc::new(view.without_me());
        }
        view
    }

    /// Whether this server's heartbeat lease has run out.
    pub fn lapsed(&self) -> bool {
        self.lease
            .as_ref()
            .is_some_and(|(renewed, ttl)| renewed.lock().unwrap().elapsed() >= *ttl)
    }

    /// Records a renewal that started at `at`. The store stamps the heartbeat
    /// after that, so the others count this server alive at least as long.
    pub fn renewed(&self, at: Instant) {
        if let Some((renewed, _)) = &self.lease {
            *renewed.lock().unwrap() = at;
        }
    }

    /// Replaces the list. Returns whether it changed.
    pub fn set(&self, cluster: Cluster) -> bool {
        self.view.send_if_modified(|view| {
            let changed = **view != cluster;
            if changed {
                *view = Arc::new(cluster);
            }
            changed
        })
    }

    /// Wakes each time the list changes.
    pub fn subscribe(&self) -> watch::Receiver<Arc<Cluster>> {
        self.view.subscribe()
    }
}

/// Keeps a router's view of the servers current: every `every`, it asks the
/// registry which servers are live.
pub fn follow(members: Arc<Members>, registry: Arc<dyn Registry>, every: Duration) {
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(every);
        loop {
            tick.tick().await;
            let registry = registry.clone();
            match tokio::task::spawn_blocking(move || registry.live()).await {
                Ok(Ok(live)) => {
                    let mut live = live;
                    live.sort();
                    if members.set(Cluster::observer(live)) {
                        tracing::info!(servers = ?members.now().nodes(), "the servers changed");
                    }
                }
                Ok(Err(error)) => tracing::warn!(%error, "couldn't read the list of servers"),
                Err(error) => tracing::warn!(%error, "couldn't read the list of servers"),
            }
        }
    });
}

/// FNV-1a over the node, a separator and the id. It's stable across Rust
/// versions and platforms, unlike `DefaultHasher`, so every server and proxy
/// agrees. The final mix spreads FNV's weak low bits.
fn score(node: &str, design_id: &str) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in node.bytes().chain([0]).chain(design_id.bytes()) {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    // splitmix64's finalizer.
    hash ^= hash >> 30;
    hash = hash.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    hash ^= hash >> 27;
    hash = hash.wrapping_mul(0x94d0_49bb_1331_11eb);
    hash ^ (hash >> 31)
}

/// Whether `url` is a plain server base URL like `FINITE_NODES` holds:
/// `http://` or `https://`, a host and maybe a port, and nothing after.
pub fn is_base_url(url: &str) -> bool {
    let Ok(uri) = url.parse::<http::Uri>() else {
        return false;
    };
    matches!(uri.scheme_str(), Some("http" | "https"))
        && uri
            .authority()
            .is_some_and(|a| !a.host().is_empty() && !a.as_str().contains('@'))
        && uri
            .path_and_query()
            .is_none_or(|p| p.as_str().is_empty() || p.as_str() == "/")
        && !url.ends_with('/')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base_urls_are_a_scheme_a_host_and_maybe_a_port() {
        for ok in [
            "http://10.0.0.2:4100",
            "https://finite.example.com",
            "http://[::1]:4100",
        ] {
            assert!(is_base_url(ok), "{ok}");
        }
        for bad in [
            "",
            "10.0.0.2:4100",
            "file:///etc/passwd",
            "http://a:4100/",
            "http://a:4100/api",
            "http://a:4100?x=1",
            "http://user@a:4100",
            "javascript:alert(1)",
        ] {
            assert!(!is_base_url(bad), "{bad}");
        }
    }

    /// Matches an independent Python implementation of `score`.
    const PINNED: u64 = 2_931_733_081_812_993_517;

    fn cluster(n: usize) -> Cluster {
        let nodes = (0..n).map(|i| format!("http://node{i}:4100")).collect();
        Cluster::new(nodes, 0).unwrap()
    }

    fn ids() -> impl Iterator<Item = String> {
        (0..10_000).map(|i| format!("design{i}"))
    }

    /// A server that hasn't renewed its heartbeat in time may have been
    /// replaced, so it counts itself out until it renews.
    #[test]
    fn a_server_whose_lease_lapsed_owns_nothing() {
        let nodes = vec!["http://a".to_owned(), "http://b".to_owned()];
        let lease = Lease(Duration::from_millis(50));
        let members = Members::heartbeating(Cluster::live(nodes, "http://a"), lease);
        let mine = ids().find(|id| members.now().owns(id)).unwrap();
        std::thread::sleep(lease.0);
        assert!(members.lapsed());
        let view = members.now();
        assert!(!view.has_me());
        assert_eq!(view.place(&mine), Place::Elsewhere("http://b".into()));
        members.renewed(Instant::now());
        assert!(members.now().owns(&mine), "renewing brings it back");

        let alone =
            Members::heartbeating(Cluster::live(vec!["http://a".into()], "http://a"), lease);
        alone.renewed(Instant::now() - lease.0);
        assert_eq!(alone.now().place(&mine), Place::Nowhere);
    }

    #[test]
    fn mcp_accepts_the_cluster_hosts() {
        let hosts = cluster(2).allowed_hosts();
        assert!(hosts.contains(&"node1:4100".to_owned()), "{hosts:?}");
        assert!(hosts.contains(&"127.0.0.1".to_owned()));
    }

    #[test]
    fn a_single_server_owns_everything() {
        let single = Cluster::default();
        assert!(ids().all(|id| single.owns(&id)));
        assert_eq!(single.elsewhere("x"), None);
    }

    #[test]
    fn designs_spread_evenly() {
        let c = cluster(4);
        let mut counts = [0; 4];
        for id in ids() {
            counts[c.owner(&id).unwrap()] += 1;
        }
        // 2,500 each on average; allow ±10%.
        assert!(
            counts.iter().all(|&n| (2250..=2750).contains(&n)),
            "{counts:?}"
        );
    }

    #[test]
    fn adding_a_server_moves_only_its_share() {
        let (before, after) = (cluster(4), cluster(5));
        let moved: Vec<String> = ids()
            .filter(|id| before.owner(id) != after.owner(id))
            .collect();
        // Every moved design moves to the new server, and about 1/5 move.
        assert!(moved.iter().all(|id| after.owner(id) == Some(4)));
        assert!(
            (1800..=2200).contains(&moved.len()),
            "{} moved",
            moved.len()
        );
    }

    #[test]
    fn every_server_agrees_on_the_owner() {
        let nodes: Vec<String> = (0..3).map(|i| format!("http://node{i}:4100")).collect();
        let views: Vec<Cluster> = (0..3)
            .map(|me| Cluster::new(nodes.clone(), me).unwrap())
            .collect();
        for id in ids().take(500) {
            let owners: Vec<bool> = views.iter().map(|c| c.owns(&id)).collect();
            assert_eq!(owners.iter().filter(|&&o| o).count(), 1, "{id}");
        }
        // Pinned scores, so a proxy written in another language can check its hash.
        assert_eq!(score("http://node0:4100", "k7jo11y14e"), PINNED);
    }
}
