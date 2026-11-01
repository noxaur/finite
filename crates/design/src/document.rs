use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Deserializer, Serialize, de::Error as _};
use serde_json::Value;

use crate::node::{Node, NodeId, NodeKind, PropKey};

/// The smallest unit of change. Every edit, from any actor, becomes a list of ops.
///
/// Applying an op returns its inverse, captured from the state at that moment.
/// Undo replays inverses (the command pattern), so it never restores a whole
/// snapshot and can't erase other actors' work.
///
/// Serialized with its kind in `op`, as in `{"op": "delete", "id": "4biyjm26"}`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
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
    /// Replaces the design's shared stylesheet, the CSS every artboard
    /// renders with, or removes it when `css` is `None`.
    Css {
        #[serde(default)]
        css: Option<String>,
    },
}

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
                    + strings(&node.styles)
                    + strings(&node.attrs)
            }
            Op::Delete { id } => BASE + id.len(),
            Op::Set { id, value, .. } => {
                BASE + id.len() + value.as_ref().and_then(Value::as_str).map_or(16, str::len)
            }
            Op::Move { id, index, .. } => BASE + id.len() + index.len(),
            Op::Css { css } => BASE + css.as_ref().map_or(0, String::len),
        }
    }

    /// The node this op creates, deletes or changes. Empty for [`Op::Css`],
    /// which changes the design rather than a node.
    pub fn id(&self) -> &str {
        match self {
            Op::Create { node } => &node.id,
            Op::Delete { id } | Op::Set { id, .. } | Op::Move { id, .. } => id,
            Op::Css { .. } => "",
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

/// The node tree of one design, stored flat by id, with an index from each
/// parent to its children in sibling order, and the design's shared CSS.
#[derive(Clone, Debug, Default)]
pub struct Document {
    nodes: HashMap<NodeId, Node>,
    /// Children of each parent (`None` for artboards), sorted by `(index, id)`.
    child_index: HashMap<Option<NodeId>, BTreeSet<(String, NodeId)>>,
    /// The shared stylesheet: CSS every artboard renders with, before its own
    /// `<style>` blocks and inline styles, so those still override it.
    css: Option<String>,
}

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

    /// The document with `css` as its shared stylesheet.
    pub fn with_css(mut self, css: Option<String>) -> Self {
        self.css = css.filter(|css| !css.is_empty());
        self
    }

    /// The shared stylesheet, if the design has one.
    pub fn css(&self) -> Option<&str> {
        self.css.as_deref()
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
        self.nodes.insert(node.id.clone(), node);
    }

    fn remove(&mut self, id: &str) -> Option<Node> {
        let node = self.nodes.remove(id)?;
        if let Some(siblings) = self.child_index.get_mut(&node.parent) {
            siblings.remove(&(node.index.clone(), node.id.clone()));
            if siblings.is_empty() {
                self.child_index.remove(&node.parent);
            }
        }
        Some(node)
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

    fn can_parent(&self, parent: Option<&str>) -> bool {
        match parent {
            None => true,
            Some(p) => matches!(
                self.nodes.get(p).map(|n| &n.kind),
                Some(NodeKind::Element { .. })
            ),
        }
    }

    /// Applies `op` and returns the ops that undo it, or `None` if the op no
    /// longer applies (its node is gone, its parent was deleted, the value is
    /// unchanged, ...). Skipping stale ops is how undo stays safe when other
    /// actors have changed the document in the meantime.
    pub fn apply(&mut self, op: &Op) -> Option<Vec<Op>> {
        match op {
            Op::Create { node } => {
                if self.nodes.contains_key(&node.id) || !self.can_parent(node.parent.as_deref()) {
                    return None;
                }
                self.insert(node.clone());
                Some(vec![Op::Delete {
                    id: node.id.clone(),
                }])
            }
            Op::Delete { id } => {
                let removed: Vec<Node> = self.subtree(id).into_iter().cloned().collect();
                if removed.is_empty() {
                    return None;
                }
                for node in &removed {
                    self.remove(&node.id);
                }
                Some(
                    removed
                        .into_iter()
                        .map(|node| Op::Create { node })
                        .collect(),
                )
            }
            Op::Set { id, key, value } => {
                let node = self.nodes.get_mut(id)?;
                let value = value.clone().filter(|v| !v.is_null());
                let previous = node.get(key);
                if previous == value {
                    return None;
                }
                node.set(key, value).ok()?;
                Some(vec![Op::Set {
                    id: id.clone(),
                    key: key.clone(),
                    value: previous,
                }])
            }
            Op::Move { id, parent, index } => {
                let node = self.nodes.get(id)?;
                if !crate::fractional::is_valid(index)
                    || !self.can_parent(parent.as_deref())
                    || parent.as_deref() == Some(id.as_str())
                    || parent.as_deref().is_some_and(|p| self.is_ancestor(id, p))
                    || (node.parent == *parent && node.index == *index)
                {
                    return None;
                }
                let inverse = Op::Move {
                    id: id.clone(),
                    parent: node.parent.clone(),
                    index: node.index.clone(),
                };
                let mut node = self.remove(id)?;
                node.parent = parent.clone();
                node.index = index.clone();
                self.insert(node);
                Some(vec![inverse])
            }
            Op::Css { css } => {
                let css = css.clone().filter(|css| !css.is_empty());
                if css == self.css {
                    return None;
                }
                let previous = std::mem::replace(&mut self.css, css);
                Some(vec![Op::Css { css: previous }])
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
