//! Edit commands: validate a request against the current document and turn it
//! into ops. Nothing here mutates; the caller commits the ops through
//! [`crate::Design::commit`] so they land on the right actor's history.

use std::{collections::BTreeMap, fmt};

use serde_json::Value;

use crate::{
    document::{Document, MAX_DEPTH, MAX_NODES, Op},
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

/// A free canvas position for a new `width` × `height` artboard: to the right
/// of everything, aligned with the top of the existing artboards.
pub fn find_placement(doc: &Document, _width: f64, _height: f64) -> (f64, f64) {
    let boards = doc.artboards();
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

pub struct NewArtboard {
    pub name: String,
    pub width: f64,
    pub height: f64,
    pub position: Option<(f64, f64)>,
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
    if !(spec.width > 0.0 && spec.height > 0.0) {
        return err("artboard width and height must be positive");
    }
    let (x, y) = spec
        .position
        .unwrap_or_else(|| find_placement(doc, spec.width, spec.height));
    let mut styles = default_artboard_styles();
    for (name, value) in normalize_styles(spec.styles) {
        for longhand in longhands(&name) {
            styles.remove(*longhand);
        }
        styles.insert(name, value);
    }
    styles.insert("width".into(), format!("{}px", spec.width));
    styles.insert("height".into(), format!("{}px", spec.height));
    let index = doc.insertion_indexes(None, None, 1).remove(0);
    Ok(vec![Op::Create {
        node: Node {
            parent: None,
            index,
            name: Some(label::clip(&spec.name, label::LAYER_NAME)),
            x: Some(x),
            y: Some(y),
            styles,
            ..Node::element(id, "div")
        },
    }])
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

/// Inserts parsed HTML relative to `target`. Returns the ops and the ids of the new root nodes.
pub fn write_html(
    doc: &Document,
    target: &str,
    html_source: &str,
    mode: WriteMode,
    index: Option<usize>,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<(Vec<Op>, Vec<NodeId>)> {
    let fragments = match html::parse(html_source) {
        Ok(fragments) => fragments,
        Err(too_deep) => return err(too_deep.to_string()),
    };
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

/// Drops ids nested inside other ids in the list, so a subtree is handled once.
fn top_level<'a>(doc: &Document, ids: &'a [NodeId]) -> Vec<&'a NodeId> {
    ids.iter()
        .filter(|id| {
            !ids.iter()
                .any(|other| other != *id && doc.is_ancestor(other, id))
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
    let (mut x, y) = find_placement(doc, 0.0, 0.0);
    for (id, index) in ids.into_iter().zip(indexes) {
        let n = node(doc, id)?;
        ops.push(Op::Move {
            id: id.clone(),
            parent: parent.map(Into::into),
            index,
        });
        match (n.is_artboard(), parent.is_none()) {
            // Leaving the canvas: canvas positions no longer apply.
            (true, false) => {
                ops.push(Op::Set {
                    id: id.clone(),
                    key: PropKey::X,
                    value: None,
                });
                ops.push(Op::Set {
                    id: id.clone(),
                    key: PropKey::Y,
                    value: None,
                });
            }
            // Becoming an artboard: give it a free spot.
            (false, true) => {
                ops.push(Op::Set {
                    id: id.clone(),
                    key: PropKey::X,
                    value: Some(Value::from(x)),
                });
                ops.push(Op::Set {
                    id: id.clone(),
                    key: PropKey::Y,
                    value: Some(Value::from(y)),
                });
                x += pixel_size(n).0.unwrap_or(400.0) + ARTBOARD_GAP;
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
    let (mut x, y) = find_placement(doc, 0.0, 0.0);
    for id in top_level(doc, ids) {
        let original = node(doc, id)?;
        let fragment = Fragment::from_document(doc, id).expect("node exists");
        let index = doc.index_after(id).expect("node exists");
        let position = original.is_artboard().then_some((x, y));
        if original.is_artboard() {
            x += pixel_size(original).0.unwrap_or(400.0) + ARTBOARD_GAP;
        }
        let parent = original.parent.clone();
        roots.push(fragment.create_ops(parent.as_deref(), index, position, new_id, &mut ops));
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
                height: 900.0,
                position: None,
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
            assert!(
                refused.1 < std::time::Duration::from_secs(2),
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
    fn artboard_styles_are_normalized() {
        let mut doc = Document::default();
        let id = board(&mut doc);
        let node = doc.get(&id).unwrap();
        assert_eq!(node.styles["background-color"], "#000");
        assert_eq!(pixel_size(node), (Some(1440.0), Some(900.0)));
        assert_eq!(
            find_placement(&doc, 100.0, 100.0),
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
                height: 10.0,
                position: None,
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
    }
}
