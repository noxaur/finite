//! Servers that share one store: designs live in the store, ownership follows
//! the servers' heartbeats, and a server that lost a design can't write it.
//!
//! Each test runs against the in-memory store, and against Postgres too when
//! the crate is built with the `postgres` feature and
//! `FINITE_TEST_DATABASE_URL` is set. Servers run in this process, over real
//! sockets. A server is "killed" or "paused" by cutting it off from the
//! store: it can't heartbeat or save, as a crashed or frozen process can't.
//! `tests/failover.rs` does the same with real processes and signals.

use std::{
    io,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};

use finite_design::{Record, Snapshot};
use finite_server::{
    Hub, app,
    blob::BlobHash,
    cluster::{self, Cluster, Lease, Members},
    router,
    store::{Claim, MemoryStore, Registry, Store, Stored, Token},
};
use futures::StreamExt;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

/// Short, so a dead server's designs move within a second.
const LEASE: Lease = Lease(Duration::from_millis(600));

trait Both: Store + Registry {}
impl<T: Store + Registry> Both for T {}

/// One server's connection to the store, which a test can cut.
struct Cut {
    inner: Box<dyn Both>,
    cut: AtomicBool,
}

impl Cut {
    fn check(&self) -> io::Result<()> {
        if self.cut.load(Ordering::SeqCst) {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionRefused,
                "cut off from the store",
            ));
        }
        Ok(())
    }
}

impl Store for Cut {
    fn ids(&self) -> io::Result<Vec<String>> {
        self.check()?;
        self.inner.ids()
    }
    fn load(&self, id: &str) -> io::Result<Option<Stored>> {
        self.check()?;
        self.inner.load(id)
    }
    fn save(&self, snapshot: &Snapshot, token: Token) -> io::Result<()> {
        self.check()?;
        self.inner.save(snapshot, token)
    }
    fn append(&self, id: &str, records: &[Record], token: Token) -> io::Result<()> {
        self.check()?;
        self.inner.append(id, records, token)
    }
    fn remove(&self, id: &str) -> io::Result<()> {
        self.check()?;
        self.inner.remove(id)
    }
    fn create(&self, snapshot: &Snapshot) -> io::Result<Option<Token>> {
        self.check()?;
        self.inner.create(snapshot)
    }
    fn claim(&self, id: &str) -> io::Result<Claim> {
        self.check()?;
        self.inner.claim(id)
    }
    fn release(&self, id: &str, token: Token) -> io::Result<()> {
        self.check()?;
        self.inner.release(id, token)
    }
    fn held(&self) -> io::Result<Vec<(String, Token)>> {
        self.check()?;
        self.inner.held()
    }
    fn put_blob(&self, bytes: &[u8]) -> io::Result<BlobHash> {
        self.check()?;
        self.inner.put_blob(bytes)
    }
    fn get_blob(&self, hash: &BlobHash) -> io::Result<Option<Vec<u8>>> {
        self.check()?;
        self.inner.get_blob(hash)
    }
    fn has_blob(&self, hash: &BlobHash) -> io::Result<bool> {
        self.check()?;
        self.inner.has_blob(hash)
    }
}

impl Registry for Cut {
    fn heartbeat(&self) -> io::Result<()> {
        self.check()?;
        self.inner.heartbeat()
    }
    fn live(&self) -> io::Result<Vec<String>> {
        self.check()?;
        self.inner.live()
    }
    fn leave(&self) -> io::Result<()> {
        self.check()?;
        self.inner.leave()
    }
}

/// Where the shared designs live, and how long a heartbeat counts there.
enum Backend {
    Memory(MemoryStore, Lease),
    #[cfg(feature = "postgres")]
    Postgres(String, Lease),
}

impl Backend {
    /// The in-memory store, and Postgres if it's configured.
    fn all() -> Vec<Backend> {
        Self::all_with(LEASE)
    }

    fn all_with(lease: Lease) -> Vec<Backend> {
        let memory = Backend::Memory(MemoryStore::with_lease(lease.0), lease);
        #[cfg(feature = "postgres")]
        if let Some(url) = finite_server::postgres::test_database() {
            return vec![memory, Backend::Postgres(url, lease)];
        }
        vec![memory]
    }

    fn lease(&self) -> Lease {
        match self {
            Self::Memory(_, lease) => *lease,
            #[cfg(feature = "postgres")]
            Self::Postgres(_, lease) => *lease,
        }
    }

    fn name(&self) -> &'static str {
        match self {
            Self::Memory(..) => "memory",
            #[cfg(feature = "postgres")]
            Self::Postgres(..) => "postgres",
        }
    }

    /// A connection for the server at `url`.
    fn connect(&self, url: &str) -> Arc<Cut> {
        let inner: Box<dyn Both> = match self {
            Self::Memory(store, _) => Box::new(store.node(url)),
            #[cfg(feature = "postgres")]
            Self::Postgres(db, lease) => {
                Box::new(finite_server::postgres::PgStore::connect(db, url, lease.0).unwrap())
            }
        };
        Arc::new(Cut {
            inner,
            cut: AtomicBool::new(false),
        })
    }
}

struct Server {
    url: String,
    hub: Arc<Hub>,
    store: Arc<Cut>,
    serve: tokio::task::JoinHandle<()>,
}

impl Server {
    async fn start(backend: &Backend) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let store = backend.connect(&url);
        let hub = Hub::shared(store.clone(), store.clone(), &url, backend.lease()).unwrap();
        let routes = app(hub.clone(), None);
        let serve = tokio::spawn(async move {
            let _ = axum::serve(listener, routes).await;
        });
        Self {
            url,
            hub,
            store,
            serve,
        }
    }

    /// Cuts the server off from the store, as if it froze, or heals it.
    fn pause(&self, paused: bool) {
        self.store.cut.store(paused, Ordering::SeqCst);
    }

    /// Stops it the way a crash would: it stops answering, and can't
    /// heartbeat or save again.
    fn kill(&self) {
        self.pause(true);
        self.serve.abort();
    }
}

/// A client that doesn't keep connections open, so a stopped server's
/// connections end.
fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .build()
        .unwrap()
}

/// Waits until every server sees `n` servers.
async fn settle(servers: &[&Server], n: usize) {
    eventually("the servers see each other", || async {
        servers.iter().all(|s| s.hub.cluster().len() == n)
    })
    .await;
}

/// Polls `check` every 50 ms, for up to 10 seconds.
async fn eventually<F: Future<Output = bool>>(what: &str, mut check: impl FnMut() -> F) {
    for _ in 0..200 {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("timed out waiting until {what}");
}

async fn create(http: &reqwest::Client, base: &str, name: &str) -> String {
    let res = http
        .post(format!("{base}/api/designs"))
        .json(&json!({ "name": name }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 201, "creating on {base}");
    let created: Value = res.json().await.unwrap();
    created["id"].as_str().unwrap().to_owned()
}

/// Pins a comment saying `body` on the design. Comments are saved through
/// the same journal as edits.
async fn comment(http: &reqwest::Client, base: &str, id: &str, body: &str) {
    let res = http
        .post(format!("{base}/api/designs/{id}/comments"))
        .json(&json!({ "author": { "id": "1", "name": "Per" }, "body": body, "x": 1, "y": 2 }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 201, "commenting on {base}");
}

/// The comments a design's snapshot holds, from `base`, or `None` if it
/// doesn't answer `200`.
async fn comments(http: &reqwest::Client, base: &str, id: &str) -> Option<Vec<String>> {
    let res = http
        .get(format!("{base}/api/designs/{id}"))
        .send()
        .await
        .ok()?;
    if res.status() != 200 {
        return None;
    }
    let snapshot: Value = res.json().await.ok()?;
    Some(bodies(&snapshot))
}

fn bodies(snapshot: &Value) -> Vec<String> {
    snapshot["comments"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["messages"][0]["body"].as_str().unwrap().to_owned())
        .collect()
}

/// The comments in the store itself, journal included.
fn stored_comments(store: &dyn Store, id: &str) -> Vec<String> {
    let stored = store.load(id).unwrap().unwrap();
    let mut design = finite_design::Design::from_snapshot(stored.snapshot);
    for record in stored.journal {
        design.replay(record);
    }
    design
        .comments()
        .iter()
        .map(|c| c.messages[0].body.clone())
        .collect()
}

/// Waits out the save delay, so what's been sent so far is in the store.
async fn saved() {
    tokio::time::sleep(Duration::from_millis(500)).await;
}

/// Each server creates and serves its own designs, and sends requests for
/// the other's to their owner. Both see every design in the one store. When
/// a server shuts down, it leaves the cluster, and the other serves its
/// designs right away, without waiting for its lease to run out.
#[tokio::test(flavor = "multi_thread")]
async fn two_servers_share_one_store() {
    // Long enough to tell leaving from a lease running out.
    let lease = Lease(Duration::from_secs(5));
    for backend in Backend::all_with(lease) {
        eprintln!("store: {}", backend.name());
        let (a, b) = (Server::start(&backend).await, Server::start(&backend).await);
        settle(&[&a, &b], 2).await;
        let http = client();
        let mut on_a = Vec::new();
        for i in 0..4 {
            on_a.push(create(&http, &a.url, &format!("A{i}")).await);
            create(&http, &b.url, &format!("B{i}")).await;
        }
        assert_eq!(a.hub.list().len(), 4);
        assert_eq!(b.hub.list().len(), 4);
        assert_eq!(a.store.ids().unwrap().len(), 8, "one store holds all");
        for id in &on_a {
            comment(&http, &a.url, id, "Hello").await;
            let res = http
                .get(format!("{}/api/designs/{id}", b.url))
                .send()
                .await
                .unwrap();
            assert_eq!(res.status(), 421);
            assert_eq!(res.headers()["finite-owner"], a.url.as_str());
        }

        // A shuts down cleanly: it saves, releases its leases and leaves.
        a.serve.abort();
        let hub = a.hub.clone();
        tokio::task::spawn_blocking(move || hub.flush())
            .await
            .unwrap();
        let left = std::time::Instant::now();
        for id in &on_a {
            eventually("B serves A's designs", || async {
                comments(&http, &b.url, id).await == Some(vec!["Hello".into()])
            })
            .await;
        }
        // B answers for A's designs from the store before it adds them to
        // its list, so the list can trail by a moment.
        eventually("B lists every design", || async { b.hub.list().len() == 8 }).await;
        assert!(
            left.elapsed() < lease.0 / 2,
            "B took over at once, not after A's lease: {:?}",
            left.elapsed()
        );
        b.kill();
    }
}

/// A server that dies stops heartbeating. Once its lease runs out, its
/// designs move to the other server, which loads them from the store. Every
/// edit saved before the crash is there.
#[tokio::test(flavor = "multi_thread")]
async fn a_dead_servers_designs_move_to_the_survivor() {
    for backend in Backend::all() {
        eprintln!("store: {}", backend.name());
        let (a, b) = (Server::start(&backend).await, Server::start(&backend).await);
        settle(&[&a, &b], 2).await;
        let http = client();
        let id = create(&http, &a.url, "Landing").await;
        for body in ["One", "Two", "Three"] {
            comment(&http, &a.url, &id, body).await;
        }
        saved().await;

        a.kill();
        eventually("B serves A's design", || async {
            comments(&http, &b.url, &id).await
                == Some(vec!["One".into(), "Two".into(), "Three".into()])
        })
        .await;
        eventually("B lists A's design", || async {
            b.hub.list().iter().any(|d| d.meta.id == id)
        })
        .await;
        b.kill();
    }
}

/// The fencing test. A pauses with an edit not yet saved. B takes over the
/// design and edits it. When A wakes, its save carries its old token, so the
/// store refuses it, and A drops its copy. B's edit survives, and A's
/// unsaved one is lost, as an edit within the save delay is in a crash.
#[tokio::test(flavor = "multi_thread")]
async fn a_paused_owner_cant_overwrite_the_new_owner() {
    for backend in Backend::all() {
        eprintln!("store: {}", backend.name());
        let (a, b) = (Server::start(&backend).await, Server::start(&backend).await);
        settle(&[&a, &b], 2).await;
        let http = client();
        let id = create(&http, &a.url, "Landing").await;
        comment(&http, &a.url, &id, "Saved").await;
        saved().await;
        a.pause(true);
        comment(&http, &a.url, &id, "Lost").await;

        // A's lease runs out, so B takes the design over.
        eventually("B serves the design", || async {
            comments(&http, &b.url, &id).await == Some(vec!["Saved".into()])
        })
        .await;
        comment(&http, &b.url, &id, "Fresh").await;
        saved().await;

        // A wakes up and tries to save what it has: "Saved" and "Lost".
        a.pause(false);
        settle(&[&a, &b], 2).await;
        saved().await;
        saved().await;
        assert_eq!(
            stored_comments(b.store.as_ref(), &id),
            ["Saved", "Fresh"],
            "the store has B's edit and not A's stale copy"
        );
        // Whichever server owns it now serves B's edit.
        eventually("the owner serves B's edit", || async {
            let owner = a.hub.cluster().owner_url(&id).unwrap().to_owned();
            comments(&http, &owner, &id).await == Some(vec!["Saved".into(), "Fresh".into()])
        })
        .await;
        a.kill();
        b.kill();
    }
}

/// A router following the same heartbeats sends each request to the live
/// owner. A viewer whose server dies is disconnected, reconnects through the
/// router, and finds the design on the survivor.
#[tokio::test(flavor = "multi_thread")]
async fn the_router_follows_a_moved_design() {
    for backend in Backend::all() {
        eprintln!("store: {}", backend.name());
        let (a, b) = (Server::start(&backend).await, Server::start(&backend).await);
        settle(&[&a, &b], 2).await;
        let watcher = backend.connect("http://router");
        let members = Arc::new(Members::fixed(Cluster::observer(watcher.live().unwrap())));
        cluster::follow(members.clone(), watcher, LEASE.every());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let front = format!("http://{}", listener.local_addr().unwrap());
        let routes = router::app_with_members(members.clone(), None, None);
        tokio::spawn(async move { axum::serve(listener, routes).await });

        let http = client();
        let id = create(&http, &front, "Landing").await;
        comment(&http, &front, &id, "Hello").await;
        saved().await;
        let owner = members.now().owner_url(&id).unwrap().to_owned();
        let (dying, survivor) = if owner == a.url { (&a, &b) } else { (&b, &a) };

        let ws = format!("{front}/api/designs/{id}/ws").replacen("http://", "ws://", 1);
        let (mut viewer, _) = tokio_tungstenite::connect_async(&ws).await.unwrap();
        let Some(Ok(Message::Text(first))) = viewer.next().await else {
            panic!("no snapshot")
        };
        let first: Value = serde_json::from_str(first.as_str()).unwrap();
        assert_eq!(bodies(&first["snapshot"]), ["Hello"]);

        dying.kill();
        // The dead server's copy sends its viewers away once its lease lapses.
        let closed = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                match viewer.next().await {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(_)) => continue,
                }
            }
        })
        .await;
        assert!(closed.is_ok(), "the viewer was disconnected");

        eventually("the router sends the design to the survivor", || async {
            comments(&http, &front, &id).await == Some(vec!["Hello".into()])
        })
        .await;
        assert_eq!(members.now().owner_url(&id), Some(survivor.url.as_str()));
        let (mut viewer, _) = tokio_tungstenite::connect_async(&ws).await.unwrap();
        let Some(Ok(Message::Text(first))) = viewer.next().await else {
            panic!("no snapshot")
        };
        let first: Value = serde_json::from_str(first.as_str()).unwrap();
        assert_eq!(bodies(&first["snapshot"]), ["Hello"], "the viewer is back");
        survivor.kill();
    }
}
