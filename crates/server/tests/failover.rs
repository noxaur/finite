//! Failover with real processes: two `finite-server`s over one Postgres
//! database and a `finite-server router` in front, all started from the
//! built binary. One server is killed with `SIGKILL`, or frozen with
//! `SIGSTOP` and thawed with `SIGCONT`, and the router keeps serving its
//! designs from the other.
//!
//! These need Postgres: build with `--features postgres` and set
//! `FINITE_TEST_DATABASE_URL`. Without the variable they skip.
#![cfg(all(unix, feature = "postgres"))]

use std::{
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

use finite_server::postgres::test_database;
use serde_json::{Value, json};

/// Every process gets the same short lease, so a dead server's designs move
/// within about a second and a half.
const LEASE_MS: u64 = 1000;

struct Process {
    child: Child,
    url: String,
}

impl Process {
    fn signal(&self, signal: &str) -> bool {
        Command::new("kill")
            .args([signal, &self.child.id().to_string()])
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|s| s.success())
    }
}

impl Drop for Process {
    fn drop(&mut self) {
        // A frozen process can't die until it's thawed.
        self.signal("-CONT");
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn start(database: &str, router: bool) -> Process {
    let port = free_port();
    let url = format!("http://127.0.0.1:{port}");
    let mut command = Command::new(env!("CARGO_BIN_EXE_finite-server"));
    if router {
        command.arg("router");
    }
    let child = command
        .env("FINITE_DATABASE_URL", database)
        .env("FINITE_PORT", port.to_string())
        .env("FINITE_NODE_URL", &url)
        .env("FINITE_LEASE_MS", LEASE_MS.to_string())
        .env("RUST_LOG", "warn")
        .env_remove("FINITE_NODES")
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    Process { child, url }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .pool_max_idle_per_host(0)
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap()
}

async fn eventually<F: Future<Output = bool>>(what: &str, mut check: impl FnMut() -> F) {
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(20) {
        if check().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting until {what}");
}

/// Two servers and a router, once the router sees both servers.
async fn deployment(database: &str) -> (Process, Process, Process) {
    let (a, b) = (start(database, false), start(database, false));
    let router = start(database, true);
    let http = client();
    let urls = [a.url.clone(), b.url.clone()];
    eventually("the router sees both servers", || async {
        // Each server owns about half the ids, so 20 ids reach both.
        let mut owners = std::collections::HashSet::new();
        for i in 0..20 {
            let Ok(res) = http
                .get(format!("{}/api/owner/probe{i}", router.url))
                .send()
                .await
            else {
                return false;
            };
            let Ok(body) = res.json::<Value>().await else {
                return false;
            };
            if let Some(owner) = body["owner"].as_str() {
                owners.insert(owner.to_owned());
            }
        }
        owners.len() == 2 && urls.iter().all(|u| owners.contains(u))
    })
    .await;
    (a, b, router)
}

async fn owner(http: &reqwest::Client, router: &str, id: &str) -> Option<String> {
    let body: Value = http
        .get(format!("{router}/api/owner/{id}"))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    body["owner"].as_str().map(String::from)
}

/// Creates designs through the router until one lands on `on`.
async fn design_on(http: &reqwest::Client, router: &str, on: &str) -> String {
    for _ in 0..20 {
        let created: Value = http
            .post(format!("{router}/api/designs"))
            .json(&json!({ "name": "Landing" }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let id = created["id"].as_str().unwrap().to_owned();
        if owner(http, router, &id).await.as_deref() == Some(on) {
            return id;
        }
    }
    panic!("no design landed on {on}");
}

async fn comment(http: &reqwest::Client, base: &str, id: &str, body: &str) {
    let res = http
        .post(format!("{base}/api/designs/{id}/comments"))
        .json(&json!({ "author": { "id": "1", "name": "Per" }, "body": body, "x": 1, "y": 2 }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 201, "commenting through {base}");
}

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
    Some(
        snapshot["comments"]
            .as_array()?
            .iter()
            .filter_map(|c| c["messages"][0]["body"].as_str().map(String::from))
            .collect(),
    )
}

/// Longer than the 250 ms save delay.
async fn saved() {
    tokio::time::sleep(Duration::from_millis(600)).await;
}

/// `kill -9` on a server: its designs move to the other, with every edit
/// saved before the kill, and the router sends requests there.
#[tokio::test(flavor = "multi_thread")]
async fn killing_a_server_moves_its_designs() {
    let Some(database) = test_database() else {
        return;
    };
    let (mut a, b, router) = deployment(&database).await;
    let http = client();
    let id = design_on(&http, &router.url, &a.url).await;
    let sent: Vec<String> = (1..=5).map(|n| format!("Edit {n}")).collect();
    for body in &sent {
        comment(&http, &router.url, &id, body).await;
    }
    saved().await;

    a.child.kill().unwrap();
    a.child.wait().unwrap();
    let killed = Instant::now();
    eventually("the router serves the design from B", || async {
        comments(&http, &router.url, &id).await.as_ref() == Some(&sent)
    })
    .await;
    assert_eq!(owner(&http, &router.url, &id).await, Some(b.url.clone()));
    eprintln!("the design moved {:?} after the kill", killed.elapsed());
}

/// `SIGSTOP` on the owner with an edit still unsaved, `SIGCONT` after the
/// other server took over and edited. The woken server's save carries an old
/// fencing token, so it can't overwrite the new owner's edit.
#[tokio::test(flavor = "multi_thread")]
async fn a_frozen_owner_cant_overwrite_the_new_owner() {
    let Some(database) = test_database() else {
        return;
    };
    let (a, b, router) = deployment(&database).await;
    let http = client();
    let id = design_on(&http, &router.url, &a.url).await;
    comment(&http, &router.url, &id, "Saved").await;
    saved().await;
    // Straight to A, then freeze it before its save delay is up.
    comment(&http, &a.url, &id, "Lost").await;
    assert!(a.signal("-STOP"));

    eventually("B serves the design", || async {
        comments(&http, &router.url, &id).await == Some(vec!["Saved".into()])
    })
    .await;
    assert_eq!(owner(&http, &router.url, &id).await, Some(b.url.clone()));
    comment(&http, &router.url, &id, "Fresh").await;
    saved().await;

    assert!(a.signal("-CONT"));
    // A rejoins, and may own the design again, after B lets it go.
    let mut owners = std::collections::HashSet::new();
    let woke = Instant::now();
    while woke.elapsed() < Duration::from_millis(4 * LEASE_MS) {
        if let Some(found) = comments(&http, &router.url, &id).await {
            assert_eq!(found, ["Saved", "Fresh"], "B's edit stays, and A's is gone");
        }
        if let Some(owner) = owner(&http, &router.url, &id).await {
            owners.insert(owner);
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        owners.contains(&a.url),
        "A came back and took the design back"
    );
    eventually("the design is served after the move back", || async {
        comments(&http, &router.url, &id).await == Some(vec!["Saved".into(), "Fresh".into()])
    })
    .await;
    drop(b);
}
