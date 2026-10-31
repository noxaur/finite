//! MCP through the router: one agent session that reaches every server.
//!
//! The router is an MCP server itself. For each agent session it opens one
//! backend session per Finite server, on first use, and forwards each tool
//! call to the server that owns the call's `designId`. An agent always talks
//! to the same backend session on a given server, so its undo history there
//! works as if it were connected directly. The `X-Finite-Agent` header is
//! passed on, so a named agent keeps its name.
//!
//! - `list_designs` asks every server and merges the lists.
//! - `create_design` takes turns between servers, like `POST /api/designs`.
//! - Every other tool goes to the owner of its `designId`.

use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};

use rmcp::{
    ErrorData as McpError, RoleClient, RoleServer, ServerHandler, ServiceExt,
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig,
    },
    service::{RequestContext, RunningService},
    transport::{
        StreamableHttpClientTransport,
        streamable_http_client::StreamableHttpClientTransportConfig,
        streamable_http_server::{
            StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
        },
    },
};
use serde_json::Value;
use tokio::sync::Mutex;

use crate::{cluster::Cluster, mcp::INSTRUCTIONS};

type Backend = Arc<RunningService<RoleClient, ()>>;

/// One agent session's connections to the servers.
pub struct Relay {
    cluster: Arc<Cluster>,
    /// Shared by every session, so creation takes turns across all agents.
    next: Arc<AtomicUsize>,
    /// Backend sessions by server position, opened on first use.
    backends: Mutex<HashMap<usize, Backend>>,
}

/// The router's MCP endpoint, to mount at `/mcp`.
pub fn service(cluster: Cluster) -> StreamableHttpService<Relay, LocalSessionManager> {
    let config = StreamableHttpServerConfig::default().with_allowed_hosts(cluster.allowed_hosts());
    let cluster = Arc::new(cluster);
    let next = Arc::new(AtomicUsize::new(0));
    StreamableHttpService::new(
        move || {
            Ok(Relay {
                cluster: cluster.clone(),
                next: next.clone(),
                backends: Mutex::new(HashMap::new()),
            })
        },
        Arc::new(LocalSessionManager::default()),
        config,
    )
}

fn agent_header(ctx: &RequestContext<RoleServer>) -> Option<http::HeaderValue> {
    ctx.extensions
        .get::<http::request::Parts>()
        .and_then(|p| p.headers.get("x-finite-agent"))
        .cloned()
}

fn unreachable(base: &str, error: impl std::fmt::Display) -> McpError {
    McpError::internal_error(format!("Finite server {base} didn't answer: {error}"), None)
}

impl Relay {
    async fn backend(
        &self,
        node: usize,
        ctx: &RequestContext<RoleServer>,
    ) -> Result<Backend, McpError> {
        let mut backends = self.backends.lock().await;
        if let Some(backend) = backends.get(&node) {
            return Ok(backend.clone());
        }
        let base = &self.cluster.nodes()[node];
        let mut headers = HashMap::new();
        if let Some(agent) = agent_header(ctx) {
            headers.insert(http::HeaderName::from_static("x-finite-agent"), agent);
        }
        let config = StreamableHttpClientTransportConfig::with_uri(format!("{base}/mcp"))
            .custom_headers(headers);
        let backend =
            ().serve(StreamableHttpClientTransport::from_config(config))
                .await
                .map_err(|e| unreachable(base, e))?;
        let backend = Arc::new(backend);
        backends.insert(node, backend.clone());
        Ok(backend)
    }

    async fn call(
        &self,
        node: usize,
        params: CallToolRequestParams,
        ctx: &RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let backend = self.backend(node, ctx).await?;
        match backend.call_tool_once(params).await {
            Ok(CallToolResponse::Complete(result)) => Ok(result),
            Ok(_) => Err(McpError::internal_error("unexpected tool response", None)),
            Err(error) => Err(unreachable(&self.cluster.nodes()[node], error)),
        }
    }

    /// Calls `list_designs` everywhere and merges the JSON arrays, newest first.
    async fn list_designs(
        &self,
        params: CallToolRequestParams,
        ctx: &RequestContext<RoleServer>,
    ) -> Result<CallToolResult, McpError> {
        let mut designs: Vec<Value> = Vec::new();
        for node in 0..self.cluster.len() {
            let result = self.call(node, params.clone(), ctx).await?;
            for block in &result.content {
                if let Some(text) = block.as_text()
                    && let Ok(Value::Array(list)) = serde_json::from_str(&text.text)
                {
                    designs.extend(list);
                }
            }
        }
        designs.sort_by_key(|d| std::cmp::Reverse(d["updatedAt"].as_u64().unwrap_or(0)));
        let text = serde_json::to_string_pretty(&designs).expect("json values serialize");
        Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
    }
}

impl ServerHandler for Relay {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new(
                "finite-router",
                env!("CARGO_PKG_VERSION"),
            ))
            .with_instructions(INSTRUCTIONS)
    }

    /// Every server has the same tools, so the first one lists them.
    async fn list_tools(
        &self,
        _request: Option<PaginatedRequestParams>,
        ctx: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, McpError> {
        let backend = self.backend(0, &ctx).await?;
        let tools = backend
            .list_all_tools()
            .await
            .map_err(|e| unreachable(&self.cluster.nodes()[0], e))?;
        Ok(ListToolsResult::with_all_items(tools))
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
        let result = match (request.name.as_ref(), design_id) {
            ("list_designs", _) => self.list_designs(request, &ctx).await?,
            ("create_design", _) => {
                let node = self.next.fetch_add(1, Ordering::Relaxed) % self.cluster.len();
                self.call(node, request, &ctx).await?
            }
            (_, Some(id)) => self.call(self.cluster.owner(&id), request, &ctx).await?,
            // No designId: let a server report the missing argument.
            (_, None) => self.call(0, request, &ctx).await?,
        };
        Ok(result.into())
    }
}
