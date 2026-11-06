//! Records one of every WebSocket message in `fixtures/messages.json`. The web
//! app decodes each one with its schemas (`apps/web/src/design/wire.test.ts`),
//! so a renamed or retyped field in the Rust types fails the web tests instead
//! of failing silently in the browser. It also holds what the browser sends
//! back, the heartbeat's strings and timings, and the design list's size limit.
//!
//! Ids and timestamps are replaced with fixed values so the file only changes
//! when the format does. After changing a message type, regenerate it with
//! `FINITE_UPDATE_FIXTURES=1 cargo test -p finite-server --test wire`.

use std::{collections::BTreeMap, fs, path::PathBuf, sync::Arc};

use finite_design::{
    comment::{Anchor, Audience, Author, AuthorKind},
    edit::{self, NewArtboard, WriteMode},
    user_edit::{Position, UserEdit},
};
use finite_server::{
    Hub, heartbeat,
    hub::{Actor, ClientMessage, DesignMessage, LOBBY_LIMIT, Outgoing, Since, Stamp, UserAuthor},
    store::MemoryStore,
};
use serde_json::{Value, json};
use tokio::sync::broadcast::Receiver;

/// Keys whose values vary between runs.
const TIMESTAMPS: &[&str] = &["at", "createdAt", "updatedAt", "resolvedAt", "editedAt"];

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
                height: Some(900.0),
                position: None,
                page: None,
                styles: BTreeMap::new(),
                ..Default::default()
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
        extra_node_ids: Vec::new(),
        x: 24.0,
        y: 16.0,
    };
    let comment = handle
        .add_comment(user, anchor, Audience::Agents, "Make it orange")
        .unwrap();
    handle
        .edit(&agent, "Update styles", |doc| {
            let styles = BTreeMap::from([("background".to_owned(), Some("orange".to_owned()))]);
            Ok((edit::update_styles(doc, &["n1".into()], &styles)?, ()))
        })
        .unwrap();
    handle.undo(&agent, None).unwrap();
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
    // A comment on an artboard that's then deleted stays pinned where it was.
    handle
        .edit(&agent, "Create artboard", |doc| {
            let spec = NewArtboard {
                name: "Scratch".into(),
                width: 300.0,
                height: Some(200.0),
                position: Some((2000.0, 0.0)),
                page: None,
                styles: BTreeMap::new(),
                ..Default::default()
            };
            Ok((edit::create_artboard(doc, "scratch".into(), spec)?, ()))
        })
        .unwrap();
    let user = Author {
        id: "user:1".into(),
        name: "Guest".into(),
        kind: AuthorKind::User,
    };
    let anchor = Anchor {
        artboard_id: Some("scratch".into()),
        node_id: None,
        extra_node_ids: Vec::new(),
        x: 5.0,
        y: 5.0,
    };
    let scratch_comment = handle
        .add_comment(user, anchor, Audience::Agents, "Remove this?")
        .unwrap();
    handle
        .edit_message(&scratch_comment.id, "user:1", "Remove this artboard?")
        .unwrap();
    handle
        .edit(&agent, "Delete", |doc| {
            Ok((edit::delete(doc, &["scratch".into()])?, ()))
        })
        .unwrap();
    handle
        .edit(&agent, "Set tokens", |doc| {
            let names = ["Light".to_owned(), "Dark".to_owned()];
            let (mut ops, modes) = edit::set_modes(doc, &names, &mut || "mode-dark".into())?;
            let brand = edit::TokenChange::Modes(BTreeMap::from([
                ("Light".to_owned(), Some("orange".to_owned())),
                ("Dark".to_owned(), Some("gold".to_owned())),
            ]));
            ops.extend(edit::set_tokens(doc, &modes, &[("--brand".into(), brand)])?);
            Ok((ops, ()))
        })
        .unwrap();
    // The button becomes a component, and an instance of it removes its padding.
    handle
        .edit(&agent, "Create component", |doc| {
            Ok((edit::create_component(doc, "n1", Some("CTA"), &[])?, ()))
        })
        .unwrap();
    handle
        .edit(&agent, "Insert instance", |doc| {
            let values = [edit::InstanceValues {
                styles: BTreeMap::from([("padding".to_owned(), None)]),
                ..Default::default()
            }];
            edit::insert_instance(doc, "n1", "board", None, None, &values, &mut new_id)
        })
        .unwrap();
    handle.rename("Landing v2".into());
    // A person drags the artboard in their browser tab, then undoes it.
    let person = Actor {
        id: "user:1".into(),
        name: "Guest".into(),
    };
    let stamp = |mid| Stamp {
        client: "tab1".into(),
        mid,
    };
    let drag = [UserEdit::SetPosition {
        moves: vec![Position {
            id: "board".into(),
            x: 40.0,
            y: 80.0,
        }],
    }];
    handle.mutate(&person, &stamp(1), &drag).unwrap().unwrap();
    handle.undo(&person, Some(&stamp(2))).unwrap();
    let user = Author {
        id: "user:1".into(),
        name: "Guest".into(),
        kind: AuthorKind::User,
    };
    let anchor = Anchor {
        artboard_id: None,
        node_id: None,
        extra_node_ids: Vec::new(),
        x: 0.0,
        y: 0.0,
    };
    let stray = handle
        .add_comment(user, anchor, Audience::Agents, "Oops")
        .unwrap();
    handle.delete_comment(&stray.id).unwrap();

    let first = |o: Outgoing| serde_json::from_str::<Value>(&o.json).unwrap();
    let design_first = first(design_first);
    let epoch = design_first["epoch"].as_str().unwrap().to_owned();
    // A viewer that saw the first four changes reconnects and gets the rest.
    let since = Since {
        epoch: epoch.clone(),
        seq: 4,
    };
    let (resumed, _, _) = handle.subscribe_from(Some(&since));
    let mut design = vec![design_first];
    design.extend(drain(&mut events));
    design.push(first(resumed));
    // A viewer that joins now gets the tokens and modes in its snapshot.
    design.push(first(handle.subscribe().0));
    // Only the tab whose mutation changed nothing gets this one.
    let settled = DesignMessage::Settled {
        mid: 3,
        seq: 15,
        error: Some("node \"gone\" not found".into()),
    };
    design.push(serde_json::to_value(settled).unwrap());
    let mut lobby_messages = vec![first(lobby_first)];
    lobby_messages.extend(drain(&mut lobby));
    // What the tab sends back.
    let author = || UserAuthor {
        id: "1".into(),
        name: "Guest".into(),
    };
    let client: Vec<Value> = [
        ClientMessage::Mutate {
            author: author(),
            stamp: stamp(1),
            edits: drag.to_vec(),
        },
        ClientMessage::Undo {
            author: author(),
            stamp: stamp(2),
        },
        ClientMessage::Redo {
            author: author(),
            stamp: stamp(3),
        },
    ]
    .iter()
    .map(|m| serde_json::to_value(m).unwrap())
    .collect();
    let mut messages = json!({
        "about": "One of each WebSocket message, recorded from crates/server/tests/wire.rs. apps/web/src/design/wire.test.ts decodes them with the web app's schemas.",
        "design": design,
        "lobby": lobby_messages,
        "client": client,
        "heartbeat": {
            "ping": heartbeat::PING,
            "pong": heartbeat::PONG,
            "pingEveryMs": heartbeat::PING_EVERY.as_millis(),
            "silentForMs": heartbeat::SILENT_FOR.as_millis(),
        },
        "lobbyLimit": LOBBY_LIMIT,
    });
    let ids = [
        (summary.meta.id.clone(), "design1"),
        (comment.id.clone(), "comment1"),
        (scratch_comment.id.clone(), "comment2"),
        (stray.id.clone(), "comment3"),
        (epoch, "epoch1"),
    ];
    normalize(&mut messages, &ids);

    let types: Vec<&str> = messages["design"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["type"].as_str().unwrap())
        .collect();
    for kind in [
        "snapshot",
        "resume",
        "change",
        "settled",
        "presence",
        "meta",
        "comment",
        "commentDeleted",
    ] {
        assert!(types.contains(&kind), "no {kind} message recorded");
    }
    let lobby_types: Vec<&str> = messages["lobby"]
        .as_array()
        .unwrap()
        .iter()
        .map(|m| m["type"].as_str().unwrap())
        .collect();
    for kind in ["designs", "design"] {
        assert!(
            lobby_types.contains(&kind),
            "no lobby {kind} message recorded"
        );
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
