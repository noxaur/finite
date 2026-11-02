//! Imports and exports through the server: the bytes land in the blob store,
//! the import's record and nodes are journaled together, and both survive a
//! restart.

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use finite_server::{
    Hub, app,
    hub::Actor,
    store::{FileStore, MemoryStore, Store},
    transfer::{self, ImportRequest, TransferError},
};
use finite_transfer::{Axis, Format, Scope};
use http_body_util::BodyExt;
use serde_json::Value;
use tower::ServiceExt;

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

/// Sends `req` and returns the status, the headers and the body.
async fn send(app: &Router, req: Request<Body>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let res = app.clone().oneshot(req).await.unwrap();
    let (parts, body) = res.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes().to_vec();
    (parts.status, parts.headers, bytes)
}

fn post(uri: &str, body: &str) -> Request<Body> {
    Request::post(uri)
        .body(Body::from(body.to_owned()))
        .unwrap()
}

fn get(uri: &str) -> Request<Body> {
    Request::get(uri).body(Body::empty()).unwrap()
}

fn header<'a>(headers: &'a axum::http::HeaderMap, name: &str) -> &'a str {
    headers
        .get(name)
        .unwrap_or_else(|| panic!("no {name} header"))
        .to_str()
        .unwrap()
}

#[tokio::test]
async fn http_imports_exports_and_serves_the_original() {
    let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
    let id = hub.create("Over HTTP").meta.id;
    let app = app(hub.clone(), None);

    let (status, _, body) = send(
        &app,
        post(
            &format!("/api/designs/{id}/import?format=html&name=card.html&strict=preserved"),
            PAGE,
        ),
    )
    .await;
    assert_eq!(
        status,
        StatusCode::CREATED,
        "{}",
        String::from_utf8_lossy(&body)
    );
    let result: Value = serde_json::from_slice(&body).unwrap();
    let board = result["artboards"][0].as_str().unwrap().to_owned();
    let import = result["import"]["id"].as_str().unwrap().to_owned();
    assert_eq!(result["diagnostics"][0]["what"], "onclick");
    let handle = hub.open(&id).await.unwrap();
    assert!(handle.read(|d| d.doc().contains(&board)));

    let (status, _, body) = send(&app, get(&format!("/api/designs/{id}/imports"))).await;
    assert_eq!(status, StatusCode::OK);
    let imports: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(imports[0]["id"], import.as_str());

    let (status, headers, body) = send(
        &app,
        get(&format!(
            "/api/designs/{id}/export?format=html&artboard={board}"
        )),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(header(&headers, "content-type").starts_with("text/html"));
    assert_eq!(
        header(&headers, "content-disposition"),
        "attachment; filename=\"card.html\""
    );
    header(&headers, "finite-diagnostics")
        .parse::<usize>()
        .unwrap();
    let page = String::from_utf8(body).unwrap();
    assert!(page.contains("data-name=\"Card\""), "{page}");

    // The original can be hostile HTML, so it's only ever a download.
    let (status, headers, body) = send(
        &app,
        get(&format!("/api/designs/{id}/imports/{import}/original")),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, PAGE.as_bytes());
    assert_eq!(header(&headers, "content-type"), "application/octet-stream");
    assert!(header(&headers, "content-disposition").starts_with("attachment"));
    assert_eq!(header(&headers, "x-content-type-options"), "nosniff");
    assert_eq!(header(&headers, "content-security-policy"), "sandbox");

    let (status, _, _) = send(
        &app,
        get(&format!("/api/designs/{id}/imports/nope/original")),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn http_refuses_unknown_names_and_strict_failures_with_422() {
    let hub = Hub::new(Arc::new(MemoryStore::default())).unwrap();
    let id = hub.create("Refusals").meta.id;
    let app = app(hub.clone(), None);

    for query in [
        "format=docx",
        "format=html&strict=pretty",
        "format=html&strict=preserved,editable",
    ] {
        let (status, _, body) = send(
            &app,
            post(&format!("/api/designs/{id}/import?{query}"), PAGE),
        )
        .await;
        assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY, "{query}");
        assert!(!body.is_empty(), "{query} says why");
    }
    let (status, _, _) = send(&app, get(&format!("/api/designs/{id}/export?format=docx"))).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // Nothing was imported.
    let handle = hub.open(&id).await.unwrap();
    assert!(handle.read(|d| d.doc().is_empty() && d.imports().is_empty()));
}
