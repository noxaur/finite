//! Components and their instances: one definition, shown in many places.
//!
//! A **component** is an ordinary subtree whose root is marked
//! [`Node::component`]. It stays where it is and renders like any other
//! node, and editing it edits the definition.
//!
//! An **instance** is a node with [`Node::instance_of`] set. It has no
//! children of its own: it renders as its component, and stores only its
//! [`Node::overrides`], the values where it differs. So editing the
//! component changes every instance, except for the values an instance
//! overrides.
//!
//! Readers see instances **expanded**: [`expand`] returns the document with
//! every instance's content in place, as nodes with **virtual ids**. A node
//! of the component shows inside instance `I` as `I/<its id>`, and a node
//! of a component nested in it, through instance `n`, as `I/n/<its id>`.
//! Real ids never contain `/`. The path after the instance's id is what an
//! override names: `override:4biyjm26/text` on instance `I` changes the
//! text of `I/4biyjm26`. Overrides from further out win, so an instance can
//! override what a nested instance overrides.
//!
//! Edits run against the expanded document too, and [`redirect`] turns the
//! ops that touch virtual nodes into overrides on the real instance. Ops
//! that would change an instance's structure are refused with what to do
//! instead.

use std::{
    borrow::Cow,
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
};

use serde_json::Value;

use crate::{
    document::{Document, MAX_DEPTH, MAX_NODES, Op},
    edit::{EditError, longhands},
    html::Fragment,
    node::{Node, NodeId, NodeKind, PropKey},
};

/// Separates the parts of a virtual id.
pub const SEPARATOR: char = '/';

/// Values an instance changes, keyed as [`PropKey::Override`] keys are.
pub type Overrides = BTreeMap<String, Option<String>>;

/// Whether `id` is a node shown inside an instance rather than a real node.
pub fn is_virtual(id: &str) -> bool {
    id.contains(SEPARATOR)
}

/// The real instance a virtual id is shown in, and the path inside it.
pub fn split(id: &str) -> Option<(&str, &str)> {
    id.split_once(SEPARATOR)
}

/// The real node an id stands for: itself, or the instance it's shown in.
pub fn real_id(id: &str) -> &str {
    split(id).map_or(id, |(root, _)| root)
}

fn err<T>(message: impl Into<String>) -> Result<T, EditError> {
    Err(EditError(message.into()))
}

/// The document with every instance expanded, or the document itself when
/// it has none.
pub fn expand(doc: &Document) -> Cow<'_, Document> {
    if !doc.has_instances() {
        return Cow::Borrowed(doc);
    }
    let mut instances: Vec<&str> = doc
        .instance_lists()
        .flat_map(|(_, ids)| ids)
        .filter(|id| doc.contains(id))
        .collect();
    instances.sort_unstable();
    let mut expander = Expander::new(doc);
    for id in &instances {
        expander.real(id);
    }
    let replaced: HashSet<&str> = instances.into_iter().collect();
    let nodes = doc
        .nodes()
        .filter(|n| !replaced.contains(n.id.as_str()))
        .cloned()
        .chain(expander.out);
    // The design's tokens style instances like everything else.
    Cow::Owned(
        Document::from_nodes(nodes)
            .with_css(doc.css().map(str::to_owned))
            .with_pages(doc.page_map().clone())
            .with_tokens(doc.tokens().clone(), doc.mode_map().clone()),
    )
}

/// Instance `id` expanded: its root, as it renders, then the nodes inside
/// it, parents first and siblings in order. Empty if `id` isn't an instance.
pub fn expand_instance(doc: &Document, id: &str) -> Vec<Node> {
    if !doc.get(id).is_some_and(Node::is_instance) {
        return Vec::new();
    }
    let mut expander = Expander::new(doc);
    expander.real(id);
    expander.out
}

/// The component `id` belongs to: the closest component root at or above
/// it. For a virtual node, the one its real instance belongs to.
pub fn component_of<'a>(doc: &'a Document, id: &str) -> Option<&'a Node> {
    let mut node = doc.get(real_id(id))?;
    loop {
        if node.component {
            return Some(node);
        }
        node = doc.get(node.parent.as_deref()?)?;
    }
}

/// The instance a node is shown in, and its component, for a virtual id or
/// an instance's own id.
pub fn instance_of<'a>(doc: &'a Document, id: &str) -> Option<(&'a Node, Option<&'a Node>)> {
    let instance = doc.get(real_id(id)).filter(|n| n.is_instance())?;
    let component = instance.instance_of.as_deref().and_then(|c| doc.get(c));
    Some((instance, component))
}

/// The real instances whose expansion shows real node `id`: the instances
/// of every component it's in, and of every component those are in, and
/// so on. Includes `id` if it's an instance itself.
pub fn affected(doc: &Document, id: &str) -> BTreeSet<NodeId> {
    let mut out = BTreeSet::new();
    if !doc.has_instances() {
        return out;
    }
    let mut queue = vec![id.to_owned()];
    let mut seen = HashSet::new();
    while let Some(id) = queue.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        if doc.get(&id).is_some_and(Node::is_instance) {
            out.insert(id.clone());
        }
        // Every component above `id` shows it.
        let mut node = doc.get(&id);
        while let Some(n) = node {
            if n.component {
                for instance in doc.instances_of(&n.id) {
                    out.insert(instance.to_owned());
                    queue.push(instance.to_owned());
                }
            }
            node = n.parent.as_deref().and_then(|p| doc.get(p));
        }
    }
    out
}

/// The instances of components inside the subtree at `id`, other than
/// those inside the subtree too: what deleting it would leave without a
/// component.
pub fn orphaned_by(doc: &Document, id: &str) -> Vec<NodeId> {
    if !doc.has_instances() {
        return Vec::new();
    }
    let subtree: Vec<&Node> = doc.subtree(id);
    let inside: HashSet<&str> = subtree.iter().map(|n| n.id.as_str()).collect();
    let mut out = Vec::new();
    for node in subtree.iter().filter(|n| n.component) {
        for instance in doc.instances_of(&node.id) {
            if !inside.contains(instance) {
                out.push(instance.to_owned());
            }
        }
    }
    out
}

/// Whether `component`'s subtree shows `other` anywhere, through instances
/// of it or of components that do.
fn uses(doc: &Document, component: &str, other: &str) -> bool {
    let mut stack = vec![component.to_owned()];
    let mut seen = HashSet::new();
    while let Some(c) = stack.pop() {
        if c == other {
            return true;
        }
        if !seen.insert(c.clone()) {
            continue;
        }
        for node in doc.subtree(&c) {
            if let Some(inner) = &node.instance_of {
                stack.push(inner.clone());
            }
        }
    }
    false
}

/// Refuses an instance of `component` under `parent` when the component
/// would end up showing itself.
pub fn check_cycle(doc: &Document, component: &str, parent: Option<&str>) -> Result<(), EditError> {
    let mut node = parent.and_then(|p| doc.get(real_id(p)));
    while let Some(n) = node {
        if n.component && uses(doc, component, &n.id) {
            let name = doc
                .get(component)
                .map(Node::display_name)
                .unwrap_or_default();
            return err(format!(
                "an instance of {name:?} #{component} can't go inside {}, because the component would then contain itself",
                if n.id == component {
                    "the component itself".to_owned()
                } else {
                    format!("component {:?} #{}, which it shows", n.display_name(), n.id)
                }
            ));
        }
        node = n.parent.as_deref().and_then(|p| doc.get(p));
    }
    Ok(())
}

/// The component `id`, or why it isn't one.
pub fn check_component<'a>(doc: &'a Document, id: &str) -> Result<&'a Node, EditError> {
    match doc.get(id) {
        Some(node) if node.component => Ok(node),
        Some(node) if node.is_instance() => err(format!(
            "#{id} is an instance, not a component; its component is #{}",
            node.instance_of.as_deref().unwrap_or("")
        )),
        Some(_) => err(format!(
            "#{id} isn't a component; make it one with {{\"op\": \"component\", \"select\": \"#{id}\"}}"
        )),
        None => err(format!("component {id:?} not found")),
    }
}

/// How many nodes an instance of `component` adds to the expanded design.
pub fn expanded_size(doc: &Document, component: &str) -> usize {
    preview(doc, component).len()
}

/// What a new instance of `component` with no overrides shows, as
/// [`expand_instance`] would list it, with `_` as the instance's id.
pub fn preview(doc: &Document, component: &str) -> Vec<Node> {
    let probe = Node {
        instance_of: Some(component.to_owned()),
        ..Node::element("_", "div")
    };
    let mut expander = Expander::new(doc);
    expander.instance(&probe, "_".into(), None, Overrides::new(), 0);
    expander.out
}

/// Builds the nodes instances show.
struct Expander<'a> {
    doc: &'a Document,
    out: Vec<Node>,
    /// Components being expanded, so an instance inside its own component
    /// shows nothing instead of itself forever.
    stack: Vec<&'a str>,
    /// How many more nodes it may make. Instances nested in instances
    /// multiply, so this keeps a design from expanding without bound.
    budget: usize,
    /// For [`detach`]: the overrides each nested instance ends up with.
    frames: Option<HashMap<NodeId, Overrides>>,
}

impl<'a> Expander<'a> {
    fn new(doc: &'a Document) -> Self {
        Self {
            doc,
            out: Vec::new(),
            stack: Vec::new(),
            budget: MAX_NODES,
            frames: None,
        }
    }

    /// Expands real instance `id` where it is.
    fn real(&mut self, id: &str) {
        let doc = self.doc;
        let Some(node) = doc.get(id) else { return };
        let at = self.out.len();
        self.instance(
            node,
            id.to_owned(),
            node.parent.clone(),
            Overrides::new(),
            doc.depth(id),
        );
        // Its own overrides stay readable on its root.
        if let Some(root) = self.out.get_mut(at) {
            root.overrides = node.overrides.clone();
        }
    }

    /// Writes `node`, an instance, as virtual node `id` under `parent`:
    /// its component's root with the overrides applied, then the
    /// component's content. `outer` holds the overrides from instances
    /// further out, keyed relative to this one; they win over its own.
    fn instance(
        &mut self,
        node: &'a Node,
        id: String,
        parent: Option<NodeId>,
        outer: Overrides,
        depth: usize,
    ) {
        let doc = self.doc;
        let mut frame = node.overrides.clone();
        frame.extend(outer);
        let component = node
            .instance_of
            .as_deref()
            .and_then(|c| doc.get(c))
            .filter(|c| c.tag().is_some() && !self.stack.contains(&c.id.as_str()));
        let mut root = Node {
            id: id.clone(),
            parent,
            index: node.index.clone(),
            name: node.name.clone(),
            x: node.x,
            y: node.y,
            instance_of: node.instance_of.clone(),
            ..Node::element("", node.tag().unwrap_or("div"))
        };
        if let Some(component) = component {
            root.kind = component.kind.clone();
            root.name = root.name.or_else(|| component.name.clone());
            root.styles = component.styles.clone();
            root.attrs = component.attrs.clone();
        }
        // Styles set on the instance itself count as its own overrides.
        let own: Overrides = node
            .styles
            .iter()
            .map(|(k, v)| (PropKey::Style(k.clone()).to_string(), Some(v.clone())))
            .chain(
                node.attrs
                    .iter()
                    .map(|(k, v)| (PropKey::Attr(k.clone()).to_string(), Some(v.clone()))),
            )
            .collect();
        apply(&mut root, &own, "");
        apply(&mut root, &frame, "");
        if let Some(frames) = &mut self.frames {
            frames.insert(id.clone(), frame.clone());
        }
        self.out.push(root);
        let Some(component) = component else { return };
        self.stack.push(&component.id);
        for child in doc.children(Some(&component.id)) {
            self.node(child, &id, &id, &frame, depth + 1);
        }
        self.stack.pop();
    }

    /// Writes `node`, a node of a component, inside the instance whose
    /// virtual id is `prefix`, under virtual node `parent`.
    fn node(
        &mut self,
        node: &'a Node,
        prefix: &str,
        parent: &str,
        frame: &Overrides,
        depth: usize,
    ) {
        if depth > MAX_DEPTH || self.budget == 0 {
            return;
        }
        self.budget -= 1;
        let id = format!("{prefix}{SEPARATOR}{}", node.id);
        if node.is_instance() {
            let inner = within(frame, &node.id);
            self.instance(node, id, Some(parent.to_owned()), inner, depth);
            return;
        }
        let mut copy = Node {
            id: id.clone(),
            parent: Some(parent.to_owned()),
            component: false,
            instance_of: None,
            overrides: Overrides::new(),
            ..node.clone()
        };
        apply(&mut copy, frame, &node.id);
        self.out.push(copy);
        for child in self.doc.children(Some(&node.id)) {
            self.node(child, prefix, &id, frame, depth + 1);
        }
    }
}

/// The overrides in `frame` for what's inside nested instance `id`, keyed
/// relative to it.
fn within(frame: &Overrides, id: &str) -> Overrides {
    let prefix = format!("{id}{SEPARATOR}");
    frame
        .range(prefix.clone()..)
        .take_while(|(k, _)| k.starts_with(&prefix))
        .map(|(k, v)| (k[prefix.len()..].to_owned(), v.clone()))
        .collect()
}

/// The overrides in `frame` for the node at `path`, as properties.
fn props_at<'f>(frame: &'f Overrides, path: &str) -> Vec<(PropKey, &'f Option<String>)> {
    let entries: Box<dyn Iterator<Item = (&String, &Option<String>)>> = if path.is_empty() {
        Box::new(frame.iter())
    } else {
        let prefix = format!("{path}{SEPARATOR}");
        Box::new(
            frame
                .range(prefix.clone()..)
                .take_while(move |(k, _)| k.starts_with(&prefix)),
        )
    };
    entries
        .filter_map(|(k, v)| match PropKey::split_override(k) {
            Some((p, prop)) if p == path => Some((prop, v)),
            _ => None,
        })
        .collect()
}

/// Applies the overrides in `frame` for the node at `path` to `node`. A
/// shorthand clears the longhands it covers, as `update_styles` does.
fn apply(node: &mut Node, frame: &Overrides, path: &str) {
    let props = props_at(frame, path);
    if props.is_empty() {
        return;
    }
    let overridden: HashSet<&str> = props
        .iter()
        .filter_map(|(p, _)| match p {
            PropKey::Style(k) => Some(k.as_str()),
            _ => None,
        })
        .collect();
    for (prop, value) in &props {
        match prop {
            PropKey::Text if node.kind == NodeKind::Text => {
                node.text = Some(value.as_deref().unwrap_or_default().to_owned());
            }
            PropKey::Style(k) => match value {
                Some(v) => {
                    for longhand in longhands(k) {
                        if !overridden.contains(longhand) {
                            node.styles.remove(*longhand);
                        }
                    }
                    node.styles.insert(k.clone(), v.clone());
                }
                None => {
                    node.styles.remove(k);
                }
            },
            PropKey::Attr(k) => match value {
                Some(v) => {
                    node.attrs.insert(k.clone(), v.clone());
                }
                None => {
                    node.attrs.remove(k);
                }
            },
            _ => {}
        }
    }
}

/// A property's value on a node, as a string, or `None` when it's unset.
fn value_of(node: &Node, prop: &PropKey) -> Option<String> {
    match prop {
        PropKey::Text => node.text.clone(),
        PropKey::Style(k) => node.styles.get(k).cloned(),
        PropKey::Attr(k) => node.attrs.get(k).cloned(),
        _ => None,
    }
}

/// Explains why a node inside an instance can't change the way an op asked.
fn refuse_inside(doc: &Document, id: &str, what: &str) -> EditError {
    let (instance, component) = match instance_of(doc, id) {
        Some((i, c)) => (i.id.clone(), c),
        None => (real_id(id).to_owned(), None),
    };
    let (name, cid) = component.map_or((String::new(), String::new()), |c| {
        (format!(" {:?}", c.display_name()), c.id.clone())
    });
    EditError(format!(
        "#{id} is inside instance #{instance} of component{name}, so {what}. \
         Edit the component #{cid} to change every instance, change this one's text, styles or \
         attributes (they become overrides; display: none hides a part), or detach the instance first with {{\"op\": \"component\", \"select\": \"#{instance}\", \"detach\": true}}."
    ))
}

/// One value a change asks an instance to show: an override to work out.
struct Wanted {
    instance: NodeId,
    path: String,
    prop: PropKey,
    value: Option<String>,
}

/// Turns ops built against the expanded document into ops on the real one.
///
/// - Setting text, a style or an attribute on a node inside an instance,
///   or on an instance's root, sets an override on the instance instead. A
///   value equal to what the instance would show anyway clears the
///   override, so the instance goes back to following its component.
/// - Creating, deleting or moving nodes inside an instance is refused.
/// - Deleting a component first detaches its instances elsewhere, so they
///   keep what they showed.
pub fn redirect(
    doc: &Document,
    ops: Vec<Op>,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<Vec<Op>, EditError> {
    if !doc.has_instances() && !ops.iter().any(|op| is_virtual(op.id())) {
        return Ok(ops);
    }
    // A component this change deletes and creates again, like a screen
    // rewritten with it, keeps its instances.
    let recreated: HashSet<NodeId> = ops
        .iter()
        .filter_map(|op| match op {
            Op::Create { node } if node.component && doc.contains(&node.id) => {
                Some(node.id.clone())
            }
            _ => None,
        })
        .collect();
    let orphans = |doc: &Document, id: &str| -> Vec<NodeId> {
        orphaned_by(doc, id)
            .into_iter()
            .filter(|i| {
                doc.get(i)
                    .and_then(|n| n.instance_of.as_deref())
                    .is_none_or(|c| !recreated.contains(c))
            })
            .collect()
    };
    let mut plain = Vec::with_capacity(ops.len());
    let mut wanted = Vec::new();
    let mut detaching = false;
    // Instances this change turns into plain elements, like `detach` does,
    // can hold content after that.
    let mut plain_now: HashSet<NodeId> = HashSet::new();
    for op in ops {
        if let Op::Set {
            id,
            key: PropKey::InstanceOf,
            value: None,
        } = &op
        {
            plain_now.insert(id.clone());
        }
        let instance =
            |id: &str| doc.get(id).is_some_and(Node::is_instance) && !plain_now.contains(id);
        match &op {
            Op::Set { id, key, value } => {
                let target = is_virtual(id) || instance(id);
                match key {
                    PropKey::Text | PropKey::Style(_) | PropKey::Attr(_) if target => {
                        let (root, path) = split(id).unwrap_or((id, ""));
                        wanted.push(Wanted {
                            instance: root.to_owned(),
                            path: path.to_owned(),
                            prop: key.clone(),
                            value: value.as_ref().and_then(Value::as_str).map(str::to_owned),
                        });
                        continue;
                    }
                    _ if is_virtual(id) => {
                        let what = match key {
                            PropKey::Name => "its layer name comes from the component",
                            _ => "that can only change on the component",
                        };
                        return Err(refuse_inside(doc, id, what));
                    }
                    _ => {}
                }
            }
            Op::Create { node } => {
                if let Some(parent) = node.parent.as_deref()
                    && (is_virtual(parent) || instance(parent))
                {
                    return Err(refuse_inside(doc, parent, "nothing can be added inside it"));
                }
            }
            Op::Delete { id } => {
                if is_virtual(id) {
                    return Err(refuse_inside(doc, id, "it can't be deleted on its own"));
                }
                detaching |= !orphans(doc, id).is_empty();
            }
            // The design's tokens, modes and pages aren't part of any instance.
            Op::Css { .. } | Op::Page { .. } | Op::Token { .. } | Op::Mode { .. } => {}
            Op::Move { id, parent, .. } => {
                if is_virtual(id) {
                    return Err(refuse_inside(doc, id, "it can't be moved on its own"));
                }
                if let Some(parent) = parent.as_deref()
                    && (is_virtual(parent) || instance(parent))
                {
                    return Err(refuse_inside(doc, parent, "nothing can be moved inside it"));
                }
            }
        }
        plain.push(op);
    }
    if wanted.is_empty() && !detaching {
        return Ok(plain);
    }
    // Work on a copy, so each step sees what the steps before it did.
    let mut scratch = doc.clone();
    let mut out = Vec::with_capacity(plain.len() + wanted.len());
    for op in plain {
        if let Op::Delete { id } = &op {
            for instance in orphans(&scratch, id) {
                let ops = detach(&scratch, &instance, new_id)?;
                scratch.apply_all(&ops);
                out.extend(ops);
            }
        }
        scratch.apply(&op);
        out.push(op);
    }
    // Then the overrides, against what the instance would show without them.
    let mut by_instance: BTreeMap<NodeId, Vec<Wanted>> = BTreeMap::new();
    for w in wanted {
        by_instance.entry(w.instance.clone()).or_default().push(w);
    }
    for (id, wanted) in by_instance {
        let Some(node) = scratch.get(&id).filter(|n| n.is_instance()) else {
            continue;
        };
        let mut bare = node.clone();
        for w in &wanted {
            bare.overrides
                .remove(&PropKey::override_key(&w.path, &w.prop));
        }
        let mut expander = Expander::new(&scratch);
        let depth = scratch.depth(&id);
        expander.instance(
            &bare,
            id.clone(),
            bare.parent.clone(),
            Overrides::new(),
            depth,
        );
        let base: HashMap<&str, &Node> = expander.out.iter().map(|n| (n.id.as_str(), n)).collect();
        let mut ops = Vec::new();
        for w in &wanted {
            let vid = if w.path.is_empty() {
                id.clone()
            } else {
                format!("{id}{SEPARATOR}{}", w.path)
            };
            let Some(shown) = base.get(vid.as_str()) else {
                continue;
            };
            let before = value_of(shown, &w.prop);
            let value = match (&w.value, &before) {
                (v, b) if v == b => None,
                (None, _) => Some(Value::Bool(false)),
                (Some(v), _) => Some(Value::String(v.clone())),
            };
            ops.push(Op::Set {
                id: id.clone(),
                key: PropKey::Override(PropKey::override_key(&w.path, &w.prop)),
                value,
            });
        }
        scratch.apply_all(&ops);
        out.extend(ops);
    }
    Ok(out)
}

/// Turns instance `id` into a plain copy of what it shows: its root keeps
/// its id and becomes an ordinary element, with the content created under
/// it. Instances nested inside stay instances, with the overrides they
/// had.
pub fn detach(
    doc: &Document,
    id: &str,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<Vec<Op>, EditError> {
    let Some(node) = doc.get(id) else {
        return err(format!("node {id:?} not found"));
    };
    if !node.is_instance() {
        return err(format!("#{id} isn't an instance"));
    }
    let mut expander = Expander::new(doc);
    expander.frames = Some(HashMap::new());
    expander.real(id);
    let frames = expander.frames.take().unwrap_or_default();
    let mut nodes = expander.out.into_iter();
    let Some(root) = nodes.next() else {
        return Ok(Vec::new());
    };
    let mut ops = vec![Op::Set {
        id: id.to_owned(),
        key: PropKey::InstanceOf,
        value: None,
    }];
    let set = |key: PropKey, value: Option<String>| Op::Set {
        id: id.to_owned(),
        key,
        value: value.map(Value::String),
    };
    for key in node.overrides.keys() {
        ops.push(set(PropKey::Override(key.clone()), None));
    }
    for (k, v) in &root.styles {
        ops.push(set(PropKey::Style(k.clone()), Some(v.clone())));
    }
    for (k, v) in &root.attrs {
        ops.push(set(PropKey::Attr(k.clone()), Some(v.clone())));
    }
    for k in node.styles.keys().filter(|k| !root.styles.contains_key(*k)) {
        ops.push(set(PropKey::Style(k.clone()), None));
    }
    for k in node.attrs.keys().filter(|k| !root.attrs.contains_key(*k)) {
        ops.push(set(PropKey::Attr(k.clone()), None));
    }
    if node.name.is_none() {
        ops.push(set(PropKey::Name, root.name.clone()));
    }
    // Virtual ids become fresh real ones. A nested instance keeps no
    // children, and what it showed is skipped.
    let mut ids: HashMap<String, NodeId> = HashMap::from([(id.to_owned(), id.to_owned())]);
    for mut copy in nodes {
        let Some(parent) = copy.parent.as_deref().and_then(|p| ids.get(p)).cloned() else {
            continue;
        };
        let fresh = new_id();
        ids.insert(copy.id.clone(), fresh.clone());
        if copy.is_instance() {
            copy.overrides = frames.get(&copy.id).cloned().unwrap_or_default();
            // Its children are what it shows, not its own.
            ids.remove(&copy.id);
        }
        copy.id = fresh;
        copy.parent = Some(parent);
        ops.push(Op::Create { node: copy });
    }
    Ok(ops)
}

/// The overrides that make an instance of `component` look like
/// `fragment`, HTML an agent wrote for an instance, often after reading it
/// with `read`. Elements say which node of the component they show with
/// [`Fragment::source`] (their `data-id`), and text inside them matches the
/// component's text by position. Returns the overrides and how many
/// elements didn't match a node of the component and were left out.
///
/// An instance written without children is new, not a copy: only the
/// styles and attributes on its own element count, as overrides of its
/// root.
pub fn overrides_from_html(
    doc: &Document,
    component: &str,
    fragment: &Fragment,
) -> (Overrides, usize) {
    let mut out = Overrides::new();
    let mut skipped = 0;
    let probe = Node {
        instance_of: Some(component.to_owned()),
        ..Node::element("_", "div")
    };
    let mut expander = Expander::new(doc);
    expander.instance(&probe, "_".into(), None, Overrides::new(), 0);
    let base: HashMap<&str, &Node> = expander.out.iter().map(|n| (n.id.as_str(), n)).collect();
    let mut children: HashMap<&str, Vec<&Node>> = HashMap::new();
    for n in &expander.out {
        if let Some(p) = &n.parent {
            children.entry(p.as_str()).or_default().push(n);
        }
    }
    let Some(root) = base.get("_") else {
        return (out, 0);
    };
    if fragment.children.is_empty() {
        for (k, v) in &fragment.styles {
            if root.styles.get(k) != Some(v) {
                out.insert(PropKey::Style(k.clone()).to_string(), Some(v.clone()));
            }
        }
        for (k, v) in &fragment.attrs {
            if root.attrs.get(k) != Some(v) {
                out.insert(PropKey::Attr(k.clone()).to_string(), Some(v.clone()));
            }
        }
        return (out, 0);
    }
    struct Walk<'b> {
        base: &'b HashMap<&'b str, &'b Node>,
        children: &'b HashMap<&'b str, Vec<&'b Node>>,
        out: &'b mut Overrides,
        skipped: &'b mut usize,
    }
    impl Walk<'_> {
        fn compare(&mut self, path: &str, shown: &Node, wrote: &Fragment) {
            for (k, v) in &wrote.styles {
                if shown.styles.get(k) != Some(v) {
                    let key = PropKey::override_key(path, &PropKey::Style(k.clone()));
                    self.out.insert(key, Some(v.clone()));
                }
            }
            for k in shown
                .styles
                .keys()
                .filter(|k| !wrote.styles.contains_key(*k))
            {
                let key = PropKey::override_key(path, &PropKey::Style(k.clone()));
                self.out.insert(key, None);
            }
            for (k, v) in &wrote.attrs {
                if shown.attrs.get(k) != Some(v) {
                    let key = PropKey::override_key(path, &PropKey::Attr(k.clone()));
                    self.out.insert(key, Some(v.clone()));
                }
            }
            for k in shown.attrs.keys().filter(|k| !wrote.attrs.contains_key(*k)) {
                let key = PropKey::override_key(path, &PropKey::Attr(k.clone()));
                self.out.insert(key, None);
            }
            // Text by position among the children.
            let shown_children = self.children.get(shown.id.as_str());
            for (i, child) in wrote.children.iter().enumerate() {
                if child.kind == NodeKind::Text {
                    if let Some(s) = shown_children.and_then(|c| c.get(i))
                        && s.kind == NodeKind::Text
                        && s.text != child.text
                    {
                        let path = &s.id[2..];
                        let key = PropKey::override_key(path, &PropKey::Text);
                        self.out.insert(key, child.text.clone());
                    }
                    continue;
                }
                self.element(child);
            }
        }

        fn element(&mut self, wrote: &Fragment) {
            // `I/x` shows component node `x`; a component's own HTML names it `x`.
            let path = wrote
                .source
                .as_deref()
                .map(|s| split(s).map_or(s, |(_, rest)| rest));
            let shown = path.and_then(|p| self.base.get(format!("_/{p}").as_str()).copied());
            match (path, shown) {
                (Some(path), Some(shown)) if shown.tag() == wrote.kind_tag() => {
                    self.compare(path, shown, wrote);
                }
                _ => {
                    *self.skipped += 1;
                }
            }
        }
    }
    let mut walk = Walk {
        base: &base,
        children: &children,
        out: &mut out,
        skipped: &mut skipped,
    };
    walk.compare("", root, fragment);
    (out, skipped)
}

/// The overrides that make an instance of `component` look like the real
/// subtree at `id`, matching the two node by node, in order. Fails, saying
/// where, if they aren't built the same way.
pub fn overrides_to_match(doc: &Document, component: &str, id: &str) -> Result<Overrides, String> {
    let probe = Node {
        instance_of: Some(component.to_owned()),
        ..Node::element("_", "div")
    };
    let mut expander = Expander::new(doc);
    expander.instance(&probe, "_".into(), None, Overrides::new(), 0);
    let mut children: HashMap<&str, Vec<&Node>> = HashMap::new();
    for n in &expander.out {
        if let Some(p) = &n.parent {
            children.entry(p.as_str()).or_default().push(n);
        }
    }
    let Some(root) = expander.out.first() else {
        return Err("the component is empty".into());
    };
    let mut out = Overrides::new();
    let mut stack = vec![(root, doc.get(id).ok_or("not found")?)];
    while let Some((shown, real)) = stack.pop() {
        let path = if shown.id == "_" { "" } else { &shown.id[2..] };
        let describe = |n: &Node| match n.tag() {
            Some(tag) => format!("<{tag}>"),
            None => "text".into(),
        };
        if shown.tag() != real.tag() {
            return Err(format!(
                "#{} is {} where the component has {}",
                real.id,
                describe(real),
                describe(shown)
            ));
        }
        if real.component {
            return Err(format!("#{} is a component itself", real.id));
        }
        if real.is_instance() {
            // A nested instance matches if it shows the same component,
            // and keeps its own overrides.
            if real.instance_of != shown.instance_of {
                return Err(format!("#{} is an instance of another component", real.id));
            }
            for (k, v) in &real.overrides {
                let key = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}{SEPARATOR}{k}")
                };
                out.insert(key, v.clone());
            }
            continue;
        }
        if shown.is_instance() && shown.id != "_" {
            return Err(format!(
                "#{} isn't an instance where the component has one",
                real.id
            ));
        }
        let mut differ = |prop: PropKey, value: Option<String>| {
            out.insert(PropKey::override_key(path, &prop), value);
        };
        if shown.kind == NodeKind::Text {
            if shown.text != real.text {
                differ(PropKey::Text, real.text.clone());
            }
            continue;
        }
        for (k, v) in &real.styles {
            if shown.styles.get(k) != Some(v) {
                differ(PropKey::Style(k.clone()), Some(v.clone()));
            }
        }
        for k in shown
            .styles
            .keys()
            .filter(|k| !real.styles.contains_key(*k))
        {
            differ(PropKey::Style(k.clone()), None);
        }
        for (k, v) in &real.attrs {
            if shown.attrs.get(k) != Some(v) {
                differ(PropKey::Attr(k.clone()), Some(v.clone()));
            }
        }
        for k in shown.attrs.keys().filter(|k| !real.attrs.contains_key(*k)) {
            differ(PropKey::Attr(k.clone()), None);
        }
        // A nested instance's content matches as its own.
        let shown_children: &[&Node] = children.get(shown.id.as_str()).map_or(&[], Vec::as_slice);
        let real_children = doc.children(Some(&real.id));
        if shown_children.len() != real_children.len() {
            return Err(format!(
                "#{} has {} children where the component has {}",
                real.id,
                real_children.len(),
                shown_children.len()
            ));
        }
        stack.extend(shown_children.iter().copied().zip(real_children));
    }
    Ok(out)
}

impl Fragment {
    /// The tag, for an element.
    fn kind_tag(&self) -> Option<&str> {
        match &self.kind {
            NodeKind::Element { tag } => Some(tag),
            NodeKind::Text => None,
        }
    }
}

/// What a node is, as far as components go, for people and agents: the
/// instance it's shown in and its component, or the component it's in.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Info {
    /// The real instance the node is in, or is.
    pub instance: Option<NodeId>,
    /// The component that instance shows, or the one the node is in.
    pub component: Option<NodeId>,
    pub component_name: Option<String>,
    /// How many instances that component has.
    pub instances: usize,
}

/// [`Info`] for node `id`, real or virtual. `None` when it's neither in an
/// instance nor in a component.
pub fn info(doc: &Document, id: &str) -> Option<Info> {
    let (instance, component) = match instance_of(doc, id) {
        Some((instance, component)) => (Some(instance.id.clone()), component),
        None => (None, component_of(doc, id)),
    };
    if instance.is_none() && component.is_none() {
        return None;
    }
    Some(Info {
        instance,
        component: component.map(|c| c.id.clone()),
        component_name: component.map(Node::display_name),
        instances: component.map_or(0, |c| doc.instances_of(&c.id).count()),
    })
}

/// The classes used inside component `id` that a `<style>` block in its
/// artboard, outside the component, mentions. A `<style>` only styles its
/// own artboard, so instances on other artboards don't get those rules.
pub fn classes_styled_outside(doc: &Document, id: &str) -> Vec<String> {
    let mut classes: Vec<String> = doc
        .subtree(id)
        .iter()
        .filter_map(|n| n.attrs.get("class"))
        .flat_map(|c| c.split_whitespace().map(str::to_owned))
        .collect();
    classes.sort();
    classes.dedup();
    let Some(board) = doc.artboard_of(id) else {
        return Vec::new();
    };
    let css: String = doc
        .subtree(&board.id)
        .into_iter()
        .filter(|n| n.tag().is_some_and(|t| t.eq_ignore_ascii_case("style")))
        .filter(|n| n.id != id && !doc.is_ancestor(id, &n.id))
        .flat_map(|n| doc.children(Some(&n.id)))
        .filter_map(|t| t.text.as_deref())
        .collect();
    classes
        .into_iter()
        .filter(|c| {
            let selector = format!(".{c}");
            css.match_indices(&selector).any(|(at, _)| {
                // `.bar` shouldn't match `.barrel`.
                !css[at + selector.len()..]
                    .chars()
                    .next()
                    .is_some_and(|ch| ch.is_alphanumeric() || ch == '-' || ch == '_')
            })
        })
        .collect()
}

/// An instance that a change set or cleared overrides on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Overridden {
    pub instance: NodeId,
    /// The component the instance shows.
    pub component: Option<NodeId>,
    pub set: usize,
    pub cleared: usize,
}

/// A component that a change edited, and what showing it affects.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EditedComponent {
    pub component: NodeId,
    /// Every instance that shows the edit, nested ones included.
    pub instances: Vec<NodeId>,
    /// The instances of the component itself.
    pub direct: Vec<NodeId>,
    /// Up to four elements the change added to the component, which have no
    /// overrides in the instances yet. Empty for a component the change made.
    pub added: Vec<NodeId>,
}

/// What a change did to components and instances, as [`summarize`] reads it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ChangeSummary {
    /// Instances that got overrides, or lost them.
    pub overridden: Vec<Overridden>,
    /// Components the change made that no instance shows yet.
    pub defined: Vec<NodeId>,
    /// Existing components the change edited.
    pub edited: Vec<EditedComponent>,
    /// Instances turned into plain copies.
    pub detached: Vec<NodeId>,
}

/// Reads what `ops` did to components, once applied to `doc` (the real
/// document, not the expanded view). An edit inside an instance becomes an
/// override on it, and one inside a component changes every instance, which
/// the HTML an agent writes doesn't show.
pub fn summarize(doc: &Document, ops: &[Op]) -> ChangeSummary {
    let mut summary = ChangeSummary::default();
    if !doc.has_instances() && !doc.nodes().any(|n| n.component) {
        return summary;
    }
    let mut overridden: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    let mut edited: BTreeMap<String, usize> = BTreeMap::new();
    // Components this change made: new ones, not edits to old ones.
    let made: Vec<&str> = ops
        .iter()
        .filter_map(|op| match op {
            Op::Create { node } if node.component => Some(node.id.as_str()),
            Op::Set {
                id,
                key: PropKey::Component,
                value: Some(_),
            } => Some(id.as_str()),
            _ => None,
        })
        .collect();
    for op in ops {
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
            } => summary.detached.push(id.clone()),
            Op::Set {
                key: PropKey::Component | PropKey::Name,
                ..
            } => {}
            _ => {
                let id = match op {
                    Op::Create { node } => node.parent.as_deref().unwrap_or(&node.id),
                    _ => op.id(),
                };
                if let Some(component) = component_of(doc, id) {
                    *edited.entry(component.id.clone()).or_default() += 1;
                }
            }
        }
    }
    // Detaching clears an instance's overrides; that's not news.
    summary.overridden = overridden
        .into_iter()
        .filter(|(id, _)| !summary.detached.iter().any(|d| d == id))
        .map(|(instance, (set, cleared))| Overridden {
            instance: instance.to_owned(),
            component: doc.get(instance).and_then(|n| n.instance_of.clone()),
            set,
            cleared,
        })
        .collect();
    for id in &made {
        if doc.instances_of(id).next().is_none() && doc.get(id).is_some() {
            summary.defined.push((*id).to_owned());
            edited.remove(*id);
        }
    }
    for component in edited.into_keys() {
        let instances: Vec<NodeId> = affected(doc, &component).into_iter().collect();
        let direct: Vec<NodeId> = doc.instances_of(&component).map(str::to_owned).collect();
        let was_made = made.contains(&component.as_str());
        let added = if was_made || instances.is_empty() {
            Vec::new()
        } else {
            ops.iter()
                .filter_map(|op| match op {
                    Op::Create { node } => doc.get(&node.id),
                    _ => None,
                })
                .filter(|n| {
                    n.tag().is_some()
                        && component_of(doc, &n.id).is_some_and(|c| c.id == component)
                        && n.id != component
                })
                .map(|n| n.id.clone())
                .take(4)
                .collect()
        };
        summary.edited.push(EditedComponent {
            component,
            instances,
            direct,
            added,
        });
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::html;
    use serde_json::json;

    fn ids() -> impl FnMut() -> NodeId {
        let mut n = 0;
        move || {
            n += 1;
            format!("new{n}")
        }
    }

    /// Ids that don't clash with the ones [`design`] made.
    fn fresh() -> impl FnMut() -> NodeId {
        let mut n = 0;
        move || {
            n += 1;
            format!("f{n}")
        }
    }

    /// A design with a "Bar" component (a header with a title and a
    /// button) on artboard `a`, and an instance `i` of it on artboard `b`.
    fn design() -> Document {
        let mut doc = Document::default();
        let mut next = ids();
        let mut ops = Vec::new();
        for (board, index) in [("a", "V"), ("b", "W")] {
            ops.push(Op::Create {
                node: Node {
                    index: index.into(),
                    x: Some(0.0),
                    y: Some(0.0),
                    ..Node::element(board, "div")
                },
            });
        }
        let bar = html::parse(
            r#"<header data-name="Bar" style="padding: 8px; color: black"><h1 data-name="Title">Home</h1><button style="background: blue">Go</button></header>"#,
        )
        .unwrap()
        .remove(0);
        let bar = bar.create_ops(Some("a"), "V".into(), None, &mut next, &mut ops);
        assert_eq!(bar, "new1");
        doc.apply_all(&ops);
        doc.apply(&Op::Set {
            id: bar.clone(),
            key: PropKey::Component,
            value: Some(json!(true)),
        });
        doc.apply(&Op::Create {
            node: Node {
                parent: Some("b".into()),
                index: "V".into(),
                instance_of: Some(bar),
                ..Node::element("i", "header")
            },
        });
        doc
    }

    fn text(doc: &Document, id: &str) -> String {
        html::export_compact(&expand(doc), id).unwrap()
    }

    #[test]
    fn instances_show_their_component() {
        let doc = design();
        assert_eq!(
            text(&doc, "b"),
            r#"<div><header style="color: black; padding: 8px"><h1>Home</h1><button style="background: blue">Go</button></header></div>"#
        );
        let view = expand(&doc);
        // Each node inside has a virtual id: the instance, then the component's node.
        let title = view.children(Some("i"))[0];
        assert_eq!(title.id, "i/new2");
        assert_eq!(title.name.as_deref(), Some("Title"));
        assert_eq!(
            view.children(Some("i/new2"))[0].text.as_deref(),
            Some("Home")
        );
        // The design's shared CSS stays in the expanded view.
        let mut doc = doc;
        doc.apply(&Op::Css {
            css: Some(".x { color: red; }".into()),
        });
        assert_eq!(expand(&doc).css(), Some(".x { color: red; }"));
    }

    #[test]
    fn the_expanded_view_keeps_the_pages() {
        let mut doc = design();
        let ops = crate::edit::create_page(&doc, "drafts".into(), "Drafts").unwrap();
        doc.apply_all(&ops);
        doc.apply(&Op::Set {
            id: "b".into(),
            key: PropKey::Page,
            value: Some(json!("drafts")),
        });
        let view = expand(&doc);
        let names: Vec<_> = view.pages().iter().map(|(_, p)| p.name.clone()).collect();
        assert_eq!(names, ["Page 1", "Drafts"]);
        assert_eq!(view.page_of(view.get("b").unwrap()), "drafts");
    }

    #[test]
    fn editing_the_component_changes_every_instance() {
        let mut doc = design();
        doc.apply(&Op::Set {
            id: "new3".into(),
            key: PropKey::Text,
            value: Some(json!("Start")),
        });
        assert!(
            text(&doc, "b").contains("<h1>Start</h1>"),
            "{}",
            text(&doc, "b")
        );
        assert_eq!(affected(&doc, "new3"), BTreeSet::from(["i".to_owned()]));
    }

    #[test]
    fn edits_inside_an_instance_become_its_overrides() {
        let doc = design();
        let view = expand(&doc);
        let ops = crate::edit::set_text(&view, "i/new2", "Settings", &mut fresh()).unwrap();
        let ops = redirect(&doc, ops, &mut fresh()).unwrap();
        assert_eq!(
            ops,
            [Op::Set {
                id: "i".into(),
                key: PropKey::Override("new3/text".into()),
                value: Some(json!("Settings")),
            }]
        );
        let mut doc = doc;
        doc.apply_all(&ops);
        assert!(text(&doc, "b").contains("<h1>Settings</h1>"));
        assert!(
            text(&doc, "a").contains("<h1>Home</h1>"),
            "the component keeps its text"
        );

        // A style on the instance's root, and a shorthand over the component's longhands.
        let view = expand(&doc);
        let styles = BTreeMap::from([("padding".into(), Some("20px".into()))]);
        let ops = crate::edit::update_styles(&view, &["i".into()], &styles).unwrap();
        let ops = redirect(&doc, ops, &mut fresh()).unwrap();
        doc.apply_all(&ops);
        assert!(
            text(&doc, "b").contains(r#"<header style="color: black; padding: 20px">"#),
            "{}",
            text(&doc, "b")
        );

        // Setting it back to the component's value drops the override.
        let view = expand(&doc);
        let ops = crate::edit::set_text(&view, "i/new2", "Home", &mut fresh()).unwrap();
        let ops = redirect(&doc, ops, &mut fresh()).unwrap();
        assert_eq!(
            ops[0],
            Op::Set {
                id: "i".into(),
                key: PropKey::Override("new3/text".into()),
                value: None,
            }
        );
    }

    #[test]
    fn rewriting_a_component_keeps_what_its_instances_override() {
        let mut doc = design();
        doc.apply(&Op::Set {
            id: "i".into(),
            key: PropKey::Override("new3/text".into()),
            value: Some(json!("Settings")),
        });
        // One write with an element added in front, the title restyled, and a link at the end.
        let html = r#"<span data-name="Back">←</span><h1 data-name="Title" style="font-weight: 700">Home</h1><button style="background: blue">Go</button><a>Help</a>"#;
        for mode in [
            crate::edit::WriteMode::ReplaceChildren,
            crate::edit::WriteMode::Replace,
        ] {
            let mut doc = doc.clone();
            let html = match mode {
                crate::edit::WriteMode::Replace => {
                    format!(
                        r#"<header data-name="Bar" style="padding: 8px; color: black">{html}</header>"#
                    )
                }
                _ => html.to_owned(),
            };
            let view = expand(&doc);
            let (ops, _) =
                crate::edit::write_html(&view, "new1", &html, mode, None, &mut fresh()).unwrap();
            let ops = redirect(&doc, ops, &mut fresh()).unwrap();
            assert!(
                !ops.iter()
                    .any(|op| op.id() == "new3" && matches!(op, Op::Delete { .. }))
            );
            doc.apply_all(&ops);
            assert!(
                doc.get("new1").unwrap().component,
                "{mode:?}: still the component"
            );
            assert_eq!(doc.instances_of("new1").collect::<Vec<_>>(), ["i"]);
            let b = text(&doc, "b");
            assert!(
                b.starts_with("<div><header style=\"color: black; padding: 8px\"><span>←</span><h1 style=\"font-weight: 700\">Settings</h1>"),
                "{mode:?}: {b}"
            );
            assert!(b.contains("<a>Help</a>"), "{b}");
            assert!(text(&doc, "a").contains(">Home</h1>"));
        }
    }

    /// Three empty artboards `a`, `b` and `c`.
    fn boards() -> Document {
        let mut doc = Document::default();
        for (id, index) in [("a", "V"), ("b", "W"), ("c", "X")] {
            doc.apply(&Op::Create {
                node: Node {
                    index: index.into(),
                    x: Some(0.0),
                    y: Some(0.0),
                    ..Node::element(id, "div")
                },
            });
        }
        doc
    }

    /// Writes `html` the way the server does: built against the expanded
    /// document, then redirected.
    fn write(
        doc: &mut Document,
        target: &str,
        html: &str,
        mode: crate::edit::WriteMode,
    ) -> Result<(), EditError> {
        let view = expand(doc).into_owned();
        let mut next = {
            let mut n = 0;
            let taken: HashSet<String> = view.nodes().map(|n| n.id.clone()).collect();
            move || {
                crate::id::fresh(
                    &mut || {
                        n += 1;
                        format!("w{n}")
                    },
                    |id| taken.contains(id),
                )
            }
        };
        let (ops, _) = crate::edit::write_html(&view, target, html, mode, None, &mut next)?;
        let ops = redirect(doc, ops, &mut next)?;
        doc.apply_all(&ops);
        Ok(())
    }

    const BAR: &str = r#"<header data-component="Bar" style="display: flex"><span data-name="Title">{}</span></header>"#;

    #[test]
    fn a_name_in_html_defines_a_component_and_then_instances_of_it() {
        use crate::edit::WriteMode::*;
        let mut doc = boards();
        write(&mut doc, "a", &BAR.replace("{}", "Home"), Append).unwrap();
        let bar = doc.nodes().find(|n| n.component).unwrap().id.clone();
        assert_eq!(doc.get(&bar).unwrap().name.as_deref(), Some("Bar"));
        // The same bar with another title is an instance with that title.
        write(&mut doc, "b", &BAR.replace("{}", "Settings"), Append).unwrap();
        // Empty, it's a plain instance.
        write(
            &mut doc,
            "c",
            r#"<header data-component="Bar"></header>"#,
            Append,
        )
        .unwrap();
        assert_eq!(doc.instances_of(&bar).count(), 2);
        assert_eq!(
            text(&doc, "b"),
            r#"<div><header style="display: flex"><span>Settings</span></header></div>"#
        );
        assert_eq!(
            text(&doc, "c"),
            r#"<div><header style="display: flex"><span>Home</span></header></div>"#
        );
        // `read` names it, so writing that back means the same component.
        let html = crate::html::export(&expand(&doc), &bar, true).unwrap();
        assert!(html.contains(r#"data-component="Bar""#), "{html}");

        // Built differently, it's refused with what to do instead.
        let refused = write(
            &mut doc,
            "c",
            r#"<header data-component="Bar"><b>x</b><i>y</i></header>"#,
            Append,
        )
        .unwrap_err();
        assert!(
            refused.0.contains("isn't built like the component"),
            "{refused}"
        );

        // Rewriting the screen that holds it redefines it for every instance:
        // same id, and the instances keep their own titles.
        let screen = r#"<header data-component="Bar" style="display: flex; gap: 8px"><button>←</button><span data-name="Title">Home</span></header><p>Hi</p>"#;
        write(&mut doc, "a", screen, ReplaceChildren).unwrap();
        assert!(doc.get(&bar).is_some_and(|n| n.component));
        assert_eq!(doc.instances_of(&bar).count(), 2);
        assert_eq!(
            text(&doc, "b"),
            r#"<div><header style="display: flex; gap: 8px"><button>←</button><span>Settings</span></header></div>"#
        );
        // So does writing the component itself in place.
        let root = r#"<header data-component="Bar" style="display: flex; gap: 8px"><button>←</button><span data-name="Title">Home</span><a>Help</a></header>"#;
        write(&mut doc, &bar, root, Replace).unwrap();
        assert!(
            text(&doc, "b").contains("<span>Settings</span><a>Help</a>"),
            "{}",
            text(&doc, "b")
        );
    }

    #[test]
    fn copies_in_the_same_html_follow_the_first() {
        let mut doc = boards();
        write(
            &mut doc,
            "a",
            r#"<div data-component="Card"><p>One</p></div><div data-component="Card"><p>Two</p></div><div data-component="Card"><p>Three</p></div>"#,
            crate::edit::WriteMode::Append,
        )
        .unwrap();
        let card = doc.nodes().find(|n| n.component).unwrap().id.clone();
        assert_eq!(doc.instances_of(&card).count(), 2);
        assert_eq!(
            text(&doc, "a"),
            "<div><div><p>One</p></div><div><p>Two</p></div><div><p>Three</p></div></div>"
        );
    }

    #[test]
    fn removing_a_value_in_an_instance_is_an_override_too() {
        let mut doc = design();
        let view = expand(&doc);
        let styles = BTreeMap::from([("background".into(), None)]);
        let ops = crate::edit::update_styles(&view, &["i/new4".into()], &styles).unwrap();
        let ops = redirect(&doc, ops, &mut fresh()).unwrap();
        assert_eq!(
            ops[0],
            Op::Set {
                id: "i".into(),
                key: PropKey::Override("new4/style:background".into()),
                value: Some(json!(false)),
            }
        );
        doc.apply_all(&ops);
        assert!(
            text(&doc, "b").contains("<button>Go</button>"),
            "{}",
            text(&doc, "b")
        );
    }

    #[test]
    fn a_component_cant_be_made_from_a_node_an_instance_shows() {
        let doc = design();
        let view = expand(&doc);
        let refused = crate::edit::create_component(&view, "i/new2", None, &[]).unwrap_err();
        assert!(
            refused.0.contains("\"select\": \"#i\", \"detach\": true"),
            "{refused}"
        );
    }

    #[test]
    fn structure_inside_an_instance_is_refused() {
        let doc = design();
        let view = expand(&doc);
        let delete = crate::edit::delete(&view, &["i/new4".into()]).unwrap();
        let refused = redirect(&doc, delete, &mut fresh()).unwrap_err();
        assert!(
            refused.0.contains("\"select\": \"#i\", \"detach\": true"),
            "{refused}"
        );
        let write = crate::edit::write_html(
            &view,
            "i",
            "<p>x</p>",
            crate::edit::WriteMode::Append,
            None,
            &mut fresh(),
        )
        .unwrap()
        .0;
        assert!(redirect(&doc, write, &mut fresh()).is_err());
    }

    #[test]
    fn deleting_a_component_detaches_its_instances() {
        let mut doc = design();
        let mut next = fresh();
        let ops = redirect(&doc, vec![Op::Delete { id: "a".into() }], &mut next).unwrap();
        let (_, undo) = doc.apply_all(&ops);
        assert!(!doc.has_instances());
        assert_eq!(
            text(&doc, "b"),
            r#"<div><header style="color: black; padding: 8px"><h1>Home</h1><button style="background: blue">Go</button></header></div>"#
        );
        assert_eq!(doc.get("i").unwrap().name.as_deref(), Some("Bar"));
        // Undo brings back the component and the instance.
        doc.apply_all(&undo);
        assert_eq!(doc.instances_of("new1").collect::<Vec<_>>(), ["i"]);
        assert!(doc.children(Some("i")).is_empty());
    }

    #[test]
    fn nested_instances_take_overrides_from_further_out() {
        let mut doc = design();
        // A "Page" component on `a` holds an instance `n` of Bar that overrides its title.
        doc.apply_all(&[
            Op::Create {
                node: Node {
                    parent: Some("a".into()),
                    index: "W".into(),
                    component: true,
                    ..Node::element("page", "main")
                },
            },
            Op::Create {
                node: Node {
                    parent: Some("page".into()),
                    index: "V".into(),
                    instance_of: Some("new1".into()),
                    overrides: BTreeMap::from([("new3/text".into(), Some("Inbox".into()))]),
                    ..Node::element("n", "header")
                },
            },
            Op::Create {
                node: Node {
                    parent: Some("b".into()),
                    index: "W".into(),
                    instance_of: Some("page".into()),
                    ..Node::element("p", "main")
                },
            },
        ]);
        let view = expand(&doc);
        assert_eq!(view.get("p/n/new3").unwrap().text.as_deref(), Some("Inbox"));
        // The outer instance overrides the nested one.
        let ops = crate::edit::set_text(&view, "p/n/new2", "Sent", &mut fresh()).unwrap();
        let ops = redirect(&doc, ops, &mut fresh()).unwrap();
        assert_eq!(ops[0].id(), "p");
        doc.apply_all(&ops);
        let view = expand(&doc);
        assert_eq!(view.get("p/n/new3").unwrap().text.as_deref(), Some("Sent"));
        assert_eq!(view.get("n/new3").unwrap().text.as_deref(), Some("Inbox"));
        // Bar's own edits reach both, through Page.
        assert_eq!(
            affected(&doc, "new4"),
            BTreeSet::from(["i".to_owned(), "n".to_owned(), "p".to_owned()])
        );
        // A Bar instance can't go inside Bar, nor a Page instance inside Page.
        assert!(check_cycle(&doc, "new1", Some("new2")).is_err());
        assert!(check_cycle(&doc, "page", Some("n")).is_err());
        assert!(check_cycle(&doc, "new1", Some("page")).is_ok());
    }

    #[test]
    fn an_instance_inside_its_own_component_stops() {
        let mut doc = design();
        // Only raw ops can do this; the edit commands refuse it.
        doc.apply(&Op::Create {
            node: Node {
                parent: Some("new1".into()),
                index: "z".into(),
                instance_of: Some("new1".into()),
                ..Node::element("loop", "header")
            },
        });
        let view = expand(&doc);
        assert!(view.contains("i/loop"));
        assert!(view.children(Some("i/loop")).is_empty());
    }

    #[test]
    fn detaching_makes_a_plain_copy_with_the_overrides() {
        let mut doc = design();
        doc.apply(&Op::Set {
            id: "i".into(),
            key: PropKey::Override("new3/text".into()),
            value: Some(json!("Settings")),
        });
        let before = text(&doc, "b");
        let ops = detach(&doc, "i", &mut fresh()).unwrap();
        doc.apply_all(&ops);
        assert!(!doc.get("i").unwrap().is_instance());
        assert_eq!(text(&doc, "b"), before);
        assert_eq!(doc.subtree("i").len(), 5);
    }

    #[test]
    fn html_written_for_an_instance_becomes_overrides() {
        let doc = design();
        // What `read` shows, with the title and the button's color changed.
        let html = r#"<header data-id="i" data-instance-of="new1" style="color: black; padding: 8px"><h1 data-id="i/new2">Settings</h1><button data-id="i/new4" style="background: red">Go</button><p>new</p></header>"#;
        let fragment = html::parse(html).unwrap().remove(0);
        assert_eq!(fragment.instance_of.as_deref(), Some("new1"));
        let (overrides, skipped) = overrides_from_html(&doc, "new1", &fragment);
        assert_eq!(
            overrides,
            BTreeMap::from([
                ("new3/text".into(), Some("Settings".into())),
                ("new4/style:background".into(), Some("red".into())),
            ])
        );
        assert_eq!(skipped, 1, "the <p> isn't in the component");
        // Written fresh, only its own styles count.
        let fresh = html::parse(r#"<header data-instance-of="new1" style="margin: 4px"></header>"#)
            .unwrap()
            .remove(0);
        let (overrides, _) = overrides_from_html(&doc, "new1", &fresh);
        assert_eq!(
            overrides,
            BTreeMap::from([("style:margin".into(), Some("4px".into()))])
        );
    }

    #[test]
    fn a_matching_copy_becomes_an_instance_with_its_differences() {
        let mut doc = design();
        let mut ops = Vec::new();
        html::parse(
            r#"<header style="padding: 8px; color: black"><h1>Inbox</h1><button style="background: blue">Go</button></header>"#,
        )
        .unwrap()
        .remove(0)
        .create_ops(Some("b"), "k".into(), None, &mut fresh(), &mut ops);
        let copy = ops[0].id().to_owned();
        doc.apply_all(&ops);
        let overrides = overrides_to_match(&doc, "new1", &copy).unwrap();
        let text_id = doc.children(Some(&doc.children(Some("new1"))[0].id))[0]
            .id
            .clone();
        assert_eq!(
            overrides,
            BTreeMap::from([(format!("{text_id}/text"), Some("Inbox".into()))])
        );
        // A copy built differently can't.
        doc.apply(&Op::Delete {
            id: doc.children(Some(&copy))[1].id.clone(),
        });
        let refused = overrides_to_match(&doc, "new1", &copy).unwrap_err();
        assert!(
            refused.contains("has 1 children where the component has 2"),
            "{refused}"
        );
    }

    #[test]
    fn the_snapshot_format_keeps_components_and_instances() {
        let doc = design();
        let node = serde_json::to_value(doc.get("new1").unwrap()).unwrap();
        assert_eq!(node["component"], true);
        let instance = serde_json::to_value(doc.get("i").unwrap()).unwrap();
        assert_eq!(instance["instanceOf"], "new1");
        assert!(
            instance.get("overrides").is_none(),
            "empty overrides are left out"
        );
        let plain = serde_json::to_value(doc.get("a").unwrap()).unwrap();
        assert!(plain.get("component").is_none() && plain.get("instanceOf").is_none());
        let back: Node = serde_json::from_value(instance).unwrap();
        assert_eq!(&back, doc.get("i").unwrap());
        let key: PropKey = serde_json::from_value(json!("override:a/b/attr:xlink:href")).unwrap();
        assert_eq!(
            PropKey::split_override("a/b/attr:xlink:href").unwrap().0,
            "a/b"
        );
        assert_eq!(key, PropKey::Override("a/b/attr:xlink:href".into()));
        assert!(serde_json::from_value::<PropKey>(json!("override:a/name")).is_err());
        assert!(serde_json::from_value::<PropKey>(json!("override:/text")).is_err());
    }
}
