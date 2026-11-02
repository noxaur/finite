//! Imports and exports through the server: the bytes land in the blob store,
//! the import's record and nodes are journaled together, and both survive a
//! restart.

use std::sync::Arc;

use finite_server::{
    Hub,
    hub::Actor,
    store::{FileStore, MemoryStore, Store},
    transfer::{self, ImportRequest, TransferError},
};
use finite_transfer::{Axis, Format, Scope};

const PAGE: &str = "<div data-name=\"Card\"><button onclick=\"steal()\">Go</button></div>";

fn agent() -> Actor {
    Actor {
        id: "agent:test".into(),
        name: "Test".into(),
    }
}

fn request(strict: Vec<Axis>) -> ImportRequest {
    ImportRequest {
        format: Format::Html,
        bytes: PAGE.as_bytes().to_vec(),
        file_name: Some("card.html".into()),
        strict,
    }
}

#[tokio::test]
async fn an_import_keeps_its_bytes_and_survives_a_restart() {
    let dir = std::env::temp_dir().join(format!("finite-transfer-{}", uuid::Uuid::new_v4()));
    let store = Arc::new(FileStore::new(&dir).unwrap());
    let hub = Hub::new(store.clone()).unwrap();
    let id = hub.create("Imports").meta.id;

    let result = transfer::import(&hub, &id, &agent(), request(Vec::new()))
        .await
        .unwrap();
    assert_eq!(result.artboards.len(), 1);
    assert_eq!(result.import.quarantined[0].what, "onclick");
    assert!(store.has_blob(&result.import.artifact).unwrap());

    let (record, bytes) = transfer::original(&hub, &id, &result.import.id)
        .await
        .unwrap();
    assert_eq!(record, result.import);
    assert_eq!(bytes, PAGE.as_bytes());

    let exported = transfer::export(
        &hub,
        &id,
        Format::Html,
        Scope::Artboard(result.artboards[0].clone()),
    )
    .await
    .unwrap();
    assert_eq!(exported.file_name, "card.html");
    let page = String::from_utf8(exported.bytes).unwrap();
    assert!(page.contains("data-name=\"Card\""), "{page}");
    assert!(!page.contains("onclick"), "{page}");

    // After a restart, the record and the nodes are both still there.
    hub.flush();
    drop((hub, store));
    let hub = Hub::new(Arc::new(FileStore::new(&dir).unwrap())).unwrap();
    let (record, bytes) = transfer::original(&hub, &id, &result.import.id)
        .await
        .unwrap();
    assert_eq!(record, result.import);
    assert_eq!(bytes, PAGE.as_bytes());
    let handle = hub.open(&id).await.unwrap();
    assert!(handle.read(|d| d.doc().contains(&result.artboards[0])));
    std::fs::remove_dir_all(&dir).unwrap();
}

#[tokio::test]
async fn strict_mode_refuses_before_anything_is_stored() {
    let store = Arc::new(MemoryStore::default());
    let hub = Hub::new(store.clone()).unwrap();
    let id = hub.create("Strict").meta.id;

    let error = transfer::import(&hub, &id, &agent(), request(vec![Axis::Editable]))
        .await
        .unwrap_err();
    assert!(
        matches!(&error, TransferError::Invalid(m) if m.contains("onclick")),
        "{error}"
    );
    let handle = hub.open(&id).await.unwrap();
    assert!(handle.read(|d| d.doc().is_empty() && d.imports().is_empty()));
    let hash = finite_server::blob::BlobHash::of(PAGE.as_bytes());
    assert!(!store.has_blob(&hash).unwrap());

    // Preserved is a yes for quarantined content, so that much strictness passes.
    transfer::import(&hub, &id, &agent(), request(vec![Axis::Preserved]))
        .await
        .unwrap();
}

#[tokio::test]
async fn exporting_something_that_isnt_an_artboard_fails() {
    let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
    let id = hub.create("Empty").meta.id;
    let error = transfer::export(&hub, &id, Format::Html, Scope::Artboard("nope".into()))
        .await
        .unwrap_err();
    assert!(matches!(error, TransferError::Invalid(_)), "{error}");
}
