use std::collections::{BTreeSet, HashMap};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::node::{Node, NodeId, NodeKind, PropKey};

/// The smallest unit of change. Every edit, from any actor, becomes a list of ops.
///
/// Applying an op returns its inverse, captured from the state at that moment.
/// Undo replays inverses (the command pattern), so it never restores a whole
/// snapshot and can't erase other actors' work.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
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
}

impl Op {
    /// The node this op creates, deletes or changes.
    pub fn id(&self) -> &str {
        match self {
            Op::Create { node } => &node.id,
            Op::Delete { id } | Op::Set { id, .. } | Op::Move { id, .. } => id,
        }
    }
}

/// How deep nodes can nest. An artboard is at depth 0, its children at 1,
/// and so on. Exports, the outline and the browser's renderer walk the tree
/// recursively, so a much deeper tree would overflow the stack and abort the
/// server. (Chrome's HTML parser stops nesting at 512.)
pub const MAX_DEPTH: usize = 256;

/// The node tree of one design, stored flat by id, with an index from each
/// parent to its children in sibling order.
#[derive(Clone, Debug, Default)]
pub struct Document {
    nodes: HashMap<NodeId, Node>,
    /// Children of each parent (`None` for artboards), sorted by `(index, id)`.
    child_index: HashMap<Option<NodeId>, BTreeSet<(String, NodeId)>>,
}

impl Document {
    pub fn from_nodes(nodes: impl IntoIterator<Item = Node>) -> Self {
        let mut doc = Self::default();
        for node in nodes {
            doc.insert(node);
        }
        doc
    }

    /// Adds or replaces a node, keeping the child index current.
    fn insert(&mut self, node: Node) {
        self.remove(&node.id);
        self.child_index
            .entry(node.parent.clone())
            .or_default()
            .insert((node.index.clone(), node.id.clone()));
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

    /// The sibling index right after `id`, before its next sibling.
    pub fn index_after(&self, id: &str) -> Option<String> {
        let node = self.nodes.get(id)?;
        let siblings = self.children(node.parent.as_deref());
        let pos = siblings.iter().position(|n| n.id == id)?;
        let next = siblings.get(pos + 1).map(|n| n.index.as_str());
        Some(crate::fractional::key_between(Some(&node.index), next))
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
}
