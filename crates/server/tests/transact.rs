//! Several edits as one change through the hub (`DesignHandle::transact`):
//! one broadcast, one journal record, and two agents' transactions taking
//! turns under the design's lock.

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use finite_design::{
    Op, PropKey, Record,
    edit::{self, EditError, NewArtboard, WriteMode},
};
use finite_server::{
    Hub,
    hub::{Actor, DesignHandle, random_id},
    store::{MemoryStore, Store},
};
use serde_json::Value;
use tokio::sync::broadcast;

fn agent(id: &str) -> Actor {
    Actor {
        id: format!("agent:{id}"),
        name: id.into(),
    }
}

fn red() -> BTreeMap<String, Option<String>> {
    BTreeMap::from([("color".to_owned(), Some("red".to_owned()))])
}

/// Writes `<p>{text}</p>` into `board` and colors it, as one transaction
/// whose second step styles the paragraph its first step made.
fn paragraph(
    handle: &DesignHandle,
    actor: &Actor,
    board: &str,
    text: &str,
) -> Result<String, EditError> {
    let mut make_id = || random_id(8);
    let (paragraph, change) = handle.transact(actor, "Add a paragraph", |tx| {
        let (ops, roots) = edit::write_html(
            tx.view(),
            board,
            &format!("<p>{text}</p>"),
            WriteMode::Append,
            None,
            &mut || tx.new_id(&mut make_id),
        )?;
        tx.edit(ops, &mut make_id)?;
        let ops = edit::update_styles(tx.view(), &roots, &red())?;
        tx.edit(ops, &mut make_id)?;
        Ok::<_, EditError>(roots[0].clone())
    })?;
    assert_eq!(
        change.unwrap().ops.len(),
        3,
        "the paragraph, its text, its color"
    );
    Ok(paragraph)
}

/// A design with one artboard, saved, and its handle.
async fn board(hub: &Arc<Hub>) -> (String, Arc<DesignHandle>) {
    let id = hub.create("Transactions").meta.id;
    let handle = hub.open(&id).await.unwrap();
    let artboard = NewArtboard {
        name: "Page".into(),
        width: 600.0,
        height: Some(400.0),
        position: None,
        page: None,
        styles: BTreeMap::new(),
        ..Default::default()
    };
    handle
        .edit(&agent("setup"), "Create artboard", |doc| {
            Ok((edit::create_artboard(doc, "board".into(), artboard)?, ()))
        })
        .unwrap();
    (id, handle)
}

/// The changes broadcast so far, as JSON.
fn broadcast_changes(rx: &mut broadcast::Receiver<finite_server::hub::Outgoing>) -> Vec<Value> {
    std::iter::from_fn(|| rx.try_recv().ok())
        .filter(|message| message.seq.is_some())
        .map(|message| serde_json::from_str::<Value>(&message.json).unwrap()["change"].clone())
        .collect()
}

/// The store's journal for `id` once the save task has written a change
/// past `seq`.
async fn journaled_after(store: &MemoryStore, id: &str, seq: u64) -> Vec<Record> {
    for _ in 0..100 {
        if let Some(stored) = store.load(id).unwrap() {
            let past = stored.journal.iter().any(|r| match r {
                Record::Change { change } => change.seq > seq,
                _ => false,
            });
            if past || stored.snapshot.seq > seq {
                return stored.journal;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("the change wasn't saved");
}

#[tokio::test]
async fn a_transaction_is_broadcast_and_journaled_once_and_survives_a_reload() {
    let store = Arc::new(MemoryStore::default());
    let hub = Hub::new(store.clone()).unwrap();
    let (id, handle) = board(&hub).await;
    let seq = handle.read(|d| d.seq());
    journaled_after(&store, &id, seq - 1).await;
    let (_, _, mut rx) = handle.subscribe();

    let paragraph = paragraph(&handle, &agent("a"), "board", "Hello").unwrap();
    let changes = broadcast_changes(&mut rx);
    assert_eq!(changes.len(), 1, "one broadcast");
    assert_eq!(changes[0]["label"], "Add a paragraph");
    assert_eq!(changes[0]["ops"].as_array().unwrap().len(), 3);

    let journal = journaled_after(&store, &id, seq).await;
    let journaled: Vec<u64> = journal
        .iter()
        .filter_map(|r| match r {
            Record::Change { change } => Some(change.seq),
            _ => None,
        })
        .collect();
    assert_eq!(journaled, [seq + 1], "one journal record");

    // A server that loads the design from the store sees it.
    let reloaded = Hub::new(store.clone()).unwrap();
    let handle = reloaded.open(&id).await.unwrap();
    let color = handle.read(|d| {
        d.doc()
            .get(&paragraph)
            .and_then(|n| n.get(&PropKey::Style("color".into())))
    });
    assert_eq!(color, Some(Value::from("red")));
}

#[tokio::test]
async fn a_failed_transaction_sends_and_saves_nothing() {
    let store = Arc::new(MemoryStore::default());
    let hub = Hub::new(store.clone()).unwrap();
    let (_id, handle) = board(&hub).await;
    let before = handle.read(|d| serde_json::to_string(&d.snapshot_to_save()).unwrap());
    let (_, _, mut rx) = handle.subscribe();
    let failed = handle.transact(&agent("a"), "Broken", |tx| {
        let ops = edit::update_styles(tx.doc(), &["board".into()], &red())?;
        tx.apply(&ops)?;
        tx.apply(&[Op::Delete { id: "gone".into() }])?;
        Ok::<_, EditError>(())
    });
    assert!(failed.is_err());
    assert!(broadcast_changes(&mut rx).is_empty());
    let after = handle.read(|d| serde_json::to_string(&d.snapshot_to_save()).unwrap());
    assert_eq!(after, before);

    // Nor does a dry run, though it says what it would do.
    let (ops, ()) = handle
        .dry_run(&agent("a"), |tx| {
            let ops = edit::update_styles(tx.doc(), &["board".into()], &red())?;
            tx.apply(&ops)?;
            Ok::<_, EditError>(())
        })
        .unwrap();
    assert_eq!(ops.len(), 1);
    assert!(broadcast_changes(&mut rx).is_empty());
    let after = handle.read(|d| serde_json::to_string(&d.snapshot_to_save()).unwrap());
    assert_eq!(after, before);
}

#[tokio::test]
async fn two_agents_transactions_take_turns_and_undo_separately() {
    let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
    let (_id, handle) = board(&hub).await;
    let seq = handle.read(|d| d.seq());
    let (_, _, mut rx) = handle.subscribe();
    let (a, b) = (agent("a"), agent("b"));
    let write = |actor: &Actor| {
        (0..20)
            .map(|i| paragraph(&handle, actor, "board", &format!("{} {i}", actor.name)).unwrap())
            .collect::<Vec<_>>()
    };
    let (mine, theirs) = std::thread::scope(|scope| {
        let a = scope.spawn(|| write(&a));
        let b = scope.spawn(|| write(&b));
        (a.join().unwrap(), b.join().unwrap())
    });
    assert_eq!(handle.read(|d| d.seq()), seq + 40);
    // Each change is one whole transaction by one agent.
    let changes = broadcast_changes(&mut rx);
    assert_eq!(changes.len(), 40);
    for change in &changes {
        assert_eq!(change["ops"].as_array().unwrap().len(), 3);
    }

    // Undoing all of a's transactions leaves b's paragraphs, still red.
    for _ in 0..20 {
        handle.undo(&a, None).unwrap();
    }
    assert!(
        handle.undo(&a, None).is_none(),
        "a has nothing left to undo"
    );
    handle.read(|d| {
        assert!(mine.iter().all(|id| !d.doc().contains(id)));
        for id in &theirs {
            let color = d
                .doc()
                .get(id)
                .unwrap()
                .get(&PropKey::Style("color".into()));
            assert_eq!(color, Some(Value::from("red")));
        }
    });
}
