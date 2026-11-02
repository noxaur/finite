//! HTTP and WebSocket routes for the web app, under `/api`.

use std::sync::Arc;

use axum::{
    Json, Router,
    body::Bytes,
    extract::{
        DefaultBodyLimit, Path, Query, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
};
use finite_design::{
    Snapshot,
    comment::{self, Anchor, Author, AuthorKind, Comment, CommentError},
    edit,
    import::ImportRecord,
    version::{self, VersionError},
};
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast::{self, error::RecvError};

use crate::blob::{self, BlobHash};
use crate::cluster::Place;
use crate::heartbeat::{self, Heartbeat};
use crate::hub::{
    Actor, AdoptError, DesignHandle, DesignSummary, Hub, LOBBY_LIMIT, OpenError, Outgoing, Since,
    is_design_id,
};
use crate::transfer::{self, ImportRequest, ImportResult, TransferError};

/// The largest design another server can hand off. axum's default of 2 MB
/// suits API calls, but a handoff carries a whole design with its undo
/// histories, and one MCP call alone can add 4 MB.
const HANDOFF_LIMIT: usize = 256 << 20;

/// The largest file an import accepts: the largest blob, since the file is
/// kept whole as one. The codecs parse it all in memory.
pub const IMPORT_LIMIT: usize = crate::blob::MAX_BLOB;

/// Who imports over HTTP. The body is the file itself, so unlike
/// [`set_css`] there's no room for the person's own id and name.
fn browser() -> Actor {
    Actor {
        id: "web".into(),
        name: "Someone in the browser".into(),
    }
}

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
        .route(
            "/designs/{id}/comments/{comment}",
            patch(update_comment).delete(delete_comment),
        )
        .route(
            "/designs/{id}/comments/{comment}/messages/last",
            patch(edit_last_message),
        )
        .route(
            "/designs/{id}/comments/{comment}/replies",
            post(reply_to_comment),
        )
        .route("/designs/{id}/css", put(set_css))
        .route(
            "/designs/{id}/import",
            post(import).layer(DefaultBodyLimit::max(IMPORT_LIMIT)),
        )
        .route("/designs/{id}/export", get(export))
        .route("/designs/{id}/imports", get(list_imports))
        .route("/designs/{id}/imports/{import}/original", get(original))
        .route(
            "/designs/{id}/assets/{hash}",
            get(get_asset)
                .put(put_asset)
                .layer(DefaultBodyLimit::max(blob::MAX_BLOB)),
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
) -> Result<(StatusCode, Json<DesignSummary>), ApiError> {
    let created = tokio::task::spawn_blocking(move || hub.try_create(&body.name))
        .await
        .map_err(|e| ApiError::Unavailable(e.to_string()))?;
    match created {
        Ok(summary) => Ok((StatusCode::CREATED, Json(summary))),
        Err(error) => Err(ApiError::Unavailable(error.to_string())),
    }
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
    /// Something broke on this server, like storage.
    Failed(String),
    /// No server can serve the design right now, say while it moves
    /// between servers. Worth trying again in a moment.
    Unavailable(String),
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
            Self::Failed(message) => (StatusCode::INTERNAL_SERVER_ERROR, message).into_response(),
            Self::Unavailable(message) => (
                StatusCode::SERVICE_UNAVAILABLE,
                [("retry-after", "1")],
                message,
            )
                .into_response(),
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

impl From<TransferError> for ApiError {
    fn from(error: TransferError) -> Self {
        match error {
            TransferError::NotFound(message) => Self::NotFound(message),
            TransferError::Invalid(message) => Self::Unprocessable(message),
            TransferError::Io(_) => Self::Failed(error.to_string()),
        }
    }
}

/// Refuses a design another server owns, or that no server can serve now.
fn here(hub: &Hub, id: &str) -> Result<(), ApiError> {
    match hub.place(id) {
        Place::Here => Ok(()),
        Place::Elsewhere(owner) => Err(ApiError::Misdirected {
            id: id.into(),
            owner,
        }),
        Place::Nowhere => Err(ApiError::Unavailable(
            "no Finite server is serving designs right now".into(),
        )),
    }
}

/// Opens a design this server owns.
async fn open(hub: &Arc<Hub>, id: &str) -> Result<Arc<DesignHandle>, ApiError> {
    here(hub, id)?;
    hub.open(id).await.map_err(|error| match error {
        OpenError::Busy(_) => ApiError::Unavailable(error.to_string()),
        _ => ApiError::NotFound(format!("design {id:?} not found")),
    })
}

/// A design's snapshot. Thumbnails ask for every design in the list, so this
/// doesn't load the design into memory (see [`Hub::peek`]).
async fn get_design(
    State(hub): State<Arc<Hub>>,
    Path(id): Path<String>,
) -> Result<Json<Snapshot>, ApiError> {
    here(&hub, &id)?;
    hub.peek(&id)
        .await
        .map(Json)
        .ok_or_else(|| ApiError::NotFound(format!("design {id:?} not found")))
}

/// Takes over a design another server is handing off, after the list of
/// servers changed. Only the new owner accepts it, and only if it doesn't
/// already have that design. A snapshot from a newer version is refused with
/// `409`, so the sender keeps its copy.
async fn adopt(State(hub): State<Arc<Hub>>, Path(id): Path<String>, body: String) -> Response {
    let snapshot: Snapshot = match version::SNAPSHOT.decode(&body) {
        Ok(snapshot) => snapshot,
        Err(error @ VersionError::Newer { .. }) => {
            return (StatusCode::CONFLICT, error.to_string()).into_response();
        }
        Err(error) => return ApiError::Unprocessable(error.to_string()).into_response(),
    };
    if snapshot.meta.id != id {
        return ApiError::Unprocessable("the snapshot is for another design".into())
            .into_response();
    }
    if !is_design_id(&id) {
        return ApiError::Unprocessable("that isn't a design id".into()).into_response();
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
        Err(AdoptError::Shared) => (
            StatusCode::CONFLICT,
            "this server shares its store, so designs never need handing off",
        )
            .into_response(),
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
struct Owner {
    /// The owner's base URL, or `null` when it's this server.
    owner: Option<String>,
}

/// Which server owns a design. Any id works, even one not created yet, so a
/// proxy can ask any server where to send a request.
async fn owner_of(State(hub): State<Arc<Hub>>, Path(id): Path<String>) -> Response {
    Json(Owner {
        owner: hub.elsewhere(&id),
    })
    .into_response()
}

/// A blob, by the hash of its bytes. A hash always names the same bytes, so
/// browsers may keep the answer forever.
///
/// Anyone can store bytes that claim to be an image, so every answer is
/// locked down: the type comes from the bytes, `nosniff` stops a browser
/// from guessing another, and `sandbox` keeps a script in an SVG from running
/// when someone opens the URL itself.
async fn get_asset(
    State(hub): State<Arc<Hub>>,
    Path((id, hash)): Path<(String, String)>,
) -> Response {
    let mut response = match asset(&hub, &id, &hash).await {
        Ok(response) => response,
        Err(error) => error.into_response(),
    };
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static("sandbox"),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

async fn asset(hub: &Hub, id: &str, hash: &str) -> Result<Response, ApiError> {
    here(hub, id)?;
    let hash = BlobHash::parse(hash).map_err(|e| ApiError::Unprocessable(e.to_string()))?;
    let store = hub.store();
    let key = hash.clone();
    let bytes = tokio::task::spawn_blocking(move || store.get_blob(&key))
        .await
        .map_err(|e| ApiError::Unavailable(e.to_string()))?
        .map_err(|e| ApiError::Unavailable(e.to_string()))?
        .ok_or_else(|| ApiError::NotFound(format!("blob {hash} not found")))?;
    Ok((
        [
            (header::CONTENT_TYPE, blob::media_type(&bytes)),
            (header::CACHE_CONTROL, "public, max-age=31536000, immutable"),
        ],
        bytes,
    )
        .into_response())
}

/// Stores a blob a server is handing off along with its design. Only a
/// handoff calls this: an import stores its own bytes. The hash in the path
/// must match the body, so a handoff can't plant bytes under another name.
async fn put_asset(
    State(hub): State<Arc<Hub>>,
    Path((id, hash)): Path<(String, String)>,
    body: Bytes,
) -> Result<StatusCode, ApiError> {
    here(&hub, &id)?;
    let hash = BlobHash::parse(&hash).map_err(|e| ApiError::Unprocessable(e.to_string()))?;
    let store = hub.store();
    tokio::task::spawn_blocking(move || {
        let actual = BlobHash::of(&body);
        if actual != hash {
            return Ok(Err(ApiError::Unprocessable(format!(
                "those bytes hash to {actual}, not {hash}"
            ))));
        }
        store.put_blob(&body).map(|_| Ok(StatusCode::CREATED))
    })
    .await
    .map_err(|e| ApiError::Unavailable(e.to_string()))?
    .map_err(|e| ApiError::Unavailable(e.to_string()))?
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

#[derive(Deserialize)]
struct EditMessage {
    author: UserAuthor,
    body: String,
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

/// Replaces the body of the thread's newest message, if the person wrote it.
async fn edit_last_message(
    State(hub): State<Arc<Hub>>,
    Path((id, comment)): Path<(String, String)>,
    Json(body): Json<EditMessage>,
) -> CommentResult {
    let author = body.author.into_author();
    let comment = open(&hub, &id)
        .await?
        .edit_message(&comment, &author.id, &body.body)?;
    Ok((StatusCode::OK, Json(comment)))
}

async fn delete_comment(
    State(hub): State<Arc<Hub>>,
    Path((id, comment)): Path<(String, String)>,
) -> Result<StatusCode, ApiError> {
    open(&hub, &id).await?.delete_comment(&comment)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
struct SetCss {
    author: UserAuthor,
    css: String,
}

/// What a change made: its `seq`, or `null` when it changed nothing.
#[derive(Serialize)]
struct Changed {
    seq: Option<u64>,
}

/// Replaces the design's shared CSS, as one undoable change by the person
/// who sent it. Viewers get it as a change like any other.
async fn set_css(
    State(hub): State<Arc<Hub>>,
    Path(id): Path<String>,
    Json(body): Json<SetCss>,
) -> Result<Json<Changed>, ApiError> {
    let author = body.author.into_author();
    let actor = Actor {
        id: author.id,
        name: author.name,
    };
    let (_, change) = open(&hub, &id)
        .await?
        .edit(&actor, "Set shared CSS", |_| {
            Ok((edit::set_css(&body.css)?, ()))
        })
        .map_err(|error| ApiError::Unprocessable(error.to_string()))?;
    Ok(Json(Changed {
        seq: change.map(|c| c.seq),
    }))
}

/// `?format=…&name=…&strict=…` on an import: the format, the file's name,
/// and the axes strict mode holds, like `preserved,editable`.
#[derive(Deserialize)]
struct ImportQuery {
    format: String,
    name: Option<String>,
    /// The page the artboards go on. Omitted: the first page.
    page: Option<String>,
    #[serde(default)]
    strict: String,
}

/// Imports the body, the file's exact bytes, as new artboards in one undo
/// step. See `docs/import-export.md`.
async fn import(
    State(hub): State<Arc<Hub>>,
    Path(id): Path<String>,
    Query(query): Query<ImportQuery>,
    body: Bytes,
) -> Result<(StatusCode, Json<ImportResult>), ApiError> {
    here(&hub, &id)?;
    let request = ImportRequest {
        format: transfer::format_named(&query.format)?,
        bytes: body.to_vec(),
        file_name: query.name,
        page: query.page,
        strict: transfer::strict_named([query.strict.as_str()])?,
    };
    let result = transfer::import(&hub, &id, &browser(), request).await?;
    Ok((StatusCode::CREATED, Json(result)))
}

/// `?format=…&artboard=…` on an export. Without an artboard it's the whole design.
#[derive(Deserialize)]
struct ExportQuery {
    format: String,
    artboard: Option<String>,
}

/// The design, or one artboard, as a file to download. `Finite-Diagnostics`
/// counts what didn't convert exactly.
async fn export(
    State(hub): State<Arc<Hub>>,
    Path(id): Path<String>,
    Query(query): Query<ExportQuery>,
) -> Result<Response, ApiError> {
    here(&hub, &id)?;
    let format = transfer::format_named(&query.format)?;
    let scope = match query.artboard {
        Some(artboard) => finite_transfer::Scope::Artboard(artboard),
        None => finite_transfer::Scope::Design,
    };
    let exported = transfer::export(&hub, &id, format, scope).await?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static(exported.media_type),
            ),
            (
                header::CONTENT_DISPOSITION,
                attachment(Some(&exported.file_name)),
            ),
            (
                header::HeaderName::from_static("finite-diagnostics"),
                HeaderValue::from(exported.diagnostics.len()),
            ),
        ],
        exported.bytes,
    )
        .into_response())
}

/// A `Content-Disposition` that downloads the file as `name`. Characters a
/// header can't carry, and quotes, become `_`.
fn attachment(name: Option<&str>) -> HeaderValue {
    let Some(name) = name else {
        return HeaderValue::from_static("attachment");
    };
    let name: String = name
        .chars()
        .map(|c| match c {
            ' ' | '!' | '#'..='[' | ']'..='~' => c,
            _ => '_',
        })
        .collect();
    HeaderValue::from_str(&format!("attachment; filename=\"{name}\""))
        .expect("only visible ASCII is left")
}

/// Every import into the design, oldest first, with what each one kept out.
async fn list_imports(
    State(hub): State<Arc<Hub>>,
    Path(id): Path<String>,
) -> Result<Json<Vec<ImportRecord>>, ApiError> {
    let imports = open(&hub, &id).await?.read(|d| d.imports().to_vec());
    Ok(Json(imports))
}

/// The exact bytes an import received. They can be hostile HTML, so they're
/// only ever downloaded: the type says nothing, `nosniff` stops a browser
/// from guessing one, and `sandbox` stops a script if it renders anyway.
async fn original(
    State(hub): State<Arc<Hub>>,
    Path((id, import)): Path<(String, String)>,
) -> Result<Response, ApiError> {
    here(&hub, &id)?;
    let (record, bytes) = transfer::original(&hub, &id, &import).await?;
    Ok((
        [
            (
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/octet-stream"),
            ),
            (
                header::CONTENT_DISPOSITION,
                attachment(record.file_name.as_deref()),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
            (
                header::CONTENT_SECURITY_POLICY,
                HeaderValue::from_static("sandbox"),
            ),
        ],
        bytes,
    )
        .into_response())
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
                Some(Ok(message)) => {
                    heartbeat.heard();
                    if matches!(&message, Message::Text(text) if text.as_str() == heartbeat::PING)
                        && !heartbeat::send(&mut socket, Message::text(heartbeat::PONG)).await
                    {
                        return;
                    }
                }
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
    heartbeat::send(socket, Message::Text(message.json.clone())).await
}
