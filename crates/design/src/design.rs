use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::{
    comment::Comment,
    document::{Document, Op},
    history::{Entry, History},
    node::Node,
};

/// Identifies whoever made a change: an agent's MCP session today, a user's tab later.
pub type ActorId = String;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignMeta {
    pub id: String,
    pub name: String,
    /// Milliseconds since the Unix epoch.
    pub created_at: u64,
    pub updated_at: u64,
}

/// Everything needed to rebuild a design. This is what gets persisted and what
/// a viewer receives when it connects.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub meta: DesignMeta,
    pub seq: u64,
    pub nodes: Vec<Node>,
    #[serde(default)]
    pub comments: Vec<Comment>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Origin {
    Edit,
    Undo,
    Redo,
}

/// A committed change, broadcast to every viewer. Replicas apply `ops` in
/// `seq` order and end up identical to the server's document.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub seq: u64,
    pub actor: ActorId,
    pub origin: Origin,
    pub label: String,
    pub ops: Vec<Op>,
}

/// A design (one canvas): its document, change counter, and per-actor histories.
///
/// The server holds one of these per open design and serializes access to it,
/// so it is the single source of truth. All edits go through [`Design::commit`],
/// [`Design::undo`] or [`Design::redo`].
#[derive(Debug)]
pub struct Design {
    pub meta: DesignMeta,
    /// Comment threads, oldest first. They aren't part of the document or its undo history.
    pub comments: Vec<Comment>,
    doc: Document,
    seq: u64,
    histories: HashMap<ActorId, History>,
}

impl Design {
    pub fn new(meta: DesignMeta) -> Self {
        Self {
            meta,
            comments: Vec::new(),
            doc: Document::default(),
            seq: 0,
            histories: HashMap::new(),
        }
    }

    pub fn from_snapshot(snapshot: Snapshot) -> Self {
        Self {
            meta: snapshot.meta,
            comments: snapshot.comments,
            doc: Document::from_nodes(snapshot.nodes),
            seq: snapshot.seq,
            histories: HashMap::new(),
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let mut nodes: Vec<Node> = self.doc.nodes().cloned().collect();
        nodes.sort_by(|a, b| a.id.cmp(&b.id));
        Snapshot {
            meta: self.meta.clone(),
            seq: self.seq,
            nodes,
            comments: self.comments.clone(),
        }
    }

    pub fn doc(&self) -> &Document {
        &self.doc
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn history(&self, actor: &str) -> Option<&History> {
        self.histories.get(actor)
    }

    pub fn history_mut(&mut self, actor: &str) -> &mut History {
        self.histories.entry(actor.to_owned()).or_default()
    }

    pub fn forget_actor(&mut self, actor: &str) {
        self.histories.remove(actor);
    }

    /// Applies an edit and records its inverse on `actor`'s undo stack.
    /// Returns `None` when nothing changed.
    pub fn commit(&mut self, actor: &str, label: &str, ops: &[Op], now: u64) -> Option<Change> {
        let (applied, inverse) = self.doc.apply_all(ops);
        if applied.is_empty() {
            return None;
        }
        self.history_mut(actor).record(label.to_owned(), inverse);
        Some(self.finish(actor, Origin::Edit, label, applied, now))
    }

    /// Reverses `actor`'s most recent change that still applies. Entries whose
    /// every op is stale (another actor deleted the nodes, say) are dropped.
    pub fn undo(&mut self, actor: &str, now: u64) -> Option<Change> {
        self.step(actor, Origin::Undo, now)
    }

    pub fn redo(&mut self, actor: &str, now: u64) -> Option<Change> {
        self.step(actor, Origin::Redo, now)
    }

    fn step(&mut self, actor: &str, origin: Origin, now: u64) -> Option<Change> {
        let history = self.histories.get_mut(actor)?;
        loop {
            let entry = match origin {
                Origin::Undo => history.pop_undo(),
                _ => history.pop_redo(),
            }?;
            let (applied, inverse) = self.doc.apply_all(&entry.ops);
            if applied.is_empty() {
                continue;
            }
            let reverse = Entry {
                label: entry.label.clone(),
                ops: inverse,
            };
            match origin {
                Origin::Undo => history.push_redo(reverse),
                _ => history.push_undo(reverse),
            }
            return Some(self.finish(actor, origin, &entry.label, applied, now));
        }
    }

    fn finish(
        &mut self,
        actor: &str,
        origin: Origin,
        label: &str,
        ops: Vec<Op>,
        now: u64,
    ) -> Change {
        self.seq += 1;
        self.meta.updated_at = now;
        Change {
            seq: self.seq,
            actor: actor.to_owned(),
            origin,
            label: label.to_owned(),
            ops,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::PropKey;
    use serde_json::json;

    fn design() -> Design {
        Design::new(DesignMeta {
            id: "d".into(),
            name: "Test".into(),
            created_at: 0,
            updated_at: 0,
        })
    }

    fn create(id: &str, parent: Option<&str>) -> Op {
        let mut node = Node::element(id, "div");
        node.parent = parent.map(Into::into);
        node.index = "V".into();
        Op::Create { node }
    }

    fn color(id: &str, value: &str) -> Op {
        Op::Set {
            id: id.into(),
            key: PropKey::Style("color".into()),
            value: Some(json!(value)),
        }
    }

    fn color_of(d: &Design, id: &str) -> Option<String> {
        d.doc().get(id)?.styles.get("color").cloned()
    }

    #[test]
    fn undo_only_reverses_own_changes() {
        let mut d = design();
        d.commit("alice", "board", &[create("a", None)], 1);
        d.commit("bob", "child", &[create("b", Some("a"))], 2);
        d.commit("alice", "red", &[color("b", "red")], 3);

        // Bob's undo removes his child, not Alice's later recolor.
        d.undo("bob", 4).unwrap();
        assert!(!d.doc().contains("b"));
        assert!(d.doc().contains("a"));

        // Alice's recolor targets a node Bob removed: it is skipped, and her
        // undo falls through to the next entry that still applies.
        let change = d.undo("alice", 5).unwrap();
        assert_eq!(change.label, "board");
        assert!(d.doc().is_empty());
    }

    #[test]
    fn undo_then_redo_returns_to_same_state() {
        let mut d = design();
        d.commit("alice", "board", &[create("a", None)], 1);
        d.commit("bob", "child", &[create("b", Some("a"))], 2);
        // Alice undoes her artboard, which also takes Bob's child with it...
        d.undo("alice", 3).unwrap();
        assert!(d.doc().is_empty());
        // ...and redo brings back both, because the inverse captured the subtree.
        d.redo("alice", 4).unwrap();
        assert!(d.doc().contains("a") && d.doc().contains("b"));
        assert_eq!(d.seq(), 4);
    }

    #[test]
    fn interleaved_property_edits() {
        let mut d = design();
        d.commit("alice", "board", &[create("a", None)], 1);
        d.commit("alice", "red", &[color("a", "red")], 2);
        d.commit("bob", "blue", &[color("a", "blue")], 3);
        // Last writer wins on the same property. Alice's undo restores what she
        // overwrote, as in Figma.
        d.undo("alice", 4).unwrap();
        assert_eq!(color_of(&d, "a"), None);
        d.undo("bob", 5).unwrap();
        assert_eq!(color_of(&d, "a").as_deref(), Some("red"));
    }

    #[test]
    fn new_edit_clears_redo() {
        let mut d = design();
        d.commit("alice", "board", &[create("a", None)], 1);
        d.commit("alice", "red", &[color("a", "red")], 2);
        d.undo("alice", 3).unwrap();
        d.commit("alice", "green", &[color("a", "green")], 4);
        assert!(d.redo("alice", 5).is_none());
    }

    #[test]
    fn batch_undoes_in_one_step() {
        let mut d = design();
        d.commit("alice", "board", &[create("a", None)], 1);
        d.history_mut("alice").begin_batch();
        for c in ["red", "green", "blue"] {
            d.commit("alice", "drag", &[color("a", c)], 2);
        }
        d.history_mut("alice").end_batch();
        d.undo("alice", 3).unwrap();
        assert_eq!(color_of(&d, "a"), None);
        d.redo("alice", 4).unwrap();
        assert_eq!(color_of(&d, "a").as_deref(), Some("blue"));
    }

    #[test]
    fn noop_edits_do_not_bump_seq() {
        let mut d = design();
        d.commit("alice", "board", &[create("a", None)], 1);
        d.commit("alice", "red", &[color("a", "red")], 2);
        assert!(d.commit("alice", "red", &[color("a", "red")], 3).is_none());
        assert_eq!(d.seq(), 2);
    }
}
