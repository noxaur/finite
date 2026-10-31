//! Two servers behind the router, over real sockets: designs created through
//! the router spread across both servers, and every request and WebSocket
//! reaches the right one.

use std::sync::Arc;

use finite_server::{Hub, app, cluster::Cluster, router, store::MemoryStore};
use futures::StreamExt;
use serde_json::{Value, json};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

async fn listen() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    (listener, url)
}

/// Starts two servers and a router in front of them. Returns the router's URL
/// and the servers' URLs.
async fn deployment() -> (String, Vec<String>) {
    let (a, a_url) = listen().await;
    let (b, b_url) = listen().await;
    let nodes = vec![a_url, b_url];
    for (me, listener) in [a, b].into_iter().enumerate() {
        let cluster = Cluster::new(nodes.clone(), me).unwrap();
        let hub = Hub::with_cluster(Arc::new(MemoryStore::default()), cluster).unwrap();
        tokio::spawn(async move { axum::serve(listener, app(hub, None)).await });
    }
    let (front, front_url) = listen().await;
    let routes = router::app(nodes.clone(), None);
    tokio::spawn(async move { axum::serve(front, routes).await });
    (front_url, nodes)
}

async fn first_text(url: &str) -> Value {
    let ws = url.replacen("http://", "ws://", 1);
    let (mut socket, _) = tokio_tungstenite::connect_async(ws).await.unwrap();
    match socket.next().await.unwrap().unwrap() {
        Message::Text(text) => serde_json::from_str(text.as_str()).unwrap(),
        other => panic!("expected text, got {other:?}"),
    }
}

#[tokio::test]
async fn the_router_makes_two_servers_look_like_one() {
    let (front, nodes) = deployment().await;
    let http = reqwest::Client::new();

    let mut ids = Vec::new();
    for i in 0..6 {
        let created: Value = http
            .post(format!("{front}/api/designs"))
            .json(&json!({ "name": format!("Design {i}") }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        ids.push(created["id"].as_str().unwrap().to_owned());
    }

    // Creation takes turns, so both servers hold designs.
    for node in &nodes {
        let own: Vec<Value> = http
            .get(format!("{node}/api/designs"))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        assert_eq!(own.len(), 3, "{node} holds half the designs");
    }

    // The router's list merges both.
    let all: Vec<Value> = http
        .get(format!("{front}/api/designs"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(all.len(), 6);

    for id in &ids {
        // Plain requests reach the owner.
        let res = http
            .get(format!("{front}/api/designs/{id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200, "{id}");

        // So do comments, which carry a body.
        let res = http
            .post(format!("{front}/api/designs/{id}/comments"))
            .json(
                &json!({ "author": { "id": "u1", "name": "Guest" }, "body": "Hi", "x": 1, "y": 2 }),
            )
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 201, "{id}");

        // And the design's WebSocket, which starts with its snapshot.
        let first = first_text(&format!("{front}/api/designs/{id}/ws")).await;
        assert_eq!(first["type"], "snapshot");
        assert_eq!(first["snapshot"]["meta"]["id"], id.as_str());
        assert_eq!(first["snapshot"]["comments"].as_array().unwrap().len(), 1);
    }

    // The design list's WebSocket starts with every server's designs, then
    // relays new ones from whichever server creates them.
    let ws = format!("{front}/api/designs/ws").replacen("http://", "ws://", 1);
    let (mut lobby, _) = tokio_tungstenite::connect_async(ws).await.unwrap();
    let mut next = async || match lobby.next().await.unwrap().unwrap() {
        Message::Text(text) => serde_json::from_str::<Value>(text.as_str()).unwrap(),
        other => panic!("expected text, got {other:?}"),
    };
    let first = next().await;
    assert_eq!(first["type"], "designs");
    assert_eq!(first["designs"].as_array().unwrap().len(), 6);
    for name in ["Seventh", "Eighth"] {
        http.post(format!("{front}/api/designs"))
            .json(&json!({ "name": name }))
            .send()
            .await
            .unwrap();
        let update = next().await;
        assert_eq!(update["type"], "design");
        assert_eq!(update["design"]["name"], name);
    }
}
