use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::Value;

use crate::{
    node::{Node, NodeId, NodeKind, PropKey},
    tokens::{self, FIRST_MODE, FIRST_MODE_NAME, Mode, Values},
};

/// The smallest unit of change. Every edit, from any actor, becomes a list of ops.
///
/// Applying an op returns its inverse, captured from the state at that moment.
/// Undo replays inverses (the command pattern), so it never restores a whole
/// snapshot and can't erase other actors' work.
///
/// Serialized with its kind in `op`, as in `{"op": "delete", "id": "4biyjm26"}`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
#[allow(
    clippy::large_enum_variant,
    reason = "ops are built and applied in place; boxing the node would touch every one"
)]
pub enum Op {
    /// Inserts one node. Children are separate `Create` ops that follow their parent.
    Create { node: Node },
    /// Removes a node and its whole subtree.
    Delete { id: NodeId },
    /// Sets one property, or clears it when `value` is `None`.
    Set {
        id: NodeId,
        key: PropKey,
        #[serde(default)]
        value: Option<Value>,
    },
    /// Reparents and/or reorders a node.
    Move {
        id: NodeId,
        parent: Option<NodeId>,
        index: String,
    },
    /// Replaces the design's old shared stylesheet, or removes it when
    /// `css` is `None`. Tokens replaced it: only journals from before them
    /// hold this op, and [`crate::Design::migrate_css`] moves what it set
    /// into tokens when the design loads.
    Css {
        #[serde(default)]
        css: Option<String>,
    },
    /// Creates, renames, reorders or recolors one page, or removes it when
    /// `page` is `None`. Removing a page leaves its artboards, which fall
    /// back to the first page.
    Page {
        id: String,
        #[serde(default)]
        page: Option<Page>,
    },
    /// Sets one token's value in one mode, or removes it when `value` is
    /// `None` (see [`crate::tokens`]). A token without values is gone. One
    /// mode at a time, so undoing one agent's Light value leaves another's
    /// Dark value alone.
    Token {
        name: String,
        #[serde(rename = "modeId")]
        mode_id: String,
        #[serde(default)]
        value: Option<String>,
    },
    /// Creates, renames or reorders one mode, or removes it when `mode` is
    /// `None`. Artboards in a removed mode fall back to the first one.
    Mode {
        id: String,
        #[serde(default)]
        mode: Option<Mode>,
    },
}

/// A named group of artboards. The viewer shows one page at a time, so a
/// design can keep components or drafts away from its screens.
///
/// A design with no pages has one implicit page, [`FIRST_PAGE`], so designs
/// from before pages existed need no migration. An artboard's
/// [`Node::page`] says which page it's on; a missing or unknown page means
/// the first one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Page {
    pub name: String,
    /// Fractional index among pages (see [`crate::fractional`]).
    pub index: String,
    /// The color of the canvas behind the page's artboards, as a CSS
    /// color. `None` leaves the viewer's own canvas color.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
}

/// The implicit first mode.
static IMPLICIT_MODE: std::sync::LazyLock<Mode> = std::sync::LazyLock::new(|| Mode {
    name: FIRST_MODE_NAME.into(),
    index: "V".into(),
});

/// The id of a design's implicit first page, before it has any pages.
pub const FIRST_PAGE: &str = "page-1";

/// The implicit first page.
static IMPLICIT_PAGE: std::sync::LazyLock<Page> = std::sync::LazyLock::new(|| Page {
    name: "Page 1".into(),
    index: "V".into(),
    background: None,
});

/// Reads an op field by field. A derived `Deserialize` for an internally
/// tagged enum first buffers the whole op, node and all, to find `op`, and
/// then reads it again: parsing a 30,000-node `write_html` change took half
/// as long again. Missing and unknown fields are handled as the derive would.
impl<'de> Deserialize<'de> for Op {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        enum Kind {
            Create,
            Delete,
            Set,
            Move,
            Css,
            Page,
            Token,
            Mode,
        }
        #[derive(Deserialize)]
        struct Wire {
            op: Kind,
            node: Option<Node>,
            id: Option<NodeId>,
            key: Option<PropKey>,
            #[serde(default)]
            value: Option<Value>,
            parent: Option<NodeId>,
            index: Option<String>,
            #[serde(default)]
            css: Option<String>,
            #[serde(default)]
            page: Option<Page>,
            name: Option<String>,
            #[serde(rename = "modeId")]
            mode_id: Option<String>,
            #[serde(default)]
            mode: Option<Mode>,
        }
        let wire = Wire::deserialize(deserializer)?;
        let need = |field: &'static str| D::Error::missing_field(field);
        Ok(match wire.op {
            Kind::Create => Op::Create {
                node: wire.node.ok_or_else(|| need("node"))?,
            },
            Kind::Delete => Op::Delete {
                id: wire.id.ok_or_else(|| need("id"))?,
            },
            Kind::Set => Op::Set {
                id: wire.id.ok_or_else(|| need("id"))?,
                key: wire.key.ok_or_else(|| need("key"))?,
                value: wire.value,
            },
            Kind::Move => Op::Move {
                id: wire.id.ok_or_else(|| need("id"))?,
                parent: wire.parent,
                index: wire.index.ok_or_else(|| need("index"))?,
            },
            Kind::Css => Op::Css { css: wire.css },
            Kind::Page => Op::Page {
                id: wire.id.ok_or_else(|| need("id"))?,
                page: wire.page,
            },
            Kind::Token => Op::Token {
                name: wire.name.ok_or_else(|| need("name"))?,
                mode_id: wire.mode_id.ok_or_else(|| need("modeId"))?,
                value: match wire.value {
                    None | Some(Value::Null) => None,
                    Some(Value::String(value)) => Some(value),
                    Some(_) => return Err(D::Error::custom("a token's value is a string")),
                },
            },
            Kind::Mode => Op::Mode {
                id: wire.id.ok_or_else(|| need("id"))?,
                mode: wire.mode,
            },
        })
    }
}

impl Op {
    /// Roughly how many bytes this op takes, counting its strings plus a
    /// fixed amount for the rest. Cheap enough to call on every undo step.
    pub fn size(&self) -> usize {
        const BASE: usize = 64;
        match self {
            Op::Create { node } => {
                let strings = |map: &BTreeMap<String, String>| {
                    map.iter()
                        .map(|(k, v)| k.len() + v.len() + 8)
                        .sum::<usize>()
                };
                BASE + node.id.len()
                    + node.index.len()
                    + node.name.as_ref().map_or(0, String::len)
                    + node.text.as_ref().map_or(0, String::len)
                    + node.instance_of.as_ref().map_or(0, String::len)
                    + strings(&node.styles)
                    + strings(&node.attrs)
                    + node
                        .overrides
                        .iter()
                        .map(|(k, v)| k.len() + v.as_ref().map_or(0, String::len) + 8)
                        .sum::<usize>()
            }
            Op::Delete { id } => BASE + id.len(),
            Op::Set { id, key, value } => {
                let key = match key {
                    PropKey::Override(k) => k.len(),
                    _ => 0,
                };
                BASE + id.len() + key + value.as_ref().and_then(Value::as_str).map_or(16, str::len)
            }
            Op::Move { id, index, .. } => BASE + id.len() + index.len(),
            Op::Css { css } => BASE + css.as_ref().map_or(0, String::len),
            Op::Page { id, page } => {
                BASE + id.len()
                    + page.as_ref().map_or(0, |p| {
                        p.name.len() + p.index.len() + p.background.as_ref().map_or(0, String::len)
                    })
            }
            Op::Token {
                name,
                mode_id,
                value,
            } => BASE + name.len() + mode_id.len() + value.as_ref().map_or(0, String::len),
            Op::Mode { id, mode } => {
                BASE + id.len() + mode.as_ref().map_or(0, |m| m.name.len() + m.index.len())
            }
        }
    }

    /// The node this op creates, deletes or changes. Empty for the ops that
    /// change the design rather than a node: [`Op::Css`], [`Op::Page`],
    /// [`Op::Token`] and [`Op::Mode`].
    pub fn id(&self) -> &str {
        match self {
            Op::Create { node } => &node.id,
            Op::Delete { id } | Op::Set { id, .. } | Op::Move { id, .. } => id,
            Op::Css { .. } | Op::Page { .. } | Op::Token { .. } | Op::Mode { .. } => "",
        }
    }
}

/// How deep nodes can nest. An artboard is at depth 0, its children at 1,
/// and so on. Exports, the outline and the browser's renderer walk the tree
/// recursively, so a much deeper tree would overflow the stack and abort the
/// server. (Chrome's HTML parser stops nesting at 512.)
pub const MAX_DEPTH: usize = 256;

/// How many nodes a design can hold. A big real design has about 20,000.
/// Every node is journaled, held in memory and sent to every viewer, and
/// without a limit an agent stuck in a loop could grow a design forever.
pub const MAX_NODES: usize = 100_000;

/// What [`Document::try_apply`] did with an op that applies.
#[derive(Clone, Debug, PartialEq)]
pub enum Applied {
    /// The op changed the document. These ops undo it.
    Changed(Vec<Op>),
    /// The document already looked like that, like a style set to its current value.
    Unchanged,
}

/// Why an op couldn't apply. Each names the node it was about.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Rejected {
    /// The op changes or deletes a node that isn't there.
    Missing(NodeId),
    /// The op creates a node whose id is taken.
    Exists(NodeId),
    /// The op creates a node under a parent that's gone or is text.
    NoParent(NodeId),
    /// The value doesn't fit the property, or a move would make a cycle or
    /// use a bad index.
    Invalid(NodeId),
}

impl std::fmt::Display for Rejected {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Missing(id) => write!(f, "node {id:?} doesn't exist"),
            Self::Exists(id) => write!(f, "node {id:?} already exists"),
            Self::NoParent(id) => write!(f, "node {id:?} has no parent to go under"),
            Self::Invalid(id) => write!(f, "the change to node {id:?} isn't valid"),
        }
    }
}

/// The node tree of one design, stored flat by id, with an index from each
/// parent to its children in sibling order, and the design's pages, tokens
/// and modes.
#[derive(Clone, Debug, Default)]
pub struct Document {
    nodes: HashMap<NodeId, Node>,
    /// Children of each parent (`None` for artboards), sorted by `(index, id)`.
    child_index: HashMap<Option<NodeId>, BTreeSet<(String, NodeId)>>,
    /// The instances of each component, by the component's id. A component
    /// that's gone can still have instances here, until they're detached.
    instances: HashMap<NodeId, BTreeSet<NodeId>>,
    /// The old shared stylesheet, until [`crate::Design::migrate_css`]
    /// moves it into tokens. See [`Op::Css`].
    css: Option<String>,
    /// Pages by id. Empty for a design with only its implicit first page.
    pages: BTreeMap<String, Page>,
    /// Token values by name (see [`crate::tokens`]).
    tokens: BTreeMap<String, Values>,
    /// Modes by id. Empty for a design with only its implicit first mode.
    modes: BTreeMap<String, Mode>,
}

/// How many pages a design can have. Every page shows in the viewer's
/// sidebar and in `get_basic_info`.
pub const MAX_PAGES: usize = 100;

impl Document {
    pub fn from_nodes(nodes: impl IntoIterator<Item = Node>) -> Self {
        let nodes = nodes.into_iter();
        let mut doc = Self::default();
        doc.nodes.reserve(nodes.size_hint().0);
        for node in nodes {
            doc.insert(node);
        }
        doc
    }

    /// The document with `css` as its old shared stylesheet.
    pub fn with_css(mut self, css: Option<String>) -> Self {
        self.css = css.filter(|css| !css.is_empty());
        self
    }

    /// The old shared stylesheet, if the design still has one to migrate.
    pub fn css(&self) -> Option<&str> {
        self.css.as_deref()
    }

    /// The document with these tokens and modes.
    pub fn with_tokens(
        mut self,
        tokens: BTreeMap<String, Values>,
        modes: BTreeMap<String, Mode>,
    ) -> Self {
        self.tokens = tokens;
        self.modes = modes;
        self
    }

    /// Token values by name, in name order.
    pub fn tokens(&self) -> &BTreeMap<String, Values> {
        &self.tokens
    }

    /// Modes by id, as saved. Empty when the design has only its implicit first mode.
    pub fn mode_map(&self) -> &BTreeMap<String, Mode> {
        &self.modes
    }

    /// Modes in order, sorted by `(index, id)`. Never empty: a design
    /// without modes has its implicit [`FIRST_MODE`].
    pub fn modes(&self) -> Vec<(&str, &Mode)> {
        if self.modes.is_empty() {
            return vec![(FIRST_MODE, &IMPLICIT_MODE)];
        }
        let mut modes: Vec<(&str, &Mode)> =
            self.modes.iter().map(|(id, m)| (id.as_str(), m)).collect();
        modes.sort_by(|a, b| (&a.1.index, a.0).cmp(&(&b.1.index, b.0)));
        modes
    }

    /// The id of the first mode.
    pub fn first_mode(&self) -> &str {
        self.modes
            .iter()
            .min_by(|a, b| (&a.1.index, a.0).cmp(&(&b.1.index, b.0)))
            .map_or(FIRST_MODE, |(id, _)| id)
    }

    /// The mode an artboard renders in: its own mode if that exists, else the first mode.
    pub fn mode_of<'a>(&'a self, artboard: &'a Node) -> &'a str {
        match &artboard.mode {
            Some(mode) if self.modes.contains_key(mode) => mode,
            _ => self.first_mode(),
        }
    }

    /// The document with `pages` as its pages.
    pub fn with_pages(mut self, pages: BTreeMap<String, Page>) -> Self {
        self.pages = pages;
        self
    }

    /// Pages by id, as saved. Empty when the design has only its implicit first page.
    pub fn page_map(&self) -> &BTreeMap<String, Page> {
        &self.pages
    }

    /// Pages in order, sorted by `(index, id)`. Never empty: a design
    /// without pages has its implicit [`FIRST_PAGE`].
    pub fn pages(&self) -> Vec<(&str, &Page)> {
        if self.pages.is_empty() {
            return vec![(FIRST_PAGE, &IMPLICIT_PAGE)];
        }
        let mut pages: Vec<(&str, &Page)> =
            self.pages.iter().map(|(id, p)| (id.as_str(), p)).collect();
        pages.sort_by(|a, b| (&a.1.index, a.0).cmp(&(&b.1.index, b.0)));
        pages
    }

    /// The page with this id, including the implicit first page.
    pub fn page(&self, id: &str) -> Option<&Page> {
        match self.pages.get(id) {
            None if self.pages.is_empty() && id == FIRST_PAGE => Some(&IMPLICIT_PAGE),
            page => page,
        }
    }

    /// The id of the first page.
    pub fn first_page(&self) -> &str {
        self.pages
            .iter()
            .min_by(|a, b| (&a.1.index, a.0).cmp(&(&b.1.index, b.0)))
            .map_or(FIRST_PAGE, |(id, _)| id)
    }

    /// The page an artboard is on: its own page if that exists, else the first page.
    pub fn page_of<'a>(&'a self, artboard: &'a Node) -> &'a str {
        match &artboard.page {
            Some(page) if self.pages.contains_key(page) => page,
            _ => self.first_page(),
        }
    }

    /// The artboards on `page`, in sibling order.
    pub fn artboards_on(&self, page: &str) -> Vec<&Node> {
        let first = self.first_page();
        self.artboards()
            .into_iter()
            .filter(|board| match &board.page {
                Some(p) if self.pages.contains_key(p) => p == page,
                _ => first == page,
            })
            .collect()
    }

    /// Adds or replaces a node, keeping the child index current.
    fn insert(&mut self, node: Node) {
        self.remove(&node.id);
        let key = (node.index.clone(), node.id.clone());
        // Look up before inserting, so the parent's id is copied only for
        // its first child. Loading a snapshot inserts every node.
        match self.child_index.get_mut(&node.parent) {
            Some(siblings) => {
                siblings.insert(key);
            }
            None => {
                self.child_index
                    .insert(node.parent.clone(), BTreeSet::from([key]));
            }
        }
        if let Some(component) = &node.instance_of {
            self.link_instance(component, &node.id);
        }
        self.nodes.insert(node.id.clone(), node);
    }

    fn link_instance(&mut self, component: &str, id: &str) {
        self.instances
            .entry(component.to_owned())
            .or_default()
            .insert(id.to_owned());
    }

    fn unlink_instance(&mut self, component: &str, id: &str) {
        if let Some(ids) = self.instances.get_mut(component) {
            ids.remove(id);
            if ids.is_empty() {
                self.instances.remove(component);
            }
        }
    }

    fn remove(&mut self, id: &str) -> Option<Node> {
        let node = self.nodes.remove(id)?;
        if let Some(siblings) = self.child_index.get_mut(&node.parent) {
            siblings.remove(&(node.index.clone(), node.id.clone()));
            if siblings.is_empty() {
                self.child_index.remove(&node.parent);
            }
        }
        if let Some(component) = &node.instance_of {
            self.unlink_instance(component, id);
        }
        Some(node)
    }

    /// Whether any node is an instance of a component.
    pub fn has_instances(&self) -> bool {
        !self.instances.is_empty()
    }

    /// The ids of `component`'s instances, in id order.
    pub fn instances_of(&self, component: &str) -> impl Iterator<Item = &str> {
        self.instances
            .get(component)
            .into_iter()
            .flatten()
            .map(String::as_str)
    }

    /// Every component that has instances, with their ids.
    pub fn instance_lists(&self) -> impl Iterator<Item = (&str, impl Iterator<Item = &str>)> {
        self.instances
            .iter()
            .map(|(c, ids)| (c.as_str(), ids.iter().map(String::as_str)))
    }

    pub fn get(&self, id: &str) -> Option<&Node> {
        self.nodes.get(id)
    }

    pub fn contains(&self, id: &str) -> bool {
        self.nodes.contains_key(id)
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.values()
    }

    /// Children of `parent` (or artboards, for `None`) in sibling order.
    pub fn children(&self, parent: Option<&str>) -> Vec<&Node> {
        self.child_index
            .get(&parent.map(str::to_owned))
            .into_iter()
            .flatten()
            .filter_map(|(_, id)| self.nodes.get(id))
            .collect()
    }

    pub fn artboards(&self) -> Vec<&Node> {
        self.children(None)
    }

    /// `id` and all its descendants, parents before children, siblings in order.
    pub fn subtree(&self, id: &str) -> Vec<&Node> {
        let mut out = Vec::new();
        let mut stack: Vec<&Node> = self.nodes.get(id).into_iter().collect();
        while let Some(node) = stack.pop() {
            out.push(node);
            stack.extend(self.children(Some(&node.id)).into_iter().rev());
        }
        out
    }

    /// The artboard that contains `id` (which may be the artboard itself).
    pub fn artboard_of(&self, id: &str) -> Option<&Node> {
        let mut node = self.nodes.get(id)?;
        while let Some(parent) = &node.parent {
            node = self.nodes.get(parent)?;
        }
        Some(node)
    }

    /// How many ancestors `id` has: 0 for an artboard.
    pub fn depth(&self, id: &str) -> usize {
        let mut depth = 0;
        let mut current = self.nodes.get(id).and_then(|n| n.parent.as_deref());
        while let Some(p) = current {
            depth += 1;
            current = self.nodes.get(p).and_then(|n| n.parent.as_deref());
        }
        depth
    }

    /// How many levels the subtree at `id` spans below it: 0 for a leaf.
    pub fn height(&self, id: &str) -> usize {
        let mut height = 0;
        let mut stack = vec![(id, 0)];
        while let Some((id, level)) = stack.pop() {
            height = height.max(level);
            stack.extend(
                self.children(Some(id))
                    .iter()
                    .map(|c| (c.id.as_str(), level + 1)),
            );
        }
        height
    }

    pub fn is_ancestor(&self, ancestor: &str, id: &str) -> bool {
        let mut current = self.nodes.get(id).and_then(|n| n.parent.as_deref());
        while let Some(p) = current {
            if p == ancestor {
                return true;
            }
            current = self.nodes.get(p).and_then(|n| n.parent.as_deref());
        }
        false
    }

    /// The sibling right after `id`, or `None` if it's the last one.
    /// A range lookup in the child index, so duplicating many siblings
    /// doesn't scan the sibling list once per node.
    pub fn next_sibling(&self, id: &str) -> Option<&Node> {
        use std::ops::Bound::{Excluded, Unbounded};
        let node = self.nodes.get(id)?;
        let me = (node.index.clone(), node.id.clone());
        self.child_index
            .get(&node.parent)?
            .range((Excluded(me), Unbounded))
            .next()
            .and_then(|(_, next)| self.nodes.get(next))
    }

    /// The sibling index right after `id`, before its next sibling.
    pub fn index_after(&self, id: &str) -> Option<String> {
        let node = self.nodes.get(id)?;
        let next = self.next_sibling(id).map(|n| n.index.as_str());
        Some(crate::fractional::key_between(Some(&node.index), next))
    }

    /// Every parent's children ids in sibling order, artboards under `None`.
    /// The web viewer reads this once after loading a snapshot, to learn
    /// sibling order without sorting by index itself.
    pub fn child_lists(&self) -> impl Iterator<Item = (Option<&str>, impl Iterator<Item = &str>)> {
        self.child_index.iter().map(|(parent, children)| {
            (
                parent.as_deref(),
                children.iter().map(|(_, id)| id.as_str()),
            )
        })
    }

    /// `n` sibling indexes for inserting under `parent` at `position` (append when `None`).
    pub fn insertion_indexes(
        &self,
        parent: Option<&str>,
        position: Option<usize>,
        n: usize,
    ) -> Vec<String> {
        let siblings = self.children(parent);
        let at = position.unwrap_or(siblings.len()).min(siblings.len());
        let before = at.checked_sub(1).map(|i| siblings[i].index.as_str());
        let after = siblings.get(at).map(|n| n.index.as_str());
        crate::fractional::keys_between(before, after, n)
    }

    /// Whether a node can go under `parent`: an element, but not an
    /// instance, whose content comes from its component.
    fn can_parent(&self, parent: Option<&str>) -> bool {
        match parent {
            None => true,
            Some(p) => self
                .nodes
                .get(p)
                .is_some_and(|n| matches!(n.kind, NodeKind::Element { .. }) && !n.is_instance()),
        }
    }

    /// Applies `op` and returns the ops that undo it, or `None` if the op no
    /// longer applies (its node is gone, its parent was deleted, the value is
    /// unchanged, ...). Skipping stale ops is how undo stays safe when other
    /// actors have changed the document in the meantime.
    pub fn apply(&mut self, op: &Op) -> Option<Vec<Op>> {
        match self.try_apply(op) {
            Ok(Applied::Changed(inverse)) => Some(inverse),
            Ok(Applied::Unchanged) | Err(_) => None,
        }
    }

    /// [`Document::apply`], saying why an op didn't apply. An import uses
    /// this to refuse the whole import instead of skipping a stale op.
    pub fn try_apply(&mut self, op: &Op) -> Result<Applied, Rejected> {
        use Applied::{Changed, Unchanged};
        match op {
            Op::Create { node } => {
                if self.nodes.contains_key(&node.id) {
                    return Err(Rejected::Exists(node.id.clone()));
                }
                if !self.can_parent(node.parent.as_deref()) {
                    return Err(Rejected::NoParent(node.id.clone()));
                }
                if (node.is_instance() || node.component) && node.kind == NodeKind::Text {
                    return Err(Rejected::Invalid(node.id.clone()));
                }
                self.insert(node.clone());
                Ok(Changed(vec![Op::Delete {
                    id: node.id.clone(),
                }]))
            }
            Op::Delete { id } => {
                let removed: Vec<Node> = self.subtree(id).into_iter().cloned().collect();
                if removed.is_empty() {
                    return Err(Rejected::Missing(id.clone()));
                }
                for node in &removed {
                    self.remove(&node.id);
                }
                Ok(Changed(
                    removed
                        .into_iter()
                        .map(|node| Op::Create { node })
                        .collect(),
                ))
            }
            Op::Set { id, key, value } => {
                // `false` is how a component flag reads when it's unset.
                let unset = |v: &Value| v.is_null() || (*key == PropKey::Component && *v == false);
                let value = value.clone().filter(|v| !unset(v));
                let element = matches!(
                    self.nodes
                        .get(id)
                        .ok_or_else(|| Rejected::Missing(id.clone()))?
                        .kind,
                    NodeKind::Element { .. }
                );
                match key {
                    // Only an element without children can become an
                    // instance, and only an element can be a component.
                    PropKey::InstanceOf if value.is_some() => {
                        if !element || self.child_index.contains_key(&Some(id.clone())) {
                            return Err(Rejected::Invalid(id.clone()));
                        }
                    }
                    PropKey::Component if !element => return Err(Rejected::Invalid(id.clone())),
                    _ => {}
                }
                let node = self
                    .nodes
                    .get_mut(id)
                    .ok_or_else(|| Rejected::Missing(id.clone()))?;
                let previous = node.get(key);
                if previous == value {
                    return Ok(Unchanged);
                }
                let before = node.instance_of.clone();
                node.set(key, value)
                    .map_err(|_| Rejected::Invalid(id.clone()))?;
                if *key == PropKey::InstanceOf {
                    let after = node.instance_of.clone();
                    if let Some(c) = before {
                        self.unlink_instance(&c, id);
                    }
                    if let Some(c) = after {
                        self.link_instance(&c, id);
                    }
                }
                Ok(Changed(vec![Op::Set {
                    id: id.clone(),
                    key: key.clone(),
                    value: previous,
                }]))
            }
            Op::Move { id, parent, index } => {
                let node = self
                    .nodes
                    .get(id)
                    .ok_or_else(|| Rejected::Missing(id.clone()))?;
                if node.parent == *parent && node.index == *index {
                    return Ok(Unchanged);
                }
                if !crate::fractional::is_valid(index)
                    || !self.can_parent(parent.as_deref())
                    || parent.as_deref() == Some(id.as_str())
                    || parent.as_deref().is_some_and(|p| self.is_ancestor(id, p))
                {
                    return Err(Rejected::Invalid(id.clone()));
                }
                let inverse = Op::Move {
                    id: id.clone(),
                    parent: node.parent.clone(),
                    index: node.index.clone(),
                };
                let mut node = self.remove(id).expect("checked above");
                node.parent = parent.clone();
                node.index = index.clone();
                self.insert(node);
                Ok(Changed(vec![inverse]))
            }
            Op::Css { css } => {
                let css = css.clone().filter(|css| !css.is_empty());
                if css == self.css {
                    return Ok(Unchanged);
                }
                let previous = std::mem::replace(&mut self.css, css);
                Ok(Changed(vec![Op::Css { css: previous }]))
            }
            Op::Token {
                name,
                mode_id,
                value,
            } => {
                let previous = self.tokens.get(name).and_then(|v| v.get(mode_id)).cloned();
                if previous == *value {
                    return Ok(Unchanged);
                }
                let invalid = || Rejected::Invalid(name.clone());
                match value {
                    Some(value) => {
                        tokens::check_name(name).map_err(|_| invalid())?;
                        tokens::check_value(value).map_err(|_| invalid())?;
                        if !self.tokens.contains_key(name)
                            && self.tokens.len() >= tokens::MAX_TOKENS
                        {
                            return Err(invalid());
                        }
                        self.tokens
                            .entry(name.clone())
                            .or_default()
                            .insert(mode_id.clone(), value.clone());
                    }
                    None => {
                        let values = self.tokens.get_mut(name).expect("it had a value");
                        values.remove(mode_id);
                        if values.is_empty() {
                            self.tokens.remove(name);
                        }
                    }
                }
                Ok(Changed(vec![Op::Token {
                    name: name.clone(),
                    mode_id: mode_id.clone(),
                    value: previous,
                }]))
            }
            Op::Mode { id, mode } => {
                let previous = self.modes.get(id).cloned();
                if previous == *mode {
                    return Ok(Unchanged);
                }
                if mode.as_ref().is_some_and(|m| {
                    !crate::fractional::is_valid(&m.index)
                        || (previous.is_none() && self.modes.len() >= tokens::MAX_MODES)
                }) {
                    return Err(Rejected::Invalid(id.clone()));
                }
                match mode {
                    Some(mode) => self.modes.insert(id.clone(), mode.clone()),
                    None => self.modes.remove(id),
                };
                Ok(Changed(vec![Op::Mode {
                    id: id.clone(),
                    mode: previous,
                }]))
            }
            Op::Page { id, page } => {
                let previous = self.pages.get(id).cloned();
                if previous == *page {
                    return Ok(Unchanged);
                }
                if page
                    .as_ref()
                    .is_some_and(|p| !crate::fractional::is_valid(&p.index))
                {
                    return Err(Rejected::Invalid(id.clone()));
                }
                match page {
                    Some(page) => self.pages.insert(id.clone(), page.clone()),
                    None => self.pages.remove(id),
                };
                Ok(Changed(vec![Op::Page {
                    id: id.clone(),
                    page: previous,
                }]))
            }
        }
    }

    /// Applies `ops` in order. Returns the ops that took effect and the ops that
    /// undo all of them (already in the order they must run).
    pub fn apply_all(&mut self, ops: &[Op]) -> (Vec<Op>, Vec<Op>) {
        let mut applied = Vec::new();
        let mut inverse = Vec::new();
        for op in ops {
            if let Some(inv) = self.apply(op) {
                applied.push(op.clone());
                inverse.push(inv);
            }
        }
        (applied, inverse.into_iter().rev().flatten().collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn child(id: &str, parent: &str, index: &str) -> Node {
        Node {
            parent: Some(parent.into()),
            index: index.into(),
            ..Node::element(id, "div")
        }
    }

    fn doc() -> Document {
        let mut board = Node::element("a", "div");
        board.index = "V".into();
        Document::from_nodes([board, child("b", "a", "V"), child("c", "b", "V")])
    }

    #[test]
    fn delete_inverse_recreates_subtree() {
        let mut d = doc();
        let (_, inverse) = d.apply_all(&[Op::Delete { id: "a".into() }]);
        assert!(d.is_empty());
        d.apply_all(&inverse);
        assert_eq!(d.subtree("a").len(), 3);
    }

    #[test]
    fn set_inverse_restores_previous_value() {
        let mut d = doc();
        let set = |v: Value| Op::Set {
            id: "b".into(),
            key: PropKey::Style("color".into()),
            value: Some(v),
        };
        let (_, undo_red) = d.apply_all(&[set(json!("red"))]);
        let (_, undo_blue) = d.apply_all(&[set(json!("blue"))]);
        d.apply_all(&undo_blue);
        assert_eq!(d.get("b").unwrap().styles["color"], "red");
        d.apply_all(&undo_red);
        assert!(d.get("b").unwrap().styles.is_empty());
    }

    #[test]
    fn stale_ops_are_skipped() {
        let mut d = doc();
        let set = Op::Set {
            id: "c".into(),
            key: PropKey::Name,
            value: Some(json!("x")),
        };
        d.apply(&Op::Delete { id: "b".into() });
        assert!(d.apply(&set).is_none());
        // A child can't be recreated under a parent someone else deleted.
        assert!(
            d.apply(&Op::Create {
                node: child("z", "b", "V")
            })
            .is_none()
        );
    }

    #[test]
    fn move_rejects_cycles() {
        let mut d = doc();
        let op = Op::Move {
            id: "a".into(),
            parent: Some("c".into()),
            index: "V".into(),
        };
        assert!(d.apply(&op).is_none());
    }

    #[test]
    fn ops_parse_in_any_field_order_and_say_what_is_missing() {
        let op: Op = serde_json::from_value(
            json!({ "id": "a", "index": "V", "parent": null, "op": "move" }),
        )
        .unwrap();
        assert_eq!(
            op,
            Op::Move {
                id: "a".into(),
                parent: None,
                index: "V".into()
            }
        );
        // `value: null` and no value both clear the property.
        for set in [
            json!({ "op": "set", "id": "a", "key": "name", "value": null }),
            json!({ "op": "set", "id": "a", "key": "name" }),
        ] {
            let op: Op = serde_json::from_value(set).unwrap();
            assert!(matches!(op, Op::Set { value: None, .. }));
        }
        let err = serde_json::from_value::<Op>(json!({ "op": "create" })).unwrap_err();
        assert_eq!(err.to_string(), "missing field `node`");
        let err = serde_json::from_value::<Op>(json!({ "op": "nope", "id": "a" })).unwrap_err();
        assert!(err.to_string().contains("unknown variant `nope`"), "{err}");
        let node = json!({ "id": "e", "parent": null, "index": "V", "type": "element" });
        let err = serde_json::from_value::<Node>(node).unwrap_err();
        assert_eq!(err.to_string(), "missing field `tag`");
    }

    #[test]
    fn ops_round_trip_through_json() {
        let op = Op::Set {
            id: "a".into(),
            key: PropKey::Style("background-color".into()),
            value: Some(json!("#fff")),
        };
        let wire = serde_json::to_value(&op).unwrap();
        assert_eq!(wire["key"], "style:background-color");
        assert_eq!(serde_json::from_value::<Op>(wire).unwrap(), op);
        let node = serde_json::to_value(Node::text("t", "hi")).unwrap();
        assert_eq!(node["type"], "text");
    }

    #[test]
    fn child_index_follows_moves_and_deletes() {
        let mut d = doc();
        d.apply(&Op::Create {
            node: child("e", "a", "k"),
        });
        let ids = |d: &Document, parent: Option<&str>| -> Vec<String> {
            d.children(parent).iter().map(|n| n.id.clone()).collect()
        };
        assert_eq!(ids(&d, Some("a")), ["b", "e"]);
        // Reorder before b, then reparent under b.
        d.apply(&Op::Move {
            id: "e".into(),
            parent: Some("a".into()),
            index: "F".into(),
        });
        assert_eq!(ids(&d, Some("a")), ["e", "b"]);
        d.apply(&Op::Move {
            id: "e".into(),
            parent: Some("b".into()),
            index: "k".into(),
        });
        assert_eq!(ids(&d, Some("a")), ["b"]);
        assert_eq!(ids(&d, Some("b")), ["c", "e"]);
        d.apply(&Op::Delete { id: "b".into() });
        assert!(ids(&d, Some("a")).is_empty());
        assert!(ids(&d, Some("b")).is_empty());
        assert_eq!(ids(&d, None), ["a"]);
    }

    #[test]
    fn next_sibling_and_child_lists_follow_sibling_order() {
        let mut d = doc();
        d.apply(&Op::Create {
            node: child("e", "a", "F"),
        });
        assert_eq!(d.next_sibling("e").map(|n| n.id.as_str()), Some("b"));
        assert_eq!(d.next_sibling("b"), None);
        assert_eq!(d.next_sibling("missing"), None);
        let mut lists: Vec<(Option<&str>, Vec<&str>)> = d
            .child_lists()
            .map(|(parent, ids)| (parent, ids.collect()))
            .collect();
        lists.sort();
        assert_eq!(
            lists,
            [
                (None, vec!["a"]),
                (Some("a"), vec!["e", "b"]),
                (Some("b"), vec!["c"]),
            ]
        );
    }

    #[test]
    fn css_ops_replace_the_stylesheet_and_undo() {
        let mut d = doc();
        let set = Op::Css {
            css: Some(".btn { color: red; }".into()),
        };
        let inverse = d.apply(&set).unwrap();
        assert_eq!(d.css(), Some(".btn { color: red; }"));
        assert_eq!(inverse, [Op::Css { css: None }]);
        // The same stylesheet again changes nothing.
        assert_eq!(d.apply(&set), None);
        // Empty CSS is no stylesheet.
        assert_eq!(
            d.apply(&Op::Css {
                css: Some(String::new())
            }),
            Some(vec![set.clone()])
        );
        assert_eq!(d.css(), None);

        let wire = serde_json::to_value(&set).unwrap();
        assert_eq!(wire, json!({ "op": "css", "css": ".btn { color: red; }" }));
        assert_eq!(serde_json::from_value::<Op>(wire).unwrap(), set);
        let cleared: Op = serde_json::from_value(json!({ "op": "css" })).unwrap();
        assert_eq!(cleared, Op::Css { css: None });
    }
}
