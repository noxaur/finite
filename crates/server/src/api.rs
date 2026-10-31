//! HTTP and WebSocket routes for the web app, under `/api`.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{
        DefaultBodyLimit, Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
};
use finite_design::{
    Snapshot,
    comment::{self, Anchor, Author, AuthorKind, Comment, CommentError},
};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::{self, error::RecvError};

use crate::heartbeat::{self, Heartbeat};
use crate::hub::{AdoptError, DesignHandle, DesignSummary, Hub, LOBBY_LIMIT, Outgoing, Since};

/// The largest design another server can hand off. axum's default of 2 MB
/// suits API calls, but a handoff carries a whole design with its undo
/// histories, and one MCP call alone can add 4 MB.
const HANDOFF_LIMIT: usize = 256 << 20;

pub fn routes() -> Router<Arc<Hub>> {
    Router::new()
        .route("/designs", get(list_designs).post(create_design))
        .route("/designs/ws", get(lobby_socket))
        .route("/designs/{id}", get(get_design))
        .route("/owner/{id}", get(owner_of))
        .route(
            "/designs/{id}/handoff",
            put(adopt).layer(DefaultBodyLimit::max(HANDOFF_LIMIT)),
        )
        .route("/designs/{id}/ws", get(design_socket))
        .route("/designs/{id}/comments", post(create_comment))
        .route("/designs/{id}/comments/{comment}", patch(update_comment))
        .route(
            "/designs/{id}/comments/{comment}/replies",
            post(reply_to_comment),
        )
}

/// `?q=…&limit=…` on the design list: a name to search for, and how many.
#[derive(Deserialize)]
struct ListQuery {
    q: Option<String>,
    limit: Option<usize>,
}

/// The most recently edited designs, at most `limit` (200 by default, 1,000
/// at most), whose name contains `q` if it's given.
async fn list_designs(
    State(hub): State<Arc<Hub>>,
    Query(query): Query<ListQuery>,
) -> Json<Vec<DesignSummary>> {
    let limit = query.limit.unwrap_or(LOBBY_LIMIT).clamp(1, 1000);
    Json(hub.find(query.q.as_deref(), limit))
}

#[derive(Deserialize)]
struct CreateDesign {
    #[serde(default)]
    name: String,
}

async fn create_design(
    State(hub): State<Arc<Hub>>,
    Json(body): Json<CreateDesign>,
) -> (StatusCode, Json<DesignSummary>) {
    (StatusCode::CREATED, Json(hub.create(&body.name)))
}

/// Why a request failed, as an HTTP response.
enum ApiError {
    NotFound(String),
    /// Another server owns the design. The `Finite-Owner` header says which,
    /// so a proxy can retry there.
    Misdirected {
        id: String,
        owner: String,
    },
    Unprocessable(String),
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        match self {
            Self::NotFound(message) => (StatusCode::NOT_FOUND, message).into_response(),
            Self::Misdirected { id, owner } => (
                StatusCode::MISDIRECTED_REQUEST,
                [("finite-owner", owner.clone())],
                format!("design {id:?} lives on {owner}"),
            )
                .into_response(),
            Self::Unprocessable(message) => {
                (StatusCode::UNPROCESSABLE_ENTITY, message).into_response()
            }
        }
    }
}

impl From<CommentError> for ApiError {
    fn from(error: CommentError) -> Self {
        match error {
            CommentError::NotFound(_) => Self::NotFound(error.to_string()),
            _ => Self::Unprocessable(error.to_string()),
        }
    }
}

/// Opens a design this server owns.
async fn open(hub: &Hub, id: &str) -> Result<Arc<DesignHandle>, ApiError> {
    if let Some(owner) = hub.elsewhere(id) {
        return Err(ApiError::Misdirected {
            id: id.into(),
            owner: owner.into(),
        });
    }
    hub.open(id)
        .await
        .ok_or_else(|| ApiError::NotFound(format!("design {id:?} not found")))
}

/// A design's snapshot. Thumbnails ask for every design in the list, so this
/// doesn't load the design into memory (see [`Hub::peek`]).
async fn get_design(
    State(hub): State<Arc<Hub>>,
    Path(id): Path<String>,
) -> Result<Json<Snapshot>, ApiError> {
    if let Some(owner) = hub.elsewhere(&id) {
        return Err(ApiError::Misdirected {
            id,
            owner: owner.into(),
        });
    }
    hub.peek(&id)
        .await
        .map(Json)
        .ok_or_else(|| ApiError::NotFound(format!("design {id:?} not found")))
}

/// Takes over a design another server is handing off, after the list of
/// servers changed. Only the new owner accepts it, and only if it doesn't
/// already have that design.
async fn adopt(
    State(hub): State<Arc<Hub>>,
    Path(id): Path<String>,
    Json(snapshot): Json<Snapshot>,
) -> Response {
    if snapshot.meta.id != id {
        return ApiError::Unprocessable("the snapshot is for another design".into())
            .into_response();
    }
    let adopted = match tokio::task::spawn_blocking(move || hub.adopt(snapshot)).await {
        Ok(adopted) => adopted,
        Err(error) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response();
        }
    };
    match adopted {
        Ok(summary) => (StatusCode::CREATED, Json(summary)).into_response(),
        Err(AdoptError::NotOwner(owner)) => ApiError::Misdirected { id, owner }.into_response(),
        Err(AdoptError::Exists) => (
            StatusCode::CONFLICT,
            format!("design {id:?} is already here"),
        )
            .into_response(),
        Err(AdoptError::Io(error)) => {
            (StatusCode::INTERNAL_SERVER_ERROR, error.to_string()).into_response()
        }
    }
}

#[derive(Serialize)]
struct Owner<'a> {
    /// The owner's base URL, or `null` when it's this server.
    owner: Option<&'a str>,
}

/// Which server owns a design. Any id works, even one not created yet, so a
/// proxy can ask any server where to send a request.
async fn owner_of(State(hub): State<Arc<Hub>>, Path(id): Path<String>) -> Response {
    Json(Owner {
        owner: hub.elsewhere(&id),
    })
    .into_response()
}

/// Who is commenting. Users have no accounts yet, so the browser picks an id
/// and a name, and the server marks them as users.
#[derive(Deserialize)]
struct UserAuthor {
    id: String,
    name: String,
}

impl UserAuthor {
    fn into_author(self) -> Author {
        let id: String = self.id.chars().take(comment::MAX_USER_ID).collect();
        let name = self.name.trim();
        Author {
            id: format!("user:{id}"),
            name: if name.is_empty() {
                "Guest".into()
            } else {
                name.chars().take(comment::MAX_NAME).collect()
            },
            kind: AuthorKind::User,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateComment {
    author: UserAuthor,
    body: String,
    #[serde(default)]
    artboard_id: Option<String>,
    #[serde(default)]
    node_id: Option<String>,
    x: f64,
    y: f64,
}

#[derive(Deserialize)]
struct Reply {
    author: UserAuthor,
    body: String,
}

#[derive(Deserialize)]
struct UpdateComment {
    resolved: bool,
}

type CommentResult = Result<(StatusCode, Json<Comment>), ApiError>;

async fn create_comment(
    State(hub): State<Arc<Hub>>,
    Path(id): Path<String>,
    Json(body): Json<CreateComment>,
) -> CommentResult {
    let anchor = Anchor {
        artboard_id: body.artboard_id,
        node_id: body.node_id,
        x: body.x,
        y: body.y,
    };
    let comment =
        open(&hub, &id)
            .await?
            .add_comment(body.author.into_author(), anchor, &body.body)?;
    Ok((StatusCode::CREATED, Json(comment)))
}

async fn reply_to_comment(
    State(hub): State<Arc<Hub>>,
    Path((id, comment)): Path<(String, String)>,
    Json(body): Json<Reply>,
) -> CommentResult {
    let comment =
        open(&hub, &id)
            .await?
            .reply(&comment, body.author.into_author(), &body.body, None)?;
    Ok((StatusCode::CREATED, Json(comment)))
}

async fn update_comment(
    State(hub): State<Arc<Hub>>,
    Path((id, comment)): Path<(String, String)>,
    Json(body): Json<UpdateComment>,
) -> CommentResult {
    let comment = open(&hub, &id)
        .await?
        .set_resolved(&comment, body.resolved)?;
    Ok((StatusCode::OK, Json(comment)))
}

/// Streams the design list: every design once, then each design as it changes.
async fn lobby_socket(State(hub): State<Arc<Hub>>, ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(move |socket| async move {
        let (first, rx) = hub.subscribe_lobby();
        let resync = {
            let hub = hub.clone();
            move || {
                let (first, _) = hub.subscribe_lobby();
                (first, 0)
            }
        };
        stream(socket, first, 0, rx, resync).await;
    })
}

/// `?epoch=…&since=…` on a design's socket: where a reconnecting viewer left off.
#[derive(Deserialize)]
struct ResumeQuery {
    epoch: Option<String>,
    since: Option<u64>,
}

/// Streams one design: a snapshot (or, for a viewer that reconnects with
/// `?epoch=…&since=…`, just what it missed), then every change and presence update.
///
/// Viewers can't edit the design yet, only comment on it (over HTTP). When
/// users can edit, they will send ops and undo/redo requests on this socket.
async fn design_socket(
    State(hub): State<Arc<Hub>>,
    Path(id): Path<String>,
    Query(query): Query<ResumeQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    let handle = match open(&hub, &id).await {
        Ok(handle) => handle,
        Err(error) => return error.into_response(),
    };
    let since = match query {
        ResumeQuery {
            epoch: Some(epoch),
            since: Some(seq),
        } => Some(Since { epoch, seq }),
        _ => None,
    };
    ws.on_upgrade(move |socket| async move {
        let (first, seq, rx) = handle.subscribe_from(since.as_ref());
        let resync = move || {
            let (first, seq, _) = handle.subscribe();
            (first, seq)
        };
        stream(socket, first, seq, rx, resync).await;
    })
}

/// Sends `first`, then every broadcast message newer than `seq`. If the
/// client falls behind the broadcast buffer, it gets a fresh snapshot instead
/// of the changes it missed. Pings the client, and closes if it goes quiet
/// (see [`crate::heartbeat`]).
async fn stream(
    mut socket: WebSocket,
    first: Outgoing,
    mut seq: u64,
    mut rx: broadcast::Receiver<Outgoing>,
    resync: impl Fn() -> (Outgoing, u64),
) {
    if !send(&mut socket, &first).await {
        return;
    }
    let mut heartbeat = Heartbeat::new();
    loop {
        tokio::select! {
            message = rx.recv() => match message {
                Ok(message) => {
                    if message.seq.is_some_and(|s| s <= seq) {
                        continue;
                    }
                    if !send(&mut socket, &message).await {
                        return;
                    }
                }
                Err(RecvError::Lagged(_)) => {
                    rx = rx.resubscribe();
                    let (snapshot, snapshot_seq) = resync();
                    seq = snapshot_seq;
                    if !send(&mut socket, &snapshot).await {
                        return;
                    }
                }
                Err(RecvError::Closed) => return,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => heartbeat.heard(),
            },
            alive = heartbeat.tick() => {
                if !alive || !heartbeat::send(&mut socket, Message::Ping(Default::default())).await {
                    return;
                }
            }
        }
    }
}

async fn send(socket: &mut WebSocket, message: &Outgoing) -> bool {
    heartbeat::send(socket, Message::Text(message.json.as_ref().into())).await
}
