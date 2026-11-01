//! The agent-facing MCP server, served over Streamable HTTP at `/mcp`.
//!
//! The tool set follows Paper's MCP server (orient with `get_basic_info` and
//! `get_tree_summary`, build with `write_html`, refine with `update_styles`,
//! verify with `get_screenshot`), with two differences: every tool names its
//! design with `designId`, so one agent or many can work on several canvases
//! at once, and each agent has its own `undo`/`redo`.

use std::{
    sync::{Arc, OnceLock},
    time::Duration,
};

use base64::Engine;
use finite_design::{
    Change, Document, NodeKind, Op,
    comment::{self, Author, AuthorKind},
    edit::{self, EditError, NewArtboard, WriteMode},
    html, label,
};
use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::{
        CallToolResult, ContentBlock, Implementation, MetaObject, ServerCapabilities, ServerConfig,
    },
    service::RequestContext,
    tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};

use crate::{
    hub::{Actor, DesignHandle, Hub, SESSION_ACTOR, random_id},
    screenshot,
};

mod format;
pub(crate) mod params;

use format::{OUTPUT_LIMIT, comments_json, cut, node_json, outline};
use params::*;

/// What agents see when they connect: the workflow, the HTML rules, comments and undo.
/// The `_meta` key on a tool error that names the server owning the design,
/// so the router's relay can send the call there instead (see `relay.rs`).
/// The call didn't run, so sending it again is safe.
/// The note after a `list_designs` result that was cut short.
pub(crate) fn more_designs(shown: usize, total: usize) -> String {
    format!(
        "Showing the {shown} most recently edited of {total} designs. Pass a query to find one by name, or a larger limit."
    )
}

pub const OWNER_META: &str = "finite/owner";

pub(crate) const INSTRUCTIONS: &str = include_str!("instructions.md");

#[derive(Clone)]
pub struct FiniteMcp {
    hub: Arc<Hub>,
    session: Arc<SessionGuard>,
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

/// The most nodes one agent's presence can name.
const PRESENCE_NODES: usize = 100;

/// A session manager whose sessions close after [`SESSION_IDLE`].
pub(crate) fn sessions() -> LocalSessionManager {
    let mut sessions = LocalSessionManager::default();
    sessions.session_config.keep_alive = Some(SESSION_IDLE);
    sessions
}

/// The MCP endpoint as a tower service, to mount at `/mcp`.
pub fn service(hub: Arc<Hub>) -> StreamableHttpService<FiniteMcp, LocalSessionManager> {
    let config =
        StreamableHttpServerConfig::default().with_allowed_hosts(hub.cluster().allowed_hosts());
    StreamableHttpService::new(
        move || Ok(FiniteMcp::new(hub.clone())),
        Arc::new(sessions()),
        config,
    )
}

type ToolResult = Result<CallToolResult, McpError>;

fn ok(text: impl Into<String>) -> ToolResult {
    Ok(CallToolResult::success(vec![ContentBlock::text(text)]))
}

fn fail(text: impl Into<String>) -> ToolResult {
    Ok(CallToolResult::error(vec![ContentBlock::text(text)]))
}

/// As many of `items` as fit in [`OUTPUT_LIMIT`] as a JSON array, and how
/// many that is. Always at least one, so a long list still makes progress.
fn fit(items: impl Iterator<Item = serde_json::Value>) -> (ContentBlock, usize) {
    let mut kept = Vec::new();
    let mut size = 0;
    for item in items {
        let text = serde_json::to_string_pretty(&item).expect("json values serialize");
        // Inside the array, every line is indented two more spaces.
        let len = text.len() + 2 * text.lines().count() + 2;
        if !kept.is_empty() && size + len > OUTPUT_LIMIT {
            break;
        }
        size += len;
        kept.push(item);
    }
    let shown = kept.len();
    let text = serde_json::to_string_pretty(&kept).expect("json values serialize");
    (ContentBlock::text(text), shown)
}

/// `content`, followed by `note` if there is one.
fn with_note(content: ContentBlock, note: Option<String>) -> Vec<ContentBlock> {
    std::iter::once(content)
        .chain(note.map(ContentBlock::text))
        .collect()
}

fn json(value: serde_json::Value) -> ToolResult {
    ok(serde_json::to_string_pretty(&value).expect("json values serialize"))
}

/// A fresh node id that isn't in `doc`.
fn id_in(doc: &Document) -> impl FnMut() -> String + '_ {
    move || loop {
        let id = random_id(8);
        if !doc.contains(&id) {
            return id;
        }
    }
}

fn describe(change: Option<&Change>) -> &'static str {
    if change.is_some() {
        "Done."
    } else {
        "Nothing changed: the design already looked like that."
    }
}

impl FiniteMcp {
    pub fn new(hub: Arc<Hub>) -> Self {
        Self {
            session: Arc::new(SessionGuard {
                hub: hub.clone(),
                actor: OnceLock::new(),
            }),
            hub,
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
        if let Some(agent) = header("x-finite-agent") {
            // The router names relayed agents separately from their identity.
            let name = header("x-finite-agent-name").unwrap_or_else(|| agent.clone());
            return Actor {
                id: format!("agent:{agent}"),
                name: display(&name),
            };
        }
        if let Some(session) = header("mcp-session-id") {
            let id = format!("{SESSION_ACTOR}{session}");
            let _ = self.session.actor.set(id.clone());
            let short: String = session.chars().take(4).collect();
            return Actor {
                id,
                name: display(&format!("{client} · {short}")),
            };
        }
        Actor {
            id: format!("{SESSION_ACTOR}anonymous"),
            name: display(&client),
        }
    }

    async fn design(&self, id: &str) -> Result<Arc<DesignHandle>, CallToolResult> {
        if let Some(owner) = self.hub.elsewhere(id) {
            let mut meta = MetaObject::new();
            meta.0.insert(OWNER_META.into(), owner.into());
            return Err(CallToolResult::error(vec![ContentBlock::text(format!(
                "design {id:?} lives on another Finite server. Connect to {owner}/mcp to work on it."
            ))])
            .with_meta(Some(meta)));
        }
        self.hub.open(id).await.ok_or_else(|| {
            CallToolResult::error(vec![ContentBlock::text(format!(
                "design {id:?} not found. Call list_designs to see the available ids."
            ))])
        })
    }

    /// Runs an edit as one undo step and reports the outcome.
    async fn edit<T>(
        &self,
        ctx: &RequestContext<RoleServer>,
        design_id: &str,
        label: &str,
        build: impl FnOnce(&Document) -> Result<(Vec<Op>, T), EditError>,
        report: impl FnOnce(&DesignHandle, T, Option<&Change>) -> String,
    ) -> ToolResult {
        let handle = match self.design(design_id).await {
            Ok(handle) => handle,
            Err(result) => return Ok(result),
        };
        match handle.edit(&self.actor(ctx), label, build) {
            Ok((output, change)) => ok(report(&handle, output, change.as_ref())),
            Err(error) => fail(error.to_string()),
        }
    }
}

macro_rules! design {
    ($self:ident, $id:expr) => {
        match $self.design($id).await {
            Ok(handle) => handle,
            Err(result) => return Ok(result),
        }
    };
}

#[tool_router]
impl FiniteMcp {
    #[tool(
        description = "List designs (canvases), most recently edited first, with each one's id, name, artboard count and last edit time. Returns 50 unless you pass a limit; pass a query to find one by name.",
        annotations(read_only_hint = true)
    )]
    async fn list_designs(&self, Parameters(p): Parameters<ListParams>) -> ToolResult {
        let matching: Vec<_> = self
            .hub
            .list()
            .into_iter()
            .filter(|d| p.matches(&d.meta.name))
            .collect();
        let limit = p.limit();
        let designs: Vec<_> = matching
            .iter()
            .take(limit)
            .map(|d| {
                serde_json::json!({
                    "designId": d.meta.id,
                    "name": d.meta.name,
                    "artboards": d.artboard_count,
                    "nodes": d.node_count,
                    "updatedAt": d.meta.updated_at,
                })
            })
            .collect();
        let mut content = vec![ContentBlock::text(
            serde_json::to_string_pretty(&designs).expect("json values serialize"),
        )];
        if matching.len() > limit {
            content.push(ContentBlock::text(more_designs(limit, matching.len())));
        }
        Ok(CallToolResult::success(content))
    }

    #[tool(description = "Create a new, empty design (canvas). Returns its designId.")]
    async fn create_design(&self, Parameters(p): Parameters<CreateDesignParams>) -> ToolResult {
        let design = self.hub.create(&p.name);
        ok(format!(
            "Created design {:?} with designId {:?}. Next: find_placement and create_artboard.",
            design.meta.name, design.meta.id
        ))
    }

    #[tool(description = "Rename a design.")]
    async fn rename_design(&self, Parameters(p): Parameters<RenameDesignParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        handle.rename(p.name);
        ok("Renamed.")
    }

    #[tool(
        description = "Overview of a design: its name, its artboards (id, name, position, size) and which agents are working on what.",
        annotations(read_only_hint = true)
    )]
    async fn get_basic_info(&self, Parameters(p): Parameters<DesignParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let presence = handle.presence();
        let info = handle.read(|design| {
            let doc = design.doc();
            let all = doc.artboards();
            let artboards: Vec<_> = all
                .iter()
                .take(ChildrenParams::PAGE)
                .map(|a| {
                    let (w, h) = edit::pixel_size(a);
                    serde_json::json!({
                        "id": a.id,
                        "name": a.display_name(),
                        "x": a.x,
                        "y": a.y,
                        "width": w,
                        "height": h,
                        "childCount": doc.children(Some(&a.id)).len(),
                    })
                })
                .collect();
            serde_json::json!({
                "designId": design.meta.id,
                "name": design.meta.name,
                "nodeCount": doc.len(),
                "artboardCount": all.len(),
                "artboards": artboards,
                "agentsWorking": presence,
                "openComments": design.comments().iter().filter(|c| !c.resolved).count(),
            })
        });
        let count = info["artboardCount"].as_u64().unwrap_or(0) as usize;
        Ok(CallToolResult::success(with_note(
            ContentBlock::text(serde_json::to_string_pretty(&info).expect("json values serialize")),
            (count > ChildrenParams::PAGE).then(|| {
                format!(
                    "Showing {} of {count} artboards. get_children without a nodeId pages through them all.",
                    ChildrenParams::PAGE
                )
            }),
        )))
    }

    #[tool(
        description = "Indented outline of a subtree: tag, name, #id, size and text for each node. Cheap; use it to orient before editing.",
        annotations(read_only_hint = true)
    )]
    async fn get_tree_summary(&self, Parameters(p): Parameters<TreeParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let depth = p.depth.unwrap_or(4);
        let text = handle.read(|design| {
            let doc = design.doc();
            match &p.node_id {
                Some(id) if !doc.contains(id) => Err(format!("node {id:?} not found")),
                Some(id) => Ok(outline(doc, id, depth)),
                None => {
                    let boards = doc.artboards();
                    if boards.is_empty() {
                        return Ok(
                            "This design has no artboards yet. Create one with create_artboard."
                                .into(),
                        );
                    }
                    Ok(boards.iter().map(|b| outline(doc, &b.id, depth)).collect())
                }
            }
        });
        match text {
            Ok(text) => ok(cut(
                text,
                "Pass the nodeId of one part, or a smaller depth, to see the rest.",
            )),
            Err(error) => fail(error),
        }
    }

    #[tool(
        description = "Full details of nodes: type, tag, name, parent, artboard, styles, attributes, text and child ids.",
        annotations(read_only_hint = true)
    )]
    async fn get_node_info(&self, Parameters(p): Parameters<NodesParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let nodes: Vec<_> =
            handle.read(|d| p.node_ids.iter().map(|id| node_json(d.doc(), id)).collect());
        let total = nodes.len();
        let (content, shown) = fit(nodes.into_iter());
        Ok(CallToolResult::success(with_note(
            content,
            (shown < total).then(|| {
                format!(
                    "Showing the first {shown} of {total} nodes. Ask for the rest in another call."
                )
            }),
        )))
    }

    #[tool(
        description = "The direct children of a node, in order, or the artboards when nodeId is omitted. Returns 200 at a time; pass offset for the next ones.",
        annotations(read_only_hint = true)
    )]
    async fn get_children(&self, Parameters(p): Parameters<ChildrenParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let children = handle.read(|design| {
            let doc = design.doc();
            if let Some(id) = &p.node_id
                && !doc.contains(id)
            {
                return Err(format!("node {id:?} not found"));
            }
            let all = doc.children(p.node_id.as_deref());
            let total = all.len();
            let page = all
                .into_iter()
                .skip(p.offset)
                .take(ChildrenParams::PAGE)
                .map(|c| {
                    serde_json::json!({
                        "id": c.id,
                        "type": if c.kind == NodeKind::Text { "text" } else { "element" },
                        "tag": c.tag(),
                        "name": c.display_name(),
                        "childCount": doc.children(Some(&c.id)).len(),
                    })
                })
                .collect::<Vec<_>>();
            Ok((page, total))
        });
        let (page, total) = match children {
            Ok(children) => children,
            Err(error) => return fail(error),
        };
        let shown = page.len();
        let mut content = vec![ContentBlock::text(
            serde_json::to_string_pretty(&page).expect("json values serialize"),
        )];
        if p.offset + shown < total {
            let (from, to) = (p.offset + 1, p.offset + shown);
            content.push(ContentBlock::text(format!(
                "Showing children {from} to {to} of {total}. Pass offset {to} for the next ones."
            )));
        }
        Ok(CallToolResult::success(content))
    }

    #[tool(
        description = "A node's subtree as HTML with inline styles. Every element carries data-id, so you can target it in later calls.",
        annotations(read_only_hint = true)
    )]
    async fn get_html(&self, Parameters(p): Parameters<NodeParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let html = handle.read(|d| {
            let html = html::export(d.doc(), &p.node_id, true)?;
            if html.len() <= OUTPUT_LIMIT {
                return Some(html);
            }
            // Cut HTML would be broken HTML, so show the outline instead.
            if d.doc().children(Some(&p.node_id)).is_empty() {
                // A leaf this long is long attribute values, like an image's
                // inline data. Shortening them here would lose them if the
                // HTML were written back, so point to get_node_info.
                return Some(format!(
                    "This node's HTML is {} characters, more than the {OUTPUT_LIMIT} a call returns, \
                     and it has no children: its attribute values are long. \
                     get_node_info shows them, with long values shortened.",
                    html.len()
                ));
            }
            Some(cut(
                format!(
                    "This node's HTML is {} characters, more than the {OUTPUT_LIMIT} a call returns. \
                     Call get_html on one of its children instead:\n{}",
                    html.len(),
                    outline(d.doc(), &p.node_id, 1)
                ),
                "Use get_children to list them all.",
            ))
        });
        match html {
            Some(html) => ok(html),
            None => fail(format!("node {:?} not found", p.node_id)),
        }
    }

    #[tool(
        description = "Render an artboard to a PNG image to check how it looks. Pass the artboard id or any node inside it.",
        annotations(read_only_hint = true)
    )]
    async fn get_screenshot(&self, Parameters(p): Parameters<ScreenshotParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let page = handle.read(|d| {
            let board = d.doc().artboard_of(&p.node_id)?;
            screenshot::page(d.doc(), &board.id)
        });
        let Some((page, width, height)) = page else {
            return fail(format!("node {:?} not found", p.node_id));
        };
        let requested = p.scale.unwrap_or(1.0).clamp(0.25, 2.0);
        let scale = screenshot::output_scale(width, height, requested);
        match screenshot::capture(&page, width, height, scale).await {
            Ok(png) => {
                let mut content = vec![ContentBlock::image(
                    base64::engine::general_purpose::STANDARD.encode(png),
                    "image/png",
                )];
                if scale < requested {
                    content.push(ContentBlock::text(format!(
                        "Captured at {scale:.2}× instead of {requested}×, so the {width}×{height} artboard's longer side fits in {} pixels, the most a screenshot returns.",
                        screenshot::MAX_OUTPUT_SIDE
                    )));
                }
                Ok(CallToolResult::success(content))
            }
            Err(error) => fail(error),
        }
    }

    #[tool(
        description = "Find free canvas space for a new artboard of the given size. Returns x and y.",
        annotations(read_only_hint = true)
    )]
    async fn find_placement(&self, Parameters(p): Parameters<PlacementParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let (x, y) = handle.read(|d| edit::find_placement(d.doc(), p.width, p.height));
        json(serde_json::json!({ "x": x, "y": y }))
    }

    #[tool(
        description = "Create an artboard: a fixed-size frame on the canvas that holds a screen or component. Returns its id."
    )]
    async fn create_artboard(
        &self,
        Parameters(p): Parameters<CreateArtboardParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let position = p.x.zip(p.y);
        let label = format!("Create artboard {:?}", p.name);
        let spec = NewArtboard {
            name: p.name,
            width: p.width,
            height: p.height,
            position,
            styles: p.styles,
        };
        self.edit(
            &ctx,
            &p.design_id,
            &label,
            |doc| {
                let id = id_in(doc)();
                Ok((edit::create_artboard(doc, id.clone(), spec)?, id))
            },
            |_, id, _| {
                format!(
                    "Created artboard #{id}. Next: start_working_on_nodes, then write_html into it."
                )
            },
        )
        .await
    }

    #[tool(
        description = "Write HTML into the design. mode \"append\" (default) inserts it as children of targetId, \"replace-children\" replaces the target's children, and \"replace\" replaces the target node. Use inline styles or <style> blocks with classes; <script> is allowed for motion and interaction. Name layers with data-name. Returns the new nodes' outline with ids."
    )]
    async fn write_html(
        &self,
        Parameters(p): Parameters<WriteHtmlParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let mode = match p.mode {
            WriteHtmlMode::Append => WriteMode::Append,
            WriteHtmlMode::ReplaceChildren => WriteMode::ReplaceChildren,
            WriteHtmlMode::Replace => WriteMode::Replace,
        };
        // Parse on the blocking pool, before taking the design's lock: for a
        // few MB of HTML, parsing is most of the work.
        let html = p.html;
        let parsed = tokio::task::spawn_blocking(move || edit::parse_html(&html)).await;
        let fragments = match parsed {
            Ok(Ok(fragments)) => fragments,
            Ok(Err(error)) => return fail(error.to_string()),
            Err(error) => return fail(error.to_string()),
        };
        self.edit(
            &ctx,
            &p.design_id,
            "Write HTML",
            |doc| {
                let mut new_id = id_in(doc);
                edit::write_fragments(doc, &p.target_id, fragments, mode, p.index, &mut new_id)
            },
            |handle, roots, _| {
                handle.read(|d| {
                    let mut text = format!("Wrote {} root node(s):\n", roots.len());
                    for root in &roots {
                        text.push_str(&outline(d.doc(), root, 3));
                    }
                    cut(text, "Call get_tree_summary on a root to see it.")
                })
            },
        )
        .await
    }

    #[tool(
        description = "Set or remove CSS properties on nodes. Each update applies one style map to a list of nodes; a null value removes that property. All updates form one undo step."
    )]
    async fn update_styles(
        &self,
        Parameters(p): Parameters<UpdateStylesParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        self.edit(
            &ctx,
            &p.design_id,
            "Update styles",
            |doc| {
                let mut ops = Vec::new();
                for update in &p.updates {
                    ops.extend(edit::update_styles(doc, &update.node_ids, &update.styles)?);
                }
                Ok((ops, ()))
            },
            |_, (), change| describe(change).into(),
        )
        .await
    }

    #[tool(
        description = "Set or remove HTML attributes on elements, such as an image's src and alt, an SVG path's d, or class and id. A null value removes the attribute."
    )]
    async fn set_attributes(
        &self,
        Parameters(p): Parameters<SetAttributesParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        self.edit(
            &ctx,
            &p.design_id,
            "Set attributes",
            |doc| {
                let mut ops = Vec::new();
                for update in &p.updates {
                    ops.extend(edit::update_attributes(
                        doc,
                        &update.node_ids,
                        &update.attributes,
                    )?);
                }
                Ok((ops, ()))
            },
            |_, (), change| describe(change).into(),
        )
        .await
    }

    #[tool(
        description = "Replace the text of text nodes or elements. On an element, its content becomes this text."
    )]
    async fn set_text_content(
        &self,
        Parameters(p): Parameters<SetTextParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        self.edit(
            &ctx,
            &p.design_id,
            "Set text",
            |doc| {
                let mut ops = Vec::new();
                let mut new_id = id_in(doc);
                for update in &p.updates {
                    ops.extend(edit::set_text(
                        doc,
                        &update.node_id,
                        &update.text,
                        &mut new_id,
                    )?);
                }
                Ok((ops, ()))
            },
            |_, (), change| describe(change).into(),
        )
        .await
    }

    #[tool(description = "Rename layers (the names shown in the layer tree).")]
    async fn rename_nodes(
        &self,
        Parameters(p): Parameters<RenameNodesParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        self.edit(
            &ctx,
            &p.design_id,
            "Rename layers",
            |doc| {
                let mut ops = Vec::new();
                for update in &p.updates {
                    ops.extend(edit::rename(doc, &update.node_id, update.name.as_deref())?);
                }
                Ok((ops, ()))
            },
            |_, (), change| describe(change).into(),
        )
        .await
    }

    #[tool(
        description = "Move nodes under a new parent or reorder them among their siblings, keeping their relative order. parentId null turns them into artboards."
    )]
    async fn move_nodes(
        &self,
        Parameters(p): Parameters<MoveNodesParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        self.edit(
            &ctx,
            &p.design_id,
            "Move layers",
            |doc| {
                Ok((
                    edit::move_nodes(doc, &p.node_ids, p.parent_id.as_deref(), p.index)?,
                    (),
                ))
            },
            |_, (), change| describe(change).into(),
        )
        .await
    }

    #[tool(description = "Move artboards to new canvas positions.")]
    async fn set_artboard_position(
        &self,
        Parameters(p): Parameters<PositionParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        self.edit(
            &ctx,
            &p.design_id,
            "Move artboards",
            |doc| {
                let mut ops = Vec::new();
                for u in &p.updates {
                    ops.extend(edit::set_position(doc, &u.node_id, u.x, u.y)?);
                }
                Ok((ops, ()))
            },
            |_, (), change| describe(change).into(),
        )
        .await
    }

    #[tool(
        description = "Duplicate nodes with their whole subtrees. Each copy is placed right after its original; copied artboards go into free canvas space. Returns the new ids, for example to make a mobile variant of a desktop artboard."
    )]
    async fn duplicate_nodes(
        &self,
        Parameters(p): Parameters<NodesParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        self.edit(
            &ctx,
            &p.design_id,
            "Duplicate",
            |doc| edit::duplicate(doc, &p.node_ids, &mut id_in(doc)),
            |_, roots, _| {
                // One per line, so a long list is cut between ids.
                let ids: String = roots.iter().map(|r| format!("#{r}\n")).collect();
                cut(
                    format!("Created {} copies:\n{ids}", roots.len()),
                    "Call get_children on their parent to list the rest.",
                )
            },
        )
        .await
    }

    #[tool(
        description = "Delete nodes and everything inside them.",
        annotations(destructive_hint = true)
    )]
    async fn delete_nodes(
        &self,
        Parameters(p): Parameters<NodesParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        self.edit(
            &ctx,
            &p.design_id,
            "Delete",
            |doc| Ok((edit::delete(doc, &p.node_ids)?, ())),
            |_, (), change| describe(change).into(),
        )
        .await
    }

    #[tool(
        description = "Undo your own most recent changes to a design (one tool call per step). Other agents' changes are never undone."
    )]
    async fn undo(
        &self,
        Parameters(p): Parameters<StepParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let actor = self.actor(&ctx);
        let undone: Vec<String> = (0..p.steps.unwrap_or(1).max(1))
            .map_while(|_| handle.undo(&actor).map(|c| c.label))
            .collect();
        if undone.is_empty() {
            return ok("Nothing to undo.");
        }
        ok(format!("Undid: {}", undone.join(", ")))
    }

    #[tool(description = "Redo changes you undid on a design.")]
    async fn redo(
        &self,
        Parameters(p): Parameters<StepParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let actor = self.actor(&ctx);
        let redone: Vec<String> = (0..p.steps.unwrap_or(1).max(1))
            .map_while(|_| handle.redo(&actor).map(|c| c.label))
            .collect();
        if redone.is_empty() {
            return ok("Nothing to redo.");
        }
        ok(format!("Redid: {}", redone.join(", ")))
    }

    #[tool(
        description = "Your undo and redo stacks for a design, most recent first.",
        annotations(read_only_hint = true)
    )]
    async fn get_history(
        &self,
        Parameters(p): Parameters<DesignParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let (undo, redo) = handle.history(&self.actor(&ctx));
        json(serde_json::json!({ "undo": undo, "redo": redo }))
    }

    #[tool(
        description = "Comments users pinned to a design, oldest first: what they asked for, which artboard and element it's about, and the thread so far. Open comments only, unless includeResolved is set. A long list comes in parts; the note at the end says which offset to pass next.",
        annotations(read_only_hint = true)
    )]
    async fn get_comments(&self, Parameters(p): Parameters<CommentsParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let comments = handle.read(|design| {
            let shown = design
                .comments()
                .iter()
                .filter(|c| p.include_resolved || !c.resolved);
            comments_json(design, shown)
        });
        if comments.len() <= p.offset {
            return ok(match (comments.is_empty(), p.include_resolved) {
                (false, _) => "No more comments.",
                (true, true) => "This design has no comments.",
                (true, false) => "No open comments.",
            });
        }
        let total = comments.len();
        let (content, shown) = fit(comments.into_iter().skip(p.offset));
        let to = p.offset + shown;
        Ok(CallToolResult::success(with_note(
            content,
            (to < total).then(|| {
                format!(
                    "Showing comments {} to {to} of {total}, oldest first. Pass offset {to} for the rest.",
                    p.offset + 1
                )
            }),
        )))
    }

    #[tool(
        description = "Wait for users to ask for something. Returns as soon as a comment or reply is waiting for an agent (open, with a user's message last), with those comments in the same form as get_comments. Returns right away if some already are, or with a message saying none arrived when timeoutSeconds (default 60, at most 300) runs out. Call it in a loop to keep taking feedback.",
        annotations(read_only_hint = true)
    )]
    async fn wait_for_comments(&self, Parameters(p): Parameters<WaitParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let timeout = Duration::from_secs(p.timeout_seconds.unwrap_or(60).clamp(1, 300));
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            // Register before checking, so a comment that lands in between still wakes us.
            let changed = handle.comments_changed();
            tokio::pin!(changed);
            changed.as_mut().enable();
            let waiting = handle.read(|design| {
                comments_json(
                    design,
                    design.comments().iter().filter(|c| c.awaits_agent()),
                )
            });
            if !waiting.is_empty() {
                let total = waiting.len();
                let (content, shown) = fit(waiting.into_iter());
                return Ok(CallToolResult::success(with_note(
                    content,
                    (shown < total).then(|| {
                        format!(
                            "Showing the oldest {shown} of {total} waiting comments. Reply to these, then call again for the rest."
                        )
                    }),
                )));
            }
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return ok(format!(
                    "No comments arrived in {} seconds.",
                    timeout.as_secs()
                ));
            }
        }
    }

    #[tool(
        description = "Reply to a comment, usually to say what you changed (with resolve: true) or to ask a question. The reply links the edits you made to the comment's artboard since the thread's last message."
    )]
    async fn reply_to_comment(
        &self,
        Parameters(p): Parameters<ReplyParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let actor = self.actor(&ctx);
        let author = Author {
            id: actor.id,
            name: actor.name,
            kind: AuthorKind::Agent,
        };
        match handle.reply(&p.comment_id, author, &p.message, p.resolve) {
            Ok(comment) => {
                let linked = comment.messages.last().map_or(0, |m| m.changes.len());
                let state = if comment.resolved { "resolved" } else { "open" };
                ok(format!(
                    "Replied. The comment is {state}, and your reply links {linked} change{}.",
                    if linked == 1 { "" } else { "s" }
                ))
            }
            Err(error) => fail(error.to_string()),
        }
    }

    #[tool(
        description = "Show users which nodes you're working on, with an optional status line. Call before editing; pair with finish_working_on_nodes."
    )]
    async fn start_working_on_nodes(
        &self,
        Parameters(p): Parameters<WorkingParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let handle = design!(self, &p.design_id);
        // Every viewer gets the list on each update, and a parent covers its
        // children, so keep it short.
        let mut node_ids = p.node_ids;
        let mut seen = std::collections::HashSet::new();
        node_ids.retain(|id| seen.insert(id.clone()));
        if node_ids.len() > PRESENCE_NODES {
            return fail(format!(
                "pass at most {PRESENCE_NODES} node ids; to cover more, pass their artboard or a parent"
            ));
        }
        if let Some(missing) =
            handle.read(|d| node_ids.iter().find(|id| !d.doc().contains(id)).cloned())
        {
            return fail(format!("node {missing:?} not found"));
        }
        handle.set_presence(&self.actor(&ctx), node_ids, p.status);
        ok("Users can now see what you're working on.")
    }

    #[tool(
        description = "Clear your working indicator on a design. Call when you finish, even after an error."
    )]
    async fn finish_working_on_nodes(
        &self,
        Parameters(p): Parameters<DesignParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let handle = design!(self, &p.design_id);
        handle.clear_presence(&self.actor(&ctx).id);
        ok("Done.")
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for FiniteMcp {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("finite", env!("CARGO_PKG_VERSION")))
            .with_instructions(INSTRUCTIONS)
    }
}
