//! doc6, the six-tool surface: `designs`, `read`, `edit`, `render`,
//! `comments` and `undo`, behind `FINITE_MCP_SURFACE=doc6`. Elements are
//! addressed with CSS selectors (`select.rs` in `finite-design`), and one
//! `edit` call is one transaction ([`DesignHandle::transact`]): its ops
//! apply in order against the document as the ops before them left it, all
//! or nothing, as one change and one undo step.
//!
//! The behavioural spec is the mock that AX runs tried first,
//! `e2e/ax/surfaces/doc6.mjs` on the `ax-redesign-mocks` branch: each
//! tool's description, input schema, error wording and result shape.

use std::collections::HashMap;

use finite_design::{Document, NodeId, NodeKind, select};
use rmcp::{
    RoleServer,
    handler::server::wrapper::Parameters,
    model::CallToolResult,
    schemars::{self, JsonSchema},
    service::RequestContext,
    tool, tool_router,
};
use serde::Deserialize;
use serde_json::{Map, Value, json};

use super::{
    FiniteMcp, ToolResult, fail, fit, format::comments_json, ok, outline, params::*, replied,
    show_working, with_note,
};
use crate::{
    hub::{Actor, DesignHandle, PRESENCE_NODES},
    screenshot,
};

mod edit;
mod ops;
mod read;

pub(super) const INSTRUCTIONS: &str = include_str!("instructions.md");

/// A CSS selector, or a list of them.
#[derive(Deserialize, JsonSchema, Clone, Debug)]
#[serde(untagged)]
pub enum Select {
    One(String),
    Many(Vec<String>),
}

impl Select {
    fn value(&self) -> Value {
        match self {
            Self::One(s) => s.clone().into(),
            Self::Many(list) => list.clone().into(),
        }
    }
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct DesignsParams {
    /// Part of a design's name, or the start of its id.
    #[serde(default)]
    query: Option<String>,
    /// How many designs to list (default 50, at most 200).
    #[serde(default)]
    limit: Option<usize>,
    /// Create a design with this name.
    #[serde(default)]
    create: Option<String>,
    /// With rename: the design to rename.
    #[serde(default)]
    design_id: Option<String>,
    /// The new name for designId.
    #[serde(default)]
    rename: Option<String>,
    /// A design's id or exact name to delete permanently.
    #[serde(default)]
    delete: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct ReadParams {
    design_id: String,
    /// A CSS selector: #k3x9a2bq (a node id), .card, button, [data-name="Hero"] h1, :root (artboards), :contains("Sign in"). A list of selectors works too.
    #[serde(default)]
    select: Option<Select>,
    /// What to show for select: "outline" (default), "html", "css" or "jsx".
    #[serde(default, rename = "as", alias = "view")]
    view: Option<String>,
    /// With as: "jsx", Tailwind classes.
    #[serde(default)]
    tailwind: bool,
    /// Only this page's artboards: its name or id.
    #[serde(default)]
    page: Option<String>,
    /// Return the design, or select's artboard, as a file in this format: html, finite, repo, figma or jsx.
    #[serde(default)]
    export: Option<String>,
    /// Search for this text or value, like "#3b82f6" or "Sign in".
    #[serde(default)]
    contains: Option<String>,
    /// How many levels below each match (or each artboard) to show.
    #[serde(default)]
    depth: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct EditParams {
    design_id: String,
    /// The changes, in order: artboard, html, css, attrs, move, remove, replace, page, tokens, import. See the description for each op's fields. One op can go at the top level instead.
    #[serde(default)]
    #[schemars(with = "Option<Vec<Map<String, Value>>>")]
    ops: Option<Value>,
    /// A few words shown to people watching, like "Restyling pricing".
    #[serde(default)]
    status: Option<String>,
    /// A layout check of the artboards this edit touched follows the result. false skips it.
    #[serde(default)]
    check: Option<bool>,
    /// Report what the ops would change, then change nothing.
    #[serde(default)]
    dry_run: bool,
    /// One op passed flat: its "op" and its fields at the top level.
    #[serde(flatten)]
    #[schemars(skip)]
    flat: Map<String, Value>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct RenderParams {
    design_id: String,
    /// A CSS selector (#k3x9a2bq, [data-name=Hero], :root for every artboard), at most 10 matches.
    #[serde(default)]
    select: Option<Select>,
    /// "image" (default) or "layout": each element's box as text.
    #[serde(default)]
    output: Option<String>,
    /// CSS pixels of the surroundings to include around each image.
    #[serde(default)]
    padding: Option<f64>,
    /// Device pixel ratio, 0.25 to 3; 2 helps read small text.
    #[serde(default)]
    scale: Option<f64>,
    /// Show content past the artboard's edge instead of clipping it.
    #[serde(default)]
    reveal_overflow: bool,
    /// How long to wait after load before capturing, in ms (default 3000, at most 10000).
    #[serde(default)]
    settle_ms: Option<u64>,
    /// With output "layout": how many levels to list (default 4).
    #[serde(default)]
    depth: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    comment_id: String,
    message: String,
    #[serde(default)]
    resolve: Option<bool>,
}

/// Seconds to wait, or true for 60.
#[derive(Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum Wait {
    Seconds(u64),
    Flag(bool),
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct CommentsDoc6Params {
    design_id: String,
    /// Seconds to wait for a new comment (true is 60, at most 300).
    #[serde(default)]
    wait: Option<Wait>,
    /// Replies to send: [{"commentId": "…", "message": "…", "resolve": true}].
    #[serde(default)]
    reply: Option<Vec<Reply>>,
    /// Include resolved comments too.
    #[serde(default)]
    include_resolved: bool,
    /// Skip this many comments, to page through a long list.
    #[serde(default)]
    offset: usize,
}

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UndoParams {
    design_id: String,
    /// How many of your edit calls to undo or redo (default 1).
    #[serde(default)]
    steps: Option<usize>,
    /// Redo edits you undid instead.
    #[serde(default)]
    redo: bool,
}

/// An agent's `select` as one selector list: a list joins with commas,
/// `@name` refs become the `#id` an earlier op named, and a bare node id
/// like `k3x9a2bq` becomes `#k3x9a2bq`.
pub(super) fn selector_text(
    select: &Value,
    refs: &HashMap<String, NodeId>,
) -> Result<String, String> {
    let parts: Vec<String> = match select {
        Value::Array(items) => items.iter().map(plain).collect(),
        other => vec![plain(other)],
    };
    let joined = parts.join(", ");
    if joined.trim().is_empty() {
        return Err("select is empty".into());
    }
    let resolved = with_refs(&joined, refs, true)?;
    Ok(split_top(&resolved)
        .into_iter()
        .map(|part| {
            let part = part.trim();
            if looks_like_id(part) {
                format!("#{part}")
            } else {
                part.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(", "))
}

/// A JSON value as text: a string as it is, anything else as JSON.
pub(super) fn plain(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Whether `text` is a bare node id, like `k3x9a2bq`.
fn looks_like_id(text: &str) -> bool {
    text.len() == 8
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && text.bytes().any(|b| b.is_ascii_digit())
}

/// `text` with each `@name` outside quotes replaced by `#id`. With
/// `strict`, a name no earlier op gave is an error; otherwise it's left
/// alone, as in CSS, where `@media` is no ref.
pub(super) fn with_refs(
    text: &str,
    refs: &HashMap<String, NodeId>,
    strict: bool,
) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut quote = None;
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match quote {
            Some(q) => {
                if c == '\\' {
                    out.push(c);
                    if let Some((_, next)) = chars.next() {
                        out.push(next);
                    }
                    continue;
                }
                if c == q {
                    quote = None;
                }
                out.push(c);
            }
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                out.push(c);
            }
            None if c == '@' => {
                let rest = &text[i + 1..];
                let len = rest
                    .find(|ch: char| !(ch.is_alphanumeric() || ch == '_' || ch == '-'))
                    .unwrap_or(rest.len());
                let name = &rest[..len];
                match refs.get(name) {
                    Some(id) if !name.is_empty() => {
                        out.push('#');
                        out.push_str(id);
                        for _ in 0..name.chars().count() {
                            chars.next();
                        }
                    }
                    _ if strict => {
                        return Err(format!(
                            "\"@{name}\" isn't defined. Give an earlier op in the same edit \"as\": \"{name}\"."
                        ));
                    }
                    _ => out.push(c),
                }
            }
            None => out.push(c),
        }
    }
    Ok(out)
}

/// Splits a selector list at its top-level commas.
fn split_top(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let (mut depth, mut quote, mut start) = (0i32, None, 0);
    let mut escaped = false;
    for (i, c) in text.char_indices() {
        if escaped {
            escaped = false;
            continue;
        }
        match (quote, c) {
            (_, '\\') => escaped = true,
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '(' | '[') => depth += 1,
            (None, ')' | ']') => depth -= 1,
            (None, ',') if depth == 0 => {
                out.push(&text[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&text[start..]);
    out.into_iter().filter(|p| !p.trim().is_empty()).collect()
}

/// The elements `selector` matches in document order, on `page` when given,
/// or the text nodes a bare `#id` list names. Empty when nothing matches.
pub(super) fn matched(
    doc: &Document,
    selector: &str,
    page: Option<&str>,
) -> Result<Vec<NodeId>, String> {
    let list = select::parse(selector).map_err(|e| e.to_string())?;
    let scope = match page {
        Some(page) => select::Scope::Page(page),
        None => select::Scope::Design,
    };
    let matcher = select::Matcher::new(doc, scope);
    let found = matcher.select(&list);
    if found.is_empty() {
        return Ok(matcher.text_nodes(&list));
    }
    Ok(found)
}

/// A node's outline line, like `button "CTA" #ab12cd34 "Sign up"`.
pub(super) fn line(doc: &Document, id: &str) -> String {
    outline(doc, id, 0)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_owned()
}

/// A node as a short label, like `button "CTA" #ab12cd34`.
pub(super) fn label(doc: &Document, id: &str) -> String {
    match doc.get(id) {
        Some(node) => match (&node.kind, &node.name) {
            (NodeKind::Text, _) => format!("text #{id}"),
            (NodeKind::Element { tag }, Some(name)) => format!("{tag} {name:?} #{id}"),
            (NodeKind::Element { tag }, None) => format!("{tag} #{id}"),
        },
        None => format!("#{id}"),
    }
}

/// The first few of `ids` as labels, and how many more there are.
pub(super) fn describe(doc: &Document, ids: &[NodeId]) -> String {
    const SHOWN: usize = 6;
    let mut text: Vec<String> = ids.iter().take(SHOWN).map(|id| label(doc, id)).collect();
    if ids.len() > SHOWN {
        text.push(format!("and {} more", ids.len() - SHOWN));
    }
    text.join(", ")
}

/// The id of the page `given` names: its id, its name in any case, or an
/// `@name` an earlier op gave.
pub(super) fn page_id(
    doc: &Document,
    given: &str,
    refs: &HashMap<String, NodeId>,
) -> Result<String, String> {
    let given = given.trim();
    if let Some(name) = given.strip_prefix('@')
        && let Some(id) = refs.get(name)
    {
        return Ok(id.clone());
    }
    let pages = doc.pages();
    if let Some((id, _)) = pages.iter().find(|(id, _)| *id == given).or_else(|| {
        pages
            .iter()
            .find(|(_, p)| p.name.eq_ignore_ascii_case(given))
    }) {
        return Ok((*id).to_owned());
    }
    let names: Vec<String> = pages.iter().map(|(_, p)| format!("{:?}", p.name)).collect();
    Err(format!(
        "there's no page {given:?}. Pages: {}. Add one with {{\"op\": \"page\", \"create\": {given:?}}}.",
        names.join(", ")
    ))
}

impl FiniteMcp {
    /// The id of the design `given` names: its id, its exact name ignoring
    /// case when only one design has it, or the start of one design's id.
    /// An id this server doesn't list goes through, for another server to
    /// answer.
    pub(super) fn design_named(&self, given: &str) -> Result<String, String> {
        let want = given.trim();
        let all = self.hub.list();
        if all.iter().any(|d| d.meta.id == want) {
            return Ok(want.to_owned());
        }
        let named: Vec<_> = all
            .iter()
            .filter(|d| d.meta.name.trim().eq_ignore_ascii_case(want))
            .collect();
        if let [one] = named.as_slice() {
            return Ok(one.meta.id.clone());
        }
        let prefixed: Vec<_> = all
            .iter()
            .filter(|d| !want.is_empty() && d.meta.id.starts_with(want))
            .collect();
        if named.is_empty()
            && let [one] = prefixed.as_slice()
        {
            return Ok(one.meta.id.clone());
        }
        if named.is_empty() && self.hub.elsewhere(want).is_some() {
            return Ok(want.to_owned());
        }
        let lower = want.to_lowercase();
        let near: Vec<String> = if named.len() > 1 {
            named
                .iter()
                .map(|d| format!("{:?} ({})", d.meta.name, d.meta.id))
                .collect()
        } else {
            all.iter()
                .filter(|d| d.meta.name.to_lowercase().contains(&lower))
                .take(5)
                .map(|d| format!("{:?} ({})", d.meta.name, d.meta.id))
                .collect()
        };
        let hint = if near.is_empty() {
            " Call designs to list them.".to_owned()
        } else {
            format!(" Did you mean {}?", near.join(", "))
        };
        Err(format!(
            "there's no design {want:?}{}.{hint}",
            if named.len() > 1 {
                " with one name: several have it, so pass the id"
            } else {
                ""
            }
        ))
    }

    /// Shows people `status` on the artboards `boards`, or on every
    /// artboard when the edit touched none, as start_working_on_nodes did.
    /// An empty status clears it.
    fn show_status(&self, handle: &DesignHandle, actor: &Actor, status: &str, boards: Vec<NodeId>) {
        if status.trim().is_empty() {
            handle.clear_presence(&actor.id);
            return;
        }
        let mut boards = boards;
        if boards.is_empty() {
            boards = handle.read(|d| {
                d.view()
                    .artboards()
                    .iter()
                    .take(10)
                    .map(|b| b.id.clone())
                    .collect()
            });
        }
        boards.truncate(PRESENCE_NODES);
        handle.set_presence(actor, boards, Some(status.to_owned()));
    }
}

const EDIT_DESCRIPTION: &str = include_str!("edit.md");
const READ_DESCRIPTION: &str = include_str!("read.md");

#[tool_router(router = doc6_router, vis = "pub(super)")]
impl FiniteMcp {
    #[tool(
        name = "designs",
        description = "List, create, rename or delete designs (canvases).\n\n- {} or {\"query\": \"Acme\"}: designs whose name contains query (or whose id starts with it), most recently edited first, with id, name, artboard count and last edit. limit (default 50, at most 200).\n- {\"create\": \"Checkout flow\"}: a new, empty design. Returns its designId.\n- {\"designId\": \"…\", \"rename\": \"New name\"}: renames it.\n- {\"delete\": \"…\"}: deletes that design (its id or exact name) for good, with its pages, artboards, comments and history. It can't be undone. To delete only an artboard, use edit's remove op.",
        annotations(read_only_hint = false)
    )]
    async fn designs(&self, Parameters(p): Parameters<DesignsParams>) -> ToolResult {
        if let Some(name) = p.create {
            let hub = self.hub.clone();
            let created = tokio::task::spawn_blocking(move || hub.try_create(&name)).await;
            return match created.map_err(std::io::Error::other) {
                Ok(Ok(design)) => ok(format!(
                    "Created design {:?} with designId {:?}. Next: edit with an \"artboard\" op.",
                    design.meta.name, design.meta.id
                )),
                Ok(Err(error)) | Err(error) => fail(format!("Couldn't create the design: {error}")),
            };
        }
        if let Some(given) = p.delete {
            let id = match self.design_named(&given) {
                Ok(id) => id,
                Err(error) => return fail(error),
            };
            let handle = design!(self, &id);
            let name = handle.summary().meta.name;
            // Deleting can't be undone, so only an exact id or name will do:
            // an id prefix or a mistyped name could pick another design.
            if id != given.trim() && !name.trim().eq_ignore_ascii_case(given.trim()) {
                return fail(format!(
                    "\"{}\" isn't a design's exact id or name, so nothing was deleted. Did you mean {name:?} ({id})? Pass its id to delete it.",
                    given.trim()
                ));
            }
            let hub = self.hub.clone();
            let deleted = tokio::task::spawn_blocking(move || hub.delete(&handle)).await;
            return match deleted.map_err(std::io::Error::other) {
                Ok(Ok(())) => ok(format!("Deleted design {name:?} ({id}) permanently.")),
                Ok(Err(error)) | Err(error) => fail(format!("Couldn't delete the design: {error}")),
            };
        }
        if let Some(name) = p.rename {
            let Some(id) = p.design_id else {
                return fail(
                    "rename needs designId, like {\"designId\": \"…\", \"rename\": \"New name\"}.",
                );
            };
            let handle = design!(self, &id);
            handle.rename(name.clone());
            return ok(format!("Renamed the design to {:?}.", name.trim()));
        }
        self.list_designs(Parameters(ListParams {
            query: p.query,
            limit: p.limit,
        }))
        .await
    }

    #[tool(
        name = "read",
        description = READ_DESCRIPTION,
        annotations(read_only_hint = true)
    )]
    async fn doc6_read(
        &self,
        Parameters(p): Parameters<ReadParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let handle = design!(self, &p.design_id);
        read::read(self, &handle, &self.actor(&ctx), p).await
    }

    #[tool(
        name = "edit",
        description = EDIT_DESCRIPTION,
        annotations(read_only_hint = false, destructive_hint = true)
    )]
    async fn doc6_edit(
        &self,
        Parameters(p): Parameters<EditParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let actor = self.actor(&ctx);
        let steps = match ops::prepare(&self.hub, &p).await {
            Ok(steps) => steps,
            Err(error) => return fail(error),
        };
        let count = steps.len();
        let label = match p.status.as_deref().map(str::trim) {
            Some(status) if !status.is_empty() => {
                finite_design::label::clip(status, finite_design::label::STATUS)
            }
            _ => ops::summary(&steps),
        };
        let plural = |n: usize| if n == 1 { "" } else { "s" };
        if p.dry_run {
            return match handle.dry_run(&actor, |tx| edit::run(tx, steps)) {
                Ok((applied, sections)) => {
                    let head = if applied.is_empty() {
                        "Dry run: nothing was changed, and these ops would change nothing:"
                            .to_owned()
                    } else {
                        format!(
                            "Dry run: nothing was changed. Without dryRun, this edit would make {count} op{} as one step:",
                            plural(count)
                        )
                    };
                    ok(edit::result(head, sections))
                }
                Err(error) => fail(error),
            };
        }
        let (sections, change) = match handle.transact(&actor, &label, |tx| edit::run(tx, steps)) {
            Ok(done) => done,
            Err(error) => return fail(error),
        };
        let boards: Vec<NodeId> = change
            .as_ref()
            .map(|change| {
                handle.read(|d| {
                    let mut boards: Vec<NodeId> = Vec::new();
                    for op in &change.ops {
                        if let Some(board) = d.view().artboard_of(op.id())
                            && !boards.contains(&board.id)
                        {
                            boards.push(board.id.clone());
                        }
                    }
                    boards
                })
            })
            .unwrap_or_default();
        match (&p.status, &change) {
            (Some(status), _) => self.show_status(&handle, &actor, status, boards),
            (None, Some(change)) => show_working(&handle, &actor, change),
            (None, None) => {}
        }
        let head = match (&change, count) {
            (_, 0) => match p.status.as_deref().map(str::trim) {
                Some(status) if !status.is_empty() => format!("People now see {status:?}."),
                Some(_) => "Cleared your status.".to_owned(),
                None => "No ops, so nothing changed.".to_owned(),
            },
            (Some(_), n) => format!(
                "Changed the design in one step ({n} op{}); undo reverses all of it.",
                plural(n)
            ),
            (None, _) => "Nothing changed: the design already looked like that.".to_owned(),
        };
        let mut text = edit::result(head, sections);
        if let Some(change) = &change {
            if p.check != Some(false) {
                let clean = self.watch.after_edit(&p.design_id, &handle, change).await;
                let notes = self.watch.take(&p.design_id);
                if !notes.is_empty() {
                    text.push('\n');
                    text.push_str(&super::watch::Taken::text(&notes));
                } else if clean {
                    text.push_str(
                        "\nLayout: nothing is cut off, overflowing or overlapping on the artboards this edit touched.",
                    );
                }
            } else {
                self.watch.invalidate(&p.design_id);
            }
        }
        ok(text)
    }

    #[tool(
        name = "render",
        description = "Render what select matches to check how it looks. Each image is cropped to its element's box; with no select, every artboard (up to 10). A whole artboard's image comes with a layout check naming anything cut off by its edge and text that overflows its box, with the edit that fixes the artboard's height.\n\noutput: \"layout\" returns text instead of an image: each element's box in px from its artboard's top-left corner (x,y width×height), where its text sits when that's much smaller than its box, then the layout check (cut-off, overflowing and overlapping text). Use it to place things over content, like pins or badges, and to check a layout cheaply.\n\nselect: a CSS selector (#k3x9a2bq, [data-name=Hero], :root for every artboard), at most 10 matches. padding adds CSS pixels around each image; scale (0.25 to 3) helps read small text; revealOverflow shows content past the artboard's edge; settleMs (default 3000, at most 10000) waits longer for animations. depth (layout only, default 4).\n\nExamples: {\"designId\": \"…\", \"select\": \"#m0b1l3aa\"} · {\"designId\": \"…\", \"select\": \".card\", \"padding\": 16} · {\"designId\": \"…\", \"output\": \"layout\"}",
        annotations(read_only_hint = true)
    )]
    async fn render(&self, Parameters(p): Parameters<RenderParams>) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let ids: Vec<NodeId> = match &p.select {
            Some(select) => {
                let found = handle.read(|d| {
                    let doc = d.view();
                    let selector = selector_text(&select.value(), &HashMap::new())?;
                    let ids = matched(doc, &selector, None)?;
                    if ids.is_empty() {
                        return Err(format!(
                            "{selector:?} matches no element. read shows the outline with every id."
                        ));
                    }
                    if ids.len() > screenshot::MAX_SHOTS {
                        return Err(format!(
                            "{selector:?} matches {} elements; one render takes at most {}. Narrow select: {}.",
                            ids.len(),
                            screenshot::MAX_SHOTS,
                            describe(doc, &ids)
                        ));
                    }
                    Ok(ids)
                });
                match found {
                    Ok(ids) => ids,
                    Err(error) => return fail(error),
                }
            }
            None => {
                if handle.read(|d| d.view().artboards().is_empty()) {
                    return fail(
                        "This design has no artboards yet. Add one with an edit's \"artboard\" op.",
                    );
                }
                Vec::new()
            }
        };
        if p.output
            .as_deref()
            .is_some_and(|o| o.eq_ignore_ascii_case("layout"))
        {
            let roots: Vec<Option<NodeId>> = if ids.is_empty() {
                vec![None]
            } else {
                ids.into_iter().map(Some).collect()
            };
            let mut parts = Vec::new();
            for node_id in roots {
                let result = self
                    .get_layout(Parameters(LayoutParams {
                        design_id: p.design_id.clone(),
                        node_id,
                        depth: p.depth,
                    }))
                    .await?;
                let text = text_of(&result);
                if result.is_error == Some(true) {
                    return fail(text);
                }
                parts.push(text.trim_end().to_owned());
            }
            return ok(parts.join("\n\n"));
        }
        let params = json!({
            "designId": p.design_id,
            "nodeIds": ids,
            "padding": p.padding,
            "scale": p.scale,
            "revealOverflow": p.reveal_overflow,
            "settleMs": p.settle_ms,
        });
        let params: ScreenshotParams = serde_json::from_value(strip_nulls(params))
            .map_err(|e| rmcp::ErrorData::invalid_params(e.to_string(), None))?;
        self.get_screenshot(Parameters(params)).await
    }

    #[tool(
        name = "comments",
        description = "The comments people pinned to a design, and your replies to them.\n\n- {\"designId\": \"…\"}: open comments, oldest first: what was asked, the artboard, the element (its select and HTML), and the thread so far. includeResolved: true adds resolved ones; offset pages through a long list.\n- {\"designId\": \"…\", \"wait\": 60}: blocks until a comment or reply is waiting for an agent (open, with a person's message last), then returns those. Returns at once if some already are, or says none arrived after wait seconds (at most 300). Loop on it to keep taking feedback.\n- {\"designId\": \"…\", \"reply\": [{\"commentId\": \"…\", \"message\": \"Made it an underlined link.\", \"resolve\": true}]}: replies, one or several at once. Say what you changed, with resolve: true, or ask a question and leave it open. A reply links your edits to the comment's artboard since the thread's last message.",
        annotations(read_only_hint = false)
    )]
    async fn doc6_comments(
        &self,
        Parameters(p): Parameters<CommentsDoc6Params>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let handle = design!(self, &p.design_id);
        if let Some(replies) = p.reply {
            let actor = self.actor(&ctx);
            let many = replies.len() > 1;
            let mut out = Vec::new();
            for reply in replies {
                let author = finite_design::comment::Author {
                    id: actor.id.clone(),
                    name: actor.name.clone(),
                    kind: finite_design::comment::AuthorKind::Agent,
                };
                match handle.reply(&reply.comment_id, author, &reply.message, reply.resolve) {
                    Ok(comment) if many => {
                        out.push(format!("{}: {}", reply.comment_id, replied(&comment)))
                    }
                    Ok(comment) => out.push(replied(&comment)),
                    Err(error) => {
                        let sent = if out.is_empty() {
                            String::new()
                        } else {
                            format!(" Replies before it were sent:\n{}", out.join("\n"))
                        };
                        return fail(format!("{}: {error}.{sent}", reply.comment_id));
                    }
                }
            }
            return ok(out.join("\n"));
        }
        let wait = match p.wait {
            Some(Wait::Seconds(s)) => Some(s),
            Some(Wait::Flag(true)) => Some(60),
            Some(Wait::Flag(false)) | None => None,
        };
        if let Some(seconds) = wait {
            let deadline =
                tokio::time::Instant::now() + std::time::Duration::from_secs(seconds.clamp(1, 300));
            loop {
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
                    let (content, shown) = fit(waiting.into_iter().map(selects));
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
                        seconds.clamp(1, 300)
                    ));
                }
            }
        }
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
        let (content, shown) = fit(comments.into_iter().skip(p.offset).map(selects));
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
        name = "undo",
        description = "Undo your own most recent edit calls on a design: each edit call is one step, whatever it contained. Other agents' changes are never undone, and steps whose nodes someone else deleted are skipped. redo: true redoes edits you undid instead. steps: how many (default 1).\n\nExamples: {\"designId\": \"…\"} · {\"designId\": \"…\", \"steps\": 2} · {\"designId\": \"…\", \"redo\": true}",
        annotations(read_only_hint = false)
    )]
    async fn doc6_undo(
        &self,
        Parameters(p): Parameters<UndoParams>,
        ctx: RequestContext<RoleServer>,
    ) -> ToolResult {
        let handle = design!(self, &p.design_id);
        let actor = self.actor(&ctx);
        let labels: Vec<String> = (0..p.steps.unwrap_or(1).max(1))
            .map_while(|_| {
                if p.redo {
                    handle.redo(&actor, None)
                } else {
                    handle.undo(&actor, None)
                }
                .map(|c| c.label)
            })
            .collect();
        let (verb, nothing) = if p.redo {
            ("Redid", "Nothing to redo.")
        } else {
            ("Undid", "Nothing to undo.")
        };
        match labels.len() {
            0 => ok(nothing),
            1 => ok(format!("{verb} your last edit ({}).", labels[0])),
            n => ok(format!(
                "{verb} your last {n} edits ({}).",
                labels.join(", ")
            )),
        }
    }
}

/// A comment as doc6 shows it: its element as a selector, `#id`, rather
/// than a node id.
fn selects(mut comment: Value) -> Value {
    if let Some(map) = comment.as_object_mut() {
        if let Some(Value::String(id)) = map.remove("nodeId") {
            map.insert("select".into(), format!("#{id}").into());
        }
        if let Some(Value::Array(also)) = map.get_mut("alsoSelected") {
            for item in also {
                if let Some(item) = item.as_object_mut()
                    && let Some(Value::String(id)) = item.remove("nodeId")
                {
                    item.insert("select".into(), format!("#{id}").into());
                }
            }
        }
    }
    comment
}

/// A tool result's text blocks, joined.
fn text_of(result: &CallToolResult) -> String {
    result
        .content
        .iter()
        .filter_map(|c| c.as_text().map(|t| t.text.clone()))
        .collect::<Vec<_>>()
        .join("\n")
}

/// `value` without its null fields, for parameters with defaults.
fn strip_nulls(mut value: Value) -> Value {
    if let Some(map) = value.as_object_mut() {
        map.retain(|_, v| !v.is_null());
    }
    value
}
