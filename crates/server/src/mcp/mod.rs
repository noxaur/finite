//! The agent-facing MCP server, served over Streamable HTTP at `/mcp`.
//!
//! Six tools: `designs`, `read`, `edit`, `render`, `comments` and `undo`.
//! Elements are addressed with CSS selectors (`select.rs` in
//! `finite-design`), and every tool names its design with `designId`, so one
//! agent or many can work on several canvases at once. Each agent has its
//! own `undo`.
//!
//! `tools.rs` declares the tools; each has a module of the same name that
//! does the work. `selector`, `notes`, `format`, `layout`, `watch` and
//! `result` are what those modules share.

use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};

use finite_design::{actor, comment, label};
use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    handler::server::{router::tool::ToolRouter, tool::ToolCallContext},
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        MetaObject, ServerCapabilities, ServerConfig,
    },
    service::RequestContext,
    tool_handler,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};

use crate::hub::{Actor, DesignHandle, Hub, OpenError};

/// Resolves the design a tool names, or returns the error result.
macro_rules! design {
    ($self:ident, $id:expr) => {
        match $self.design($id).await {
            Ok(handle) => handle,
            Err(result) => return Ok(result),
        }
    };
}

mod comments;
mod designs;
mod edit;
mod format;
mod layout;
mod notes;
mod read;
mod render;
mod result;
mod selector;
mod tools;
mod transfer;
mod undo;
mod watch;

pub(crate) use designs::{
    ID_MATCH_NOTE, MAX_LIMIT, inexact_delete, list_limit, only_by_id, resolve_design,
};

/// The `_meta` key on a tool error that names the server owning the design,
/// so the router's relay can send the call there instead (see `relay.rs`).
/// The call didn't run, so sending it again is safe.
pub const OWNER_META: &str = "finite/owner";

/// What agents see when they connect: the workflow and the rules the tool
/// descriptions don't repeat.
pub(crate) const INSTRUCTIONS: &str = include_str!("instructions.md");

#[derive(Clone)]
pub struct FiniteMcp {
    hub: Arc<Hub>,
    session: Arc<SessionGuard>,
    /// Layout notes waiting for this session's next result.
    watch: Arc<watch::LayoutWatch>,
    tool_router: ToolRouter<Self>,
}

/// Forgets a session's actor (presence and undo history) when the MCP session ends.
struct SessionGuard {
    hub: Arc<Hub>,
    actor: OnceLock<String>,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        if let Some(actor) = self.actor.get() {
            self.hub.forget_actor(actor);
        }
    }
}

/// How long an MCP session can sit idle before it closes. An agent that
/// doesn't send `X-Finite-Agent` is known by its session, and its undo history
/// ends with it (see [`SessionGuard`]). rmcp's default of five minutes is a
/// short pause for an agent waiting on a person, so allow an hour.
pub const SESSION_IDLE: Duration = Duration::from_secs(60 * 60);

/// A session manager whose sessions close after [`SESSION_IDLE`].
pub(crate) fn sessions() -> LocalSessionManager {
    let mut sessions = LocalSessionManager::default();
    sessions.session_config.keep_alive = Some(SESSION_IDLE);
    sessions
}

/// The MCP endpoint, as a tower service.
pub fn service(hub: Arc<Hub>) -> StreamableHttpService<FiniteMcp, LocalSessionManager> {
    let config = StreamableHttpServerConfig::default().with_allowed_hosts(hub.allowed_hosts());
    StreamableHttpService::new(
        move || Ok(FiniteMcp::new(hub.clone())),
        Arc::new(sessions()),
        config,
    )
}

impl FiniteMcp {
    pub fn new(hub: Arc<Hub>) -> Self {
        Self {
            session: Arc::new(SessionGuard {
                hub: hub.clone(),
                actor: OnceLock::new(),
            }),
            hub,
            watch: Arc::new(watch::LayoutWatch::default()),
            tool_router: Self::tool_router(),
        }
    }

    /// Identifies the calling agent. An `X-Finite-Agent` header gives a stable
    /// id across sessions; otherwise the MCP session is the actor, so each
    /// connected agent has its own undo history.
    fn actor(&self, ctx: &RequestContext<RoleServer>) -> Actor {
        let parts = ctx.extensions.get::<http::request::Parts>();
        let header = |name: &str| {
            parts
                .and_then(|p| p.headers.get(name))
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned)
        };
        let client = ctx
            .peer
            .peer_info()
            .map(|info| info.client_info.name.clone())
            .unwrap_or_else(|| "Agent".into());
        // Every viewer shows it, so it's held to the same limit as people's names.
        let display = |name: &str| label::clip(name, comment::MAX_NAME);
        if let Some(agent) = header(crate::wire::AGENT) {
            // The id goes into every change it broadcasts and every saved
            // history, so it's held to the limit on people's ids.
            let agent = label::clip(&agent, comment::MAX_USER_ID);
            // The router names relayed agents separately from their identity.
            let name = header(crate::wire::AGENT_NAME).unwrap_or_else(|| agent.clone());
            return Actor {
                id: actor::agent(&agent),
                name: display(&name),
            };
        }
        if let Some(session) = header("mcp-session-id") {
            let id = actor::session(&session);
            let _ = self.session.actor.set(id.clone());
            let short: String = session.chars().take(4).collect();
            return Actor {
                id,
                name: display(&format!("{client} · {short}")),
            };
        }
        Actor {
            id: actor::session("anonymous"),
            name: display(&client),
        }
    }

    async fn design(&self, id: &str) -> Result<Arc<DesignHandle>, CallToolResult> {
        self.hub.open(id).await.map_err(|error| {
            if let OpenError::Elsewhere { owner, .. } = &error {
                let mut meta = MetaObject::new();
                meta.0.insert(OWNER_META.into(), owner.clone().into());
                return CallToolResult::error(vec![ContentBlock::text(format!(
                    "design {id:?} lives on another Finite server. Connect to {owner}/mcp to work on it."
                ))])
                .with_meta(Some(meta));
            }
            let text = match error {
                OpenError::Nowhere => crate::wire::NO_SERVER.to_string(),
                OpenError::Busy(_) => format!("design {id:?}: {error}."),
                _ => format!("design {id:?} not found. Call designs to see the available ids."),
            };
            CallToolResult::error(vec![ContentBlock::text(text)])
        })
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for FiniteMcp {
    /// Runs the tool, then adds any layout note waiting on the design it
    /// names. A design's name stands for its id in every tool.
    async fn call_tool(
        &self,
        mut request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        if let Some(args) = request.arguments.as_mut()
            && let Some(serde_json::Value::String(given)) = args.get("designId")
        {
            match self.design_named(given) {
                Ok(id) => {
                    args.insert("designId".into(), id.into());
                }
                Err(text) => {
                    return Ok(CallToolResponse::Complete(CallToolResult::error(vec![
                        ContentBlock::text(text),
                    ])));
                }
            }
        }
        let design = request
            .arguments
            .as_ref()
            .and_then(|args| args.get("designId")?.as_str())
            .map(str::to_owned);
        // Tools that report the layout, or change the design, make a waiting
        // note out of date. `edit` clears it itself.
        let drops_note = matches!(&*request.name, "undo" | "render");
        // Before the tool runs: an edit starts a new check, which replaces the note.
        let notes = design.as_deref().map(|d| {
            if drops_note {
                self.watch.invalidate(d);
                Vec::new()
            } else {
                self.watch.take(d)
            }
        });
        let name = request.name.clone();
        let tcc = ToolCallContext::new(self, request, context);
        let mut response = match self.tool_router.call(tcc).await {
            Ok(response) => response,
            Err(error) => {
                // The router refused the call, so nothing ran: the note still stands.
                if let (Some(design), Some(notes)) = (design.as_deref(), notes) {
                    self.watch.restore(design, notes);
                }
                return Err(error);
            }
        };
        if let (Some(design), Some(notes)) = (design.as_deref(), notes) {
            if &*name == "undo" {
                self.watch.invalidate(design);
            }
            match &mut response {
                CallToolResponse::Complete(result) if result.is_error != Some(true) => {
                    // An edit that changed an artboard has made its note out
                    // of date, and the edit reports its own check.
                    let notes = self.watch.deliver(design, notes);
                    if !notes.is_empty() {
                        result
                            .content
                            .push(ContentBlock::text(watch::Taken::text(&notes)));
                    }
                }
                // A failed call changed nothing, so the note still stands.
                _ => self.watch.restore(design, notes),
            }
        }
        Ok(response)
    }

    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("finite", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Claude Code keeps the first 4,096 characters of a server's
    /// instructions and drops the rest without telling the agent. AX runs
    /// found the end of these cut off, so they stay under this.
    const INSTRUCTIONS_LIMIT: usize = 4_000;

    #[test]
    fn instructions_fit_what_clients_keep() {
        assert!(
            INSTRUCTIONS.chars().count() <= INSTRUCTIONS_LIMIT,
            "{} characters: Claude Code would cut the end off",
            INSTRUCTIONS.chars().count()
        );
    }
}
