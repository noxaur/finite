//! Which server owns which design, when several run side by side.
//!
//! Every design lives on exactly one server, which holds it in memory and
//! saves it to its own store (see the rooms model in `hub.rs`). The owner is
//! a pure function of the design id and the list of servers, computed with
//! rendezvous hashing (highest random weight): each server scores the id, and
//! the highest score wins. Any server, proxy or load balancer that knows the
//! list computes the same answer, so routing needs no shared state.
//!
//! Adding or removing a server only moves the designs it wins or loses,
//! about 1/n of them, unlike `hash % n`, which reshuffles almost everything.

/// The servers in a deployment, and which one this is.
#[derive(Clone, Debug)]
pub struct Cluster {
    /// Each server's base URL, like `http://10.0.0.2:4100`. Every server must
    /// be given the same list.
    nodes: Vec<String>,
    me: usize,
}

impl Default for Cluster {
    /// A single server that owns every design.
    fn default() -> Self {
        Self {
            nodes: vec![String::new()],
            me: 0,
        }
    }
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
        Ok(Self { nodes, me })
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

    /// The base URL of the server that owns `design_id`.
    pub fn owner_url(&self, design_id: &str) -> &str {
        &self.nodes[self.owner(design_id)]
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

    /// The position of the server that owns `design_id`.
    pub fn owner(&self, design_id: &str) -> usize {
        (0..self.nodes.len())
            .max_by_key(|&node| score(&self.nodes[node], design_id))
            .unwrap_or(0)
    }

    pub fn owns(&self, design_id: &str) -> bool {
        self.owner(design_id) == self.me
    }

    /// The owner's base URL when another server owns `design_id`.
    pub fn elsewhere(&self, design_id: &str) -> Option<&str> {
        let owner = self.owner(design_id);
        (owner != self.me).then(|| self.nodes[owner].as_str())
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Matches an independent Python implementation of `score`.
    const PINNED: u64 = 2_931_733_081_812_993_517;

    fn cluster(n: usize) -> Cluster {
        let nodes = (0..n).map(|i| format!("http://node{i}:4100")).collect();
        Cluster::new(nodes, 0).unwrap()
    }

    fn ids() -> impl Iterator<Item = String> {
        (0..10_000).map(|i| format!("design{i}"))
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
            counts[c.owner(&id)] += 1;
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
        assert!(moved.iter().all(|id| after.owner(id) == 4));
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
