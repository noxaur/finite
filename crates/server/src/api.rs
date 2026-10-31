//! HTTP and WebSocket routes for the web app, under `/api`.

use std::sync::Arc;

use axum::{
    Json, Router,
    extract::{
        Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
};
use finite_design::{
    Design, Snapshot,
    comment::{Anchor, Author, AuthorKind, Comment, CommentError},
};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::{self, error::RecvError};

use crate::hub::{AdoptError, DesignHandle, DesignSummary, Hub, Outgoing};

pub fn routes() -> Router<Arc<Hub>> {
    Router::new()
        .route("/designs", get(list_designs).post(create_design))
        .route("/designs/ws", get(lobby_socket))
        .route("/designs/{id}", get(get_design))
        .route("/owner/{id}", get(owner_of))
        .route("/designs/{id}/handoff", put(adopt))
        .route("/designs/{id}/ws", get(design_socket))
        .route("/designs/{id}/comments", post(create_comment))
        .route("/designs/{id}/comments/{comment}", patch(update_comment))
        .route(
            "/designs/{id}/comments/{comment}/replies",
            post(reply_to_comment),
        )
}

async fn list_designs(State(hub): State<Arc<Hub>>) -> Json<Vec<DesignSummary>> {
    Json(hub.list())
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

async fn get_design(
    State(hub): State<Arc<Hub>>,
    Path(id): Path<String>,
) -> Result<Json<Snapshot>, ApiError> {
    Ok(Json(open(&hub, &id).await?.read(Design::snapshot)))
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
        let id: String = self.id.chars().take(64).collect();
        let name = self.name.trim();
        Author {
            id: format!("user:{id}"),
            name: if name.is_empty() {
                "Guest".into()
            } else {
                name.chars().take(48).collect()
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

/// Streams one design: a snapshot, then every change and presence update.
///
/// Viewers can't edit the design yet, only comment on it (over HTTP). When
/// users can edit, they will send ops and undo/redo requests on this socket.
async fn design_socket(
    State(hub): State<Arc<Hub>>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Response {
    let handle = match open(&hub, &id).await {
        Ok(handle) => handle,
        Err(error) => return error.into_response(),
    };
    ws.on_upgrade(move |socket| async move {
        let (first, seq, rx) = handle.subscribe();
        let resync = move || {
            let (first, seq, _) = handle.subscribe();
            (first, seq)
        };
        stream(socket, first, seq, rx, resync).await;
    })
}

/// Sends `first`, then every broadcast message newer than `seq`. If the
/// client falls behind the broadcast buffer, it gets a fresh snapshot instead
/// of the changes it missed.
async fn stream(
    mut socket: WebSocket,
    first: Outgoing,
    mut seq: u64,
    mut rx: broadcast::Receiver<Outgoing>,
    resync: impl Fn() -> (Outgoing, u64),
) {
    if send(&mut socket, &first).await.is_err() {
        return;
    }
    loop {
        tokio::select! {
            message = rx.recv() => match message {
                Ok(message) => {
                    if message.seq.is_some_and(|s| s <= seq) {
                        continue;
                    }
                    if send(&mut socket, &message).await.is_err() {
                        return;
                    }
                }
                Err(RecvError::Lagged(_)) => {
                    rx = rx.resubscribe();
                    let (snapshot, snapshot_seq) = resync();
                    seq = snapshot_seq;
                    if send(&mut socket, &snapshot).await.is_err() {
                        return;
                    }
                }
                Err(RecvError::Closed) => return,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {}
            },
        }
    }
}

async fn send(socket: &mut WebSocket, message: &Outgoing) -> Result<(), axum::Error> {
    socket
        .send(Message::Text(message.json.as_ref().into()))
        .await
}
