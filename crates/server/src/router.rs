//! The front door for several Finite servers. Browsers talk to the router as
//! if it were one server, and it sends each request to the server that owns
//! the design (see `cluster.rs`):
//!
//! - Requests under `/api/designs/{id}` go to the design's owner. That
//!   includes its WebSocket, which the router relays in both directions.
//! - `POST /api/designs` takes turns between servers, and each one creates an
//!   id it owns.
//! - The design list asks every server and merges the answers. Its WebSocket
//!   subscribes to every server's list and relays their updates.
//!
//! - `/mcp` relays agents' tool calls the same way (see `relay.rs`).
//!
//! The router keeps no state of its own besides those relayed MCP sessions,
//! so you can run several behind a load balancer that keeps each MCP session
//! on one router.

use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};

use axum::{
    Json, Router,
    body::{Body, Bytes},
    extract::{
        Path, RawQuery, Request, State,
        ws::{self, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, Method, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{any, get},
};
use futures::{SinkExt, StreamExt, stream::SelectAll};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

use rmcp::transport::streamable_http_server::session::store::SessionStore;

use crate::cluster::Cluster;

/// Bodies larger than this aren't forwarded.
const MAX_BODY: usize = 8 << 20;

struct Front {
    cluster: Cluster,
    http: reqwest::Client,
    /// Which server creates the next design.
    next: AtomicUsize,
}

impl Front {
    fn ws_url(base: &str, path: &str) -> String {
        let base = base
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        format!("{base}{path}")
    }
}

/// Builds the router for the servers in `nodes`. With `static_dir`, it also
/// serves the built frontend.
pub fn app(nodes: Vec<String>, static_dir: Option<&str>) -> Router {
    app_with_sessions(nodes, static_dir, None)
}

/// Like [`app`], with MCP sessions kept in `sessions`. Routers that share it
/// can each serve any agent's session, so a load balancer needn't pin them.
pub fn app_with_sessions(
    nodes: Vec<String>,
    static_dir: Option<&str>,
    sessions: Option<Arc<dyn SessionStore>>,
) -> Router {
    let cluster = Cluster::new(nodes, 0).expect("the router needs at least one server");
    let front = Arc::new(Front {
        cluster,
        http: reqwest::Client::new(),
        next: AtomicUsize::new(0),
    });
    let router = Router::new()
        .route(
            "/api/health",
            get(|| async { Json(json!({ "status": "ok" })) }),
        )
        .route("/api/designs", get(list).post(create))
        .route("/api/designs/ws", get(lobby))
        .route("/api/designs/{id}", any(forward))
        .route("/api/designs/{id}/ws", get(design_socket))
        .route("/api/designs/{id}/{*rest}", any(forward))
        .route("/api/owner/{id}", get(owner))
        .with_state(front.clone())
        .nest_service(
            "/mcp",
            crate::relay::service(front.cluster.clone(), sessions),
        );
    let router = match static_dir {
        Some(dir) => {
            let not_found = format!("{dir}/404.html");
            router.fallback_service(ServeDir::new(dir).not_found_service(ServeFile::new(not_found)))
        }
        None => router,
    };
    router.layer(TraceLayer::new_for_http())
}

fn bad_gateway(error: impl std::fmt::Display) -> Response {
    (StatusCode::BAD_GATEWAY, error.to_string()).into_response()
}

impl Front {
    /// Where a `421 Misdirected Request` says to go instead: its
    /// `Finite-Owner`. That happens while a server is being added, if the
    /// servers already know about it and the router doesn't yet. The owner
    /// comes from a server in the router's own list, so it's trusted, but it
    /// must at least be a plain base URL.
    fn redirect(status: StatusCode, headers: &HeaderMap, base: &str) -> Option<String> {
        if status != StatusCode::MISDIRECTED_REQUEST {
            return None;
        }
        let owner = headers.get("finite-owner")?.to_str().ok()?;
        (owner != base && crate::cluster::is_base_url(owner)).then(|| owner.to_owned())
    }
}

/// Sends a request on to `base` and returns its response. If `base` says
/// another server owns the design, it follows that once.
async fn relay(
    front: &Front,
    base: &str,
    method: Method,
    path_and_query: &str,
    headers: &HeaderMap,
    body: Bytes,
) -> Response {
    let send = |base: &str| {
        let mut req = front
            .http
            .request(method.clone(), format!("{base}{path_and_query}"))
            .body(body.clone());
        if let Some(content_type) = headers.get(header::CONTENT_TYPE) {
            req = req.header(header::CONTENT_TYPE, content_type);
        }
        req.send()
    };
    let mut res = match send(base).await {
        Ok(res) => res,
        Err(error) => return bad_gateway(error),
    };
    if let Some(owner) = Front::redirect(res.status(), res.headers(), base) {
        res = match send(&owner).await {
            Ok(res) => res,
            Err(error) => return bad_gateway(error),
        };
    }
    let mut out = Response::builder().status(res.status());
    for name in [header::CONTENT_TYPE, header::CACHE_CONTROL] {
        if let Some(value) = res.headers().get(&name) {
            out = out.header(name, value);
        }
    }
    match res.bytes().await {
        Ok(bytes) => out.body(Body::from(bytes)).expect("valid response"),
        Err(error) => bad_gateway(error),
    }
}

async fn forward(
    State(front): State<Arc<Front>>,
    Path(params): Path<Vec<(String, String)>>,
    req: Request,
) -> Response {
    let Some((_, id)) = params.into_iter().find(|(k, _)| k == "id") else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let (parts, body) = req.into_parts();
    let Ok(body) = axum::body::to_bytes(body, MAX_BODY).await else {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    };
    let path = parts.uri.path_and_query().map_or("/", |p| p.as_str());
    let base = front.cluster.owner_url(&id).to_owned();
    relay(&front, &base, parts.method, path, &parts.headers, body).await
}

async fn create(State(front): State<Arc<Front>>, headers: HeaderMap, body: Bytes) -> Response {
    let nodes = front.cluster.nodes();
    let base = nodes[front.next.fetch_add(1, Ordering::Relaxed) % nodes.len()].clone();
    relay(&front, &base, Method::POST, "/api/designs", &headers, body).await
}

/// Every server's designs, most recently edited first. Servers that don't
/// answer are left out rather than failing the whole list.
async fn list(State(front): State<Arc<Front>>) -> Response {
    let requests = front.cluster.nodes().iter().map(|base| {
        let http = front.http.clone();
        let url = format!("{base}/api/designs");
        async move { http.get(&url).send().await?.json::<Vec<Value>>().await }
    });
    let mut designs = Vec::new();
    for (base, result) in front
        .cluster
        .nodes()
        .iter()
        .zip(futures::future::join_all(requests).await)
    {
        match result {
            Ok(list) => designs.extend(list),
            Err(error) => tracing::warn!(base, %error, "a server didn't answer the design list"),
        }
    }
    sort_newest_first(&mut designs);
    Json(designs).into_response()
}

fn sort_newest_first(designs: &mut [Value]) {
    designs.sort_by_key(|d| std::cmp::Reverse(d["updatedAt"].as_u64().unwrap_or(0)));
}

async fn owner(State(front): State<Arc<Front>>, Path(id): Path<String>) -> Json<Value> {
    Json(json!({ "owner": front.cluster.owner_url(&id) }))
}

/// Relays a design's WebSocket to its owner, both ways, until either side closes.
async fn design_socket(
    State(front): State<Arc<Front>>,
    Path(id): Path<String>,
    RawQuery(query): RawQuery,
    upgrade: WebSocketUpgrade,
) -> Response {
    // The query carries where a reconnecting viewer left off.
    let query = query.map(|q| format!("?{q}")).unwrap_or_default();
    let path = format!("/api/designs/{id}/ws{query}");
    let base = front.cluster.owner_url(&id);
    let mut connected = tokio_tungstenite::connect_async(Front::ws_url(base, &path)).await;
    // As in `relay`: follow a server that says another one owns the design.
    if let Err(tungstenite::Error::Http(res)) = &connected
        && let Some(owner) = Front::redirect(res.status(), res.headers(), base)
    {
        connected = tokio_tungstenite::connect_async(Front::ws_url(&owner, &path)).await;
    }
    let upstream = match connected {
        Ok((upstream, _)) => upstream,
        Err(tungstenite::Error::Http(res)) => return res.status().into_response(),
        Err(error) => return bad_gateway(error),
    };
    upgrade.on_upgrade(move |client| async move {
        let (mut up_tx, mut up_rx) = upstream.split();
        let (mut client_tx, mut client_rx) = client.split();
        let down = async {
            while let Some(Ok(message)) = up_rx.next().await {
                let message = match message {
                    tungstenite::Message::Text(text) => ws::Message::text(text.as_str()),
                    tungstenite::Message::Binary(bytes) => ws::Message::Binary(bytes),
                    tungstenite::Message::Close(_) => break,
                    _ => continue,
                };
                if client_tx.send(message).await.is_err() {
                    break;
                }
            }
        };
        let up = async {
            while let Some(Ok(message)) = client_rx.next().await {
                // axum answers pings itself, so only data and close matter here.
                let message = match message {
                    ws::Message::Text(text) => tungstenite::Message::text(text.as_str()),
                    ws::Message::Binary(bytes) => tungstenite::Message::binary(bytes),
                    ws::Message::Close(_) => break,
                    ws::Message::Ping(_) | ws::Message::Pong(_) => continue,
                };
                if up_tx.send(message).await.is_err() {
                    break;
                }
            }
        };
        tokio::select! {
            () = down => {}
            () = up => {}
        }
    })
}

/// The design list's WebSocket across every server: one merged `designs`
/// message, then each server's `design` updates as they come. If any server
/// drops, the socket closes, and the browser reconnects and starts over.
async fn lobby(State(front): State<Arc<Front>>, upgrade: WebSocketUpgrade) -> Response {
    let mut upstreams = Vec::new();
    for base in front.cluster.nodes() {
        match tokio_tungstenite::connect_async(Front::ws_url(base, "/api/designs/ws")).await {
            Ok((upstream, _)) => upstreams.push(upstream),
            Err(error) => return bad_gateway(format!("{base}: {error}")),
        }
    }
    upgrade.on_upgrade(move |client| relay_lobby(client, upstreams))
}

async fn relay_lobby(
    mut client: WebSocket,
    upstreams: Vec<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
) {
    let text = |m: Option<Result<tungstenite::Message, tungstenite::Error>>| match m {
        Some(Ok(tungstenite::Message::Text(text))) => {
            serde_json::from_str::<Value>(text.as_str()).ok()
        }
        _ => None,
    };
    // Every server starts with its full list; merge those into one.
    let mut streams: SelectAll<_> = SelectAll::new();
    let mut designs = Vec::new();
    for mut upstream in upstreams {
        let Some(first) = text(upstream.next().await) else {
            return;
        };
        designs.extend(first["designs"].as_array().cloned().unwrap_or_default());
        streams.push(upstream);
    }
    sort_newest_first(&mut designs);
    let first = json!({ "type": "designs", "designs": designs }).to_string();
    if client.send(ws::Message::text(first)).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            message = streams.next() => {
                let Some(message) = text(message) else { return };
                if client.send(ws::Message::text(message.to_string())).await.is_err() {
                    return;
                }
            }
            incoming = client.recv() => match incoming {
                Some(Ok(ws::Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {}
            },
        }
    }
}
