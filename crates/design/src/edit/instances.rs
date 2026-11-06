//! Components and their instances.

use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

use crate::{
    components::{self, Overrides},
    document::{Document, MAX_DEPTH, Op},
    html::{self},
    label,
    node::{Node, NodeId, NodeKind, PropKey},
};

use super::normalize_style_name;
use super::rename;
use super::{EditError, Result, element, err, node, room_for};
use super::{duplicate, top_level};

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
        let instance = components::split(id).map_or(id, |(root, _)| root);
        return err(format!(
            "#{id} is inside an instance; make a component from the component's own nodes, or detach the instance first with {{\"op\": \"component\", \"select\": \"#{instance}\", \"detach\": true}}"
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
                 Make it match first, or leave it out and write an instance in its place: <div data-instance-of=\"{id}\"></div>."
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
        // `I/x` from `read` names component node `x` too.
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
                            "component #{component} has no node {id:?}; use the ids read with as: \"html\" shows for it"
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
                "#{id} is inside instance #{root}; detach #{root} with {{\"op\": \"component\", \"select\": \"#{root}\", \"detach\": true}}, or detach the nested instance from the component it's in"
            ));
        }
        ops.extend(components::detach(doc, id, new_id)?);
    }
    Ok(ops)
}

/// The instances at or below `roots`, roots included. An instance inside
/// another is skipped: it only exists while its outer instance shows it. So
/// is one inside a component's definition: the component is shared, and
/// rewriting its nodes would orphan the overrides of its instances
/// elsewhere. With `copies`, the roots are fresh copies, which nothing
/// follows yet, so a root that sits inside a definition still counts.
pub fn instances_in(doc: &Document, roots: &[NodeId], copies: bool) -> Vec<NodeId> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for root in roots {
        if !copies && components::component_of(doc, root).is_some() {
            continue;
        }
        let mut stack: Vec<&Node> = doc.get(root).into_iter().collect();
        while let Some(node) = stack.pop() {
            if node.component {
                continue;
            }
            if node.is_instance() && !components::is_virtual(&node.id) && seen.insert(&node.id) {
                out.push(node.id.clone());
            }
            stack.extend(doc.children(Some(&node.id)).into_iter().rev());
        }
    }
    out
}

/// Turns every instance at or below `roots` into plain elements, however
/// deep they nest: detaching one leaves the instances it held, and those
/// are detached in turn. Where [`detach_instances`] stops at the one
/// instance, this makes a frozen copy of a screen. `doc` is the real
/// document, not the expanded view: an expanded instance still has its
/// virtual children after it is detached, and the next round would copy
/// them along with the real ones.
pub fn detach_all(
    doc: &Document,
    roots: &[NodeId],
    copies: bool,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<Vec<Op>> {
    let mut ops = Vec::new();
    let mut staged: Option<Document> = None;
    loop {
        let current = staged.as_ref().unwrap_or(doc);
        let instances = instances_in(current, roots, copies);
        if instances.is_empty() {
            return Ok(ops);
        }
        let round = detach_instances(current, &instances, &mut *new_id)?;
        if detached_count(&round) == 0 {
            return err("instances couldn't be detached");
        }
        let nested = round
            .iter()
            .any(|op| matches!(op, Op::Create { node } if node.is_instance()));
        if nested {
            let mut next = current.clone();
            next.apply_all(&round);
            staged = Some(next);
        }
        ops.extend(round);
        if !nested {
            return Ok(ops);
        }
    }
}

/// How many instances `ops` turn into plain elements.
pub fn detached_count(ops: &[Op]) -> usize {
    ops.iter()
        .filter(|op| {
            matches!(
                op,
                Op::Set {
                    key: PropKey::InstanceOf,
                    value: None,
                    ..
                }
            )
        })
        .count()
}

/// [`duplicate`], then [`detach_all`] on the copies, so they keep what the
/// components show but no longer follow them.
pub fn duplicate_detached(
    doc: &Document,
    ids: &[NodeId],
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<(Vec<Op>, Vec<NodeId>)> {
    let (mut ops, roots) = duplicate(doc, ids, &mut *new_id)?;
    let follows = ids
        .iter()
        .flat_map(|id| doc.subtree(id))
        .any(|n| n.is_instance() || n.component);
    if follows {
        let mut copied = doc.clone();
        copied.apply_all(&ops);
        ops.extend(detach_all(&copied, &roots, true, new_id)?);
    }
    Ok((ops, roots))
}
