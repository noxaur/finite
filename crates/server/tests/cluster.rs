//! Two servers side by side: each creates and serves only the designs it
//! owns, and points requests for the other's designs at their owner.

use std::sync::Arc;

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode, header},
};
use finite_design::import::{BlobHash, Dependency, ImportRecord};
use finite_server::{Hub, app, cluster::Cluster, store::MemoryStore};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

const NODES: [&str; 2] = ["http://a:4100", "http://b:4100"];

fn node(me: usize) -> Router {
    let cluster = Cluster::new(NODES.map(String::from).to_vec(), me).unwrap();
    let hub = Hub::with_cluster(Arc::new(MemoryStore::default()), cluster).unwrap();
    app(hub, None)
}

async fn call(app: &Router, req: Request<Body>) -> (StatusCode, Option<String>, Value) {
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let owner = res
        .headers()
        .get("finite-owner")
        .map(|v| v.to_str().unwrap().to_owned());
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        owner,
        serde_json::from_slice(&bytes).unwrap_or_default(),
    )
}

fn get(path: &str) -> Request<Body> {
    Request::get(path).body(Body::empty()).unwrap()
}

#[tokio::test]
async fn each_server_serves_only_its_designs() {
    let (a, b) = (node(0), node(1));

    // Every design A creates is one A owns.
    let mut ids = Vec::new();
    for _ in 0..20 {
        let req = Request::post("/api/designs")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(json!({ "name": "Landing" }).to_string()))
            .unwrap();
        let (status, _, created) = call(&a, req).await;
        assert_eq!(status, StatusCode::CREATED);
        ids.push(created["id"].as_str().unwrap().to_owned());
    }

    for id in &ids {
        let (status, _, _) = call(&a, get(&format!("/api/designs/{id}"))).await;
        assert_eq!(status, StatusCode::OK);

        // B doesn't have it, and says who does.
        let (status, owner, _) = call(&b, get(&format!("/api/designs/{id}"))).await;
        assert_eq!(status, StatusCode::MISDIRECTED_REQUEST);
        assert_eq!(owner.as_deref(), Some(NODES[0]));

        // Any server answers where a design lives.
        let (_, _, from_b) = call(&b, get(&format!("/api/owner/{id}"))).await;
        let (_, _, from_a) = call(&a, get(&format!("/api/owner/{id}"))).await;
        assert_eq!(from_b["owner"], NODES[0]);
        assert_eq!(from_a["owner"], Value::Null);
    }
}

/// When a server joins, the designs it now owns move to it from the server
/// that used to own them.
#[tokio::test]
async fn designs_move_to_their_new_owner() {
    use finite_server::store::Store;
    use tokio::net::TcpListener;

    // One server on its own creates a dozen designs.
    let old_store = Arc::new(MemoryStore::default());
    let solo = Hub::new(old_store.clone()).unwrap();
    let ids: Vec<String> = (0..12)
        .map(|i| solo.create(&format!("D{i}")).meta.id)
        .collect();
    solo.flush();
    drop(solo);

    // Then a second server joins.
    let a = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let b = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let nodes: Vec<String> = [&a, &b]
        .map(|l| format!("http://{}", l.local_addr().unwrap()))
        .to_vec();
    let cluster = |me| Cluster::new(nodes.clone(), me).unwrap();
    let new_hub = Hub::with_cluster(Arc::new(MemoryStore::default()), cluster(1)).unwrap();
    tokio::spawn(async move { axum::serve(b, app(new_hub, None)).await });
    let old_hub = Hub::with_cluster(old_store.clone(), cluster(0)).unwrap();
    tokio::spawn(async move { axum::serve(a, app(old_hub, None)).await });

    let moving: Vec<&String> = ids
        .iter()
        .filter(|id| cluster(0).owner(id) == Some(1))
        .collect();
    assert!(!moving.is_empty(), "some designs hash to the new server");
    let http = reqwest::Client::new();
    for _ in 0..50 {
        let left = old_store.ids().unwrap();
        if moving.iter().all(|id| !left.contains(id)) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    for id in &ids {
        let owner = &nodes[cluster(0).owner(id).unwrap()];
        let res = http
            .get(format!("{owner}/api/designs/{id}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200, "{id} is served by its owner");
        let moved = moving.contains(&id);
        assert_eq!(!old_store.ids().unwrap().contains(id), moved, "{id}");
    }
}

/// If the new owner can't be reached, nothing is deleted.
#[tokio::test]
async fn designs_stay_put_while_the_new_owner_is_down() {
    use finite_server::store::Store;

    let store = Arc::new(MemoryStore::default());
    let solo = Hub::new(store.clone()).unwrap();
    let ids: Vec<String> = (0..12)
        .map(|i| solo.create(&format!("D{i}")).meta.id)
        .collect();
    solo.flush();
    drop(solo);

    // Port 9 (discard) refuses connections on a normal machine.
    let nodes = vec![
        "http://127.0.0.1:4100".to_owned(),
        "http://127.0.0.1:9".to_owned(),
    ];
    let _hub = Hub::with_cluster(store.clone(), Cluster::new(nodes, 0).unwrap()).unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    let mut kept = store.ids().unwrap();
    kept.sort();
    let mut all = ids.clone();
    all.sort();
    assert_eq!(kept, all);
}

/// A design's whole saved state moves in one request, so the new owner takes
/// bodies far larger than an API call's.
#[tokio::test]
async fn large_designs_move_too() {
    use finite_design::edit::{self, NewArtboard, WriteMode};
    use finite_server::hub::Actor;

    let solo = Hub::new(Arc::new(MemoryStore::default())).unwrap();
    let to_b = Cluster::new(NODES.map(String::from).to_vec(), 0).unwrap();
    let id = std::iter::repeat_with(|| solo.create("Big").meta.id)
        .find(|id| to_b.owner(id) == Some(1))
        .unwrap();
    let design = solo.get(&id).unwrap();
    let agent = Actor {
        id: "agent:big".into(),
        name: "Big".into(),
    };
    let artboard = NewArtboard {
        name: "Page".into(),
        width: 800.0,
        height: Some(600.0),
        position: None,
        page: None,
        styles: Default::default(),
        ..Default::default()
    };
    design
        .edit(&agent, "Add page", |doc| {
            Ok((edit::create_artboard(doc, "page".into(), artboard)?, ()))
        })
        .unwrap();
    // Three 1 MB writes: more than 2 MB, though each fits in one MCP call.
    for i in 0..3 {
        let html = format!("<p>{}</p>", "x".repeat(1 << 20));
        let mut n = 0;
        let mut new_id = || {
            n += 1;
            format!("p{i}-{n}")
        };
        design
            .edit(&agent, "Write", |doc| {
                let (ops, _) =
                    edit::write_html(doc, "page", &html, WriteMode::Append, None, &mut new_id)?;
                Ok((ops, ()))
            })
            .unwrap();
    }
    let snapshot = serde_json::to_string(&design.read(|d| d.snapshot_to_save())).unwrap();
    assert!(snapshot.len() > 3 << 20);

    let req = Request::put(format!("/api/designs/{id}/handoff"))
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(snapshot))
        .unwrap();
    let (status, _, _) = call(&node(1), req).await;
    assert_eq!(status, StatusCode::CREATED);
}

/// A design id becomes a file name, so a handoff can't name a file outside
/// the data folder.
#[tokio::test]
async fn a_handoff_cant_write_outside_the_data_folder() {
    use finite_server::store::FileStore;

    let root = std::env::temp_dir().join(format!("finite-escape-{}", uuid::Uuid::new_v4()));
    let data = root.join("data");
    let hub = Hub::new(Arc::new(FileStore::new(&data).unwrap())).unwrap();
    let app = app(hub, None);

    let id = "../../escaped";
    let snapshot = json!({
        "meta": { "id": id, "name": "x", "createdAt": 0, "updatedAt": 0 },
        "seq": 0,
        "nodes": [],
    });
    let req = Request::put("/api/designs/..%2F..%2Fescaped/handoff")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(snapshot.to_string()))
        .unwrap();
    let (status, _, _) = call(&app, req).await;
    assert!(status.is_client_error(), "got {status}");
    assert!(!root.join("escaped.json").exists());
    std::fs::remove_dir_all(&root).unwrap();
}

fn import_record(artifact: BlobHash, dependencies: Vec<Dependency>) -> ImportRecord {
    ImportRecord {
        id: "import-1".into(),
        artifact,
        format: "html".into(),
        input_kind: "html page".into(),
        file_name: None,
        received_at: 0,
        nodes: Default::default(),
        dependencies,
        quarantined: Vec::new(),
    }
}

/// The new owner gets the bytes an import record points at, so the original
/// stays downloadable after the design moves.
#[tokio::test]
async fn blobs_move_with_their_design() {
    use finite_server::store::Store;
    use tokio::net::TcpListener;

    let a = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let b = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let nodes: Vec<String> = [&a, &b]
        .map(|l| format!("http://{}", l.local_addr().unwrap()))
        .to_vec();
    let cluster = |me| Cluster::new(nodes.clone(), me).unwrap();

    // One server on its own holds an imported design that the second server
    // will own once it joins.
    let old_store = Arc::new(MemoryStore::default());
    let solo = Hub::new(old_store.clone()).unwrap();
    let id = std::iter::repeat_with(|| solo.create("Imported").meta.id)
        .find(|id| cluster(0).owner(id) == Some(1))
        .unwrap();
    solo.flush();
    let mut snapshot = solo.get(&id).unwrap().read(|d| d.snapshot_to_save());
    drop(solo);

    let artifact = old_store.put_blob(b"<h1>the original</h1>").unwrap();
    let image = old_store.put_blob(b"\x89PNG\r\n\x1a\nimage").unwrap();
    let dependencies = vec![
        Dependency {
            url: "https://example.com/a.png".into(),
            blob: Some(image.clone()),
        },
        Dependency {
            url: "https://example.com/not-fetched.png".into(),
            blob: None,
        },
        // The record can name a blob the store never got. That doesn't stop the move.
        Dependency {
            url: "https://example.com/lost.png".into(),
            blob: Some(BlobHash::of(b"lost")),
        },
    ];
    snapshot
        .imports
        .push(import_record(artifact.clone(), dependencies));
    old_store.remove(&id).unwrap();
    old_store.save(&snapshot, 0).unwrap();

    let new_store = Arc::new(MemoryStore::default());
    let new_hub = Hub::with_cluster(new_store.clone(), cluster(1)).unwrap();
    tokio::spawn(async move { axum::serve(b, app(new_hub, None)).await });
    let old_hub = Hub::with_cluster(old_store.clone(), cluster(0)).unwrap();
    tokio::spawn(async move { axum::serve(a, app(old_hub, None)).await });

    for _ in 0..50 {
        if !old_store.ids().unwrap().contains(&id) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    assert!(!old_store.ids().unwrap().contains(&id), "{id} moved");

    assert_eq!(
        new_store.get_blob(&artifact).unwrap().as_deref(),
        Some(&b"<h1>the original</h1>"[..])
    );
    assert!(new_store.has_blob(&image).unwrap());
    assert!(!new_store.has_blob(&BlobHash::of(b"lost")).unwrap());

    let res = reqwest::get(format!("{}/api/designs/{id}/assets/{artifact}", nodes[1]))
        .await
        .unwrap();
    assert_eq!(res.status(), 200);
    assert_eq!(
        res.bytes().await.unwrap().as_ref(),
        b"<h1>the original</h1>"
    );
    let moved = new_store.load(&id).unwrap().unwrap();
    assert_eq!(moved.snapshot.imports.len(), 1);
}

#[tokio::test]
async fn a_blob_must_match_its_hash() {
    use finite_server::store::Store;

    let store = Arc::new(MemoryStore::default());
    let cluster = Cluster::new(NODES.map(String::from).to_vec(), 1).unwrap();
    let app = app(Hub::with_cluster(store.clone(), cluster).unwrap(), None);
    let id = (0..)
        .map(|i| format!("design{i:04}"))
        .find(|id| {
            Cluster::new(NODES.map(String::from).to_vec(), 1)
                .unwrap()
                .owner(id)
                == Some(1)
        })
        .unwrap();
    let hash = BlobHash::of(b"the bytes");
    let put = |id: &str, hash: &str, body: &'static [u8]| {
        Request::put(format!("/api/designs/{id}/assets/{hash}"))
            .body(Body::from(body))
            .unwrap()
    };

    let (status, _, _) = call(&app, put(&id, hash.as_str(), b"other bytes")).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    let (status, _, _) = call(&app, put(&id, "not-a-hash", b"the bytes")).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(!store.has_blob(&hash).unwrap(), "nothing was stored");

    let (status, _, _) = call(&app, put(&id, hash.as_str(), b"the bytes")).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(store.get_blob(&hash).unwrap().unwrap(), b"the bytes");

    // A design the other server owns goes to its owner, like any design route.
    let elsewhere = (0..)
        .map(|i| format!("design{i:04}"))
        .find(|id| {
            Cluster::new(NODES.map(String::from).to_vec(), 1)
                .unwrap()
                .owner(id)
                == Some(0)
        })
        .unwrap();
    let (status, owner, _) = call(&app, put(&elsewhere, hash.as_str(), b"the bytes")).await;
    assert_eq!(status, StatusCode::MISDIRECTED_REQUEST);
    assert_eq!(owner.as_deref(), Some(NODES[0]));
}

/// A server doesn't guess at a snapshot from a newer version, and answers
/// `409` so the sender keeps its copy.
#[tokio::test]
async fn a_handoff_from_a_newer_version_is_refused() {
    let app = node(1);
    let cluster = Cluster::new(NODES.map(String::from).to_vec(), 0).unwrap();
    let id = (0..)
        .map(|i| format!("design{i:04}"))
        .find(|id| cluster.owner(id) == Some(1))
        .unwrap();
    let body = |version: &str| {
        format!(
            r#"{{{version}"meta":{{"id":"{id}","name":"x","createdAt":0,"updatedAt":0}},"seq":0,"nodes":[]}}"#
        )
    };
    let handoff = |body: String| {
        Request::put(format!("/api/designs/{id}/handoff"))
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(body))
            .unwrap()
    };

    let res = app
        .clone()
        .oneshot(handoff(body(r#""v":99,"#)))
        .await
        .unwrap();
    assert_eq!(res.status(), StatusCode::CONFLICT);
    let text = res.into_body().collect().await.unwrap().to_bytes();
    let text = String::from_utf8_lossy(&text);
    assert!(text.contains("version 99"), "{text}");
    let (status, _, _) = call(&app, get(&format!("/api/designs/{id}"))).await;
    assert_eq!(status, StatusCode::NOT_FOUND, "nothing was adopted");

    let (status, _, _) = call(&app, handoff(r#"{"v":1,"meta":5}"#.into())).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);

    // The current version, and a snapshot from before versions, are both taken.
    let (status, _, _) = call(&app, handoff(body(r#""v":1,"#))).await;
    assert_eq!(status, StatusCode::CREATED);
}
