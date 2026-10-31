//! Records one of every WebSocket message in `fixtures/messages.json`. The web
//! app decodes each one with its schemas (`apps/web/src/design/wire.test.ts`),
//! so a renamed or retyped field in the Rust types fails the web tests instead
//! of failing silently in the browser.
//!
//! Ids and timestamps are replaced with fixed values so the file only changes
//! when the format does. After changing a message type, regenerate it with
//! `FINITE_UPDATE_FIXTURES=1 cargo test -p finite-server --test wire`.

use std::{collections::BTreeMap, fs, path::PathBuf, sync::Arc};

use finite_design::{
    comment::{Anchor, Author, AuthorKind},
    edit::{self, NewArtboard, WriteMode},
};
use finite_server::{
    Hub,
    hub::{Actor, Outgoing},
    store::MemoryStore,
};
use serde_json::{Value, json};
use tokio::sync::broadcast::Receiver;

/// Keys whose values vary between runs.
const TIMESTAMPS: &[&str] = &["at", "createdAt", "updatedAt"];

fn drain(rx: &mut Receiver<Outgoing>) -> Vec<Value> {
    std::iter::from_fn(|| rx.try_recv().ok())
        .map(|m| serde_json::from_str(&m.json).unwrap())
        .collect()
}

fn normalize(value: &mut Value, ids: &[(String, &str)]) {
    match value {
        Value::Object(map) => {
            for (key, v) in map.iter_mut() {
                if TIMESTAMPS.contains(&key.as_str()) && v.is_number() {
                    *v = json!(0);
                } else {
                    normalize(v, ids);
                }
            }
        }
        Value::Array(items) => items.iter_mut().for_each(|v| normalize(v, ids)),
        Value::String(s) => {
            for (from, to) in ids {
                if s == from {
                    *s = (*to).to_owned();
                }
            }
        }
        _ => {}
    }
}

#[tokio::test]
async fn wire_messages_match_the_fixture() {
    let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
    let (lobby_first, mut lobby) = hub.subscribe_lobby();
    let summary = hub.create("Landing");
    let handle = hub.get(&summary.meta.id).unwrap();
    let (design_first, _, mut events) = handle.subscribe();

    let agent = Actor {
        id: "agent:Claude".into(),
        name: "Claude".into(),
    };
    let mut n = 0;
    let mut new_id = move || {
        n += 1;
        format!("n{n}")
    };
    handle
        .edit(&agent, "Create artboard", |doc| {
            let spec = NewArtboard {
                name: "Home".into(),
                width: 1440.0,
                height: 900.0,
                position: None,
                styles: BTreeMap::new(),
            };
            Ok((edit::create_artboard(doc, "board".into(), spec)?, ()))
        })
        .unwrap();
    handle
        .edit(&agent, "Write HTML", |doc| {
            let html = r#"<button data-name="CTA" style="padding: 12px">Start</button>"#;
            edit::write_html(doc, "board", html, WriteMode::Append, None, &mut new_id)
        })
        .unwrap();
    handle.set_presence(&agent, vec!["n1".into()], Some("Styling the CTA".into()));
    let user = Author {
        id: "user:1".into(),
        name: "Guest".into(),
        kind: AuthorKind::User,
    };
    let anchor = Anchor {
        artboard_id: Some("board".into()),
        node_id: Some("n1".into()),
        x: 24.0,
        y: 16.0,
    };
    let comment = handle.add_comment(user, anchor, "Make it orange").unwrap();
    handle
        .edit(&agent, "Update styles", |doc| {
            let styles = BTreeMap::from([("background".to_owned(), Some("orange".to_owned()))]);
            Ok((edit::update_styles(doc, &["n1".into()], &styles)?, ()))
        })
        .unwrap();
    handle.undo(&agent).unwrap();
    let reply = Author {
        id: agent.id.clone(),
        name: agent.name.clone(),
        kind: AuthorKind::Agent,
    };
    handle
        .reply(
            &comment.id,
            reply,
            "Tried orange, then undid it",
            Some(true),
        )
        .unwrap();
    handle.rename("Landing v2".into());

    let first = |o: Outgoing| serde_json::from_str::<Value>(&o.json).unwrap();
    let mut design = vec![first(design_first)];
    design.extend(drain(&mut events));
    let mut lobby_messages = vec![first(lobby_first)];
    lobby_messages.extend(drain(&mut lobby));
    let mut messages = json!({
        "about": "One of each WebSocket message, recorded from crates/server/tests/wire.rs. apps/web/src/design/wire.test.ts decodes them with the web app's schemas.",
        "design": design,
        "lobby": lobby_messages,
    });
    let ids = [
        (summary.meta.id.clone(), "design1"),
        (comment.id.clone(), "comment1"),
    ];
    normalize(&mut messages, &ids);

    let types: Vec<&str> = messages["design"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["type"].as_str().unwrap())
        .collect();
    for kind in ["snapshot", "change", "presence", "comment", "meta"] {
        assert!(types.contains(&kind), "no {kind} message recorded");
    }

    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/messages.json");
    if std::env::var_os("FINITE_UPDATE_FIXTURES").is_some() {
        fs::write(
            &path,
            serde_json::to_string_pretty(&messages).unwrap() + "\n",
        )
        .unwrap();
        return;
    }
    let stored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        messages, stored,
        "the wire format changed; regenerate the fixture"
    );
}
