//! People rename a design from the canvas's sidebar over REST.

use std::sync::Arc;

use axum::{
    body::Body,
    http::{Request, header},
};
use finite_server::{Hub, app, store::MemoryStore};
use serde_json::json;
use tower::ServiceExt;

#[tokio::test]
async fn a_person_renames_a_design() {
    let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
    let id = hub.create("Draft").meta.id;
    let app = app(hub.clone(), None);
    let rename = |name: &str| {
        Request::builder()
            .method("PATCH")
            .uri(format!("/api/designs/{id}"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({ "name": name }).to_string()))
            .unwrap()
    };

    let res = app
        .clone()
        .oneshot(rename("  Checkout flow  "))
        .await
        .unwrap();
    assert_eq!(res.status(), 204);
    let handle = hub.get(&id).unwrap();
    assert_eq!(handle.summary().meta.name, "Checkout flow");

    // An empty name is "Untitled", as it is for agents.
    app.clone().oneshot(rename("")).await.unwrap();
    assert_eq!(handle.summary().meta.name, "Untitled");

    let missing = Request::builder()
        .method("PATCH")
        .uri("/api/designs/nope000000")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(json!({ "name": "X" }).to_string()))
        .unwrap();
    assert_eq!(app.oneshot(missing).await.unwrap().status(), 404);
}
