//! MCP through the router: one agent session that reaches every server.
//!
//! The router is an MCP server itself. For each agent session it opens one
//! backend session per Finite server, on first use, and forwards each tool
//! call to the server that owns the call's `designId`. An agent always talks
//! to the same backend session on a given server, so its undo history there
//! works as if it were connected directly. The `X-Finite-Agent` header is
//! passed on, so a named agent keeps its name.
//!
//! An agent without its own `X-Finite-Agent` is identified by its router
//! session instead, and every router derives the same identity from it. So
//! with a shared session store ([`DirSessionStore`]), a session can move to
//! another router mid-conversation and keep its undo history.
//!
//! - `list_designs` asks every server at once and merges the lists. A server
//!   that doesn't answer, or answers with an error, is named at the end
//!   instead of failing the call. Only when none answers does the call fail.
//! - `create_design` takes turns between servers, like `POST /api/designs`.
//! - Every other tool goes to the owner of its `designId`.
//!
//! A server that restarts forgets its sessions. rmcp's client notices (the
//! server answers 404) and opens a new session by itself, and the relay opens
//! one if the old one closed. The server knows the agent by its identity, not
//! its session, so the agent's undo history there carries on.

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use futures::future::join_all;

use rmcp::{
    ErrorData as McpError, RoleClient, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig,
    },
    service::{RequestContext, RunningService, ServiceError},
    transport::{
        StreamableHttpClientTransport,
        streamable_http_client::StreamableHttpClientTransportConfig,
        streamable_http_server::{
            StreamableHttpServerConfig, StreamableHttpService,
            session::{
                local::LocalSessionManager,
                store::{SessionState, SessionStore, SessionStoreError},
            },
        },
    },
};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{
    cluster::Members,
    mcp::{ID_MATCH_NOTE, params::ListParams},
    mcp::{OWNER_META, instructions},
    router::UPSTREAM_TIMEOUT,
};

type Backend = Arc<RunningService<RoleClient, ()>>;

/// One agent session's connections to the servers.
pub struct Relay {
    /// The servers, as the router sees them now.
    members: Arc<Members>,
    /// Shared by every session, so creation takes turns across all agents.
    next: Arc<AtomicUsize>,
    /// A backend session per server, by base URL, opened on first use. That
    /// includes servers a `designId`'s owner points to that aren't in the
    /// router's list yet. Each has its own lock, so a slow server doesn't
    /// hold up calls to the others.
    backends: std::sync::Mutex<HashMap<String, Arc<Mutex<Option<Backend>>>>>,
}

/// The router's MCP endpoint, to mount at `/mcp`. With `sessions`, routers
/// that share the store can each serve any session.
pub fn service(
    members: Arc<Members>,
    sessions: Option<Arc<dyn SessionStore>>,
) -> StreamableHttpService<Relay, LocalSessionManager> {
    let mut config =
        StreamableHttpServerConfig::default().with_allowed_hosts(members.now().allowed_hosts());
    config.session_store = sessions;
    let next = Arc::new(AtomicUsize::new(0));
    StreamableHttpService::new(
        move || {
            Ok(Relay {
                members: members.clone(),
                next: next.clone(),
                backends: Default::default(),
            })
        },
        Arc::new(crate::mcp::sessions()),
        config,
    )
}

fn header(ctx: &RequestContext<RoleServer>, name: &str) -> Option<http::HeaderValue> {
    ctx.extensions
        .get::<http::request::Parts>()
        .and_then(|p| p.headers.get(name))
        .cloned()
}

/// Who the backends see. A named agent keeps its name. An unnamed one is
/// identified by its router session, which every router sees the same way,
/// and shown as its client's name.
fn identity(ctx: &RequestContext<RoleServer>) -> HashMap<http::HeaderName, http::HeaderValue> {
    let mut headers = HashMap::new();
    let agent = http::HeaderName::from_static("x-finite-agent");
    if let Some(named) = header(ctx, "x-finite-agent") {
        headers.insert(agent, named);
        return headers;
    }
    let Some(session) =
        header(ctx, "mcp-session-id").and_then(|v| v.to_str().ok().map(String::from))
    else {
        return headers;
    };
    let client: String = ctx
        .peer
        .peer_info()
        .map(|info| info.client_info.name.clone())
        .unwrap_or_else(|| "Agent".into())
        .chars()
        .filter(|c| c.is_ascii_graphic() || *c == ' ')
        .collect();
    let short: String = session.chars().take(4).collect();
    if let Ok(id) = http::HeaderValue::from_str(&format!("relay:{session}")) {
        headers.insert(agent, id);
    }
    if let Ok(name) = http::HeaderValue::from_str(&format!("{client} ({short})")) {
        headers.insert(http::HeaderName::from_static("x-finite-agent-name"), name);
    }
    headers
}

fn unreachable(base: &str, error: impl std::fmt::Display) -> McpError {
    McpError::internal_error(format!("Finite server {base} didn't answer: {error}"), None)
}

/// Waits at most `UPSTREAM_TIMEOUT` for `work` on `base`. A server that's
/// stuck, rather than down, accepts connections and never answers, and
/// without a limit it held up `list_designs` for every agent. Only for quick
/// steps: a tool call like `wait_for_comments` can rightly take minutes.
async fn in_time<T>(
    base: &str,
    work: impl Future<Output = Result<T, McpError>>,
) -> Result<T, McpError> {
    tokio::time::timeout(UPSTREAM_TIMEOUT, work)
        .await
        .unwrap_or_else(|_| Err(unreachable(base, "it took too long")))
}

impl Relay {
    /// The session on the server at `base`, opening one if there's none or
    /// the last one closed.
    async fn backend(
        &self,
        base: &str,
        ctx: &RequestContext<RoleServer>,
    ) -> Result<Backend, McpError> {
        let slot = self
            .backends
            .lock()
            .unwrap()
            .entry(base.to_owned())
            .or_default()
            .clone();
        let mut slot = slot.lock().await;
        if let Some(backend) = slot.as_ref()
            && !backend.is_closed()
            && !backend.is_transport_closed()
        {
            return Ok(backend.clone());
        }
        let config = StreamableHttpClientTransportConfig::with_uri(format!("{base}/mcp"))
            .custom_headers(identity(ctx));
        let connect = async {
            ().serve(StreamableHttpClientTransport::from_config(config))
                .await
                .map_err(|e| unreachable(base, e))
        };
        let backend = in_time(base, connect).await?;
        Ok(slot.insert(Arc::new(backend)).clone())
    }

    /// Calls a tool on the server at `base`. If it says another server owns
    /// the design, the call goes there once: it didn't run, so that's safe.
    /// That happens while a server is being added, if the servers already
    /// know about it and the router doesn't yet.
    async fn call(
        &self,
        base: &str,
        params: CallToolRequestParams,
        ctx: &RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let result = self.call_once(base, params.clone(), ctx).await?;
        let owner = result
            .meta
            .as_ref()
            .filter(|_| result.is_error == Some(true))
            .and_then(|meta| meta.0.get(OWNER_META))
            .and_then(Value::as_str)
            .filter(|owner| *owner != base && crate::cluster::is_base_url(owner))
            .map(str::to_owned);
        match owner {
            Some(owner) => self.call_once(&owner, params, ctx).await,
            None => Ok(result),
        }
    }

    /// Calls a tool on the server at `base`. A call that fails to get through
    /// isn't retried, because it may have run before the connection broke.
    async fn call_once(
        &self,
        base: &str,
        params: CallToolRequestParams,
        ctx: &RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let backend = self.backend(base, ctx).await?;
        match backend.call_tool_once(params).await {
            Ok(CallToolResponse::Complete(result)) => Ok(result),
            Ok(_) => Err(McpError::internal_error("unexpected tool response", None)),
            Err(ServiceError::McpError(error)) => Err(error),
            Err(error) => Err(unreachable(base, error)),
        }
    }

    /// Calls `list_designs` on every server at once and merges the JSON
    /// arrays, newest first. Each server applies the `query` and `limit`, so
    /// the merged list is cut to the limit again. Servers that don't answer
    /// are named after the list.
    async fn list_designs(
        &self,
        params: CallToolRequestParams,
        ctx: &RequestContext<RoleServer>,
    ) -> CallToolResult {
        let cluster = self.members.now();
        let calls = cluster
            .nodes()
            .iter()
            .map(|base| in_time(base, self.call(base, params.clone(), ctx)));
        let limit = params
            .arguments
            .as_ref()
            .and_then(|args| args.get("limit"))
            .and_then(Value::as_u64)
            .map_or(ListParams::DEFAULT_LIMIT, |n| {
                (n as usize).clamp(1, ListParams::MAX_LIMIT)
            });
        let mut designs: Vec<Value> = Vec::new();
        let mut missing = Vec::new();
        // Whether a server left some out, so the merged list is partial too.
        let mut cut = false;
        for (base, result) in cluster.nodes().iter().zip(join_all(calls).await) {
            // A server whose call failed answers with its error, not a list.
            let Some(result) = result.ok().filter(|r| r.is_error != Some(true)) else {
                missing.push(base.as_str());
                continue;
            };
            for block in &result.content {
                let Some(text) = block.as_text() else {
                    continue;
                };
                match serde_json::from_str(&text.text) {
                    Ok(Value::Array(list)) => designs.extend(list),
                    // A server's own note about its list, which is redone below.
                    _ if text.text.starts_with("The query matched") => {}
                    _ => cut = true,
                }
            }
        }
        if missing.len() == cluster.nodes().len() {
            return CallToolResult::error(vec![ContentBlock::text(format!(
                "No Finite server answered: {}",
                missing.join(", ")
            ))]);
        }
        designs.sort_by_key(|d| std::cmp::Reverse(d["updatedAt"].as_u64().unwrap_or(0)));
        cut |= designs.len() > limit;
        designs.truncate(limit);
        let text = serde_json::to_string_pretty(&designs).expect("json values serialize");
        let mut content = vec![ContentBlock::text(text)];
        if cut {
            content.push(ContentBlock::text(format!(
                "Showing the {limit} most recently edited designs; there are more. Pass a query to find one by name, or a larger limit."
            )));
        }
        let query = ListParams::with_query(
            params
                .arguments
                .as_ref()
                .and_then(|args| args.get("query"))
                .and_then(Value::as_str)
                .map(str::to_owned),
        );
        let entries = designs
            .iter()
            .filter_map(|d| Some((d["designId"].as_str()?, d["name"].as_str()?)));
        if query.only_by_id(entries) {
            content.push(ContentBlock::text(ID_MATCH_NOTE));
        }
        if !missing.is_empty() {
            content.push(ContentBlock::text(format!(
                "These Finite servers didn't answer, so their designs are missing: {}",
                missing.join(", ")
            )));
        }
        CallToolResult::success(content)
    }
}

impl ServerHandler for Relay {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "finite-router",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(instructions())
    }

    /// Every server has the same tools, so the first that answers lists them.
    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let mut last = None;
        let cluster = self.members.now();
        for base in cluster.nodes() {
            let listed = match self.backend(base, &ctx).await {
                Ok(backend) => {
                    let list = async {
                        backend
                            .list_all_tools()
                            .await
                            .map_err(|e| unreachable(base, e))
                    };
                    in_time(base, list).await
                }
                Err(error) => Err(error),
            };
            match listed {
                Ok(tools) => return Ok(ListToolsResult::with_all_items(tools)),
                Err(error) => last = Some(error),
            }
        }
        Err(last.unwrap_or_else(|| McpError::internal_error("no Finite server is running", None)))
    }

    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        ctx: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        let design_id = request
            .arguments
            .as_ref()
            .and_then(|args| args.get("designId"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let cluster = self.members.now();
        let nodes = cluster.nodes();
        if nodes.is_empty() {
            return Ok(CallToolResult::error(vec![ContentBlock::text(
                "No Finite server is running. Try again in a few seconds.",
            )])
            .into());
        }
        let result = match (request.name.as_ref(), design_id) {
            ("list_designs", _) => self.list_designs(request, &ctx).await,
            ("create_design", _) => {
                let turn = self.next.fetch_add(1, Ordering::Relaxed);
                let mut created = None;
                for i in 0..nodes.len() {
                    let base = &nodes[(turn + i) % nodes.len()];
                    // A server we can't open a session with never saw the
                    // call, so the next one can take it.
                    if i + 1 < nodes.len() && self.backend(base, &ctx).await.is_err() {
                        continue;
                    }
                    created = Some(self.call(base, request.clone(), &ctx).await?);
                    break;
                }
                created.expect("the last server is always tried")
            }
            (_, Some(id)) => {
                let owner = cluster.owner_url(&id).expect("some server is live");
                self.call(owner, request, &ctx).await?
            }
            // No designId: let a server report the missing argument.
            (_, None) => self.call(&nodes[0], request, &ctx).await?,
        };
        Ok(result.into())
    }
}

/// MCP sessions as JSON files in one directory, so several routers on a
/// shared volume can serve the same sessions. Each file holds what the
/// session's `initialize` request said, which is all a router needs to
/// resume it.
pub struct DirSessionStore {
    dir: std::path::PathBuf,
}

impl DirSessionStore {
    pub fn new(dir: impl Into<std::path::PathBuf>) -> std::io::Result<Self> {
        let dir = dir.into();
        std::fs::create_dir_all(&dir)?;
        Ok(Self { dir })
    }

    fn path(&self, session_id: &str) -> std::path::PathBuf {
        let safe: String = session_id
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
            .collect();
        self.dir.join(format!("{safe}.json"))
    }
}

#[async_trait::async_trait]
impl SessionStore for DirSessionStore {
    /// A file that doesn't parse (cut short by a power cut, say) counts as
    /// no session. An error here would fail every request in that session,
    /// while "no session" gets a `404`, and MCP clients answer that by
    /// starting a new one.
    async fn load(&self, session_id: &str) -> Result<Option<SessionState>, SessionStoreError> {
        let path = self.path(session_id);
        let bytes = match tokio::fs::read(&path).await {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        match serde_json::from_slice(&bytes) {
            Ok(state) => Ok(Some(state)),
            Err(error) => {
                tracing::warn!(session_id, %error, "dropping an unreadable session file");
                let _ = tokio::fs::remove_file(&path).await;
                Ok(None)
            }
        }
    }

    /// Writes to a temporary file, syncs it, then renames it into place, so
    /// a session file is always whole. The temporary name is random, since
    /// routers share the directory: with one name, two routers saving the
    /// same session would write into the same file.
    async fn store(&self, session_id: &str, state: &SessionState) -> Result<(), SessionStoreError> {
        let path = self.path(session_id);
        let tmp = path.with_extension(format!("{}.tmp", crate::hub::random_id(8)));
        let bytes = serde_json::to_vec(state)?;
        let written = tmp.clone();
        tokio::task::spawn_blocking(move || -> std::io::Result<()> {
            use std::io::Write;
            let mut file = std::fs::File::create(&written)?;
            file.write_all(&bytes)?;
            file.sync_all()
        })
        .await
        .map_err(std::io::Error::other)??;
        tokio::fs::rename(tmp, path).await?;
        Ok(())
    }

    async fn delete(&self, session_id: &str) -> Result<(), SessionStoreError> {
        match tokio::fs::remove_file(self.path(session_id)).await {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn an_unreadable_session_file_counts_as_no_session() {
        let dir =
            std::env::temp_dir().join(format!("finite-sessions-{}", crate::hub::random_id(8)));
        let store = DirSessionStore::new(&dir).unwrap();
        std::fs::write(dir.join("abc.json"), b"{\"cut sh").unwrap();
        assert!(store.load("abc").await.unwrap().is_none());
        assert!(!dir.join("abc.json").exists(), "the broken file is removed");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
