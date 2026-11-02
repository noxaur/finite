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
    cluster::{Cluster, Members},
    heartbeat::{self, Heartbeat},
    hub::LOBBY_LIMIT,
};

/// Bodies larger than this aren't forwarded: an import's file, the largest
/// body a design route takes.
const MAX_BODY: usize = crate::api::IMPORT_LIMIT;

struct Front {
    /// The servers, fixed or kept current from the shared store's heartbeats.
    members: Arc<Members>,
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
    assert!(!nodes.is_empty(), "the router needs at least one server");
    let members = Arc::new(Members::fixed(Cluster::observer(nodes)));
    app_with_members(members, static_dir, sessions)
}

/// Like [`app_with_sessions`], for servers that come and go: `members` is
/// kept current, say by [`crate::cluster::follow`], and each request goes by
/// the list as it is then.
pub fn app_with_members(
    members: Arc<Members>,
    static_dir: Option<&str>,
    sessions: Option<Arc<dyn SessionStore>>,
) -> Router {
    build(members, static_dir, sessions, SILENT_SERVER)
}

/// Like [`app`], with a request failing after `silence` without a byte from
/// its server, instead of [`SILENT_SERVER`]. For tests, so a stuck server
/// doesn't hold one up for 30 seconds.
pub fn app_with_silence(nodes: Vec<String>, silence: std::time::Duration) -> Router {
    assert!(!nodes.is_empty(), "the router needs at least one server");
    let members = Arc::new(Members::fixed(Cluster::observer(nodes)));
    build(members, None, None, silence)
}

fn build(
    members: Arc<Members>,
    static_dir: Option<&str>,
    sessions: Option<Arc<dyn SessionStore>>,
    silence: std::time::Duration,
) -> Router {
    let allowed: Arc<[String]> = members.now().allowed_hosts().into();
    let front = Arc::new(Front {
        members: members.clone(),
        http: reqwest::Client::builder()
            .connect_timeout(UPSTREAM_TIMEOUT)
            .read_timeout(silence)
            .build()
            .expect("the HTTP client builds"),
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
            allowed.clone(),
            crate::guard::known_hosts,
        ))
        .merge(
            Router::new()
                .nest_service("/mcp", crate::relay::service(members, sessions))
                .layer(axum::middleware::from_fn_with_state(
                    allowed,
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

/// The answer while no server is live, as when they all restart at once.
fn no_servers() -> Response {
    (
        StatusCode::SERVICE_UNAVAILABLE,
        [("retry-after", "1")],
        "no Finite server is running",
    )
        .into_response()
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
    let Some(base) = front.members.now().owner_url(&id).map(String::from) else {
        return no_servers();
    };
    pass_on(send(&front, &base, &parts.method, path, &parts.headers, &body).await).await
}

/// Creates a design on the server whose turn it is. If that server can't be
/// reached, the next one takes it: a refused connection never reached the
/// server, so nothing was created twice. A server that doesn't answer in
/// `UPSTREAM_TIMEOUT` may have created it, so that's a `504` instead, and
/// the next try goes to the next server.
async fn create(State(front): State<Arc<Front>>, headers: HeaderMap, body: Bytes) -> Response {
    let cluster = front.members.now();
    let nodes = cluster.nodes();
    if nodes.is_empty() {
        return no_servers();
    }
    let turn = front.next.fetch_add(1, Ordering::Relaxed);
    for i in 0..nodes.len() {
        let base = &nodes[(turn + i) % nodes.len()];
        let created = send(&front, base, &Method::POST, "/api/designs", &headers, &body);
        let Ok(created) = tokio::time::timeout(UPSTREAM_TIMEOUT, created).await else {
            tracing::warn!(
                base,
                "a server didn't answer in time; the design may not exist"
            );
            return (
                StatusCode::GATEWAY_TIMEOUT,
                "the server didn't answer in time",
            )
                .into_response();
        };
        match created {
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
    let cluster = front.members.now();
    let requests = cluster.nodes().iter().map(|base| {
        let http = front.http.clone();
        let url = format!("{base}/api/designs{query}");
        async move {
            http.get(&url)
                .timeout(UPSTREAM_TIMEOUT)
                .send()
                .await?
                .error_for_status()?
                .json::<Vec<Value>>()
                .await
        }
    });
    let mut designs = Vec::new();
    let mut answered = false;
    for (base, result) in cluster
        .nodes()
        .iter()
        .zip(futures::future::join_all(requests).await)
    {
        match result {
            Ok(list) => {
                answered = true;
                designs.extend(list);
            }
            Err(error) => tracing::warn!(base, %error, "a server didn't answer the design list"),
        }
    }
    // With some servers down, the others' designs are still worth showing.
    // With all of them down, an empty list would say there are no designs.
    if !answered {
        return bad_gateway("no server answered the design list");
    }
    sort_newest_first(&mut designs);
    designs.truncate(limit);
    Json(designs).into_response()
}

fn sort_newest_first(designs: &mut [Value]) {
    designs.sort_by_key(|d| std::cmp::Reverse(d["updatedAt"].as_u64().unwrap_or(0)));
}

async fn owner(State(front): State<Arc<Front>>, Path(id): Path<String>) -> Json<Value> {
    Json(json!({ "owner": front.members.now().owner_url(&id) }))
}

/// How long the router waits to connect to a server, for a server to accept
/// a WebSocket, and for its design list. A server that's stuck, rather than
/// down, still accepts connections and never answers. Without a limit, one
/// stuck server held up every browser's design list. A server's list takes
/// milliseconds, so this is generous. The MCP relay uses it too.
pub(crate) const UPSTREAM_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// How long a request the router passes on may go without a byte from the
/// server. Without it, a request for a design on a stuck server, such as a
/// new comment, waited forever. It's a limit on silence, not on the whole
/// request, so a large design still downloads however long it takes. Opening
/// a large design from disk can take a few seconds before the first byte.
pub const SILENT_SERVER: std::time::Duration = std::time::Duration::from_secs(30);

/// Opens a server's WebSocket. A server sends a design's snapshot as one
/// frame, and tungstenite refuses frames over 16 MB by default, which would
/// leave a large design unable to open through the router. Browsers have no
/// such limit, and servers are trusted, so the router takes any size too.
async fn connect_ws(
    url: String,
) -> tungstenite::Result<(Upstream, tungstenite::handshake::client::Response)> {
    let config = tungstenite::protocol::WebSocketConfig::default()
        .max_message_size(None)
        .max_frame_size(None);
    let connect = tokio_tungstenite::connect_async_with_config(url, Some(config), false);
    tokio::time::timeout(UPSTREAM_TIMEOUT, connect)
        .await
        .unwrap_or_else(|_| {
            let late =
                std::io::Error::new(std::io::ErrorKind::TimedOut, "the server didn't answer");
            Err(tungstenite::Error::Io(late))
        })
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
    let Some(base) = front.members.now().owner_url(&id).map(String::from) else {
        return no_servers();
    };
    let mut connected = connect_ws(Front::ws_url(&base, &path)).await;
    // As in `relay`: follow a server that says another one owns the design.
    if let Err(tungstenite::Error::Http(res)) = &connected
        && let Some(owner) = Front::redirect(res.status(), res.headers(), &base)
    {
        connected = connect_ws(Front::ws_url(&owner, &path)).await;
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
///
/// When the list of servers changes, the socket closes too, so the browser
/// reconnects to a list that includes a server that joined, and has each
/// design that moved under its new owner.
async fn lobby(State(front): State<Arc<Front>>, upgrade: WebSocketUpgrade) -> Response {
    let changes = front.members.subscribe();
    let cluster = front.members.now();
    let connects = cluster.nodes().iter().map(|base| async move {
        let url = Front::ws_url(base, "/api/designs/ws");
        (base, connect_ws(url).await)
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
    let complete = upstreams.len() == cluster.len();
    upgrade.on_upgrade(move |client| relay_lobby(client, upstreams, complete, changes))
}

/// A server's `designs` message as its list and total.
fn list_of(message: &Value) -> (Vec<Value>, u64) {
    (
        message["designs"].as_array().cloned().unwrap_or_default(),
        message["total"].as_u64().unwrap_or(0),
    )
}

/// One `designs` message for every server's latest list: newest first, cut
/// to `LOBBY_LIMIT`, with the totals added up.
fn merged(lists: &[(Vec<Value>, u64)]) -> String {
    let mut designs: Vec<Value> = lists.iter().flat_map(|(list, _)| list.clone()).collect();
    sort_newest_first(&mut designs);
    designs.truncate(LOBBY_LIMIT);
    let total: u64 = lists.iter().map(|(_, total)| total).sum();
    json!({ "type": "designs", "designs": designs, "total": total }).to_string()
}

/// A server's first message, its full list. Pings before it are skipped.
/// `None` if the server sends anything else, closes, or takes longer than
/// `UPSTREAM_TIMEOUT`.
async fn first_list(upstream: &mut Upstream) -> Option<Value> {
    let first = async {
        loop {
            match upstream.next().await? {
                Ok(tungstenite::Message::Ping(_) | tungstenite::Message::Pong(_)) => continue,
                Ok(tungstenite::Message::Text(text)) => {
                    return serde_json::from_str(text.as_str()).ok();
                }
                _ => return None,
            }
        }
    };
    tokio::time::timeout(UPSTREAM_TIMEOUT, first)
        .await
        .ok()
        .flatten()
}

async fn relay_lobby(
    mut client: WebSocket,
    mut upstreams: Vec<Upstream>,
    mut complete: bool,
    mut changes: tokio::sync::watch::Receiver<Arc<Cluster>>,
) {
    let text = |m: Option<Result<tungstenite::Message, tungstenite::Error>>| match m {
        Some(Ok(tungstenite::Message::Text(text))) => {
            serde_json::from_str::<Value>(text.as_str()).ok()
        }
        _ => None,
    };
    // Every server starts with its full list. The router keeps each one,
    // because a server sends its full list again when its socket falls
    // behind, and that replaces only that server's part of the merge.
    let mut streams: SelectAll<_> = SelectAll::new();
    let mut lists: Vec<(Vec<Value>, u64)> = Vec::new();
    let firsts = futures::future::join_all(upstreams.iter_mut().map(first_list)).await;
    for (upstream, first) in upstreams.into_iter().zip(firsts) {
        let Some(first) = first else {
            complete = false;
            continue;
        };
        let at = lists.len();
        lists.push(list_of(&first));
        streams.push(upstream.map(move |message| (at, message)));
    }
    if !heartbeat::send(&mut client, ws::Message::text(merged(&lists))).await {
        return;
    }
    let mut heartbeat = Heartbeat::new();
    // Servers ping every `PING_EVERY`. One that's silent for `SILENT_FOR`
    // is gone without having closed, like a machine that lost power, and its
    // designs would stop updating while the browser saw nothing wrong. Then
    // the socket closes, and the browser reconnects to a fresh list.
    let mut heard = vec![tokio::time::Instant::now(); lists.len()];
    let retry = async {
        if complete {
            std::future::pending::<()>().await;
        }
        tokio::time::sleep(LOBBY_RETRY).await;
    };
    tokio::pin!(retry);
    loop {
        tokio::select! {
            next = streams.next() => {
                let Some((at, message)) = next else { return };
                heard[at] = tokio::time::Instant::now();
                // Servers ping too; tungstenite answers them.
                if let Ok(tungstenite::Message::Ping(_) | tungstenite::Message::Pong(_)) = message {
                    continue;
                }
                let Some(message) = text(Some(message)) else { return };
                let out = if message["type"] == "designs" {
                    lists[at] = list_of(&message);
                    merged(&lists)
                } else {
                    message.to_string()
                };
                if !heartbeat::send(&mut client, ws::Message::text(out)).await {
                    return;
                }
            }
            incoming = client.recv() => match incoming {
                Some(Ok(ws::Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(message)) => {
                    heartbeat.heard();
                    // The list merges several servers, so the router answers itself.
                    if matches!(&message, ws::Message::Text(text) if text.as_str() == heartbeat::PING)
                        && !heartbeat::send(&mut client, ws::Message::text(heartbeat::PONG)).await
                    {
                        return;
                    }
                }
            },
            alive = heartbeat.tick() => {
                let servers_alive = heard.iter().all(|at| at.elapsed() < heartbeat::SILENT_FOR);
                if !alive
                    || !servers_alive
                    || !heartbeat::send(&mut client, ws::Message::Ping(Default::default())).await
                {
                    return;
                }
            }
            () = &mut retry => {
                let _ = client.send(ws::Message::Close(None)).await;
                return;
            }
            Ok(()) = changes.changed() => {
                let _ = client.send(ws::Message::Close(None)).await;
                return;
            }
        }
    }
}
