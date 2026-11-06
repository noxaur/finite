//! People edit a design from their browser tab over its WebSocket: a
//! gesture's edits come back to every viewer as one change with the tab's
//! stamp, a refused one comes back to that tab alone as `settled`, and undo
//! reverses only the person's own work. It runs through the router too,
//! which passes the tab's messages on to the server.

use std::{collections::BTreeMap, sync::Arc};

use finite_design::edit::{self, NewArtboard};
use finite_server::{
    Hub, app,
    hub::Actor,
    store::MemoryStore,
    testing::{front_for, listen, serve},
};
use futures::{SinkExt, StreamExt};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The next message on the socket that isn't presence.
async fn next(socket: &mut Socket) -> Value {
    loop {
        if let Message::Text(text) = socket.next().await.unwrap().unwrap() {
            let message: Value = serde_json::from_str(&text).unwrap();
            if message["type"] != "presence" {
                return message;
            }
        }
    }
}

fn mutate(mid: u64, edits: Value) -> Message {
    let message = json!({
        "type": "mutate",
        "author": { "id": "p1", "name": "Per" },
        "stamp": { "client": "tab", "mid": mid },
        "edits": edits,
    });
    Message::text(message.to_string())
}

#[tokio::test]
async fn a_tab_edits_and_undoes_its_own_work() {
    let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
    let id = hub.create("People").meta.id;
    let handle = hub.get(&id).unwrap();
    let agent = Actor {
        id: "agent:Claude".into(),
        name: "Claude".into(),
    };
    handle
        .edit(&agent, "Create artboard", |doc| {
            let spec = NewArtboard {
                name: "Home".into(),
                width: 400.0,
                height: Some(300.0),
                position: Some((0.0, 0.0)),
                page: None,
                styles: BTreeMap::new(),
                ..Default::default()
            };
            Ok((edit::create_artboard(doc, "board".into(), spec)?, ()))
        })
        .unwrap();
    let (server, server_url) = listen().await;
    let serving = hub.clone();
    serve(server, app(serving, None));
    let (front, front_url) = listen().await;
    let routes = front_for(vec![server_url.clone()]);
    serve(front, routes);

    for (n, base) in [server_url, front_url].iter().enumerate() {
        let url = format!(
            "{}/api/designs/{id}/ws",
            base.replacen("http://", "ws://", 1)
        );
        let (mut tab, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        let (mut watcher, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
        assert_eq!(next(&mut tab).await["type"], "snapshot");
        assert_eq!(next(&mut watcher).await["type"], "snapshot");

        let x = 100 + n as i64;
        let drag =
            json!([{ "kind": "setPosition", "moves": [{ "id": "board", "x": x, "y": 20 }] }]);
        tab.send(mutate(1, drag)).await.unwrap();
        for socket in [&mut tab, &mut watcher] {
            let change = next(socket).await;
            assert_eq!(change["type"], "change", "{base}");
            assert_eq!(change["actorName"], "Per");
            assert_eq!(change["change"]["actor"], "user:p1");
            assert_eq!(change["change"]["label"], "Move");
            assert_eq!(change["mutation"], json!({ "client": "tab", "mid": 1 }));
        }
        assert_eq!(
            handle.read(|d| d.doc().get("board").unwrap().x),
            Some(x as f64)
        );

        // Refused: only the tab hears, with the seq to catch up to first.
        let missing = json!([{ "kind": "delete", "ids": ["gone"] }]);
        tab.send(mutate(2, missing)).await.unwrap();
        let settled = next(&mut tab).await;
        assert_eq!(settled["type"], "settled");
        assert_eq!(settled["mid"], 2);
        assert!(settled["error"].as_str().unwrap().contains("not found"));
        assert_eq!(settled["seq"], handle.read(|d| d.seq()));

        // Undo reverses the person's move, not the agent's artboard.
        let undo = json!({
            "type": "undo",
            "author": { "id": "p1", "name": "Per" },
            "stamp": { "client": "tab", "mid": 3 },
        });
        tab.send(Message::text(undo.to_string())).await.unwrap();
        let undone = next(&mut watcher).await;
        assert_eq!(undone["change"]["origin"], "undo");
        assert_eq!(next(&mut tab).await["mutation"]["mid"], 3);
        let board = handle.read(|d| d.doc().get("board").cloned()).unwrap();
        assert_eq!(board.x, Some(0.0));
        tab.close(None).await.unwrap();
        watcher.close(None).await.unwrap();
    }
}
