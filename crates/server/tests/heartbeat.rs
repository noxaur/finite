//! Sockets whose browser went quiet close; sockets whose browser answers
//! pings stay open, and the web app's own pings get an answer. Tokio's clock
//! is paused, so a minute passes instantly.
//!
//! The clock runs while sockets connect, though. A paused clock jumps to the
//! next timer whenever every task is waiting on a socket, so the router's
//! 5-second limit on connecting to a server would run out at once.

use std::sync::Arc;

use finite_server::{
    Hub, app,
    heartbeat::{PING, PING_EVERY, PONG, SILENT_FOR},
    router,
    store::MemoryStore,
};
use futures::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

async fn listen() -> (TcpListener, String) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    (listener, url)
}

#[tokio::test]
async fn quiet_sockets_close_and_answering_ones_stay_open() {
    let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
    let id = hub.create("Pinged").meta.id;
    let (server, server_url) = listen().await;
    tokio::spawn(async move { axum::serve(server, app(hub, None)).await });
    let (front, front_url) = listen().await;
    let routes = router::app(vec![server_url.replacen("ws://", "http://", 1)], None);
    tokio::spawn(async move { axum::serve(front, routes).await });

    for base in [&server_url, &front_url] {
        for path in [
            format!("/api/designs/{id}/ws"),
            "/api/designs/ws".to_owned(),
        ] {
            let url = format!("{base}{path}");
            // This one reads the first message and then stops reading, so it
            // never answers a ping, like a browser that went to sleep.
            let (mut quiet, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            quiet.next().await.unwrap().unwrap();
            // This one keeps reading, and tungstenite answers each ping.
            let (mut live, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            let live = tokio::spawn(async move { while let Some(Ok(_)) = live.next().await {} });

            tokio::time::pause();
            tokio::time::sleep(SILENT_FOR + PING_EVERY * 2).await;

            let closed = tokio::time::timeout(PING_EVERY * 10, async {
                loop {
                    match quiet.next().await {
                        Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                        Some(Ok(_)) => {}
                    }
                }
            })
            .await;
            assert!(closed.is_ok(), "{url}: a silent client should be closed");
            assert!(
                !live.is_finished(),
                "{url}: an answering client should stay open"
            );
            live.abort();
            tokio::time::resume();

            // The web app's own ping gets an answer.
            let (mut app, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
            app.next().await.unwrap().unwrap();
            app.send(Message::text(PING)).await.unwrap();
            let answer = loop {
                if let Message::Text(text) = app.next().await.unwrap().unwrap() {
                    break text;
                }
            };
            assert_eq!(answer.as_str(), PONG, "{url}");
        }
    }
}

/// A server behind the router that sends its design list and then goes
/// silent without closing, like a machine that lost power. Servers ping every
/// `PING_EVERY`, so after `SILENT_FOR` the router closes the browser's list,
/// and the browser reconnects to a fresh one.
#[tokio::test]
async fn the_router_closes_a_design_list_whose_server_went_silent() {
    use axum::extract::ws::{Message as WsMessage, WebSocketUpgrade};
    let (server, server_url) = listen().await;
    let silent = axum::Router::new().route(
        "/api/designs/ws",
        axum::routing::get(|ws: WebSocketUpgrade| async move {
            ws.on_upgrade(|mut socket| async move {
                let list = r#"{"type":"designs","designs":[],"total":0}"#;
                let _ = socket.send(WsMessage::text(list)).await;
                std::future::pending::<()>().await;
            })
        }),
    );
    tokio::spawn(async move { axum::serve(server, silent).await });
    let (front, front_url) = listen().await;
    let routes = router::app(vec![server_url.replacen("ws://", "http://", 1)], None);
    tokio::spawn(async move { axum::serve(front, routes).await });

    // The browser keeps reading, so it answers the router's pings.
    let (mut browser, _) = tokio_tungstenite::connect_async(format!("{front_url}/api/designs/ws"))
        .await
        .unwrap();
    browser.next().await.unwrap().unwrap();
    tokio::time::pause();
    let closed = tokio::time::timeout(SILENT_FOR + PING_EVERY * 2, async {
        loop {
            match browser.next().await {
                Some(Ok(Message::Close(_)) | Err(_)) | None => break,
                Some(Ok(_)) => {}
            }
        }
    })
    .await;
    assert!(
        closed.is_ok(),
        "the list stayed open with its server silent"
    );
}
