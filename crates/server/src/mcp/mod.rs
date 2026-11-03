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
    Change, Design, Document, Kept, KeptNode, NodeKind, Op, PropKey,
    comment::{self, Author, AuthorKind},
    components,
    edit::{self, EditError, NewArtboard, WriteMode},
    html, label,
};
use rmcp::{
    ErrorData as McpError, RoleServer, ServerHandler,
    handler::server::{router::tool::ToolRouter, tool::ToolCallContext, wrapper::Parameters},
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        MetaObject, ServerCapabilities, ServerConfig,
    },
    service::RequestContext,
    tool, tool_handler, tool_router,
    transport::streamable_http_server::{
        StreamableHttpServerConfig, StreamableHttpService, session::local::LocalSessionManager,
    },
};

use finite_transfer::{assets, jsx};

use crate::{
    hub::{Actor, DesignHandle, Hub, OpenError, SESSION_ACTOR, random_id},
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

/// The note after a `list_designs` result whose query matched ids, not names.
pub(crate) const ID_MATCH_NOTE: &str =
    "The query matched the designId, not the name. Pass this designId to the other tools.";

pub const OWNER_META: &str = "finite/owner";

const INSTRUCTIONS: &str = include_str!("instructions.md");

/// What the search tools add to the instructions.
const SEARCH_INSTRUCTIONS: &str = "Search: find_nodes finds elements by text, name, tag, CSS or attribute, across artboards and <style> blocks. replace_values finds and replaces text or a value in one call: a brand color in any notation everywhere, or part of a <style> or <script> with within (not set_text_content with the whole CSS). Use them instead of reading whole artboards.";

/// Whether `FINITE_MCP_EXTRA` (a comma-separated list) turns on a group of
/// experimental tools. AX experiments (`e2e/ax`) compare agents with and
/// without a group before it ships to everyone, as the search tools did. Right now `layout` adds a layout note to results
/// after `write_html` and `update_styles` (see `watch.rs`), and `components`
/// is experimental.
pub(crate) fn extra(group: &str) -> bool {
    static EXTRA: OnceLock<Vec<String>> = OnceLock::new();
    EXTRA
        .get_or_init(|| {
            std::env::var("FINITE_MCP_EXTRA")
                .unwrap_or_default()
                .split(',')
                .map(|s| s.trim().to_owned())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .iter()
        .any(|g| g == group)
}

/// Whether `FINITE_MCP_SURFACE=doc6` serves the six tools of `doc6`
/// instead of today's, so AX runs (`e2e/ax`) can compare both on one build.
/// Unset, or `classic`, serves today's tools.
pub(crate) fn doc6() -> bool {
    static DOC6: OnceLock<bool> = OnceLock::new();
    *DOC6.get_or_init(|| {
        std::env::var("FINITE_MCP_SURFACE").is_ok_and(|s| s.trim().eq_ignore_ascii_case("doc6"))
    })
}

/// What agents see when they connect, with a section for each extra tool group.
pub(crate) fn instructions() -> &'static str {
    if doc6() {
        return doc6::INSTRUCTIONS;
    }
    static TEXT: OnceLock<String> = OnceLock::new();
    TEXT.get_or_init(|| {
        let mut text = INSTRUCTIONS.trim_end().to_owned();
        text.push_str("\n\n");
        text.push_str(SEARCH_INSTRUCTIONS);
        if extra("components") {
            text.push_str("\n\n");
            text.push_str(component_tools::INSTRUCTIONS);
        }
        text.push_str("\n\n");
        text.push_str(tokens::INSTRUCTIONS);
        text.push_str("\n\n");
        text.push_str(pages::INSTRUCTIONS);
        text.push('\n');
        text
    })
}

#[derive(Clone)]
pub struct FiniteMcp {
    hub: Arc<Hub>,
    session: Arc<SessionGuard>,
    /// Layout notes waiting for this session's next result (`layout` group).
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

use crate::hub::PRESENCE_NODES;

/// A session manager whose sessions close after [`SESSION_IDLE`].
pub(crate) fn sessions() -> LocalSessionManager {
    let mut sessions = LocalSessionManager::default();
    sessions.session_config.keep_alive = Some(SESSION_IDLE);
    sessions
}

/// The MCP endpoint as a tower service, to mount at `/mcp`.
pub fn service(hub: Arc<Hub>) -> StreamableHttpService<FiniteMcp, LocalSessionManager> {
    let config = StreamableHttpServerConfig::default().with_allowed_hosts(hub.allowed_hosts());
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

/// A note that the design has tokens, which `what` (markup read from the
/// design) leaves out, so using it outside the design would lose them.
fn tokens_note(handle: &DesignHandle, what: &str) -> Option<String> {
    let count = handle.read(|d| d.doc().tokens().len());
    (count > 0).then(|| {
        format!(
            "This design also has {count} token{} (get_tokens) that its var(--…) values read. \
             {what} leaves them out, so copy them too if you use this markup outside this design.",
            if count == 1 { "" } else { "s" }
        )
    })
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

/// Says what HTML parsing left out, so the agent isn't surprised by a missing
/// handler or iframe. Empty when nothing was.
fn left_out(dropped: &[html::Dropped]) -> String {
    if dropped.is_empty() {
        return String::new();
    }
    let mut text = format!("\nLeft out {} thing(s) that can't run here:", dropped.len());
    for d in dropped {
        text.push_str(&format!("\n- {} at {}: {}", d.what, d.path, d.reason));
    }
    text
}

fn describe(change: Option<&Change>) -> &'static str {
    if change.is_some() {
        "Done."
    } else {
        "Nothing changed: the design already looked like that."
    }
}

/// How many changed nodes an edit's result names before it just counts them.
const CHANGED_NAMED: usize = 12;

/// What an edit changed: how many values on which nodes, with each node's
/// outline line, so an agent can check its ids hit what it meant without
/// reading the tree again. `requested` is how many nodes the call named.
/// Names the values a merged rewrite kept because another agent set them
/// after the HTML was read (see `Design::merge`).
fn kept_note(doc: &Document, kept: &[Kept]) -> String {
    let mut text = String::new();
    for k in kept.iter().take(CHANGED_NAMED) {
        let Some(node) = doc.get(&k.id) else { continue };
        let value = match node.get(&k.key) {
            Some(serde_json::Value::String(s)) => Some(s),
            Some(v) => Some(v.to_string()),
            None => None,
        };
        let what = match (&k.key, value) {
            (PropKey::Style(name), Some(v)) => format!("{name}: {v}"),
            (PropKey::Attr(name), Some(v)) => format!("{name}=\"{v}\""),
            (PropKey::Text, Some(v)) => format!("the text {v:?}"),
            (PropKey::Name, Some(v)) => format!("the layer name {v:?}"),
            (key, Some(v)) => format!("{key} {v:?}"),
            (PropKey::Style(name) | PropKey::Attr(name), None) => format!("{name} unset"),
            (key, None) => format!("{key} unset"),
        };
        let element = match node.kind {
            NodeKind::Text => node.parent.as_deref().unwrap_or(&node.id),
            _ => &node.id,
        };
        let on = outline(doc, element, 0);
        let _ = std::fmt::Write::write_fmt(
            &mut text,
            format_args!(
                "\nNote: kept {what} on {}, which another agent set after you read it{}",
                on.lines().next().unwrap_or("").trim(),
                if k.conflict {
                    ", instead of your change. Set it again if you meant to replace theirs."
                } else {
                    "."
                }
            ),
        );
    }
    if kept.len() > CHANGED_NAMED {
        let _ = std::fmt::Write::write_fmt(
            &mut text,
            format_args!(
                "\n…and {} more values kept the same way.",
                kept.len() - CHANGED_NAMED
            ),
        );
    }
    text
}

/// Names the elements a merged rewrite kept because another agent added
/// them, or moved them in, after the HTML was read (see `Design::merge`).
fn kept_nodes_note(doc: &Document, kept: &[KeptNode]) -> String {
    let mut text = String::new();
    for k in kept.iter().take(CHANGED_NAMED) {
        if doc.get(&k.id).is_none() {
            continue;
        }
        let on = outline(doc, &k.id, 0);
        let _ = std::fmt::Write::write_fmt(
            &mut text,
            format_args!(
                "\nNote: kept {}, which another agent {} after you read it. Delete it if you meant to remove it.",
                on.lines().next().unwrap_or("").trim(),
                if k.moved { "moved here" } else { "added" }
            ),
        );
    }
    if kept.len() > CHANGED_NAMED {
        let _ = std::fmt::Write::write_fmt(
            &mut text,
            format_args!(
                "\n…and {} more elements kept the same way.",
                kept.len() - CHANGED_NAMED
            ),
        );
    }
    text
}

fn changed(handle: &DesignHandle, change: Option<&Change>, requested: usize) -> String {
    let Some(change) = change else {
        return describe(None).into();
    };
    handle.read(|d| {
        let doc = d.view();
        let mut seen = std::collections::HashSet::new();
        let mut nodes = Vec::new();
        for op in &change.ops {
            // An override names the node inside the instance it changes.
            let shown = shown_id(op);
            // A text edit changes a text node; name the element it's in.
            let id = match doc.get(&shown) {
                Some(n) if n.kind == NodeKind::Text => n.parent.clone().unwrap_or(shown),
                _ => shown,
            };
            if doc.contains(&id) && seen.insert(id.clone()) {
                nodes.push(id);
            }
        }
        let values = change
            .ops
            .iter()
            .filter(|op| matches!(op, Op::Set { .. }))
            .count();
        let mut text = if values > 0 {
            format!(
                "Changed {values} value{} on {} node{}",
                if values == 1 { "" } else { "s" },
                nodes.len(),
                if nodes.len() == 1 { "" } else { "s" }
            )
        } else {
            format!(
                "Changed {} node{}",
                nodes.len(),
                if nodes.len() == 1 { "" } else { "s" }
            )
        };
        if requested > nodes.len() {
            let _ = std::fmt::Write::write_fmt(
                &mut text,
                format_args!(
                    " ({} of the {requested} you named already looked like that)",
                    requested - nodes.len()
                ),
            );
        }
        text.push(':');
        for id in nodes.iter().take(CHANGED_NAMED) {
            text.push_str("\n  ");
            text.push_str(outline(doc, id, 0).lines().next().unwrap_or("").trim());
        }
        if nodes.len() > CHANGED_NAMED {
            let _ = std::fmt::Write::write_fmt(
                &mut text,
                format_args!("\n  … and {} more", nodes.len() - CHANGED_NAMED),
            );
        }
        text
    })
}

/// The node an op changes as agents see it: for an override, the node
/// inside the instance (`I/x`), otherwise the op's own node.
fn shown_id(op: &Op) -> String {
    if let Op::Set {
        id,
        key: PropKey::Override(key),
        ..
    } = op
        && let Some((path, _)) = PropKey::split_override(key)
        && !path.is_empty()
    {
        return format!("{id}/{path}");
    }
    op.id().to_owned()
}

/// What a change did to components, for the end of an edit's result:
/// agents can't tell from the HTML whether an edit inside an instance
/// changed only that instance or the component every instance shows.
fn component_note(handle: &DesignHandle, change: &Change) -> Option<String> {
    use std::collections::BTreeMap;
    handle.read(|d| {
        let doc = d.doc();
        if !doc.has_instances() && !doc.nodes().any(|n| n.component) {
            return None;
        }
        let name = |id: &str| {
            doc.get(id)
                .map(|n| format!("{:?} #{id}", n.display_name()))
                .unwrap_or_else(|| format!("#{id}"))
        };
        let mut overridden: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
        let mut edited: BTreeMap<String, usize> = BTreeMap::new();
        let mut detached = Vec::new();
        // Components this change made: new ones, not edits to old ones.
        let defined: Vec<&str> = change
            .ops
            .iter()
            .filter_map(|op| match op {
                Op::Create { node } if node.component => Some(node.id.as_str()),
                _ => None,
            })
            .collect();
        for op in &change.ops {
            match op {
                Op::Set {
                    id,
                    key: PropKey::Override(_),
                    value,
                } => {
                    let entry = overridden.entry(id.as_str()).or_default();
                    if value.is_some() {
                        entry.0 += 1;
                    } else {
                        entry.1 += 1;
                    }
                }
                Op::Set {
                    id,
                    key: PropKey::InstanceOf,
                    value: None,
                } => detached.push(id.as_str()),
                Op::Set {
                    key: PropKey::Component | PropKey::Name,
                    ..
                } => {}
                _ => {
                    let id = match op {
                        Op::Create { node } => node.parent.as_deref().unwrap_or(&node.id),
                        _ => op.id(),
                    };
                    if let Some(component) = components::component_of(doc, id) {
                        *edited.entry(component.id.clone()).or_default() += 1;
                    }
                }
            }
        }
        let mut notes = Vec::new();
        // Detaching clears an instance's overrides; that's not news.
        overridden.retain(|id, _| !detached.contains(id));
        for (instance, (set, cleared)) in overridden {
            let component = doc
                .get(instance)
                .and_then(|n| n.instance_of.as_deref())
                .map(name)
                .unwrap_or_default();
            let mut text = format!("Only instance #{instance} of {component} changed");
            if set > 0 {
                text.push_str(&format!(
                    ": {set} value{} became its overrides",
                    if set == 1 { "" } else { "s" }
                ));
            }
            if cleared > 0 {
                text.push_str(&format!(
                    "{}{cleared} value{} follow{} the component again",
                    if set > 0 { ", and " } else { ": " },
                    if cleared == 1 { "" } else { "s" },
                    if cleared == 1 { "s" } else { "" },
                ));
            }
            text.push_str(". To change every instance, edit the component instead.");
            notes.push(text);
        }
        for id in &defined {
            let count = doc.instances_of(id).count();
            if count == 0 && doc.get(id).is_some() {
                notes.push(format!(
                    "Defined component {}. Write data-component={:?} again for an instance of it.",
                    name(id),
                    doc.get(id).map(|n| n.display_name()).unwrap_or_default()
                ));
                edited.remove(*id);
            }
        }
        for (component, _) in edited {
            let instances: Vec<String> = components::affected(doc, &component)
                .into_iter()
                .map(|i| format!("#{i}"))
                .collect();
            if instances.is_empty() {
                notes.push(format!(
                    "This edited component {}, which has no instances yet.",
                    name(&component)
                ));
                continue;
            }
            // New nodes have no overrides yet, so name their ids in each
            // instance: an agent giving each instance its own text needs them.
            let added: Vec<&finite_design::Node> = change
                .ops
                .iter()
                .filter_map(|op| match op {
                    Op::Create { node } => doc.get(&node.id),
                    _ => None,
                })
                .filter(|n| {
                    n.tag().is_some()
                        && components::component_of(doc, &n.id).is_some_and(|c| c.id == component)
                        && n.id != component
                })
                .take(4)
                .collect();
            let direct: Vec<&str> = doc.instances_of(&component).take(CHANGED_NAMED).collect();
            for node in &added {
                let ids: Vec<String> = direct.iter().map(|i| format!("#{i}/{}", node.id)).collect();
                let line = outline(doc, &node.id, 0);
                notes.push(format!(
                    "New in the component: {}. In its instances it's {}: set those to give each instance its own value.",
                    line.lines().next().unwrap_or("").trim(),
                    ids.join(", ")
                ));
            }
            let shown: Vec<&str> = instances.iter().take(CHANGED_NAMED).map(String::as_str).collect();
            notes.push(format!(
                "This edited component {}, so all {} instance{} show it too ({}{}), except where they override a value.",
                name(&component),
                instances.len(),
                if instances.len() == 1 { "" } else { "s" },
                shown.join(", "),
                if instances.len() > shown.len() { ", …" } else { "" }
            ));
        }
        if !detached.is_empty() {
            let ids: Vec<String> = detached.iter().map(|i| format!("#{i}")).collect();
            notes.push(format!(
                "Detached {}: {} plain cop{} now, no longer following a component.",
                ids.join(", "),
                if ids.len() == 1 { "it's a" } else { "they're" },
                if ids.len() == 1 { "y" } else { "ies" }
            ));
        }
        (!notes.is_empty()).then(|| notes.join("\n"))
    })
}

/// What get_html's HTML says about components, so an agent knows where an
/// edit would land: instances show their component's content, and ids
/// inside one edit only it.
fn html_component_note(design: &finite_design::Design, id: &str, html: &str) -> Option<String> {
    let doc = design.doc();
    let mut notes = Vec::new();
    if let Some((instance, component)) = components::instance_of(doc, id) {
        notes.push(format!(
            "This is inside instance #{} of component {}. Editing it changes only this instance (an override); edit the component to change them all.",
            instance.id,
            component.map_or_else(String::new, |c| format!("{:?} #{}", c.display_name(), c.id)),
        ));
    } else if let Some(component) = components::component_of(doc, id) {
        let count = doc.instances_of(&component.id).count();
        notes.push(format!(
            "This is {} component {:?} #{}, which {count} instance{} show{}: editing it changes all of them.",
            if component.id == id { "the root of" } else { "inside" },
            component.display_name(),
            component.id,
            if count == 1 { "" } else { "s" },
            if count == 1 { "s" } else { "" },
        ));
    }
    if html.contains(html::INSTANCE_ATTR) && !components::is_virtual(id) {
        notes.push(format!(
            "Elements with {} are instances: their content comes from that component, and is shown expanded here. Ids inside one look like instanceId/nodeId, and editing those changes only that instance. To copy this HTML into another design, remove the {} attributes: that design doesn't have the component.",
            html::INSTANCE_ATTR,
            html::INSTANCE_ATTR
        ));
    }
    (!notes.is_empty()).then(|| notes.join("\n"))
}

/// For a file or code made from node `id`: instances in it are written as the
/// elements they show, so the result doesn't follow their components.
fn instances_note(design: &finite_design::Design, id: &str) -> Option<String> {
    let doc = design.doc();
    let count = doc
        .subtree(components::real_id(id))
        .into_iter()
        .filter(|n| n.is_instance())
        .count();
    (count > 0).then(|| {
        "It includes component instances, written as the elements they show; they won't follow their components elsewhere.".to_owned()
    })
}

/// How many different nodes a batch of updates names.
fn distinct<'a>(ids: impl Iterator<Item = &'a String>) -> usize {
    ids.collect::<std::collections::HashSet<_>>().len()
}

impl FiniteMcp {
    /// Every tool, with the [`extra`] groups that are turned on.
    fn tools() -> ToolRouter<Self> {
        if doc6() {
            return Self::doc6_router();
        }
        let mut router = Self::tool_router();
        router.merge(Self::search_router());
        if extra("components") {
            router.merge(Self::component_router());
        }
        router.merge(Self::tokens_router());
        router.merge(Self::transfer_router());
        router.merge(Self::pages_router());
        router
    }

    pub fn new(hub: Arc<Hub>) -> Self {
        Self {
            session: Arc::new(SessionGuard {
                hub: hub.clone(),
                actor: OnceLock::new(),
            }),
            hub,
            watch: Arc::default(),
            tool_router: Self::tools(),
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
            // The id goes into every change it broadcasts and every saved
            // history, so it's held to the limit on people's ids.
            let agent = label::clip(&agent, comment::MAX_USER_ID);
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
            meta.0.insert(OWNER_META.into(), owner.clone().into());
            return Err(CallToolResult::error(vec![ContentBlock::text(format!(
                "design {id:?} lives on another Finite server. Connect to {owner}/mcp to work on it."
            ))])
            .with_meta(Some(meta)));
        }
        if self.hub.cluster().owner(id).is_none() {
            return Err(CallToolResult::error(vec![ContentBlock::text(
                "No Finite server is serving designs right now. Try again in a few seconds.",
            )]));
        }
        self.hub.open(id).await.map_err(|error| {
            let text = match error {
                OpenError::Busy(_) => format!("design {id:?}: {error}."),
                _ => {
                    let list = if doc6() { "designs" } else { "list_designs" };
                    format!("design {id:?} not found. Call {list} to see the available ids.")
                }
            };
            CallToolResult::error(vec![ContentBlock::text(text)])
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
        let build = |design: &Design| build(design.view());
        self.edit_checked(ctx, design_id, label, false, build, report)
            .await
    }

    /// [`Self::edit`], and with `check` and the `layout` group on, a layout
    /// check on the artboards it touched, for the next result (see `watch.rs`).
    async fn edit_checked<T>(
        &self,
        ctx: &RequestContext<RoleServer>,
        design_id: &str,
        label: &str,
        check: bool,
        build: impl FnOnce(&Design) -> Result<(Vec<Op>, T), EditError>,
        report: impl FnOnce(&DesignHandle, T, Option<&Change>) -> String,
    ) -> ToolResult {
        let handle = match self.design(design_id).await {
            Ok(handle) => handle,
            Err(result) => return Ok(result),
        };
        let actor = self.actor(ctx);
        match handle.edit_design(&actor, label, build) {
            Ok((output, change)) => {
                let mut text = report(&handle, output, change.as_ref());
                if let Some(change) = &change {
                    show_working(&handle, &actor, change);
                    if let Some(note) = component_note(&handle, change) {
                        text.push('\n');
                        text.push_str(&note);
                    }
                    if check && extra("layout") {
                        self.watch.after_edit(design_id, &handle, change).await;
                        let notes = self.watch.take(design_id);
                        if !notes.is_empty() {
                            text.push('\n');
                            text.push_str(&watch::Taken::text(&notes));
                        }
                    } else if !check {
                        // Any other edit can change what a waiting note says.
                        self.watch.invalidate(design_id);
                    }
                }
                ok(text)
            }
            Err(error) => fail(error.to_string()),
        }
    }
}

/// What a reply did: whether the comment is open, and the changes it links.
fn replied(comment: &comment::Comment) -> String {
    let labels: Vec<&str> = comment
        .messages
        .last()
        .map(|m| m.changes.iter().map(|c| c.label.as_str()).collect())
        .unwrap_or_default();
    let state = if comment.resolved { "resolved" } else { "open" };
    let linked = match labels.len() {
        0 => "links none of your changes".to_owned(),
        n => format!(
            "links your {n} change{} to this artboard since the thread's last message: {}",
            if n == 1 { "" } else { "s" },
            labels.join(", ")
        ),
    };
    format!("Replied. The comment is {state}, and your reply {linked}.")
}

/// Shows users which artboards an agent is editing, if it hasn't said with
/// start_working_on_nodes. Most agents skipped that call, so viewers saw
/// edits land with no one named. The indicator goes a minute after the
/// agent's last edit, or on finish_working_on_nodes.
fn show_working(handle: &DesignHandle, actor: &Actor, change: &Change) {
    let boards: Vec<String> = handle.read(|d| {
        let mut boards = Vec::new();
        for op in &change.ops {
            if let Some(board) = d.view().artboard_of(op.id())
                && !boards.contains(&board.id)
            {
                boards.push(board.id.clone());
            }
            if boards.len() >= PRESENCE_NODES {
                break;
            }
        }
        boards
    });
    if !boards.is_empty() {
        handle.show_editing(actor, boards);
    }
}

/// `error` with a hint when the agent passed the design's id where a node's
/// goes, which AX runs saw agents do on every read tool.
fn node_hint(error: String, design_id: &str) -> String {
    if error.contains(&format!("{design_id:?}")) {
        format!(
            "{error}: {design_id:?} is the designId. Pass an artboard's id (get_basic_info lists them) or a node's."
        )
    } else {
        error
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

mod component_tools;
mod doc6;
mod pages;
mod search;
mod tokens;

pub(crate) use self::{params::TokenValue, tokens::token_ops};
mod transfer;
mod watch;

#[tool_router]
impl FiniteMcp {
    #[tool(
        description = "List designs (canvases), most recently edited first, with each one's id, name, artboard count and last edit time. Returns 50 unless you pass a limit; pass a query to find one by name or id.",
        annotations(read_only_hint = true)
    )]
    async fn list_designs(&self, Parameters(p): Parameters<ListParams>) -> ToolResult {
        let matching: Vec<_> = self
            .hub
            .list()
            .into_iter()
            .filter(|d| p.matches(&d.meta.id, &d.meta.name))
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
        if p.only_by_id(
            matching
                .iter()
                .map(|d| (d.meta.id.as_str(), d.meta.name.as_str())),
        ) {
            content.push(ContentBlock::text(ID_MATCH_NOTE));
        }
        if matching.len() > limit {
            content.push(ContentBlock::text(more_designs(limit, matching.len())));
        }
        Ok(CallToolResult::success(content))
    }

    #[tool(description = "Create a new, empty design (canvas). Returns its designId.")]
    async fn create_design(&self, Parameters(p): Parameters<CreateDesignParams>) -> ToolResult {
        let hub = self.hub.clone();
        let created = tokio::task::spawn_blocking(move || hub.try_create(&p.name)).await;
        let design = match created.map_err(std::io::Error::other) {
            Ok(Ok(design)) => design,
            Ok(Err(error)) | Err(error) => {
                return fail(format!("Couldn't create the design: {error}"));
            }
        };
        ok(format!(
            "Created design {:?} with designId {:?}. Next: create_artboard.",
            design.meta.name, design.meta.id
        ))
    }

    #[tool(
        description = "Permanently delete a design (canvas), including all its pages, artboards, comments and undo history. This cannot be undone. To delete only an artboard, use delete_nodes instead.",
        annotations(destructive_hint = true)
    )]
    async fn delete_design(&self, Parameters(p): Parameters<DesignParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let hub = self.hub.clone();
        let deleted = tokio::task::spawn_blocking(move || hub.delete(&handle)).await;
        match deleted.map_err(std::io::Error::other) {
            Ok(Ok(())) => ok("Deleted the design permanently."),
            Ok(Err(error)) | Err(error) => fail(format!("Couldn't delete the design: {error}")),
        }
    }

    #[tool(description = "Rename a design.")]
    async fn rename_design(&self, Parameters(p): Parameters<RenameDesignParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        handle.rename(p.name);
        ok("Renamed.")
    }

    #[tool(
        description = "Overview of a design: its name, its pages, its artboards (id, name, position, size, page, mode), how many tokens it has and which agents are working on what.",
        annotations(read_only_hint = true)
    )]
    async fn get_basic_info(&self, Parameters(p): Parameters<DesignParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let presence = handle.presence();
        let info = handle.read(|design| {
            let doc = design.view();
            let all = doc.artboards();
            let pages = doc.pages();
            let artboards: Vec<_> = all
                .iter()
                .take(ChildrenParams::PAGE)
                .map(|a| {
                    let (w, h) = edit::pixel_size(a);
                    let mut board = serde_json::json!({
                        "id": a.id,
                        "name": a.display_name(),
                        "x": a.x,
                        "y": a.y,
                        "width": w,
                        "height": h,
                        "childCount": doc.children(Some(&a.id)).len(),
                    });
                    // With one page, every artboard is on it.
                    if pages.len() > 1 {
                        board["pageId"] = doc.page_of(a).into();
                    }
                    if let Some(mode) = a.mode.as_deref().and_then(|m| doc.mode_map().get(m)) {
                        board["mode"] = mode.name.clone().into();
                    }
                    board
                })
                .collect();
            let pages: Vec<_> = pages
                .iter()
                .map(|(id, page)| {
                    serde_json::json!({
                        "id": id,
                        "name": page.name,
                        "artboardCount": doc.artboards_on(id).len(),
                    })
                })
                .collect();
            serde_json::json!({
                "designId": design.meta.id,
                "name": design.meta.name,
                "nodeCount": doc.len(),
                "pages": pages,
                "artboardCount": all.len(),
                "artboards": artboards,
                "agentsWorking": presence,
                "openComments": design.comments().iter().filter(|c| !c.resolved).count(),
            })
        });
        let mut info = info;
        // So agents needn't call get_tokens to find out there are none.
        info["tokenCount"] = handle.read(|d| d.doc().tokens().len()).into();
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
            let doc = design.view();
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
                    let pages = doc.pages();
                    if pages.len() == 1 {
                        return Ok(boards.iter().map(|b| outline(doc, &b.id, depth)).collect());
                    }
                    let mut text = String::new();
                    for (id, page) in pages {
                        let boards = doc.artboards_on(id);
                        text.push_str(&format!("Page {:?} (pageId {id})", page.name));
                        if boards.is_empty() {
                            text.push_str(": no artboards\n");
                            continue;
                        }
                        text.push('\n');
                        for board in boards {
                            text.push_str(&outline(doc, &board.id, depth));
                        }
                    }
                    Ok(text)
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
        let nodes: Vec<_> = handle.read(|d| {
            p.node_ids
                .iter()
                .map(|id| node_json(d.view(), id))
                .collect()
        });
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
            let doc = design.view();
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
        description = "A node's subtree as HTML with inline styles. Every element carries data-id, so you can target it in later calls. The root carries data-read-at: to rewrite the node, edit this HTML and write it back with write_html, keeping both, so its elements keep their ids and comments, and changes others made since you read it stay.",
        annotations(read_only_hint = true)
    )]
    async fn get_html(&self, Parameters(p): Parameters<HtmlParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let shared = tokens_note(&handle, "The HTML above");
        let options = html::ExportOptions {
            ids: true,
            styles: p.include_styles.unwrap_or(true),
            depth: p.depth,
            max_value_len: p.max_value_length.map(|n| n.max(1)),
            stylesheets: p.include_stylesheets,
            ..Default::default()
        };
        let html = handle.read(|d| {
            let doc = d.view();
            let options = html::ExportOptions {
                read_at: Some(d.seq()),
                ..options
            };
            let (export, depth) = html::export_within(doc, &p.node_id, &options, OUTPUT_LIMIT)?;
            let has_children = !doc.children(Some(&p.node_id)).is_empty();
            if export.html.len() > OUTPUT_LIMIT && !has_children {
                // A leaf this long is long attribute values, like an image's
                // inline data. Shortening them here would lose them if the
                // HTML were written back, so point to get_node_info.
                return Some(format!(
                    "This node's HTML is {} characters, more than the {OUTPUT_LIMIT} a call returns, \
                     and it has no children: its attribute values are long. \
                     get_node_info shows them, with long values shortened, or pass maxValueLength.",
                    export.html.len()
                ));
            }
            // Whether the depth was lowered to fit, from all of it or from `p.depth`.
            let lowered = depth != p.depth;
            if export.html.len() > OUTPUT_LIMIT || (lowered && depth == Some(0)) {
                // Not even the children fit, so list them instead.
                let full = html::export_with(doc, &p.node_id, &options)?;
                return Some(cut(
                    format!(
                        "This node's HTML is {} characters, more than the {OUTPUT_LIMIT} a call returns. \
                         Call get_html on one of its children instead:\n{}",
                        full.html.len(),
                        outline(doc, &p.node_id, 1)
                    ),
                    "Use get_children to list them all.",
                ));
            }
            let mut out = export.html;
            if export.collapsed > 0 {
                let reason = if lowered {
                    format!("The HTML asked for is more than the {OUTPUT_LIMIT} characters a call returns, so this ")
                } else {
                    String::new()
                };
                let levels = depth.unwrap_or(0);
                out.push_str(&format!(
                        "\n{}{}shows {levels} level{} below the node. {} element{} marked \"not shown\" {}: call get_html on {} data-id.",
                        reason,
                        if reason.is_empty() { "This " } else { "" },
                        if levels == 1 { "" } else { "s" },
                        export.collapsed,
                        if export.collapsed == 1 { "" } else { "s" },
                        if export.collapsed == 1 { "holds more" } else { "hold more" },
                        if export.collapsed == 1 { "its" } else { "their" },
                ));
            }
            if export.shortened > 0 {
                out.push_str(&format!(
                        "\n{} value{} cut short, ending in …. Don't write this HTML back as it is.",
                        export.shortened,
                        if export.shortened == 1 { " was" } else { "s were" },
                ));
            }
            if let Some(note) = html_component_note(d, &p.node_id, &out) {
                out.push('\n');
                out.push_str(&note);
            }
            if export.stylesheets > 0 {
                out.push_str(&format!(
                        "\nThe first {} <style> element{} {} from elsewhere in the artboard, not inside this node.",
                        export.stylesheets,
                        if export.stylesheets == 1 { "" } else { "s" },
                        if export.stylesheets == 1 { "is" } else { "are" },
                ));
            }
            Some(out)
        });
        match html {
            Some(html) => Ok(CallToolResult::success(with_note(
                ContentBlock::text(html),
                shared,
            ))),
            None => fail(node_hint(
                format!("node {:?} not found", p.node_id),
                &p.design_id,
            )),
        }
    }

    #[tool(
        description = "A node's subtree as JSX to paste into a React codebase: elements with React's attribute names and each node's styles as an inline style object, or as Tailwind classes with tailwind true. Elements carry their layer name as data-name. <script> elements are left out, and the result says so, as is any !important. Like get_html, it keeps stored images as this server's URLs; export_design with format jsx inlines them. A node with a lot of content returns its outline instead; call get_jsx on a child.",
        annotations(read_only_hint = true)
    )]
    async fn get_jsx(&self, Parameters(p): Parameters<JsxParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let options = jsx::Options {
            tailwind: p.tailwind,
        };
        let converted = handle.read(|d| {
            // The expanded view: an instance has no children of its own.
            let doc = d.view();
            let converted = jsx::convert(doc, &p.node_id, &options, 0)?;
            if converted.jsx.len() > OUTPUT_LIMIT {
                return Some(Err(cut(
                    format!(
                        "This node's JSX is {} characters, more than the {OUTPUT_LIMIT} a call returns. \
                         Call get_jsx on one of its children instead:\n{}",
                        converted.jsx.len(),
                        outline(doc, &p.node_id, 1)
                    ),
                    "Use get_children to list them all.",
                )));
            }
            Some(Ok(converted))
        });
        let converted = match converted {
            Some(Ok(converted)) => converted,
            Some(Err(outline)) => return ok(outline),
            None => {
                return fail(node_hint(
                    format!("node {:?} not found", p.node_id),
                    &p.design_id,
                ));
            }
        };
        let mut notes: Vec<String> = converted
            .diagnostics
            .iter()
            .map(|d| {
                format!(
                    "Left out {} at #{}: {}.",
                    d.what,
                    d.node.as_deref().unwrap_or(""),
                    d.reason
                )
            })
            .collect();
        if let Some(note) = handle.read(|d| instances_note(d, &p.node_id)) {
            notes.push(note);
        }
        let mut stored = 0;
        assets::rewrite_urls(&converted.jsx, |_| {
            stored += 1;
            None
        });
        if stored > 0 {
            notes.push(format!(
                "{stored} image URL{} point{} at this server's stored files, so they only work here. \
                 export_design with format jsx and an artboardId writes them inline.",
                if stored == 1 { "" } else { "s" },
                if stored == 1 { "s" } else { "" },
            ));
        }
        notes.extend(tokens_note(&handle, "The JSX above"));
        let note = (!notes.is_empty()).then(|| notes.join("\n"));
        Ok(CallToolResult::success(with_note(
            ContentBlock::text(converted.jsx),
            note,
        )))
    }

    #[tool(
        description = "Render artboards, or nodes inside them, to images to check how they look. Each image is cropped to its node's box; with no node, it captures every artboard (up to 10). A whole artboard also gets a layout check that names anything cut off by its edge and text that overflows its box. Pages with scripts or animations are captured about 3 seconds after load; pass settleMs (at most 10000) to take the image later, such as after a transition has finished.",
        annotations(read_only_hint = true)
    )]
    async fn get_screenshot(&self, Parameters(p): Parameters<ScreenshotParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let mut nodes: Vec<String> = p.node_id.into_iter().chain(p.node_ids).collect();
        // Agents often ask with just a designId, meaning the design as a
        // whole, so capture its artboards.
        if nodes.is_empty() {
            nodes = handle.read(|d| {
                d.view()
                    .artboards()
                    .iter()
                    .take(screenshot::MAX_SHOTS)
                    .map(|a| a.id.clone())
                    .collect()
            });
            if nodes.is_empty() {
                return fail("This design has no artboards yet. Create one with create_artboard.");
            }
        }
        let shots = nodes
            .into_iter()
            .map(|node| screenshot::Shot {
                node,
                region: p
                    .region
                    .map(|r| screenshot::Rect::new(r.x, r.y, r.width, r.height)),
                padding: p.padding.unwrap_or(0.0),
            })
            .collect();
        let quality = p.quality.unwrap_or(80);
        let options = screenshot::Options {
            scale: p.scale.unwrap_or(1.0),
            format: match p.format {
                ImageFormat::Png => screenshot::Format::Png,
                ImageFormat::Jpeg => screenshot::Format::Jpeg { quality },
                ImageFormat::Webp => screenshot::Format::Webp { quality },
            },
            hide: p.hide_node_ids,
            highlight: p.highlight_node_ids,
            transparent: p.transparent,
            reveal_overflow: p.reveal_overflow,
            settle: p.settle_ms.map_or(screenshot::DEFAULT_SETTLE, |ms| {
                Duration::from_millis(ms).min(screenshot::MAX_SETTLE)
            }),
        };
        let plan = match handle.read(|d| screenshot::plan(d.view(), shots, options)) {
            Ok(plan) => plan,
            Err(error) => return fail(node_hint(error, &p.design_id)),
        };
        let images = match screenshot::capture(plan).await {
            Ok(images) => images,
            Err(error) => return fail(error),
        };
        let mut content = Vec::new();
        let mut failed = 0;
        for image in &images {
            match image {
                Ok(image) => {
                    content.push(ContentBlock::image(
                        base64::engine::general_purpose::STANDARD.encode(&image.data),
                        image.mime,
                    ));
                    content.push(ContentBlock::text(format::shot(image)));
                    if let Some(boxes) = &image.boxes {
                        let notes =
                            handle.read(|d| format::layout_notes(d.view(), &image.artboard, boxes));
                        if !notes.is_empty() {
                            content.push(ContentBlock::text(notes));
                        }
                    }
                }
                Err(error) => {
                    failed += 1;
                    content.push(ContentBlock::text(error.clone()));
                }
            }
        }
        if failed == images.len() {
            return Ok(CallToolResult::error(content));
        }
        Ok(CallToolResult::success(content))
    }

    #[tool(
        description = "Where everything rendered, without a screenshot: the node's subtree (or every artboard) as an outline with each element's position and size in px from its artboard's top-left corner (x,y width×height), and where its text sits when that's much smaller than its box. Then a layout check: content cut off by the artboard's edge, text overflowing its box, and text overlapping other text. Use it to place things over content, like pins or badges, and to check a layout cheaply after an edit.",
        annotations(read_only_hint = true)
    )]
    async fn get_layout(&self, Parameters(p): Parameters<LayoutParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let depth = p.depth.unwrap_or(4);
        // No node, or an empty one, means the design as a whole.
        let roots: Vec<String> = match p.node_id.filter(|id| !id.trim().is_empty()) {
            Some(id) => vec![id],
            None => handle.read(|d| {
                d.view()
                    .artboards()
                    .iter()
                    .take(screenshot::MAX_SHOTS)
                    .map(|a| a.id.clone())
                    .collect()
            }),
        };
        if roots.is_empty() {
            return fail("This design has no artboards yet. Create one with create_artboard.");
        }
        let mut parts = Vec::new();
        for node_id in roots {
            let options = screenshot::Options::default();
            let measurement =
                match handle.read(|d| screenshot::plan_measurement(d.view(), &node_id, options)) {
                    Ok(m) => m,
                    Err(error) => return fail(node_hint(error, &p.design_id)),
                };
            let boxes = match screenshot::layout(measurement).await {
                Ok(boxes) => boxes,
                Err(error) => return fail(error),
            };
            parts.push(handle.read(|d| {
                let doc = d.view();
                // A text node's layout is its element's.
                let root = match doc.get(&node_id) {
                    Some(n) if n.kind == NodeKind::Text => {
                        n.parent.clone().unwrap_or_else(|| node_id.clone())
                    }
                    _ => node_id.clone(),
                };
                format::rendered_outline(doc, &root, depth, &boxes)
            }));
        }
        ok(cut(
            parts.join("\n"),
            "Pass the nodeId of one part, or a smaller depth, to see the rest.",
        ))
    }

    #[tool(
        description = "Where create_artboard would put a new artboard: to the right of every existing one on its page, top-aligned with them. Returns x and y. create_artboard already does this when you omit x and y.",
        annotations(read_only_hint = true)
    )]
    async fn find_placement(&self, Parameters(p): Parameters<PlacementParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let placed = handle.read(|d| {
            let doc = d.view();
            let page = p.page_id.as_deref().unwrap_or_else(|| doc.first_page());
            doc.page(page)
                .map(|_| edit::find_placement(doc, page, p.width, p.height))
                .ok_or_else(|| format!("page {page:?} not found. get_basic_info lists the pages."))
        });
        match placed {
            Ok((x, y)) => json(serde_json::json!({ "x": x, "y": y })),
            Err(error) => fail(error),
        }
    }

    #[tool(
        description = "Create an artboard: a frame on the canvas that holds a screen or component. Give a height for a fixed size, or omit it to grow with the content. Pass html to fill it in the same call (same rules as write_html), and class to style the artboard itself from CSS. Omit x and y to place it beside the existing artboards. Pass pageId to put it on another page, and mode to render it in a token mode like \"Dark\". Returns its id, position and size, and the content's outline with ids."
    )]
    async fn create_artboard(
        &self,
        Parameters(p): Parameters<CreateArtboardParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let position = p.x.zip(p.y);
        let label = format!("Create artboard {:?}", p.name);
        let class = p.class.filter(|c| !c.trim().is_empty());
        let (fragments, dropped) = match p.html {
            Some(html) => {
                match tokio::task::spawn_blocking(move || edit::parse_html_reporting(&html)).await {
                    Ok(Ok(parsed)) => (parsed.fragments, parsed.dropped),
                    Ok(Err(error)) => return fail(error.to_string()),
                    Err(error) => return fail(error.to_string()),
                }
            }
            None => (Vec::new(), Vec::new()),
        };
        let spec = NewArtboard {
            name: p.name,
            width: p.width,
            height: p.height,
            position,
            page: p.page_id,
            styles: p.styles,
        };
        let mode = p.mode;
        self.edit(
            &ctx,
            &p.design_id,
            &label,
            |doc| {
                let mut new_id = id_in(doc);
                let id = new_id();
                let (mut ops, roots) =
                    edit::create_artboard_with(doc, id.clone(), spec, fragments, &mut new_id)?;
                if let Some(Op::Create { node }) = ops.first_mut() {
                    if let Some(class) = &class {
                        node.attrs.insert("class".into(), class.trim().to_owned());
                    }
                    if let Some(mode) = &mode {
                        node.mode = edit::artboard_mode(doc, mode)?;
                    }
                }
                Ok((ops, (id, roots)))
            },
            |handle, (id, roots), _| {
                handle.read(|d| {
                    let doc = d.view();
                    let Some(board) = doc.get(&id) else {
                        return format!("Created artboard #{id}.");
                    };
                    let (w, h) = edit::pixel_size(board);
                    let height = h.map_or_else(|| "auto height".to_owned(), |h| format!("{h}"));
                    let mut text = format!(
                        "Created artboard #{id} at x {}, y {}, {} × {}.",
                        board.x.unwrap_or(0.0),
                        board.y.unwrap_or(0.0),
                        w.unwrap_or(0.0),
                        height
                    );
                    if roots.is_empty() {
                        text.push_str(" Next: write_html into it.");
                        return text;
                    }
                    text.push_str(&format!(" Wrote {} root node(s):\n", roots.len()));
                    for root in &roots {
                        text.push_str(&outline(doc, root, 3));
                    }
                    text.push_str("Check it with get_screenshot.");
                    text.push_str(&left_out(&dropped));
                    cut(text, "Call get_tree_summary on a root to see it.")
                })
            },
        )
        .await
    }

    #[tool(
        description = "Write HTML into the design. mode \"append\" (default) inserts it as children of targetId, \"replace-children\" replaces the target's children, and \"replace\" replaces the target node. When replacing, an element written with the data-id get_html gave it keeps its node, id, comments and history; one without is new. With data-read-at from get_html, values others changed after that read keep theirs, elements they added since stay, and the result names them. Use inline styles or <style> blocks with classes; <script> is allowed for motion and interaction. Name layers with data-name. Returns the new nodes' outline with ids."
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
        let parsed = tokio::task::spawn_blocking(move || edit::parse_html_reporting(&html)).await;
        let (fragments, dropped, read_at) = match parsed {
            Ok(Ok(parsed)) => (parsed.fragments, parsed.dropped, parsed.read_at),
            Ok(Err(error)) => return fail(error.to_string()),
            Err(error) => return fail(error.to_string()),
        };
        let actor = self.actor(&ctx).id;
        self.edit_checked(
            &ctx,
            &p.design_id,
            "Write HTML",
            true,
            |design| {
                let doc = design.view();
                let mut new_id = id_in(doc);
                let (ops, roots) =
                    edit::write_fragments(doc, &p.target_id, fragments, mode, p.index, &mut new_id)?;
                // A rewrite of HTML from get_html keeps what others changed since.
                let merged = match read_at {
                    Some(seq) if mode != WriteMode::Append => design.merge(&actor, seq, ops),
                    _ => finite_design::Merged {
                        ops,
                        kept: Vec::new(),
                        kept_nodes: Vec::new(),
                        reached: true,
                    },
                };
                Ok((
                    merged.ops,
                    (roots, merged.kept, merged.kept_nodes, merged.reached),
                ))
            },
            |handle, (roots, kept, kept_nodes, reached), _| {
                handle.read(|d| {
                    let doc = d.view();
                    let mut text = if mode == WriteMode::Replace && roots == [p.target_id.as_str()] {
                        "Rewrote it in place: elements that kept their data-id kept their ids, comments and history.\n".to_owned()
                    } else {
                        format!("Wrote {} root node(s):\n", roots.len())
                    };
                    for root in &roots {
                        text.push_str(&outline(doc, root, 3));
                    }
                    text.push_str(&kept_note(doc, &kept));
                    text.push_str(&kept_nodes_note(doc, &kept_nodes));
                    if !reached {
                        text.push_str(
                            "\nNote: your data-read-at is older than the changes this server remembers, \
                             so values in your HTML replaced any that others changed since you read it, \
                             and elements others added since were removed.",
                        );
                    }
                    text.push_str(&left_out(&dropped));
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
        let design_id = p.design_id.clone();
        let updates = match p.all() {
            Ok(updates) => updates,
            Err(error) => return fail(error),
        };
        self.edit_checked(
            &ctx,
            &design_id,
            "Update styles",
            true,
            |design| {
                let doc = design.view();
                let mut ops = Vec::new();
                for update in &updates {
                    ops.extend(edit::update_styles(doc, &update.node_ids, &update.styles)?);
                }
                Ok((ops, ()))
            },
            |handle, (), change| {
                changed(
                    handle,
                    change,
                    distinct(updates.iter().flat_map(|u| &u.node_ids)),
                )
            },
        )
        .await
    }

    #[tool(
        description = "Set or remove HTML attributes on elements, such as an image's src and alt, an SVG path's d, or class and id. data-name sets the layer name (null clears it); data-id can't be changed. A null value removes the attribute."
    )]
    async fn set_attributes(
        &self,
        Parameters(p): Parameters<SetAttributesParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let design_id = p.design_id.clone();
        let updates = match p.all() {
            Ok(updates) => updates,
            Err(error) => return fail(error),
        };
        self.edit(
            &ctx,
            &design_id,
            "Set attributes",
            |doc| {
                let mut ops = Vec::new();
                for update in &updates {
                    ops.extend(edit::update_attributes(
                        doc,
                        &update.node_ids,
                        &update.attributes,
                    )?);
                }
                Ok((ops, ()))
            },
            |handle, (), change| {
                changed(
                    handle,
                    change,
                    distinct(updates.iter().flat_map(|u| &u.node_ids)),
                )
            },
        )
        .await
    }

    #[tool(
        description = "Replace the text of text nodes or elements. On an element, its content becomes this text. On a <style> or <script> element, it replaces the CSS or code."
    )]
    async fn set_text_content(
        &self,
        Parameters(p): Parameters<SetTextParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let design_id = p.design_id.clone();
        let updates = match p.all() {
            Ok(updates) => updates,
            Err(error) => return fail(error),
        };
        self.edit(
            &ctx,
            &design_id,
            "Set text",
            |doc| {
                let mut ops = Vec::new();
                let mut new_id = id_in(doc);
                for update in &updates {
                    ops.extend(edit::set_text(
                        doc,
                        &update.node_id,
                        &update.text,
                        &mut new_id,
                    )?);
                }
                Ok((ops, ()))
            },
            |handle, (), change| {
                changed(handle, change, distinct(updates.iter().map(|u| &u.node_id)))
            },
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
            |handle, (), change| {
                changed(
                    handle,
                    change,
                    distinct(p.updates.iter().map(|u| &u.node_id)),
                )
            },
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
            |handle, (), change| changed(handle, change, distinct(p.node_ids.iter())),
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
            |handle, (), change| {
                changed(
                    handle,
                    change,
                    distinct(p.updates.iter().map(|u| &u.node_id)),
                )
            },
        )
        .await
    }

    #[tool(
        description = "Duplicate nodes with their whole subtrees. Each copy is placed right after its original; copied artboards go into free canvas space. Returns each copy's outline with the new ids, so you can edit inside it, for example to make a mobile variant of a desktop artboard. To copy into another parent, duplicate, then move_nodes."
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
            |handle, roots, _| {
                // Each copy's outline, so the ids inside it can be edited
                // without reading the tree again.
                handle.read(|d| {
                    let mut text = format!("Created {} copies:\n", roots.len());
                    for root in &roots {
                        text.push_str(&outline(d.view(), root, 3));
                    }
                    cut(
                        text,
                        "Call get_children on their parent to list the rest, or get_tree_summary on a copy to see inside it.",
                    )
                })
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
            |doc| {
                let ops = edit::delete(doc, &p.node_ids)?;
                let inside: usize = ops.iter().map(|op| doc.subtree(op.id()).len()).sum();
                Ok((ops, inside))
            },
            |_, inside, change| match change {
                Some(change) => format!(
                    "Deleted {} node{}, {inside} in all with everything inside them.",
                    change.ops.len(),
                    if change.ops.len() == 1 { "" } else { "s" }
                ),
                None => describe(None).into(),
            },
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
            .map_while(|_| handle.undo(&actor, None).map(|c| c.label))
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
            .map_while(|_| handle.redo(&actor, None).map(|c| c.label))
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
        description = "Comments users pinned to a design, oldest first: what they asked for, which artboard and element it's about (alsoSelected lists more elements the user picked with it), and the thread so far. Open comments only, unless includeResolved is set. A long list comes in parts; the note at the end says which offset to pass next.",
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
        let timeout = Duration::from_secs(p.timeout_seconds.unwrap_or(60).clamp(1, 300));
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let handle = design!(self, &p.design_id);
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
            Ok(comment) => ok(replied(&comment)),
            Err(error) => fail(error.to_string()),
        }
    }

    #[tool(
        description = "Show users which nodes you're working on, with a status line like \"Building the pricing section\". Your edits already show the artboards they touch, so call this to say what you're doing; pair with finish_working_on_nodes."
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
            handle.read(|d| node_ids.iter().find(|id| !d.view().contains(id)).cloned())
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
    /// Runs the tool, then adds any layout note waiting on the design it
    /// names (the `layout` group). The layout tools drop it instead.
    async fn call_tool(
        &self,
        mut request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, McpError> {
        // doc6 takes a design's name for its id, in every tool.
        if doc6()
            && let Some(args) = request.arguments.as_mut()
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
        // doc6 checks the layout after every edit, so its notes are always on.
        let design = (extra("layout") || doc6())
            .then(|| {
                let id = request.arguments.as_ref()?.get("designId")?.as_str()?;
                Some(id.to_owned())
            })
            .flatten();
        // Tools that report the layout, or change the design, make a waiting
        // note out of date. Edits through `edit` clear it themselves.
        let drops_note = matches!(
            &*request.name,
            "get_layout" | "get_screenshot" | "undo" | "redo" | "import_design" | "render"
        );
        let name = request.name.clone();
        // Before the tool runs: an edit starts a new check, which replaces the note.
        let notes = design.as_deref().map(|d| {
            if drops_note {
                self.watch.invalidate(d);
                Vec::new()
            } else {
                self.watch.take(d)
            }
        });
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
            if matches!(&*name, "undo" | "redo" | "import_design") {
                self.watch.invalidate(design);
            }
            match &mut response {
                CallToolResponse::Complete(result) if result.is_error != Some(true) => {
                    // An edit that changed an artboard has made its note out
                    // of date, and the edit reports its own check.
                    let notes = self.watch.still_current(design, notes);
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
            .with_instructions(instructions())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Claude Code keeps the first 4,096 characters of a server's
    /// instructions and drops the rest without telling the agent. AX runs
    /// found the end of these cut off, so with every extra group on, they
    /// stay under this.
    const INSTRUCTIONS_LIMIT: usize = 4_000;

    #[test]
    fn instructions_fit_what_clients_keep() {
        let all = [
            INSTRUCTIONS.trim_end(),
            SEARCH_INSTRUCTIONS,
            component_tools::INSTRUCTIONS,
            tokens::INSTRUCTIONS,
        ]
        .join("\n\n");
        for (surface, text) in [("classic", all.as_str()), ("doc6", doc6::INSTRUCTIONS)] {
            assert!(
                text.chars().count() <= INSTRUCTIONS_LIMIT,
                "{surface}: {} characters: Claude Code would cut the end off",
                text.chars().count()
            );
        }
    }
}
