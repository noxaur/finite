//! Edit commands: validate a request against the current document and turn it
//! into ops. Nothing here mutates; the caller commits the ops through
//! [`crate::Design::commit`] so they land on the right actor's history.

use std::{
    collections::{BTreeMap, HashMap},
    fmt,
};

use serde_json::Value;

use crate::{
    components::{self, Overrides},
    document::{Document, FIRST_PAGE, MAX_DEPTH, MAX_NODES, MAX_PAGES, Op, Page},
    fractional,
    html::{self, Fragment},
    label,
    node::{Node, NodeId, NodeKind, PropKey},
    tokens::{self, MAX_MODES, Mode, Values},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditError(pub String);

impl fmt::Display for EditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EditError {}

impl From<crate::Rejected> for EditError {
    fn from(rejected: crate::Rejected) -> Self {
        Self(rejected.to_string())
    }
}

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
    let mut fragments = fragments;
    prepare_instances(doc, &mut fragments, None, &[], new_id)?;
    room_for(doc, 0, 1 + adds(doc, &fragments))?;
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
    parse_html_reporting(html_source).map(|parsed| parsed.fragments)
}

/// [`parse_html`], saying what it left out, so the author can be told.
pub fn parse_html_reporting(html_source: &str) -> Result<html::Parsed> {
    html::parse_with(html_source, html::Policy::Authoring)
        .or_else(|too_deep| err(too_deep.to_string()))
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
    // A rewrite keeps the nodes the HTML names by data-id, so their ids,
    // comment pins and undo history stay. Rewriting a component that has
    // instances also keeps nodes by tag and layer name, so the instances'
    // overrides still find them.
    if mode != WriteMode::Append && !components::is_virtual(target) {
        let in_component = components::component_of(doc, target)
            .is_some_and(|c| doc.instances_of(&c.id).next().is_some());
        let keyed = || {
            let named = |ids: &[&Node]| {
                fragments
                    .iter()
                    .any(|f| ids.iter().any(|n| f.source.as_deref() == Some(&n.id)))
            };
            let matched = match mode {
                WriteMode::Replace => named(&[target_node]),
                _ => named(&doc.children(Some(target))),
            };
            // Components are redefined by name instead (see `prepare_instances`).
            matched && !doc.subtree(target).iter().any(|n| n.component)
        };
        if (in_component || keyed())
            && let Some(result) =
                rewrite_in_place(doc, target, &fragments, mode, in_component, new_id)?
        {
            return Ok(result);
        }
    }
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
    let mut fragments = fragments;
    let replaced: Vec<NodeId> = ops.iter().map(|op| op.id().to_owned()).collect();
    prepare_instances(doc, &mut fragments, Some(&parent), &replaced, new_id)?;
    room_for(doc, removed, adds(doc, &fragments))?;
    let roots = fragments
        .into_iter()
        .zip(indexes)
        .map(|(fragment, index)| fragment.create_ops(Some(&parent), index, None, new_id, &mut ops))
        .collect();
    Ok((ops, roots))
}

/// [`write_fragments`] as edits to the nodes already there where they
/// match, so their ids stay. A node matches a fragment written with its
/// data-id and tag, and text matches text in order. `by_name`, for content
/// inside a component: a node also matches a fragment with the same tag
/// and layer name, in order. Returns `None` when it can't, like replacing
/// the root with something else.
fn rewrite_in_place(
    doc: &Document,
    target: &str,
    fragments: &[Fragment],
    mode: WriteMode,
    by_name: bool,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<Option<(Vec<Op>, Vec<NodeId>)>> {
    let mut fragments = fragments.to_vec();
    let target_node = node(doc, target)?;
    let mut ops = Vec::new();
    let roots = match mode {
        WriteMode::Replace => {
            let [only] = fragments.as_slice() else {
                return Ok(None);
            };
            if !same_kind(target_node, only)
                || only.instance_of.is_some()
                || !(by_name || only.source.as_deref() == Some(target))
            {
                return Ok(None);
            }
            // Written with its own name, it's the component, not an instance of it.
            if target_node.component
                && fragments[0].component.as_deref() == Some(&target_node.display_name())
            {
                fragments[0].component = None;
            }
            if fragments[0].component.is_some() {
                return Ok(None);
            }
            prepare_instances(doc, &mut fragments[0].children, Some(target), &[], new_id)?;
            update_node(target_node, &fragments[0], true, &mut ops);
            reconcile(
                doc,
                target,
                &fragments[0].children,
                by_name,
                &mut ops,
                new_id,
            );
            vec![target.to_owned()]
        }
        WriteMode::ReplaceChildren => {
            element(doc, target)?;
            prepare_instances(doc, &mut fragments, Some(target), &[], new_id)?;
            reconcile(doc, target, &fragments, by_name, &mut ops, new_id)
        }
        WriteMode::Append => return Ok(None),
    };
    let depth = doc.depth(target) + 1;
    let height = fragments.iter().map(Fragment::height).max().unwrap_or(0);
    if depth + height > MAX_DEPTH {
        return err(format!(
            "that would nest {} levels deep; the limit is {MAX_DEPTH}",
            depth + height
        ));
    }
    room_for(doc, doc.subtree(target).len(), adds(doc, &fragments))?;
    Ok(Some((ops, roots)))
}

/// Whether `node` and `fragment` are the same kind of node with the same tag.
fn same_kind(node: &Node, fragment: &Fragment) -> bool {
    node.kind == fragment.kind && !node.is_instance()
}

/// Sets on `node` whatever differs from `fragment`. `root`: it's the node
/// being replaced, so its layer name stays unless the HTML gives one.
fn update_node(node: &Node, fragment: &Fragment, root: bool, ops: &mut Vec<Op>) {
    let set = |key: PropKey, value: Option<String>, ops: &mut Vec<Op>| {
        ops.push(Op::Set {
            id: node.id.clone(),
            key,
            value: value.map(Value::String),
        });
    };
    if node.name != fragment.name && !(root && fragment.name.is_none()) {
        set(PropKey::Name, fragment.name.clone(), ops);
    }
    if node.kind == NodeKind::Text && node.text != fragment.text {
        set(PropKey::Text, fragment.text.clone(), ops);
    }
    for (k, v) in &fragment.styles {
        if node.styles.get(k) != Some(v) {
            set(PropKey::Style(k.clone()), Some(v.clone()), ops);
        }
    }
    for k in node
        .styles
        .keys()
        .filter(|k| !fragment.styles.contains_key(*k))
    {
        set(PropKey::Style(k.clone()), None, ops);
    }
    for (k, v) in &fragment.attrs {
        if node.attrs.get(k) != Some(v) {
            set(PropKey::Attr(k.clone()), Some(v.clone()), ops);
        }
    }
    for k in node
        .attrs
        .keys()
        .filter(|k| !fragment.attrs.contains_key(*k))
    {
        set(PropKey::Attr(k.clone()), None, ops);
    }
}

/// Makes `parent`'s children `fragments`, reusing the children that match
/// one (see [`rewrite_in_place`]). Returns the ids of the children, reused or new.
fn reconcile(
    doc: &Document,
    parent: &str,
    fragments: &[Fragment],
    by_name: bool,
    ops: &mut Vec<Op>,
    new_id: &mut impl FnMut() -> NodeId,
) -> Vec<NodeId> {
    let old = doc.children(Some(parent));
    let mut used = vec![false; old.len()];
    let reusable =
        |n: &Node, f: &Fragment| same_kind(n, f) && f.instance_of.is_none() && !n.component;
    // By data-id first, wherever the child moved to.
    let position: HashMap<&str, usize> = old
        .iter()
        .enumerate()
        .map(|(j, n)| (n.id.as_str(), j))
        .collect();
    let mut matches: Vec<Option<usize>> = fragments
        .iter()
        .map(|f| {
            let j = *position.get(f.source.as_deref()?)?;
            (!used[j] && reusable(old[j], f)).then(|| {
                used[j] = true;
                j
            })
        })
        .collect();
    // Then in order: each fragment takes the first unused child after the
    // last match that fits, so an inserted element doesn't shift the rest
    // out of place.
    let mut cursor = 0;
    for (f, found) in fragments.iter().zip(&mut matches) {
        if let Some(j) = *found {
            cursor = j + 1;
            continue;
        }
        let fits = |n: &Node| {
            reusable(n, f) && (n.kind == NodeKind::Text || (by_name && n.name == f.name))
        };
        *found = (cursor..old.len()).find(|&j| !used[j] && fits(old[j]));
        if let Some(j) = *found {
            used[j] = true;
            cursor = j + 1;
        }
    }
    for (j, child) in old.iter().enumerate() {
        if !used[j] {
            ops.push(Op::Delete {
                id: child.id.clone(),
            });
        }
    }
    let indexes = keep_order(&old, &matches);
    let mut ids = Vec::new();
    for ((fragment, found), index) in fragments.iter().zip(matches).zip(indexes) {
        match found {
            Some(j) => {
                let child = old[j];
                if child.index != index {
                    ops.push(Op::Move {
                        id: child.id.clone(),
                        parent: Some(parent.to_owned()),
                        index,
                    });
                }
                update_node(child, fragment, false, ops);
                if child.kind != NodeKind::Text {
                    reconcile(doc, &child.id, &fragment.children, by_name, ops, new_id);
                }
                ids.push(child.id.clone());
            }
            None => {
                ids.push(
                    fragment
                        .clone()
                        .create_ops(Some(parent), index, None, new_id, ops),
                );
            }
        }
    }
    ids
}

/// The index for each fragment [`reconcile`] writes, where `matches` names
/// the old child each one reuses. The longest run of reused children still
/// in order keep their indexes, so only the ones that moved get a `Move`,
/// and the rest get indexes between their neighbours.
fn keep_order(old: &[&Node], matches: &[Option<usize>]) -> Vec<String> {
    // Longest strictly increasing run of old indexes, by patience sorting:
    // `tails[k]` ends the best run of length k + 1 found so far.
    let reused: Vec<(usize, &str)> = matches
        .iter()
        .enumerate()
        .filter_map(|(i, m)| m.map(|j| (i, old[j].index.as_str())))
        .collect();
    let mut tails: Vec<usize> = Vec::new();
    let mut prev: Vec<Option<usize>> = vec![None; reused.len()];
    for (r, &(_, index)) in reused.iter().enumerate() {
        let k = tails.partition_point(|&t| reused[t].1 < index);
        prev[r] = k.checked_sub(1).map(|k| tails[k]);
        if k == tails.len() {
            tails.push(r);
        } else {
            tails[k] = r;
        }
    }
    let mut kept: Vec<Option<&str>> = vec![None; matches.len()];
    let mut at = tails.last().copied();
    while let Some(r) = at {
        kept[reused[r].0] = Some(reused[r].1);
        at = prev[r];
    }
    let mut out = Vec::with_capacity(matches.len());
    let mut i = 0;
    while i < matches.len() {
        if let Some(index) = kept[i] {
            out.push(index.to_owned());
            i += 1;
            continue;
        }
        let start = i;
        while i < matches.len() && kept[i].is_none() {
            i += 1;
        }
        let low = start.checked_sub(1).and_then(|s| kept[s]);
        let high = kept.get(i).copied().flatten();
        out.extend(fractional::keys_between(low, high, i - start));
    }
    out
}

/// How many nodes writing `fragments` adds to the expanded design: an
/// instance adds what its component shows.
fn adds(doc: &Document, fragments: &[Fragment]) -> usize {
    fragments
        .iter()
        .map(|f| match &f.instance_of {
            Some(component) => components::expanded_size(doc, component),
            None => 1 + adds(doc, &f.children),
        })
        .sum()
}

/// Checks each instance in parsed HTML and turns what was written inside
/// it into its overrides. `parent` is where the HTML goes, and `replaced`
/// the nodes the write replaces.
///
/// An instance is an element with `data-instance-of`, or with
/// `data-component="Name"` when a component of that name exists or came
/// earlier in the same HTML. Otherwise `data-component` defines a new
/// component. One that replaces a component of the same name redefines
/// it: it keeps the component's id, and the ids of the nodes that match,
/// so its instances keep following it and keep their overrides.
///
/// Refuses an instance of something that isn't a component, one that would
/// contain itself, and content the component doesn't have, since an
/// instance can't hold content of its own.
pub fn prepare_instances(
    doc: &Document,
    fragments: &mut [Fragment],
    parent: Option<&str>,
    replaced: &[NodeId],
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<()> {
    let mut named = Named::default();
    for root in replaced {
        for node in doc.subtree(root).into_iter().filter(|n| n.component) {
            named.doomed.insert(node.id.clone());
            named
                .replaced
                .entry(node.display_name())
                .or_insert_with(|| node.id.clone());
        }
    }
    prepare(doc, fragments, parent, &mut named, new_id)
}

/// Components by name while preparing one write.
#[derive(Default)]
struct Named {
    /// Defined earlier in this HTML, with the ids they'll be created with.
    defined: std::collections::HashMap<String, Fragment>,
    /// In the document, inside what this write replaces.
    replaced: std::collections::HashMap<String, NodeId>,
    doomed: std::collections::HashSet<NodeId>,
}

fn prepare(
    doc: &Document,
    fragments: &mut [Fragment],
    parent: Option<&str>,
    named: &mut Named,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<()> {
    for fragment in fragments {
        // Children first, so nested components are instances by the time
        // their parent is compared with its component.
        if fragment.instance_of.is_none() {
            prepare(doc, &mut fragment.children, parent, named, new_id)?;
        }
        if let Some(component) = fragment.instance_of.clone() {
            let node = components::check_component(doc, &component)?;
            components::check_cycle(doc, &component, parent)?;
            let (overrides, left_out) = components::overrides_from_html(doc, &component, fragment);
            if left_out > 0 {
                return err(format!(
                    "the HTML for an instance of {:?} #{component} has {left_out} element{} the component doesn't have. \
                     An instance shows its component's content: elements inside it need the data-id get_html gave them. \
                     Add new content to the component, or write it outside the instance.",
                    node.display_name(),
                    if left_out == 1 { "" } else { "s" }
                ));
            }
            become_instance(fragment, component, node.kind.clone(), overrides);
            continue;
        }
        let Some(name) = fragment.component.clone() else {
            continue;
        };
        if let Some(definition) = named.defined.get(&name) {
            let mut overrides = Overrides::new();
            if !fragment.children.is_empty() {
                differences(definition, fragment, "", &mut overrides)
                    .map_err(|why| mismatch(&name, None, &why))?;
            } else {
                root_additions(definition, fragment, &mut overrides);
            }
            let id = definition.id.clone().expect("a definition has its id");
            become_instance(fragment, id, definition.kind.clone(), overrides);
            continue;
        }
        if let Some(old) = named.replaced.remove(&name) {
            reuse_ids(doc, &old, fragment, new_id);
            fragment.name.get_or_insert_with(|| name.clone());
            named.defined.insert(name, fragment.clone());
            continue;
        }
        let existing = doc
            .nodes()
            .filter(|n| n.component && !named.doomed.contains(&n.id) && n.display_name() == name)
            .min_by(|a, b| a.id.cmp(&b.id));
        if let Some(existing) = existing {
            let id = existing.id.clone();
            components::check_cycle(doc, &id, parent)?;
            let definition = preview_fragment(doc, &id);
            let mut overrides = Overrides::new();
            if !fragment.children.is_empty() {
                differences(&definition, fragment, "", &mut overrides)
                    .map_err(|why| mismatch(&name, Some(&id), &why))?;
            } else {
                root_additions(&definition, fragment, &mut overrides);
            }
            become_instance(fragment, id, existing.kind.clone(), overrides);
            continue;
        }
        assign_ids(fragment, new_id);
        fragment.name.get_or_insert_with(|| name.clone());
        named.defined.insert(name, fragment.clone());
    }
    Ok(())
}

fn mismatch(name: &str, id: Option<&str>, why: &str) -> EditError {
    let at = id.map_or_else(
        || " where it's first written".to_owned(),
        |id| format!(" (#{id})"),
    );
    EditError(format!(
        "this data-component={name:?} isn't built like the component{at}: {why}. \
         An instance can change text, styles and attributes, not its elements. \
         Write the same elements, give it another name, or change the component itself in place, which changes every instance."
    ))
}

/// Makes `fragment` an instance of `component` showing `overrides`.
fn become_instance(
    fragment: &mut Fragment,
    component: NodeId,
    kind: NodeKind,
    overrides: Overrides,
) {
    fragment.kind = kind;
    fragment.instance_of = Some(component);
    fragment.overrides = overrides;
    fragment.component = None;
    fragment.styles.clear();
    fragment.attrs.clear();
    fragment.text = None;
    fragment.children.clear();
}

/// Gives every node of `fragment` the id it'll be created with.
fn assign_ids(fragment: &mut Fragment, new_id: &mut impl FnMut() -> NodeId) {
    fragment.id.get_or_insert_with(&mut *new_id);
    for child in &mut fragment.children {
        assign_ids(child, new_id);
    }
}

/// [`assign_ids`], reusing the ids of `old`'s subtree where a node has the
/// same tag and layer name, in order, as [`reconcile`] matches them.
fn reuse_ids(
    doc: &Document,
    old: &str,
    fragment: &mut Fragment,
    new_id: &mut impl FnMut() -> NodeId,
) {
    fragment.id = Some(old.to_owned());
    let children = doc.children(Some(old));
    let mut cursor = 0;
    for child in &mut fragment.children {
        let found = (cursor..children.len()).find(|&j| {
            let n = children[j];
            n.kind == child.kind
                && !n.is_instance()
                && child.instance_of.is_none()
                && (n.kind == NodeKind::Text || n.name == child.name)
        });
        match found {
            Some(j) => {
                cursor = j + 1;
                reuse_ids(doc, &children[j].id, child, new_id);
            }
            None => assign_ids(child, new_id),
        }
    }
}

/// What a new instance of component `id` shows, as a fragment whose ids are
/// the paths an override names (`x`, or `n/x` inside nested instance `n`).
fn preview_fragment(doc: &Document, id: &str) -> Fragment {
    let nodes = components::preview(doc, id);
    let mut children: std::collections::HashMap<&str, Vec<usize>> = Default::default();
    for (i, n) in nodes.iter().enumerate() {
        if let Some(p) = &n.parent {
            children.entry(p.as_str()).or_default().push(i);
        }
    }
    fn build(
        nodes: &[Node],
        children: &std::collections::HashMap<&str, Vec<usize>>,
        i: usize,
    ) -> Fragment {
        let n = &nodes[i];
        let path = n.id.strip_prefix("_/").unwrap_or("").to_owned();
        Fragment {
            name: n.name.clone(),
            text: n.text.clone(),
            styles: n.styles.clone(),
            attrs: n.attrs.clone(),
            instance_of: n.instance_of.clone().filter(|_| i > 0),
            id: Some(path),
            children: children
                .get(n.id.as_str())
                .into_iter()
                .flatten()
                .map(|&c| build(nodes, children, c))
                .collect(),
            ..Fragment::empty(n.kind.clone())
        }
    }
    if nodes.is_empty() {
        return Fragment::empty(NodeKind::Element { tag: "div".into() });
    }
    build(&nodes, &children, 0)
}

/// For an instance written without content: the styles and attributes on
/// its own element that differ from the component's root.
fn root_additions(definition: &Fragment, fragment: &Fragment, out: &mut Overrides) {
    for (k, v) in &fragment.styles {
        if definition.styles.get(k) != Some(v) {
            out.insert(PropKey::Style(k.clone()).to_string(), Some(v.clone()));
        }
    }
    for (k, v) in &fragment.attrs {
        if definition.attrs.get(k) != Some(v) {
            out.insert(PropKey::Attr(k.clone()).to_string(), Some(v.clone()));
        }
    }
}

/// The overrides that make an instance of `definition` look like `copy`,
/// node by node, in order, with keys under `path`. Fails, saying where, if
/// they aren't built the same way.
fn differences(
    definition: &Fragment,
    copy: &Fragment,
    path: &str,
    out: &mut Overrides,
) -> std::result::Result<(), String> {
    let describe = |f: &Fragment| match &f.kind {
        NodeKind::Element { tag } => format!("<{tag}>"),
        NodeKind::Text => "text".to_owned(),
    };
    let key = |prop: PropKey| PropKey::override_key(path, &prop);
    if definition.kind != copy.kind {
        return Err(format!(
            "it has {} where the component has {}",
            describe(copy),
            describe(definition)
        ));
    }
    if let Some(component) = &definition.instance_of {
        if copy.instance_of.as_ref() == Some(component) {
            for (k, v) in &copy.overrides {
                let k = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}/{k}")
                };
                out.insert(k, v.clone());
            }
            return Ok(());
        }
        if definition.children.is_empty() {
            return Err(format!(
                "it has a plain {} where the component has an instance of another component",
                describe(copy)
            ));
        }
    }
    if copy.kind == NodeKind::Text {
        if definition.text != copy.text {
            out.insert(key(PropKey::Text), copy.text.clone());
        }
        return Ok(());
    }
    for (k, v) in &copy.styles {
        if definition.styles.get(k) != Some(v) {
            out.insert(key(PropKey::Style(k.clone())), Some(v.clone()));
        }
    }
    for k in definition
        .styles
        .keys()
        .filter(|k| !copy.styles.contains_key(*k))
    {
        out.insert(key(PropKey::Style(k.clone())), None);
    }
    for (k, v) in &copy.attrs {
        if definition.attrs.get(k) != Some(v) {
            out.insert(key(PropKey::Attr(k.clone())), Some(v.clone()));
        }
    }
    for k in definition
        .attrs
        .keys()
        .filter(|k| !copy.attrs.contains_key(*k))
    {
        out.insert(key(PropKey::Attr(k.clone())), None);
    }
    if definition.children.len() != copy.children.len() {
        return Err(format!(
            "a {} in it has {} children where the component's has {}",
            describe(copy),
            copy.children.len(),
            definition.children.len()
        ));
    }
    for (d, c) in definition.children.iter().zip(&copy.children) {
        let child = d.id.as_deref().unwrap_or("");
        differences(d, c, child, out)?;
    }
    Ok(())
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
pub(crate) fn longhands(shorthand: &str) -> &'static [&'static str] {
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

/// How one token changes in [`set_tokens`].
#[derive(Clone, Debug, PartialEq)]
pub enum TokenChange {
    /// One value in every mode.
    All(String),
    /// Values by mode name or id. `None` removes that mode's value, so it
    /// falls back to the first mode's.
    Modes(BTreeMap<String, Option<String>>),
    /// Deletes the token.
    Delete,
}

/// A design's modes as `(id, name)`, in order.
pub type ModeList = Vec<(String, String)>;

/// A design's modes as `(id, name)`, in order, for [`set_tokens`].
pub fn mode_list(doc: &Document) -> ModeList {
    doc.modes()
        .into_iter()
        .map(|(id, mode)| (id.to_owned(), mode.name.clone()))
        .collect()
}

/// Names the design's modes in order. The first name renames the first
/// mode, and so on, and names past the last mode add modes. It never
/// deletes a mode. Returns the ops and the modes as they'll be, as
/// [`mode_list`] gives them.
pub fn set_modes(
    doc: &Document,
    names: &[String],
    new_id: &mut impl FnMut() -> String,
) -> Result<(Vec<Op>, ModeList)> {
    let existing = doc.modes();
    if names.len() < existing.len() {
        return err(format!(
            "the design has {} modes ({}); name each of them, in order. Modes aren't deleted here.",
            existing.len(),
            existing
                .iter()
                .map(|(_, m)| m.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if names.len() > MAX_MODES {
        return err(format!("a design can have at most {MAX_MODES} modes"));
    }
    let mut seen = std::collections::HashSet::new();
    let mut ops = Vec::new();
    let mut list = Vec::new();
    let mut last = None;
    for (at, name) in names.iter().enumerate() {
        let name = label::clip(name.trim(), label::LAYER_NAME);
        if name.is_empty() {
            return err("give every mode a name");
        }
        if !seen.insert(name.to_lowercase()) {
            return err(format!("two modes are named {name:?}"));
        }
        let (id, index) = match existing.get(at) {
            Some((id, mode)) => ((*id).to_owned(), mode.index.clone()),
            None => (new_id(), fractional::key_between(last.as_deref(), None)),
        };
        last = Some(index.clone());
        ops.push(Op::Mode {
            id: id.clone(),
            mode: Some(Mode {
                name: name.clone(),
                index,
            }),
        });
        list.push((id, name));
    }
    Ok((ops, list))
}

/// Renames one mode.
pub fn rename_mode(doc: &Document, id: &str, name: &str) -> Result<Vec<Op>> {
    let names: Vec<String> = doc
        .modes()
        .into_iter()
        .map(|(mode, m)| {
            if mode == id {
                name.to_owned()
            } else {
                m.name.clone()
            }
        })
        .collect();
    if !doc.modes().iter().any(|(mode, _)| *mode == id) {
        return err(format!("mode {id:?} not found"));
    }
    Ok(set_modes(doc, &names, &mut || unreachable!("renaming adds no modes"))?.0)
}

/// Deletes a mode and every token value in it. Artboards in it fall back
/// to the first mode. A design keeps at least one mode.
pub fn delete_mode(doc: &Document, id: &str) -> Result<Vec<Op>> {
    let modes = doc.modes();
    if !modes.iter().any(|(mode, _)| *mode == id) {
        return err(format!("mode {id:?} not found"));
    }
    if modes.len() == 1 {
        return err("that's the design's only mode, and a design keeps at least one");
    }
    let mut ops: Vec<Op> = doc
        .tokens()
        .iter()
        .filter(|(_, values)| values.contains_key(id))
        .map(|(name, _)| Op::Token {
            name: name.clone(),
            mode_id: id.to_owned(),
            value: None,
        })
        .collect();
    ops.push(Op::Mode {
        id: id.to_owned(),
        mode: None,
    });
    Ok(ops)
}

/// Sets, changes or deletes tokens. `modes` is the design's modes as they
/// are, or as [`set_modes`] leaves them in the same edit. A mode key is a
/// mode's name, in any case, or its id.
pub fn set_tokens(
    doc: &Document,
    modes: &[(String, String)],
    changes: &[(String, TokenChange)],
) -> Result<Vec<Op>> {
    let first = &modes.first().expect("a design has a mode").0;
    let mode_id = |key: &str| {
        modes
            .iter()
            .find(|(id, name)| id == key || name.eq_ignore_ascii_case(key))
            .map(|(id, _)| id.clone())
            .ok_or_else(|| {
                let names: Vec<&str> = modes.iter().map(|(_, n)| n.as_str()).collect();
                EditError(format!(
                    "the design has no mode {key:?}; its modes are {}. Pass modes to add one.",
                    names.join(", ")
                ))
            })
    };
    let check = |name: &str, value: &str| {
        tokens::check_value(value.trim()).map_err(|why| EditError(format!("{name}: {why}")))
    };
    // What each token holds after the changes so far, so a name that comes
    // twice builds on its first change.
    let mut planned: BTreeMap<&str, Option<Values>> = BTreeMap::new();
    for (name, change) in changes {
        tokens::check_name(name).map_err(EditError)?;
        let existing = match planned.get(name.as_str()) {
            Some(values) => values.clone(),
            None => doc.tokens().get(name).cloned(),
        };
        let values = match change {
            TokenChange::Delete => None,
            TokenChange::All(value) => {
                check(name, value)?;
                Some(Values::from([(first.clone(), value.trim().to_owned())]))
            }
            TokenChange::Modes(by_mode) => {
                let mut values = existing.clone().unwrap_or_default();
                for (key, value) in by_mode {
                    let id = mode_id(key)?;
                    match value {
                        Some(value) => {
                            check(name, value)?;
                            values.insert(id, value.trim().to_owned());
                        }
                        None => {
                            values.remove(&id);
                        }
                    }
                }
                (!values.is_empty()).then_some(values)
            }
        };
        planned.insert(name, values);
    }
    // One op per mode that ends up different, so undo reverses only those.
    // Removals go first, so a token deleted in the same edit frees its
    // place before a new one takes it.
    let none = Values::new();
    let mut ops = Vec::new();
    for (name, values) in &planned {
        let old = doc.tokens().get(*name).unwrap_or(&none);
        let new = values.as_ref().unwrap_or(&none);
        let modes: std::collections::BTreeSet<&String> = old.keys().chain(new.keys()).collect();
        for mode in modes {
            if old.get(mode) != new.get(mode) {
                ops.push(Op::Token {
                    name: (*name).to_owned(),
                    mode_id: mode.clone(),
                    value: new.get(mode).cloned(),
                });
            }
        }
    }
    ops.sort_by_key(|op| matches!(op, Op::Token { value: Some(_), .. }));
    let added = planned
        .iter()
        .filter(|(name, values)| values.is_some() && !doc.tokens().contains_key(**name))
        .count();
    if doc.tokens().len() + added > tokens::MAX_TOKENS {
        return err(format!(
            "a design can have at most {} tokens",
            tokens::MAX_TOKENS
        ));
    }
    Ok(ops)
}

/// What an artboard's `mode` should hold for the mode named `key` (or
/// with that id): its id, or `None` for a design without saved modes,
/// which keeps every artboard in its implicit one.
pub fn artboard_mode(doc: &Document, key: &str) -> Result<Option<String>> {
    let id = doc
        .modes()
        .into_iter()
        .find(|(id, m)| *id == key || m.name.eq_ignore_ascii_case(key))
        .map(|(id, _)| id.to_owned())
        .ok_or_else(|| {
            let names: Vec<String> = mode_list(doc).into_iter().map(|(_, n)| n).collect();
            EditError(format!(
                "the design has no mode {key:?}; its modes are {}",
                names.join(", ")
            ))
        })?;
    Ok((!doc.mode_map().is_empty()).then_some(id))
}

/// Sets the mode artboards render in, by the mode's name or id, or puts
/// them back in the first mode when `mode` is `None`.
pub fn set_artboard_mode(doc: &Document, ids: &[NodeId], mode: Option<&str>) -> Result<Vec<Op>> {
    let mode = match mode {
        Some(key) => artboard_mode(doc, key)?,
        None => None,
    };
    let mut ops = Vec::new();
    for id in ids {
        if !node(doc, id)?.is_artboard() {
            return err(format!(
                "node {id:?} isn't an artboard; modes are set on artboards"
            ));
        }
        ops.push(Op::Set {
            id: id.clone(),
            key: PropKey::Mode,
            value: mode.clone().map(Value::from),
        });
    }
    Ok(ops)
}

/// Moves a design's old shared CSS into tokens (see [`tokens::migrate`]).
/// What isn't a token goes in a `<style>` at the start of every artboard,
/// in the cascade layer the shared CSS had, so each artboard looks as it
/// did, and so do custom properties past [`tokens::MAX_TOKENS`]. Then the
/// old stylesheet is cleared.
pub fn migrate_css(doc: &Document, new_id: &mut impl FnMut() -> NodeId) -> Result<Vec<Op>> {
    let Some(css) = doc.css() else {
        return Ok(Vec::new());
    };
    let room = tokens::MAX_TOKENS.saturating_sub(doc.tokens().len());
    let migrated = tokens::migrate(css, room);
    let first = doc.first_mode().to_owned();
    let mut ops: Vec<Op> = migrated
        .tokens
        .into_iter()
        .map(|(name, value)| Op::Token {
            name,
            mode_id: first.clone(),
            value: Some(value),
        })
        .collect();
    if let Some(rest) = migrated.rest {
        let style = format!("<style>{}</style>", html::layered_style(&rest));
        for board in doc.artboards() {
            if board.is_instance() || board.kind == NodeKind::Text {
                continue;
            }
            let (written, _) =
                write_html(doc, &board.id, &style, WriteMode::Append, Some(0), new_id)?;
            ops.extend(written);
        }
    }
    ops.push(Op::Css { css: None });
    Ok(ops)
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
    check_move(doc, ids, parent)?;
    let ids = top_level(doc, ids);
    let indexes = doc.insertion_indexes(parent, index, ids.len());
    move_to(doc, ids, parent, indexes)
}

/// Moves nodes under `parent`, right before its child `before` (at the end
/// when `None`, or when `before` isn't one of its children any more),
/// keeping their relative order. Naming a sibling instead of a position
/// means a sibling another actor adds meanwhile can't shift where they land.
pub fn move_before(
    doc: &Document,
    ids: &[NodeId],
    parent: Option<&str>,
    before: Option<&str>,
) -> Result<Vec<Op>> {
    check_move(doc, ids, parent)?;
    let ids = top_level(doc, ids);
    // The moved nodes leave their places first, so they never anchor themselves.
    let siblings: Vec<&Node> = doc
        .children(parent)
        .into_iter()
        .filter(|n| !ids.iter().any(|id| **id == n.id))
        .collect();
    let at = before
        .and_then(|b| siblings.iter().position(|n| n.id == b))
        .unwrap_or(siblings.len());
    let prev = at.checked_sub(1).map(|i| siblings[i].index.as_str());
    let next = siblings.get(at).map(|n| n.index.as_str());
    let indexes = fractional::keys_between(prev, next, ids.len());
    move_to(doc, ids, parent, indexes)
}

/// Refuses a move of `ids` under `parent` that would make a cycle, pass
/// the depth limit or put an instance inside its own component.
fn check_move(doc: &Document, ids: &[NodeId], parent: Option<&str>) -> Result<()> {
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
        // An instance can't end up inside the component it shows.
        if doc.has_instances() {
            for inner in doc.subtree(id) {
                if let Some(component) = &inner.instance_of {
                    components::check_cycle(doc, component, parent)?;
                }
            }
        }
    }
    Ok(())
}

/// The ops that move each of `ids` under `parent` at its index in `indexes`.
fn move_to(
    doc: &Document,
    ids: Vec<&NodeId>,
    parent: Option<&str>,
    indexes: Vec<String>,
) -> Result<Vec<Op>> {
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

/// Wraps sibling nodes in a new `<div>` named "Group", where the first of
/// them was, keeping their order. Returns the ops and the group's id.
pub fn group(
    doc: &Document,
    ids: &[NodeId],
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<(Vec<Op>, NodeId)> {
    let ids = top_level(doc, ids);
    let Some(first) = ids.first() else {
        return err("name the nodes to group");
    };
    let parent = node(doc, first)?.parent.clone();
    let Some(parent) = parent else {
        return err("artboards can't be grouped; group what's inside one");
    };
    for id in &ids {
        if node(doc, id)?.parent.as_deref() != Some(parent.as_str()) {
            return err("only nodes with the same parent can be grouped");
        }
        let depth = doc.depth(&parent) + 2 + doc.height(id);
        if depth > MAX_DEPTH {
            return err(format!(
                "grouping {id:?} would nest {depth} levels deep; the limit is {MAX_DEPTH}"
            ));
        }
    }
    room_for(doc, 0, 1)?;
    // In sibling order, so the group keeps them as they were.
    let siblings = doc.children(Some(&parent));
    let members: Vec<&Node> = siblings
        .iter()
        .copied()
        .filter(|n| ids.iter().any(|id| **id == n.id))
        .collect();
    let at = siblings
        .iter()
        .position(|n| n.id == members[0].id)
        .expect("a member is a child");
    let prev = at.checked_sub(1).map(|i| siblings[i].index.as_str());
    let id = new_id();
    let mut ops = vec![Op::Create {
        node: Node {
            parent: Some(parent.clone()),
            index: fractional::key_between(prev, Some(&members[0].index)),
            name: Some("Group".into()),
            ..Node::element(id.clone(), "div")
        },
    }];
    let indexes = fractional::keys_between(None, None, members.len());
    for (member, index) in members.iter().zip(indexes) {
        ops.push(Op::Move {
            id: member.id.clone(),
            parent: Some(id.clone()),
            index,
        });
    }
    Ok((ops, id))
}

/// Takes the children out of each node in `ids`, into its parent where it
/// was, and deletes it.
pub fn ungroup(doc: &Document, ids: &[NodeId]) -> Result<Vec<Op>> {
    let mut ops = Vec::new();
    for id in top_level(doc, ids) {
        let group = element(doc, id)?;
        let Some(parent) = group.parent.clone() else {
            return err(format!(
                "{id:?} is an artboard; only a group inside one can be ungrouped"
            ));
        };
        if group.is_instance() {
            return err(format!(
                "{id:?} is an instance; detach it before ungrouping it"
            ));
        }
        let children = doc.children(Some(id));
        let next = doc.next_sibling(id).map(|n| n.index.as_str());
        let indexes = fractional::keys_between(Some(&group.index), next, children.len());
        for (child, index) in children.iter().zip(indexes) {
            ops.push(Op::Move {
                id: child.id.clone(),
                parent: Some(parent.clone()),
                index,
            });
        }
        ops.push(Op::Delete { id: id.clone() });
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

/// Makes the element `id` a component, named `name` if given, and replaces
/// each of `replace` with an instance of it, in place. A replaced node
/// keeps its id, and its differences from the component become the
/// instance's overrides, so nothing it showed changes. It has to be built
/// the same way as the component, element for element.
pub fn create_component(
    doc: &Document,
    id: &str,
    name: Option<&str>,
    replace: &[NodeId],
) -> Result<Vec<Op>> {
    if components::is_virtual(id) {
        return err(format!(
            "#{id} is inside an instance; make a component from the component's own nodes, or detach_instance first"
        ));
    }
    let node = element(doc, id)?;
    if node.is_instance() {
        return err(format!(
            "#{id} is already an instance of component #{}",
            node.instance_of.as_deref().unwrap_or("")
        ));
    }
    let mut ops = Vec::new();
    if !node.component {
        ops.push(Op::Set {
            id: id.to_owned(),
            key: PropKey::Component,
            value: Some(Value::Bool(true)),
        });
    }
    if let Some(name) = name {
        ops.extend(rename(doc, id, Some(name))?);
    }
    let mut scratch = doc.clone();
    scratch.apply_all(&ops);
    for other in top_level(doc, replace) {
        let target = node_or_virtual(doc, other)?;
        if other == id || doc.is_ancestor(id, other) || doc.is_ancestor(other, id) {
            return err(format!(
                "#{other} can't be replaced by an instance of #{id}: one is inside the other"
            ));
        }
        if target.is_artboard() {
            return err(format!(
                "#{other} is an artboard; replace its content instead"
            ));
        }
        let overrides = components::overrides_to_match(&scratch, id, other).map_err(|why| {
            EditError(format!(
                "#{other} isn't built like #{id}, so it can't become an instance of it without losing something: {why}. \
                 Make it match first, or leave it out and replace it with insert_instance."
            ))
        })?;
        components::check_cycle(&scratch, id, target.parent.as_deref())?;
        let instance = Node {
            parent: target.parent.clone(),
            index: target.index.clone(),
            name: target
                .name
                .clone()
                .filter(|n| Some(n) != node.name.as_ref()),
            instance_of: Some(id.to_owned()),
            overrides,
            ..Node::element(other.clone(), node.tag().unwrap_or("div"))
        };
        let step = [
            Op::Delete { id: other.clone() },
            Op::Create { node: instance },
        ];
        scratch.apply_all(&step);
        ops.extend(step);
    }
    Ok(ops)
}

fn node_or_virtual<'a>(doc: &'a Document, id: &str) -> Result<&'a Node> {
    if components::is_virtual(id) {
        return err(format!("#{id} is inside an instance"));
    }
    node(doc, id)
}

/// Values for a new instance to show, for one node of its component.
#[derive(Clone, Debug, Default)]
pub struct InstanceValues {
    /// The node of the component: its id, or for a node inside a nested
    /// instance, the path to it (`n/x`). The component's own id, or
    /// `None`, is the instance's root.
    pub node_id: Option<String>,
    pub text: Option<String>,
    pub styles: BTreeMap<String, Option<String>>,
    pub attributes: BTreeMap<String, Option<String>>,
}

/// Puts a new instance of `component` under `parent`, at `index` or last,
/// showing `values` where it should differ. Returns the ops and its id.
pub fn insert_instance(
    doc: &Document,
    component: &str,
    parent: &str,
    index: Option<usize>,
    name: Option<&str>,
    values: &[InstanceValues],
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<(Vec<Op>, NodeId)> {
    let comp = components::check_component(doc, component)?;
    if components::is_virtual(parent) {
        return err(format!(
            "#{parent} is inside an instance, which can't hold content of its own; put the instance in the component instead"
        ));
    }
    let target = element(doc, parent)?;
    if target.is_instance() {
        return err(format!(
            "#{parent} is an instance, which can't hold content of its own"
        ));
    }
    components::check_cycle(doc, component, Some(parent))?;
    let depth = doc.depth(parent) + 1 + doc.height(component);
    if depth > MAX_DEPTH {
        return err(format!(
            "that would nest {depth} levels deep; the limit is {MAX_DEPTH}"
        ));
    }
    room_for(doc, 0, components::expanded_size(doc, component))?;
    let overrides = instance_overrides(doc, component, values)?;
    let id = new_id();
    let index = doc.insertion_indexes(Some(parent), index, 1).remove(0);
    let node = Node {
        parent: Some(parent.to_owned()),
        index,
        name: name.map(|n| label::clip(n, label::LAYER_NAME)),
        instance_of: Some(component.to_owned()),
        overrides,
        ..Node::element(id.clone(), comp.tag().unwrap_or("div"))
    };
    Ok((vec![Op::Create { node }], id))
}

/// `values` as override keys, checked against what the component shows.
fn instance_overrides(
    doc: &Document,
    component: &str,
    values: &[InstanceValues],
) -> Result<Overrides> {
    let preview = components::preview(doc, component);
    let by_id: std::collections::HashMap<&str, &Node> =
        preview.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut overrides = Overrides::new();
    for v in values {
        // `I/x` from get_html names component node `x` too.
        let wanted = v.node_id.as_deref().filter(|id| *id != component);
        let path = match wanted {
            None => String::new(),
            Some(id) => {
                let candidates = [Some(id), components::split(id).map(|(_, rest)| rest)];
                candidates
                    .into_iter()
                    .flatten()
                    .find(|p| by_id.contains_key(format!("_/{p}").as_str()))
                    .map(str::to_owned)
                    .ok_or_else(|| {
                        EditError(format!(
                            "component #{component} has no node {id:?}; use the ids get_html shows for it"
                        ))
                    })?
            }
        };
        let vid = if path.is_empty() {
            "_".to_owned()
        } else {
            format!("_/{path}")
        };
        let shown = by_id[vid.as_str()];
        let mut put = |path: &str, prop: PropKey, value: Option<String>| {
            overrides.insert(PropKey::override_key(path, &prop), value);
        };
        if let Some(text) = &v.text {
            let children: Vec<&Node> = preview
                .iter()
                .filter(|n| n.parent.as_deref() == Some(vid.as_str()))
                .collect();
            match (shown.kind == NodeKind::Text, children.as_slice()) {
                (true, _) => put(&path, PropKey::Text, Some(text.clone())),
                (false, [only]) if only.kind == NodeKind::Text => {
                    put(&only.id[2..], PropKey::Text, Some(text.clone()));
                }
                _ => {
                    return err(format!(
                        "#{} in the component doesn't hold just text, so an instance can't set its text; set the text of the text node or element inside it",
                        if path.is_empty() { component } else { &path }
                    ));
                }
            }
        }
        for (name, value) in &v.styles {
            put(
                &path,
                PropKey::Style(normalize_style_name(name)),
                value.as_ref().map(|v| v.trim().to_owned()),
            );
        }
        for (name, value) in &v.attributes {
            if let Some(value) = value
                && !html::is_safe_attr(name, value)
            {
                return err(format!("{name}={value:?} isn't allowed"));
            }
            if !html::is_attr_name(name) || name.eq_ignore_ascii_case("style") {
                return err(format!("{name:?} isn't an attribute an instance can set"));
            }
            put(&path, PropKey::Attr(name.clone()), value.clone());
        }
    }
    Ok(overrides)
}

/// Turns instances into plain copies of what they show, as one change.
pub fn detach_instances(
    doc: &Document,
    ids: &[NodeId],
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<Vec<Op>> {
    let mut ops = Vec::new();
    for id in ids {
        if components::is_virtual(id) {
            let (root, _) = components::split(id).expect("a virtual id has a root");
            return err(format!(
                "#{id} is inside instance #{root}; detach #{root}, or the nested instance from the component it's in"
            ));
        }
        ops.extend(components::detach(doc, id, new_id)?);
    }
    Ok(ops)
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
