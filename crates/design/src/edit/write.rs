//! Writing HTML into a design: parsing it, matching it to what is there and turning the difference into ops.

use std::collections::HashMap;

use serde_json::Value;

use crate::{
    components::{self, Overrides},
    document::{Document, MAX_DEPTH, Op},
    fractional,
    html::{self, Fragment},
    node::{Node, NodeId, NodeKind, PropKey},
};

use super::{EditError, Result, element, err, node, room_for};

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
                return err("can't replace an artboard; use mode \"inner\" instead");
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
pub(super) fn adds(doc: &Document, fragments: &[Fragment]) -> usize {
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
pub(crate) fn prepare_instances(
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
                     An instance shows its component's content: elements inside it need the data-id read with as: \"html\" gave them. \
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::{support::*, *};

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
}
