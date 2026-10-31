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
