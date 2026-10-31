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
use futures::{StreamExt, stream::SelectAll};
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite;
use tower_http::{
    services::{ServeDir, ServeFile},
    trace::TraceLayer,
};

use rmcp::transport::streamable_http_server::session::store::SessionStore;

use crate::{
    cluster::Cluster,
    heartbeat::{self, Heartbeat},
    hub::LOBBY_LIMIT,
};

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
        .route_layer(axum::middleware::from_fn_with_state(
            std::sync::Arc::<[String]>::from(front.cluster.allowed_hosts()),
            crate::guard::known_hosts,
        ))
        .merge(
            Router::new()
                .nest_service(
                    "/mcp",
                    crate::relay::service(front.cluster.clone(), sessions),
                )
                .layer(axum::middleware::from_fn_with_state(
                    std::sync::Arc::<[String]>::from(front.cluster.allowed_hosts()),
                    crate::guard::known_hosts,
                )),
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

/// Sends a request on to `base`. If `base` says another server owns the
/// design, it follows that once.
async fn send(
    front: &Front,
    base: &str,
    method: &Method,
    path_and_query: &str,
    headers: &HeaderMap,
    body: &Bytes,
) -> reqwest::Result<reqwest::Response> {
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
    let res = send(base).await?;
    match Front::redirect(res.status(), res.headers(), base) {
        Some(owner) => send(&owner).await,
        None => Ok(res),
    }
}

/// A server's answer, passed on to the browser.
async fn pass_on(res: reqwest::Result<reqwest::Response>) -> Response {
    let res = match res {
        Ok(res) => res,
        Err(error) => return bad_gateway(error),
    };
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
    pass_on(send(&front, &base, &parts.method, path, &parts.headers, &body).await).await
}

/// Creates a design on the server whose turn it is. If that server can't be
/// reached, the next one takes it: a refused connection never reached the
/// server, so nothing was created twice.
async fn create(State(front): State<Arc<Front>>, headers: HeaderMap, body: Bytes) -> Response {
    let nodes = front.cluster.nodes();
    let turn = front.next.fetch_add(1, Ordering::Relaxed);
    for i in 0..nodes.len() {
        let base = &nodes[(turn + i) % nodes.len()];
        match send(&front, base, &Method::POST, "/api/designs", &headers, &body).await {
            Err(error) if error.is_connect() && i + 1 < nodes.len() => {
                tracing::warn!(base, %error, "a server is down; creating the design on the next");
            }
            res => return pass_on(res).await,
        }
    }
    unreachable!("the last server's answer is passed on")
}

/// Every server's designs, most recently edited first. Each server applies
/// `q` and `limit`, so the merged list is cut to the limit again. Servers that
/// don't answer are left out rather than failing the whole list.
async fn list(State(front): State<Arc<Front>>, RawQuery(query): RawQuery) -> Response {
    let limit = query
        .as_deref()
        .and_then(|q| q.split('&').find_map(|kv| kv.strip_prefix("limit=")))
        .and_then(|n| n.parse::<usize>().ok())
        .unwrap_or(LOBBY_LIMIT)
        .clamp(1, 1000);
    let query = query.map(|q| format!("?{q}")).unwrap_or_default();
    let requests = front.cluster.nodes().iter().map(|base| {
        let http = front.http.clone();
        let url = format!("{base}/api/designs{query}");
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
    designs.truncate(limit);
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
    upgrade.on_upgrade(move |client| relay_design(client, upstream))
}

/// Copies messages both ways until either side closes. The router pings the
/// browser itself (see [`crate::heartbeat`]); the server's pings stop here,
/// and tungstenite answers them.
async fn relay_design(mut client: WebSocket, mut upstream: Upstream) {
    let mut heartbeat = Heartbeat::new();
    loop {
        tokio::select! {
            message = upstream.next() => {
                let message = match message {
                    Some(Ok(tungstenite::Message::Text(text))) => ws::Message::text(text.as_str()),
                    Some(Ok(tungstenite::Message::Binary(bytes))) => ws::Message::Binary(bytes),
                    Some(Ok(tungstenite::Message::Close(_))) | Some(Err(_)) | None => return,
                    Some(Ok(_)) => continue,
                };
                if !heartbeat::send(&mut client, message).await {
                    return;
                }
            }
            message = client.recv() => {
                heartbeat.heard();
                // axum answers pings itself, so only data and close matter here.
                let message = match message {
                    Some(Ok(ws::Message::Text(text))) => tungstenite::Message::text(text.as_str()),
                    Some(Ok(ws::Message::Binary(bytes))) => tungstenite::Message::binary(bytes),
                    Some(Ok(ws::Message::Close(_))) | Some(Err(_)) | None => return,
                    Some(Ok(ws::Message::Ping(_) | ws::Message::Pong(_))) => continue,
                };
                if !heartbeat::send(&mut upstream, message).await {
                    return;
                }
            }
            alive = heartbeat.tick() => {
                if !alive || !heartbeat::send(&mut client, ws::Message::Ping(Default::default())).await {
                    return;
                }
            }
        }
    }
}

/// How long a design list socket that's missing a server stays open before
/// it closes, so the browser reconnects and tries that server again.
const LOBBY_RETRY: std::time::Duration = std::time::Duration::from_secs(15);

type Upstream =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// The design list's WebSocket across every server: one merged `designs`
/// message, then each server's `design` updates as they come. If a server
/// drops, the socket closes, and the browser reconnects and starts over.
///
/// A server that's down is left out, as in [`list`], rather than failing the
/// whole list. Then the socket closes after `LOBBY_RETRY`, so the browser
/// reconnects and the router tries that server again.
async fn lobby(State(front): State<Arc<Front>>, upgrade: WebSocketUpgrade) -> Response {
    let connects = front.cluster.nodes().iter().map(|base| async move {
        let url = Front::ws_url(base, "/api/designs/ws");
        (base, tokio_tungstenite::connect_async(url).await)
    });
    let mut upstreams = Vec::new();
    for (base, connected) in futures::future::join_all(connects).await {
        match connected {
            Ok((upstream, _)) => upstreams.push(upstream),
            Err(error) => tracing::warn!(base, %error, "a server didn't answer the design list"),
        }
    }
    if upstreams.is_empty() {
        return bad_gateway("no Finite server answered");
    }
    let complete = upstreams.len() == front.cluster.len();
    upgrade.on_upgrade(move |client| relay_lobby(client, upstreams, complete))
}

async fn relay_lobby(mut client: WebSocket, upstreams: Vec<Upstream>, mut complete: bool) {
    let text = |m: Option<Result<tungstenite::Message, tungstenite::Error>>| match m {
        Some(Ok(tungstenite::Message::Text(text))) => {
            serde_json::from_str::<Value>(text.as_str()).ok()
        }
        _ => None,
    };
    // Every server starts with its full list; merge those into one.
    let mut streams: SelectAll<_> = SelectAll::new();
    let mut designs = Vec::new();
    let mut total = 0;
    for mut upstream in upstreams {
        let Some(first) = text(upstream.next().await) else {
            complete = false;
            continue;
        };
        designs.extend(first["designs"].as_array().cloned().unwrap_or_default());
        total += first["total"].as_u64().unwrap_or(0);
        streams.push(upstream);
    }
    sort_newest_first(&mut designs);
    designs.truncate(LOBBY_LIMIT);
    let first = json!({ "type": "designs", "designs": designs, "total": total }).to_string();
    if !heartbeat::send(&mut client, ws::Message::text(first)).await {
        return;
    }
    let mut heartbeat = Heartbeat::new();
    let retry = async {
        if complete {
            std::future::pending::<()>().await;
        }
        tokio::time::sleep(LOBBY_RETRY).await;
    };
    tokio::pin!(retry);
    loop {
        tokio::select! {
            message = streams.next() => {
                // Servers ping too; tungstenite answers them.
                if let Some(Ok(tungstenite::Message::Ping(_) | tungstenite::Message::Pong(_))) = message {
                    continue;
                }
                let Some(message) = text(message) else { return };
                if !heartbeat::send(&mut client, ws::Message::text(message.to_string())).await {
                    return;
                }
            }
            incoming = client.recv() => match incoming {
                Some(Ok(ws::Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => heartbeat.heard(),
            },
            alive = heartbeat.tick() => {
                if !alive || !heartbeat::send(&mut client, ws::Message::Ping(Default::default())).await {
                    return;
                }
            }
            () = &mut retry => {
                let _ = client.send(ws::Message::Close(None)).await;
                return;
            }
        }
    }
}
