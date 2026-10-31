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
    routing::{get, patch, post},
};
use finite_design::{
    Design, Snapshot,
    comment::{Author, AuthorKind, Comment, CommentError},
};
use serde::Deserialize;
use tokio::sync::broadcast::{self, error::RecvError};

use crate::hub::{CommentAnchor, DesignHandle, DesignSummary, Hub, Outgoing};

pub fn routes() -> Router<Arc<Hub>> {
    Router::new()
        .route("/designs", get(list_designs).post(create_design))
        .route("/designs/ws", get(lobby_socket))
        .route("/designs/{id}", get(get_design))
        .route("/designs/{id}/ws", get(design_socket))
        .route("/designs/{id}/comments", post(create_comment))
        .route("/designs/{id}/comments/{comment}", patch(update_comment))
        .route("/designs/{id}/comments/{comment}/replies", post(reply_to_comment))
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

async fn get_design(
    State(hub): State<Arc<Hub>>,
    Path(id): Path<String>,
) -> Result<Json<Snapshot>, StatusCode> {
    let handle = hub.get(&id).ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(handle.read(Design::snapshot)))
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

type CommentResult = Result<(StatusCode, Json<Comment>), (StatusCode, String)>;

fn design_of(hub: &Hub, id: &str) -> Result<Arc<DesignHandle>, (StatusCode, String)> {
    hub.get(id)
        .ok_or((StatusCode::NOT_FOUND, format!("design {id:?} not found")))
}

fn comment_error(error: CommentError) -> (StatusCode, String) {
    let status = match error {
        CommentError::NotFound(_) => StatusCode::NOT_FOUND,
        _ => StatusCode::UNPROCESSABLE_ENTITY,
    };
    (status, error.to_string())
}

async fn create_comment(
    State(hub): State<Arc<Hub>>,
    Path(id): Path<String>,
    Json(body): Json<CreateComment>,
) -> CommentResult {
    if !body.x.is_finite() || !body.y.is_finite() {
        return Err((StatusCode::UNPROCESSABLE_ENTITY, "x and y must be numbers".into()));
    }
    let anchor = CommentAnchor {
        artboard_id: body.artboard_id,
        node_id: body.node_id,
        x: body.x,
        y: body.y,
    };
    let comment = design_of(&hub, &id)?
        .add_comment(body.author.into_author(), anchor, &body.body)
        .map_err(comment_error)?;
    Ok((StatusCode::CREATED, Json(comment)))
}

async fn reply_to_comment(
    State(hub): State<Arc<Hub>>,
    Path((id, comment)): Path<(String, String)>,
    Json(body): Json<Reply>,
) -> CommentResult {
    let comment = design_of(&hub, &id)?
        .reply(&comment, body.author.into_author(), &body.body, None)
        .map_err(comment_error)?;
    Ok((StatusCode::CREATED, Json(comment)))
}

async fn update_comment(
    State(hub): State<Arc<Hub>>,
    Path((id, comment)): Path<(String, String)>,
    Json(body): Json<UpdateComment>,
) -> CommentResult {
    let comment = design_of(&hub, &id)?
        .set_resolved(&comment, body.resolved)
        .map_err(comment_error)?;
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
    let Some(handle) = hub.get(&id) else {
        return StatusCode::NOT_FOUND.into_response();
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
