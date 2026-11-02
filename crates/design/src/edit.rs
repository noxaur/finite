//! Edit commands: validate a request against the current document and turn it
//! into ops. Nothing here mutates; the caller commits the ops through
//! [`crate::Design::commit`] so they land on the right actor's history.

use std::{
    collections::{BTreeMap, HashMap},
    fmt,
};

use serde_json::Value;

use crate::{
    document::{Document, FIRST_PAGE, MAX_DEPTH, MAX_NODES, MAX_PAGES, Op, Page},
    fractional,
    html::{self, Fragment},
    label,
    node::{Node, NodeId, NodeKind, PropKey},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditError(pub String);

impl fmt::Display for EditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EditError {}

pub type Result<T> = std::result::Result<T, EditError>;

fn err<T>(message: impl Into<String>) -> Result<T> {
    Err(EditError(message.into()))
}

fn node<'a>(doc: &'a Document, id: &str) -> Result<&'a Node> {
    doc.get(id)
        .ok_or_else(|| EditError(format!("node {id:?} not found")))
}

fn element<'a>(doc: &'a Document, id: &str) -> Result<&'a Node> {
    let node = node(doc, id)?;
    match node.kind {
        NodeKind::Element { .. } => Ok(node),
        NodeKind::Text => err(format!(
            "node {id:?} is a text node and can't have children"
        )),
    }
}

fn page<'a>(doc: &'a Document, id: &str) -> Result<&'a Page> {
    doc.page(id).ok_or_else(|| {
        EditError(format!(
            "page {id:?} not found. get_basic_info lists the pages."
        ))
    })
}

/// Space left between artboards placed automatically.
pub const ARTBOARD_GAP: f64 = 120.0;

/// Width and height of a node from its `width`/`height` styles, when they are plain pixels.
pub fn pixel_size(node: &Node) -> (Option<f64>, Option<f64>) {
    let px = |key: &str| {
        let value = node.styles.get(key)?.trim();
        value
            .strip_suffix("px")
            .unwrap_or(value)
            .trim()
            .parse::<f64>()
            .ok()
    };
    (px("width"), px("height"))
}

/// A free canvas position for a new `width` × `height` artboard on `page`:
/// to the right of everything there, aligned with the top of its artboards.
pub fn find_placement(doc: &Document, page: &str, _width: f64, _height: f64) -> (f64, f64) {
    let boards = doc.artboards_on(page);
    if boards.is_empty() {
        return (0.0, 0.0);
    }
    let right = boards
        .iter()
        .map(|b| b.x.unwrap_or(0.0) + pixel_size(b).0.unwrap_or(0.0))
        .fold(f64::MIN, f64::max);
    let top = boards
        .iter()
        .map(|b| b.y.unwrap_or(0.0))
        .fold(f64::MAX, f64::min);
    (right + ARTBOARD_GAP, top)
}

/// Free canvas spots for artboards placed one after another, to the right
/// of what's on each page.
struct Placer<'a> {
    doc: &'a Document,
    next: HashMap<String, (f64, f64)>,
}

impl<'a> Placer<'a> {
    fn new(doc: &'a Document) -> Self {
        Self {
            doc,
            next: HashMap::new(),
        }
    }

    /// A spot on `page` for `board`, and moves the next spot past it.
    fn place(&mut self, page: &str, board: &Node) -> (f64, f64) {
        let spot = self
            .next
            .entry(page.to_owned())
            .or_insert_with(|| find_placement(self.doc, page, 0.0, 0.0));
        let at = *spot;
        spot.0 += pixel_size(board).0.unwrap_or(400.0) + ARTBOARD_GAP;
        at
    }
}

pub struct NewArtboard {
    pub name: String,
    pub width: f64,
    /// Fixed height in pixels. `None` lets the artboard grow to fit its content.
    pub height: Option<f64>,
    pub position: Option<(f64, f64)>,
    /// The page to put it on. `None`: the first page.
    pub page: Option<String>,
    pub styles: BTreeMap<String, String>,
}

/// Styles every new artboard starts with. Agent-provided styles override them.
pub fn default_artboard_styles() -> BTreeMap<String, String> {
    [
        ("background-color", "#ffffff"),
        ("display", "flex"),
        ("flex-direction", "column"),
        ("overflow", "hidden"),
        ("position", "relative"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect()
}

pub fn create_artboard(doc: &Document, id: NodeId, spec: NewArtboard) -> Result<Vec<Op>> {
    let positive = |n: f64| n > 0.0;
    if !positive(spec.width) || !spec.height.is_none_or(positive) {
        return err("artboard width and height must be positive");
    }
    if let Some(id) = &spec.page {
        page(doc, id)?;
    }
    let on = spec.page.as_deref().unwrap_or_else(|| doc.first_page());
    let (x, y) = spec
        .position
        .unwrap_or_else(|| find_placement(doc, on, spec.width, spec.height.unwrap_or(0.0)));
    let mut styles = default_artboard_styles();
    for (name, value) in normalize_styles(spec.styles) {
        for longhand in longhands(&name) {
            styles.remove(*longhand);
        }
        styles.insert(name, value);
    }
    styles.insert("width".into(), format!("{}px", spec.width));
    let height = spec
        .height
        .map_or_else(|| "auto".to_owned(), |h| format!("{h}px"));
    styles.insert("height".into(), height);
    let index = doc.insertion_indexes(None, None, 1).remove(0);
    Ok(vec![Op::Create {
        node: Node {
            parent: None,
            index,
            name: Some(label::clip(&spec.name, label::LAYER_NAME)),
            x: Some(x),
            y: Some(y),
            page: spec.page,
            styles,
            ..Node::element(id, "div")
        },
    }])
}

/// [`create_artboard`], with `fragments` written into it, as one change.
/// Returns the ops and the ids of the content's root nodes.
pub fn create_artboard_with(
    doc: &Document,
    id: NodeId,
    spec: NewArtboard,
    fragments: Vec<Fragment>,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<(Vec<Op>, Vec<NodeId>)> {
    let mut ops = create_artboard(doc, id.clone(), spec)?;
    let height = fragments.iter().map(Fragment::height).max().unwrap_or(0);
    // The artboard is at depth 0, so its content starts at depth 1.
    if 1 + height > MAX_DEPTH {
        return err(format!(
            "that would nest {} levels deep; the limit is {MAX_DEPTH}",
            1 + height
        ));
    }
    room_for(
        doc,
        0,
        1 + fragments.iter().map(Fragment::count).sum::<usize>(),
    )?;
    let indexes = fractional::keys_between(None, None, fragments.len());
    let roots = fragments
        .into_iter()
        .zip(indexes)
        .map(|(fragment, index)| fragment.create_ops(Some(&id), index, None, new_id, &mut ops))
        .collect();
    Ok((ops, roots))
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteMode {
    /// Insert the HTML as children of the target, at `index` or at the end.
    Append,
    /// Replace all of the target's children with the HTML.
    ReplaceChildren,
    /// Replace the target itself, in place.
    Replace,
}

/// Parses HTML and inserts it relative to `target`, as [`write_fragments`]
/// does. Returns the ops and the ids of the new root nodes.
pub fn write_html(
    doc: &Document,
    target: &str,
    html_source: &str,
    mode: WriteMode,
    index: Option<usize>,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<(Vec<Op>, Vec<NodeId>)> {
    write_fragments(doc, target, parse_html(html_source)?, mode, index, new_id)
}

/// [`html::parse`], with its error as an [`EditError`]. Parsing doesn't need
/// the document, so the server does it before it takes the design's lock.
pub fn parse_html(html_source: &str) -> Result<Vec<Fragment>> {
    html::parse(html_source).or_else(|too_deep| err(too_deep.to_string()))
}

/// Inserts parsed HTML relative to `target`. Returns the ops and the ids of the new root nodes.
pub fn write_fragments(
    doc: &Document,
    target: &str,
    fragments: Vec<Fragment>,
    mode: WriteMode,
    index: Option<usize>,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<(Vec<Op>, Vec<NodeId>)> {
    if fragments.is_empty() {
        return err("the HTML contained no elements or text (scripts and styles are dropped)");
    }
    let target_node = node(doc, target)?;
    let mut ops = Vec::new();
    let (parent, indexes) = match mode {
        WriteMode::Append => {
            element(doc, target)?;
            let indexes = doc.insertion_indexes(Some(target), index, fragments.len());
            (target.to_owned(), indexes)
        }
        WriteMode::ReplaceChildren => {
            element(doc, target)?;
            for child in doc.children(Some(target)) {
                ops.push(Op::Delete {
                    id: child.id.clone(),
                });
            }
            (
                target.to_owned(),
                fractional::keys_between(None, None, fragments.len()),
            )
        }
        WriteMode::Replace => {
            let Some(parent) = target_node.parent.clone() else {
                return err("can't replace an artboard; use mode \"replace-children\" instead");
            };
            let next = doc
                .children(Some(&parent))
                .into_iter()
                .skip_while(|n| n.id != target)
                .nth(1)
                .map(|n| n.index.clone());
            let indexes = fractional::keys_between(
                Some(&target_node.index),
                next.as_deref(),
                fragments.len(),
            );
            ops.push(Op::Delete {
                id: target.to_owned(),
            });
            (parent, indexes)
        }
    };
    let depth = doc.depth(&parent) + 1;
    let height = fragments.iter().map(Fragment::height).max().unwrap_or(0);
    if depth + height > MAX_DEPTH {
        return err(format!(
            "that would nest {} levels deep; the limit is {MAX_DEPTH}",
            depth + height
        ));
    }
    let removed = ops
        .iter()
        .map(|op| doc.subtree(op.id()).len())
        .sum::<usize>();
    room_for(doc, removed, fragments.iter().map(Fragment::count).sum())?;
    let roots = fragments
        .into_iter()
        .zip(indexes)
        .map(|(fragment, index)| fragment.create_ops(Some(&parent), index, None, new_id, &mut ops))
        .collect();
    Ok((ops, roots))
}

/// Accepts `backgroundColor` as well as `background-color`, and keeps `--custom` properties as is.
pub fn normalize_style_name(name: &str) -> String {
    let name = name.trim();
    if name.starts_with("--") {
        return name.to_owned();
    }
    let mut out = String::with_capacity(name.len() + 4);
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Longhand properties a shorthand resets. Styles are a map, not an ordered
/// declaration list, so setting a shorthand must clear these explicitly or the
/// longhand would keep winning.
fn longhands(shorthand: &str) -> &'static [&'static str] {
    match shorthand {
        "background" => &[
            "background-color",
            "background-image",
            "background-position",
            "background-size",
            "background-repeat",
            "background-attachment",
            "background-origin",
            "background-clip",
        ],
        "border" => &[
            "border-width",
            "border-style",
            "border-color",
            "border-top",
            "border-right",
            "border-bottom",
            "border-left",
        ],
        "border-radius" => &[
            "border-top-left-radius",
            "border-top-right-radius",
            "border-bottom-right-radius",
            "border-bottom-left-radius",
        ],
        "padding" => &[
            "padding-top",
            "padding-right",
            "padding-bottom",
            "padding-left",
        ],
        "margin" => &["margin-top", "margin-right", "margin-bottom", "margin-left"],
        "inset" => &["top", "right", "bottom", "left"],
        "gap" => &["row-gap", "column-gap"],
        "flex" => &["flex-grow", "flex-shrink", "flex-basis"],
        "font" => &[
            "font-family",
            "font-size",
            "font-weight",
            "font-style",
            "line-height",
            "font-variant",
            "font-stretch",
        ],
        _ => &[],
    }
}

fn normalize_styles(styles: BTreeMap<String, String>) -> BTreeMap<String, String> {
    styles
        .into_iter()
        .map(|(k, v)| (normalize_style_name(&k), v.trim().to_owned()))
        .collect()
}

/// Sets styles on several nodes. A `None` value removes that style.
pub fn update_styles(
    doc: &Document,
    ids: &[NodeId],
    styles: &BTreeMap<String, Option<String>>,
) -> Result<Vec<Op>> {
    let styles: BTreeMap<String, Option<String>> = styles
        .iter()
        .map(|(k, v)| {
            (
                normalize_style_name(k),
                v.as_ref().map(|v| v.trim().to_owned()),
            )
        })
        .collect();
    let mut ops = Vec::new();
    for id in ids {
        let node = element(doc, id)?;
        for (name, value) in &styles {
            if value.is_some() {
                for longhand in longhands(name) {
                    if node.styles.contains_key(*longhand) && !styles.contains_key(*longhand) {
                        ops.push(Op::Set {
                            id: id.clone(),
                            key: PropKey::Style((*longhand).to_owned()),
                            value: None,
                        });
                    }
                }
            }
            ops.push(Op::Set {
                id: id.clone(),
                key: PropKey::Style(name.clone()),
                value: value.clone().map(Value::String),
            });
        }
    }
    Ok(ops)
}

/// Sets attributes (`src`, `alt`, `href`, SVG attributes, ...). A `None` value removes it.
pub fn update_attributes(
    doc: &Document,
    ids: &[NodeId],
    attrs: &BTreeMap<String, Option<String>>,
) -> Result<Vec<Op>> {
    let mut ops = Vec::new();
    for id in ids {
        element(doc, id)?;
        for (name, value) in attrs {
            let lower = name.to_ascii_lowercase();
            if lower == "style" {
                return err("use update_styles to change inline styles");
            }
            if lower.starts_with("on") {
                return err(format!(
                    "event handler attributes like {name:?} aren't supported; add a <script> that calls addEventListener"
                ));
            }
            if !html::is_attr_name(name) {
                return err(format!("{name:?} isn't a valid attribute name"));
            }
            // A layer's name is `Node.name`, not an attribute; write_html maps
            // data-name the same way. Clear any stale copy left in attrs.
            if lower == html::NAME_ATTR {
                ops.push(Op::Set {
                    id: id.clone(),
                    key: PropKey::Name,
                    value: value
                        .as_deref()
                        .map(|n| Value::String(label::clip(n, label::LAYER_NAME))),
                });
                for stale in element(doc, id)?
                    .attrs
                    .keys()
                    .filter(|k| k.eq_ignore_ascii_case(html::NAME_ATTR))
                {
                    ops.push(Op::Set {
                        id: id.clone(),
                        key: PropKey::Attr(stale.clone()),
                        value: None,
                    });
                }
                continue;
            }
            if lower == html::ID_ATTR {
                return err("data-id is the node id and can't be changed");
            }
            // The same rule write_html applies when it parses HTML.
            if let Some(value) = value
                && !html::is_safe_attr(name, value)
            {
                return err(format!(
                    "{name}={value:?} isn't allowed: no srcdoc, and no javascript: or vbscript: URLs"
                ));
            }
            ops.push(Op::Set {
                id: id.clone(),
                key: PropKey::Attr(name.clone()),
                value: value.clone().map(Value::String),
            });
        }
    }
    Ok(ops)
}

/// Replaces the text of a node. On a text node this sets its text; on an
/// element it reuses a lone text child, or replaces all children with one.
pub fn set_text(
    doc: &Document,
    id: &str,
    text: &str,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<Vec<Op>> {
    let target = node(doc, id)?;
    let set = |id: &str| Op::Set {
        id: id.to_owned(),
        key: PropKey::Text,
        value: Some(Value::String(text.to_owned())),
    };
    if target.kind == NodeKind::Text {
        return Ok(vec![set(id)]);
    }
    let children = doc.children(Some(id));
    if let [only] = children.as_slice()
        && only.kind == NodeKind::Text
    {
        return Ok(vec![set(&only.id)]);
    }
    let mut ops: Vec<Op> = children
        .iter()
        .map(|c| Op::Delete { id: c.id.clone() })
        .collect();
    ops.push(Op::Create {
        node: Node {
            parent: Some(id.to_owned()),
            index: fractional::key_between(None, None),
            ..Node::text(new_id(), text)
        },
    });
    Ok(ops)
}

pub fn rename(doc: &Document, id: &str, name: Option<&str>) -> Result<Vec<Op>> {
    node(doc, id)?;
    Ok(vec![Op::Set {
        id: id.to_owned(),
        key: PropKey::Name,
        value: name.map(|n| Value::String(label::clip(n, label::LAYER_NAME))),
    }])
}

pub fn set_position(doc: &Document, id: &str, x: f64, y: f64) -> Result<Vec<Op>> {
    if !node(doc, id)?.is_artboard() {
        return err(format!(
            "node {id:?} isn't an artboard; only artboards have a canvas position"
        ));
    }
    Ok(vec![
        Op::Set {
            id: id.to_owned(),
            key: PropKey::X,
            value: Some(Value::from(x)),
        },
        Op::Set {
            id: id.to_owned(),
            key: PropKey::Y,
            value: Some(Value::from(y)),
        },
    ])
}

/// The longest shared stylesheet, the same order as a large `<style>` block.
pub const MAX_CSS: usize = 100_000;

/// Replaces the design's shared stylesheet, or removes it when `css` is
/// blank. Exports put it in a `<style>` element, so it can't contain
/// `</style`, which would end that element early.
pub fn set_css(css: &str) -> Result<Vec<Op>> {
    if css.len() > MAX_CSS {
        return err(format!(
            "the shared CSS can be at most {MAX_CSS} characters; this is {}",
            css.len()
        ));
    }
    if css.to_ascii_lowercase().contains("</style") {
        return err("pass the CSS alone, without <style> tags");
    }
    let css = (!css.trim().is_empty()).then(|| css.to_owned());
    Ok(vec![Op::Css { css }])
}

/// Adds a page named `name` after the others, with the id `id`. A design
/// without pages first gets its implicit first page as a real one.
pub fn create_page(doc: &Document, id: String, name: &str) -> Result<Vec<Op>> {
    let pages = doc.pages();
    if pages.len() >= MAX_PAGES {
        return err(format!("a design can have at most {MAX_PAGES} pages"));
    }
    if name.trim().is_empty() {
        return err("give the page a name");
    }
    let mut ops = Vec::new();
    if doc.page_map().is_empty() {
        ops.push(Op::Page {
            id: FIRST_PAGE.into(),
            page: Some(pages[0].1.clone()),
        });
    }
    let last = pages.last().map(|(_, p)| p.index.as_str());
    ops.push(Op::Page {
        id,
        page: Some(Page {
            name: label::clip(name.trim(), label::LAYER_NAME),
            index: fractional::key_between(last, None),
        }),
    });
    Ok(ops)
}

pub fn rename_page(doc: &Document, id: &str, name: &str) -> Result<Vec<Op>> {
    let index = page(doc, id)?.index.clone();
    if name.trim().is_empty() {
        return err("give the page a name");
    }
    Ok(vec![Op::Page {
        id: id.to_owned(),
        page: Some(Page {
            name: label::clip(name.trim(), label::LAYER_NAME),
            index,
        }),
    }])
}

/// Deletes a page and every artboard on it. A design keeps at least one page.
pub fn delete_page(doc: &Document, id: &str) -> Result<Vec<Op>> {
    page(doc, id)?;
    if doc.pages().len() == 1 {
        return err("that's the design's only page, and a design keeps at least one");
    }
    let mut ops: Vec<Op> = doc
        .artboards_on(id)
        .into_iter()
        .map(|board| Op::Delete {
            id: board.id.clone(),
        })
        .collect();
    ops.push(Op::Page {
        id: id.to_owned(),
        page: None,
    });
    Ok(ops)
}

/// Moves artboards to page `to`, into free space to the right of what's
/// there. Artboards already on it stay where they are.
pub fn move_to_page(doc: &Document, ids: &[NodeId], to: &str) -> Result<Vec<Op>> {
    page(doc, to)?;
    let mut placer = Placer::new(doc);
    let mut ops = Vec::new();
    for id in ids {
        let board = node(doc, id)?;
        if !board.is_artboard() {
            return err(format!(
                "node {id:?} isn't an artboard; only artboards are on pages"
            ));
        }
        if doc.page_of(board) == to {
            continue;
        }
        let (x, y) = placer.place(to, board);
        for (key, value) in [
            (PropKey::Page, Value::from(to)),
            (PropKey::X, Value::from(x)),
            (PropKey::Y, Value::from(y)),
        ] {
            ops.push(Op::Set {
                id: id.clone(),
                key,
                value: Some(value),
            });
        }
    }
    Ok(ops)
}

/// Drops ids nested inside other ids in the list, so a subtree is handled once.
/// The ids in `ids` with none of their ancestors in `ids`, in order, each
/// once. Each node walks up its ancestors (at most `MAX_DEPTH`) instead of
/// being compared with every other id, which was quadratic.
fn top_level<'a>(doc: &Document, ids: &'a [NodeId]) -> Vec<&'a NodeId> {
    let given: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut seen = std::collections::HashSet::new();
    ids.iter()
        .filter(|id| seen.insert(id.as_str()))
        .filter(|id| {
            let mut parent = doc.get(id).and_then(|n| n.parent.as_deref());
            while let Some(p) = parent {
                if given.contains(p) {
                    return false;
                }
                parent = doc.get(p).and_then(|n| n.parent.as_deref());
            }
            true
        })
        .collect()
}

pub fn delete(doc: &Document, ids: &[NodeId]) -> Result<Vec<Op>> {
    for id in ids {
        node(doc, id)?;
    }
    Ok(top_level(doc, ids)
        .into_iter()
        .map(|id| Op::Delete { id: id.clone() })
        .collect())
}

/// Moves nodes under `parent` at `index` (append when `None`), keeping their
/// relative order. With `parent: None` the nodes become artboards.
pub fn move_nodes(
    doc: &Document,
    ids: &[NodeId],
    parent: Option<&str>,
    index: Option<usize>,
) -> Result<Vec<Op>> {
    if let Some(parent) = parent {
        element(doc, parent)?;
    }
    for id in ids {
        let n = node(doc, id)?;
        if parent == Some(id.as_str()) || parent.is_some_and(|p| doc.is_ancestor(id, p)) {
            return err(format!("can't move {id:?} into itself"));
        }
        if parent.is_none() && n.kind == NodeKind::Text {
            return err(format!("text node {id:?} can't become an artboard"));
        }
        let depth = parent.map_or(0, |p| doc.depth(p) + 1) + doc.height(id);
        if depth > MAX_DEPTH {
            return err(format!(
                "moving {id:?} there would nest {depth} levels deep; the limit is {MAX_DEPTH}"
            ));
        }
    }
    let ids = top_level(doc, ids);
    let indexes = doc.insertion_indexes(parent, index, ids.len());
    let mut ops = Vec::new();
    let mut placer = Placer::new(doc);
    for (id, index) in ids.into_iter().zip(indexes) {
        let n = node(doc, id)?;
        let board = doc.artboard_of(id).expect("node exists");
        ops.push(Op::Move {
            id: id.clone(),
            parent: parent.map(Into::into),
            index,
        });
        match (n.is_artboard(), parent.is_none()) {
            // Leaving the canvas: canvas positions and pages no longer apply.
            (true, false) => {
                for key in [PropKey::X, PropKey::Y, PropKey::Page] {
                    ops.push(Op::Set {
                        id: id.clone(),
                        key,
                        value: None,
                    });
                }
            }
            // Becoming an artboard: give it a free spot on its old artboard's page.
            (false, true) => {
                let (x, y) = placer.place(doc.page_of(board), n);
                let mut keys = vec![(PropKey::X, Value::from(x)), (PropKey::Y, Value::from(y))];
                if let Some(page) = &board.page {
                    keys.push((PropKey::Page, Value::from(page.as_str())));
                }
                for (key, value) in keys {
                    ops.push(Op::Set {
                        id: id.clone(),
                        key,
                        value: Some(value),
                    });
                }
            }
            _ => {}
        }
    }
    Ok(ops)
}

/// Copies nodes. Each copy lands right after its original; copied artboards
/// are placed in free canvas space. Returns the ops and the new root ids.
pub fn duplicate(
    doc: &Document,
    ids: &[NodeId],
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<(Vec<Op>, Vec<NodeId>)> {
    let mut ops = Vec::new();
    let mut roots = Vec::new();
    let mut placer = Placer::new(doc);
    for id in top_level(doc, ids) {
        let original = node(doc, id)?;
        let fragment = Fragment::from_document(doc, id).expect("node exists");
        let index = doc.index_after(id).expect("node exists");
        let position = original
            .is_artboard()
            .then(|| placer.place(doc.page_of(original), original));
        let parent = original.parent.clone();
        let first = ops.len();
        roots.push(fragment.create_ops(parent.as_deref(), index, position, new_id, &mut ops));
        // A copied artboard goes on its original's page.
        if let Some(Op::Create { node }) = ops.get_mut(first)
            && original.is_artboard()
        {
            node.page = original.page.clone();
        }
    }
    room_for(doc, 0, ops.len())?;
    Ok((ops, roots))
}

/// Refuses an edit that would leave the design with more than [`MAX_NODES`].
fn room_for(doc: &Document, removed: usize, added: usize) -> Result<()> {
    let total = doc.len().saturating_sub(removed) + added;
    if total > MAX_NODES {
        return err(format!(
            "that would make the design {total} nodes; the limit is {MAX_NODES}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> impl FnMut() -> NodeId {
        let mut n = 0;
        move || {
            n += 1;
            format!("n{n}")
        }
    }

    fn board(doc: &mut Document) -> NodeId {
        let ops = create_artboard(
            doc,
            "board".into(),
            NewArtboard {
                name: "Home".into(),
                width: 1440.0,
                height: Some(900.0),
                position: None,
                page: None,
                styles: BTreeMap::from([("backgroundColor".into(), "#000".into())]),
            },
        )
        .unwrap();
        doc.apply_all(&ops);
        "board".into()
    }

    fn nested(levels: usize) -> String {
        format!("{}x{}", "<div>".repeat(levels), "</div>".repeat(levels))
    }

    /// Runs `f` on a thread with a Tokio worker's 2 MiB stack.
    fn on_small_stack<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        std::thread::Builder::new()
            .stack_size(2 << 20)
            .spawn(f)
            .unwrap()
            .join()
            .unwrap()
    }

    #[test]
    fn html_can_only_nest_so_deep() {
        // 5,000 levels used to overflow the stack and abort the server.
        // 1,000,000 levels would keep the parser busy for minutes, so the
        // pre-scan refuses them at once.
        for levels in [5_000, 1_000_000] {
            let refused = on_small_stack(move || {
                let mut doc = Document::default();
                let board = board(&mut doc);
                let started = std::time::Instant::now();
                let refused = write_html(
                    &doc,
                    &board,
                    &nested(levels),
                    WriteMode::Append,
                    None,
                    &mut ids(),
                )
                .unwrap_err();
                (refused, started.elapsed())
            });
            assert!(refused.0.0.contains("256 levels"), "{}", refused.0.0);
            // It takes about 0.2 s here, and 2.2 s in a debug build on CI's
            // two cores. The limit only has to tell that apart from minutes.
            assert!(
                refused.1 < std::time::Duration::from_secs(20),
                "{levels}: {:?}",
                refused.1
            );
        }

        // The artboard is at depth 0, so its content can nest 256 levels:
        // 255 divs and the text inside them.
        let mut doc = Document::default();
        let board = board(&mut doc);
        let html = nested(MAX_DEPTH);
        assert!(write_html(&doc, &board, &html, WriteMode::Append, None, &mut ids()).is_err());
        let (ops, roots) = write_html(
            &doc,
            &board,
            &nested(MAX_DEPTH - 1),
            WriteMode::Append,
            None,
            &mut ids(),
        )
        .unwrap();
        doc.apply_all(&ops);
        let deepest = doc
            .nodes()
            .max_by_key(|n| doc.depth(&n.id))
            .unwrap()
            .id
            .clone();
        assert_eq!(doc.depth(&deepest), MAX_DEPTH);
        assert_eq!(doc.height(&board), MAX_DEPTH);
        // Nothing more fits under the deepest element.
        let inner = doc.get(&deepest).unwrap().parent.clone().unwrap();
        assert!(
            write_html(
                &doc,
                &inner,
                "<b>no</b>",
                WriteMode::Append,
                None,
                &mut ids()
            )
            .is_err()
        );

        // Moving the whole stack one level down doesn't fit either.
        let (ops, _) = write_html(
            &doc,
            &board,
            "<section></section>",
            WriteMode::Append,
            None,
            &mut ids(),
        )
        .unwrap();
        doc.apply_all(&ops);
        let section = doc.children(Some(&board)).last().unwrap().id.clone();
        assert!(move_nodes(&doc, &roots, Some(&section), None).is_err());

        // A tree at the limit exports, and copies, on a small stack, even
        // in a debug build.
        let exported = on_small_stack(move || {
            let compact = html::export_compact(&doc, &board).unwrap();
            let copy = Fragment::from_document(&doc, &board).unwrap();
            (
                compact,
                copy.count(),
                html::export(&doc, &board, true).unwrap(),
            )
        });
        assert!(exported.0.contains("x"));
        assert_eq!(exported.1, MAX_DEPTH + 1);
    }

    #[test]
    fn a_design_holds_at_most_100_000_nodes() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let siblings = |n: usize| "<i></i>".repeat(n);
        let refused = write_html(
            &doc,
            &board,
            &siblings(MAX_NODES),
            WriteMode::Append,
            None,
            &mut ids(),
        )
        .unwrap_err();
        assert!(refused.0.contains("100001 nodes"), "{}", refused.0);

        let (ops, _) = write_html(
            &doc,
            &board,
            &siblings(MAX_NODES - 1),
            WriteMode::Append,
            None,
            &mut ids(),
        )
        .unwrap();
        doc.apply_all(&ops);
        assert_eq!(doc.len(), MAX_NODES);
        assert!(duplicate(&doc, &["board".into()], &mut ids()).is_err());
        // Replacing counts what the write removes.
        let (ops, _) = write_html(
            &doc,
            &board,
            "<p>Fresh</p>",
            WriteMode::ReplaceChildren,
            None,
            &mut ids(),
        )
        .unwrap();
        doc.apply_all(&ops);
        assert_eq!(doc.len(), 3);
    }

    #[test]
    fn many_nodes_delete_at_once() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let card = "<div><p>Card</p></div>";
        let (ops, _) = write_html(
            &doc,
            &board,
            &card.repeat(10_000),
            WriteMode::Append,
            None,
            &mut ids(),
        )
        .unwrap();
        doc.apply_all(&ops);
        // Every card and every paragraph, some twice: only the cards are deleted.
        let mut all: Vec<NodeId> = doc
            .subtree(&board)
            .iter()
            .filter(|n| n.id != board && n.kind != NodeKind::Text)
            .map(|n| n.id.clone())
            .collect();
        all.extend(all[..100].to_vec());
        let started = std::time::Instant::now();
        let ops = delete(&doc, &all).unwrap();
        assert_eq!(ops.len(), 10_000);
        assert!(
            started.elapsed() < std::time::Duration::from_secs(2),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn many_siblings_duplicate_at_once() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let (ops, cards) = write_html(
            &doc,
            &board,
            &"<div><p>Card</p></div>".repeat(10_000),
            WriteMode::Append,
            None,
            &mut ids(),
        )
        .unwrap();
        doc.apply_all(&ops);
        let mut n = 0;
        let mut copy_id = || {
            n += 1;
            format!("copy{n}")
        };
        let started = std::time::Instant::now();
        let (ops, copies) = duplicate(&doc, &cards, &mut copy_id).unwrap();
        let took = started.elapsed();
        doc.apply_all(&ops);
        assert_eq!(copies.len(), 10_000);
        // Each copy sits right after its original.
        let order: Vec<String> = doc
            .children(Some(&board))
            .iter()
            .map(|n| n.id.clone())
            .collect();
        assert_eq!(
            order[..4],
            [
                cards[0].clone(),
                copies[0].clone(),
                cards[1].clone(),
                copies[1].clone()
            ]
        );
        assert!(took < std::time::Duration::from_secs(2), "{took:?}");
    }

    #[test]
    fn artboard_styles_are_normalized() {
        let mut doc = Document::default();
        let id = board(&mut doc);
        let node = doc.get(&id).unwrap();
        assert_eq!(node.styles["background-color"], "#000");
        assert_eq!(pixel_size(node), (Some(1440.0), Some(900.0)));
        assert_eq!(
            find_placement(&doc, FIRST_PAGE, 100.0, 100.0),
            (1440.0 + ARTBOARD_GAP, 0.0)
        );
    }

    #[test]
    fn shorthands_reset_longhands() {
        let mut doc = Document::default();
        let ops = create_artboard(
            &doc,
            "b".into(),
            NewArtboard {
                name: "B".into(),
                width: 10.0,
                height: Some(10.0),
                position: None,
                page: None,
                styles: BTreeMap::from([("background".into(), "#fef3c7".into())]),
            },
        )
        .unwrap();
        doc.apply_all(&ops);
        assert!(
            !doc.get("b")
                .unwrap()
                .styles
                .contains_key("background-color")
        );

        let set = |k: &str, v: &str| BTreeMap::from([(k.to_owned(), Some(v.to_owned()))]);
        doc.apply_all(&update_styles(&doc, &["b".into()], &set("paddingTop", "4px")).unwrap());
        doc.apply_all(&update_styles(&doc, &["b".into()], &set("padding", "8px")).unwrap());
        let styles = &doc.get("b").unwrap().styles;
        assert_eq!(styles.get("padding").map(String::as_str), Some("8px"));
        assert!(!styles.contains_key("padding-top"));
    }

    #[test]
    fn artboard_without_height_is_auto() {
        let mut doc = Document::default();
        let spec = |height| NewArtboard {
            name: "B".into(),
            width: 320.0,
            height,
            position: None,
            page: None,
            styles: BTreeMap::new(),
        };
        doc.apply_all(&create_artboard(&doc, "a".into(), spec(None)).unwrap());
        let board = doc.get("a").unwrap();
        assert_eq!(board.styles.get("height").map(String::as_str), Some("auto"));
        assert_eq!(pixel_size(board), (Some(320.0), None));

        doc.apply_all(&create_artboard(&doc, "b".into(), spec(Some(200.0))).unwrap());
        assert_eq!(
            pixel_size(doc.get("b").unwrap()),
            (Some(320.0), Some(200.0))
        );
        assert!(create_artboard(&doc, "c".into(), spec(Some(0.0))).is_err());
    }

    #[test]
    fn write_modes() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let mut new_id = ids();
        let (ops, roots) = write_html(
            &doc,
            &board,
            "<p>a</p><p>c</p>",
            WriteMode::Append,
            None,
            &mut new_id,
        )
        .unwrap();
        doc.apply_all(&ops);
        assert_eq!(roots.len(), 2);
        let (ops, _) = write_html(
            &doc,
            &board,
            "<p>b</p>",
            WriteMode::Append,
            Some(1),
            &mut new_id,
        )
        .unwrap();
        doc.apply_all(&ops);
        let html = html::export(&doc, &board, false).unwrap();
        assert!(html.contains("<p>a</p>\n  <p>b</p>\n  <p>c</p>"), "{html}");

        let (ops, _) = write_html(
            &doc,
            &roots[0],
            "<h1>A</h1>",
            WriteMode::Replace,
            None,
            &mut new_id,
        )
        .unwrap();
        doc.apply_all(&ops);
        let html = html::export(&doc, &board, false).unwrap();
        assert!(html.contains("<h1>A</h1>\n  <p>b</p>"), "{html}");

        let (ops, _) = write_html(
            &doc,
            &board,
            "<span>x</span>",
            WriteMode::ReplaceChildren,
            None,
            &mut new_id,
        )
        .unwrap();
        doc.apply_all(&ops);
        assert_eq!(doc.children(Some(&board)).len(), 1);
    }

    #[test]
    fn long_layer_names_are_cut() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let long = "x".repeat(500);
        let html = format!(r#"<div data-name="  {long}  "></div>"#);
        let (ops, roots) =
            write_html(&doc, &board, &html, WriteMode::Append, None, &mut ids()).unwrap();
        doc.apply_all(&ops);
        let name = |doc: &Document| doc.get(&roots[0]).unwrap().name.clone().unwrap();
        assert_eq!(name(&doc).len(), label::LAYER_NAME);
        doc.apply_all(&rename(&doc, &roots[0], Some(&long)).unwrap());
        assert_eq!(name(&doc).len(), label::LAYER_NAME);
    }

    #[test]
    fn set_text_reuses_lone_text_child() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let mut new_id = ids();
        let (ops, roots) = write_html(
            &doc,
            &board,
            "<p>old</p>",
            WriteMode::Append,
            None,
            &mut new_id,
        )
        .unwrap();
        doc.apply_all(&ops);
        let text_id = doc.children(Some(&roots[0]))[0].id.clone();
        let ops = set_text(&doc, &roots[0], "new", &mut new_id).unwrap();
        doc.apply_all(&ops);
        assert_eq!(doc.get(&text_id).unwrap().text.as_deref(), Some("new"));
    }

    #[test]
    fn duplicate_artboard_places_it_beside() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let mut new_id = ids();
        let (ops, _) = write_html(
            &doc,
            &board,
            "<p>a</p>",
            WriteMode::Append,
            None,
            &mut new_id,
        )
        .unwrap();
        doc.apply_all(&ops);
        let (ops, roots) = duplicate(&doc, std::slice::from_ref(&board), &mut new_id).unwrap();
        doc.apply_all(&ops);
        let copy = doc.get(&roots[0]).unwrap();
        assert_eq!(copy.x, Some(1440.0 + ARTBOARD_GAP));
        assert_eq!(doc.subtree(&roots[0]).len(), 3);
    }

    #[test]
    fn move_into_descendant_fails() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let mut new_id = ids();
        let (ops, roots) = write_html(
            &doc,
            &board,
            "<div><p>a</p></div>",
            WriteMode::Append,
            None,
            &mut new_id,
        )
        .unwrap();
        doc.apply_all(&ops);
        assert!(move_nodes(&doc, std::slice::from_ref(&board), Some(&roots[0]), None).is_err());
    }

    #[test]
    fn set_attributes_follows_the_same_rules_as_write_html() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let set = |name: &str, value: &str| {
            let attrs = BTreeMap::from([(name.to_owned(), Some(value.to_owned()))]);
            update_attributes(&doc, std::slice::from_ref(&board), &attrs)
        };
        assert!(set("href", "https://example.com").is_ok());
        assert!(set("viewBox", "0 0 10 10").is_ok());
        assert!(set("xlink:href", "#icon").is_ok());
        assert!(set("href", " JavaScript:alert(1)").is_err());
        assert!(set("srcdoc", "<p>hi</p>").is_err());
        assert!(set("onclick", "x()").is_err());
        assert!(set("x\" onload=\"alert(1)", "y").is_err());
        assert!(set("", "y").is_err());
        assert!(set("data-id", "n9").is_err());
    }

    #[test]
    fn set_attributes_renames_a_layer_through_data_name() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let mut set = |value: Option<&str>| {
            let attrs = BTreeMap::from([("data-name".to_owned(), value.map(str::to_owned))]);
            let ops = update_attributes(&doc, std::slice::from_ref(&board), &attrs).unwrap();
            assert!(ops.iter().all(|op| matches!(
                op,
                Op::Set {
                    key: PropKey::Name,
                    ..
                }
            )));
            doc.apply_all(&ops);
            doc.get(&board).unwrap().name.clone()
        };
        assert_eq!(set(Some("Header")).as_deref(), Some("Header"));
        let long = "x".repeat(label::LAYER_NAME + 20);
        assert_eq!(set(Some(&long)).unwrap().chars().count(), label::LAYER_NAME);
        assert_eq!(set(None), None);
        assert!(doc.get(&board).unwrap().attrs.is_empty());
    }

    #[test]
    fn set_attributes_clears_every_stale_data_name_copy() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        // Older calls could leave the same attribute under two spellings.
        for key in ["data-name", "DATA-NAME"] {
            doc.apply_all(&[Op::Set {
                id: board.clone(),
                key: PropKey::Attr(key.to_owned()),
                value: Some("Old".into()),
            }]);
        }
        let attrs = BTreeMap::from([("data-name".to_owned(), None)]);
        let ops = update_attributes(&doc, std::slice::from_ref(&board), &attrs).unwrap();
        doc.apply_all(&ops);
        assert!(doc.get(&board).unwrap().attrs.is_empty());
    }
}
