//! `GET /api/designs/{id}/assets/{hash}`: stored blobs, served so a browser can't be
//! talked into running them.

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, Response, StatusCode},
};
use finite_server::{
    Hub, app,
    blob::BlobHash,
    store::{FileStore, MemoryStore, Store},
};
use http_body_util::BodyExt;
use tower::ServiceExt;

/// Blobs belong to no design, but the route names one so it reaches its owner.
const DESIGN: &str = "abcde12345";
const PNG: &[u8] = b"\x89PNG\r\n\x1a\nnot a real image";
const SVG: &[u8] = b"<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>";

async fn fetch(app: &Router, hash: &str) -> (Response<Body>, Vec<u8>) {
    let req = Request::get(format!("/api/designs/{DESIGN}/assets/{hash}"))
        .body(Body::empty())
        .unwrap();
    let res = app.clone().oneshot(req).await.unwrap();
    let (parts, body) = res.into_parts();
    let bytes = body.collect().await.unwrap().to_bytes().to_vec();
    (Response::from_parts(parts, Body::empty()), bytes)
}

fn header_of<'a>(res: &'a Response<Body>, name: &str) -> &'a str {
    res.headers()
        .get(name)
        .unwrap_or_else(|| panic!("no {name} header"))
        .to_str()
        .unwrap()
}

/// What every answer says, found or not: a script in an SVG can't run.
fn assert_locked_down(res: &Response<Body>) {
    assert_eq!(header_of(res, "content-security-policy"), "sandbox");
    assert_eq!(header_of(res, "x-content-type-options"), "nosniff");
}

#[tokio::test]
async fn a_stored_blob_is_served_for_good() {
    let store = Arc::new(MemoryStore::default());
    let hash = store.put_blob(PNG).unwrap();
    let app = app(Hub::new(store).unwrap(), None);

    let (res, body) = fetch(&app, hash.as_str()).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body, PNG);
    assert_eq!(header_of(&res, "content-type"), "image/png");
    assert_eq!(
        header_of(&res, "cache-control"),
        "public, max-age=31536000, immutable"
    );
    assert_locked_down(&res);
}

#[tokio::test]
async fn the_type_comes_from_the_bytes() {
    let store = Arc::new(MemoryStore::default());
    let cases = [
        (SVG, "image/svg+xml"),
        (
            b"<html><script>alert(1)</script></html>".as_slice(),
            "application/octet-stream",
        ),
    ];
    let hashes: Vec<BlobHash> = cases
        .iter()
        .map(|(b, _)| store.put_blob(b).unwrap())
        .collect();
    let app = app(Hub::new(store).unwrap(), None);

    for ((_, expected), hash) in cases.iter().zip(hashes) {
        let (res, _) = fetch(&app, hash.as_str()).await;
        assert_eq!(header_of(&res, "content-type"), *expected);
        assert_locked_down(&res);
    }
}

#[tokio::test]
async fn a_missing_blob_is_a_404_and_a_malformed_hash_a_422() {
    let app = app(Hub::new(Arc::new(MemoryStore::default())).unwrap(), None);

    let missing = BlobHash::of(b"never stored");
    let (res, _) = fetch(&app, missing.as_str()).await;
    assert_eq!(res.status(), StatusCode::NOT_FOUND);
    assert_locked_down(&res);

    // The second is a path that would leave the blob folder, if it were used.
    for bad in [
        "abc",
        "..%2F..%2Fdesigns%2Fx.json",
        &missing.as_str().to_uppercase(),
    ] {
        let (res, _) = fetch(&app, bad).await;
        assert_eq!(res.status(), StatusCode::UNPROCESSABLE_ENTITY, "{bad}");
        assert_locked_down(&res);
    }
}

#[tokio::test]
async fn blobs_in_the_data_folder_are_served_after_a_restart() {
    let dir = std::env::temp_dir().join(format!("finite-assets-{}", uuid::Uuid::new_v4()));
    let hash = FileStore::new(&dir).unwrap().put_blob(PNG).unwrap();

    let app = app(
        Hub::new(Arc::new(FileStore::new(&dir).unwrap())).unwrap(),
        None,
    );
    let (res, body) = fetch(&app, hash.as_str()).await;
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(body, PNG);
    assert!(
        dir.join("blobs")
            .join(&hash.as_str()[..2])
            .join(hash.as_str())
            .is_file(),
        "a blob is blobs/<first two digits>/<hash>"
    );
    std::fs::remove_dir_all(dir).unwrap();
}
