//! Two servers side by side: each creates and serves only the designs it
//! owns, and points requests for the other's designs at their owner.

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use finite_server::{Hub, app, cluster::Cluster, store::MemoryStore};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const NODES: [&str; 2] = ["http://a:4100", "http://b:4100"];

fn node(me: usize) -> Router {
    let cluster = Cluster::new(NODES.map(String::from).to_vec(), me).unwrap();
    let hub = Hub::with_cluster(Arc::new(MemoryStore::default()), cluster).unwrap();
    app(hub, None)
}

async fn call(app: &Router, req: Request<Body>) -> (StatusCode, Option<String>, Value) {
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let owner = res
        .headers()
        .get("finite-owner")
        .map(|v| v.to_str().unwrap().to_owned());
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        owner,
        serde_json::from_slice(&bytes).unwrap_or_default(),
    )
}

fn get(path: &str) -> Request<Body> {
    Request::get(path).body(Body::empty()).unwrap()
}

#[tokio::test]
async fn each_server_serves_only_its_designs() {
    let (a, b) = (node(0), node(1));

    // Every design A creates is one A owns.
    let mut ids = Vec::new();
    for _ in 0..20 {
        let req = Request::post("/api/designs")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({ "name": "Landing" }).to_string()))
            .unwrap();
        let (status, _, created) = call(&a, req).await;
        assert_eq!(status, StatusCode::CREATED);
        ids.push(created["id"].as_str().unwrap().to_owned());
    }

    for id in &ids {
        let (status, _, _) = call(&a, get(&format!("/api/designs/{id}"))).await;
        assert_eq!(status, StatusCode::OK);

        // B doesn't have it, and says who does.
        let (status, owner, _) = call(&b, get(&format!("/api/designs/{id}"))).await;
        assert_eq!(status, StatusCode::MISDIRECTED_REQUEST);
        assert_eq!(owner.as_deref(), Some(NODES[0]));

        // Any server answers where a design lives.
        let (_, _, from_b) = call(&b, get(&format!("/api/owner/{id}"))).await;
        let (_, _, from_a) = call(&a, get(&format!("/api/owner/{id}"))).await;
        assert_eq!(from_b["owner"], NODES[0]);
        assert_eq!(from_a["owner"], Value::Null);
    }
}

/// When a server joins, the designs it now owns move to it from the server
/// that used to own them.
#[tokio::test]
async fn designs_move_to_their_new_owner() {
    use finite_server::store::Store;
    use tokio::net::TcpListener;

    // One server on its own creates a dozen designs.
    let old_store = Arc::new(MemoryStore::default());
    let solo = Hub::new(old_store.clone()).unwrap();
    let ids: Vec<String> = (0..12)
        .map(|i| solo.create(&format!("D{i}")).meta.id)
        .collect();
    solo.flush();
    drop(solo);

    // Then a second server joins.
    let a = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let b = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let nodes: Vec<String> = [&a, &b]
        .map(|l| format!("http://{}", l.local_addr().unwrap()))
        .to_vec();
    let cluster = |me| Cluster::new(nodes.clone(), me).unwrap();
    let new_hub = Hub::with_cluster(Arc::new(MemoryStore::default()), cluster(1)).unwrap();
    tokio::spawn(async move { axum::serve(b, app(new_hub, None)).await });
    let old_hub = Hub::with_cluster(old_store.clone(), cluster(0)).unwrap();
    tokio::spawn(async move { axum::serve(a, app(old_hub, None)).await });

    let moving: Vec<&String> = ids.iter().filter(|id| cluster(0).owner(id) == 1).collect();
    assert!(!moving.is_empty(), "some designs hash to the new server");
    let http = reqwest::Client::new();
    for _ in 0..50 {
        let left = old_store.ids().unwrap();
        if moving.iter().all(|id| !left.contains(id)) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    for id in &ids {
        let owner = &nodes[cluster(0).owner(id)];
        let res = http
            .get(format!("{owner}/api/designs/{id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200, "{id} is served by its owner");
        let moved = moving.contains(&id);
        assert_eq!(!old_store.ids().unwrap().contains(id), moved, "{id}");
    }
}

/// If the new owner can't be reached, nothing is deleted.
#[tokio::test]
async fn designs_stay_put_while_the_new_owner_is_down() {
    use finite_server::store::Store;

    let store = Arc::new(MemoryStore::default());
    let solo = Hub::new(store.clone()).unwrap();
    let ids: Vec<String> = (0..12)
        .map(|i| solo.create(&format!("D{i}")).meta.id)
        .collect();
    solo.flush();
    drop(solo);

    // Port 9 (discard) refuses connections on a normal machine.
    let nodes = vec![
        "http://127.0.0.1:4100".to_owned(),
        "http://127.0.0.1:9".to_owned(),
    ];
    let _hub = Hub::with_cluster(store.clone(), Cluster::new(nodes, 0).unwrap()).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let mut kept = store.ids().unwrap();
    kept.sort();
    let mut all = ids.clone();
    all.sort();
    assert_eq!(kept, all);
}
