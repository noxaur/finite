//! Comments: threads that users pin to the canvas to ask agents for changes.
//!
//! Comments sit beside the document, not in it, so they're never part of an
//! undo step. A reply from an agent links the edits it made since the
//! thread's previous message, which is how a viewer goes from a comment to the
//! change that answered it.

use std::{
    collections::{BTreeSet, VecDeque},
    fmt,
};

use serde::{Deserialize, Serialize};

use crate::{ActorId, Change, Document, NodeId, NodeKind, Op};

/// The longest comment or reply accepted, in characters.
pub const MAX_BODY: usize = 4000;
/// How many recent changes [`ChangeLog`] remembers.
const LOG_LIMIT: usize = 512;
/// How many nodes a [`ChangeRef`] lists.
const NODE_LIMIT: usize = 24;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthorKind {
    User,
    Agent,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Author {
    pub id: ActorId,
    pub name: String,
    pub kind: AuthorKind,
}

/// An edit linked from a reply: its change `seq`, label, and the outermost
/// elements it touched that still exist. A changed text node is listed as its
/// parent element.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangeRef {
    pub seq: u64,
    pub label: String,
    pub node_ids: Vec<NodeId>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub author: Author,
    pub body: String,
    /// Milliseconds since the Unix epoch.
    pub at: u64,
    /// The design's change counter when this was posted.
    pub seq: u64,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub changes: Vec<ChangeRef>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Comment {
    pub id: String,
    /// The artboard the pin sits on. `x` and `y` are relative to its top-left
    /// corner, so the pin follows the artboard. `None` pins to the canvas.
    pub artboard_id: Option<NodeId>,
    /// The element the user pointed at, so agents know what the comment is about.
    pub node_id: Option<NodeId>,
    pub x: f64,
    pub y: f64,
    pub resolved: bool,
    pub created_at: u64,
    /// The first message is the comment itself; the rest are replies.
    pub messages: Vec<Message>,
}

impl Comment {
    /// The `seq` of the latest message, or 0 for an empty thread.
    pub fn last_seq(&self) -> u64 {
        self.messages.last().map_or(0, |m| m.seq)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum CommentError {
    NotFound(String),
    NodeNotFound(NodeId),
    NotInArtboard { node: NodeId, artboard: NodeId },
    Empty,
    TooLong,
}

impl fmt::Display for CommentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotFound(id) => write!(f, "comment {id:?} not found"),
            Self::NodeNotFound(id) => write!(f, "node {id:?} not found"),
            Self::NotInArtboard { node, artboard } => {
                write!(f, "node {node:?} isn't inside artboard {artboard:?}")
            }
            Self::Empty => f.write_str("a comment can't be empty"),
            Self::TooLong => write!(f, "a comment can be at most {MAX_BODY} characters"),
        }
    }
}

impl std::error::Error for CommentError {}

/// Trims `body` and checks its length.
pub fn check_body(body: &str) -> Result<String, CommentError> {
    let body = body.trim();
    if body.is_empty() {
        return Err(CommentError::Empty);
    }
    if body.chars().count() > MAX_BODY {
        return Err(CommentError::TooLong);
    }
    Ok(body.to_owned())
}

/// Checks that a new comment's anchor exists: the artboard is an artboard, and
/// the node is inside it.
pub fn check_anchor(
    doc: &Document,
    artboard_id: Option<&str>,
    node_id: Option<&str>,
) -> Result<(), CommentError> {
    let Some(artboard) = artboard_id else {
        return match node_id {
            Some(node) => Err(CommentError::NodeNotFound(node.into())),
            None => Ok(()),
        };
    };
    match doc.get(artboard) {
        Some(board) if board.is_artboard() => {}
        _ => return Err(CommentError::NodeNotFound(artboard.into())),
    }
    if let Some(node) = node_id {
        match doc.artboard_of(node) {
            None => return Err(CommentError::NodeNotFound(node.into())),
            Some(board) if board.id != artboard => {
                return Err(CommentError::NotInArtboard {
                    node: node.into(),
                    artboard: artboard.into(),
                });
            }
            Some(_) => {}
        }
    }
    Ok(())
}

struct Logged {
    actor: ActorId,
    change: ChangeRef,
    artboards: BTreeSet<NodeId>,
}

/// The most recent changes to a design, with the artboards each one touched,
/// so a reply can link the edits its author made for a comment.
#[derive(Default)]
pub struct ChangeLog {
    entries: VecDeque<Logged>,
}

impl ChangeLog {
    /// Records `change`. `doc` is the document after it applied; `before` adds
    /// artboards it touched that no longer contain the node (such as a delete).
    pub fn record(&mut self, change: &Change, doc: &Document, before: BTreeSet<NodeId>) {
        let mut artboards = before;
        artboards.extend(artboards_of(doc, &change.ops));
        let mut node_ids: Vec<NodeId> = Vec::new();
        for op in &change.ops {
            let Some(node) = doc.get(op.id()) else { continue };
            let id = match (&node.kind, &node.parent) {
                (NodeKind::Text, Some(parent)) => parent,
                _ => &node.id,
            };
            if !node_ids.contains(id) {
                node_ids.push(id.clone());
            }
        }
        let outermost: Vec<NodeId> = node_ids
            .iter()
            .filter(|id| !node_ids.iter().any(|other| doc.is_ancestor(other, id)))
            .take(NODE_LIMIT)
            .cloned()
            .collect();
        self.entries.push_back(Logged {
            actor: change.actor.clone(),
            change: ChangeRef {
                seq: change.seq,
                label: change.label.clone(),
                node_ids: outermost,
            },
            artboards,
        });
        if self.entries.len() > LOG_LIMIT {
            self.entries.pop_front();
        }
    }

    /// `actor`'s changes after `seq`, oldest first. With `artboard`, only the
    /// changes that touched it.
    pub fn since(&self, actor: &str, seq: u64, artboard: Option<&str>) -> Vec<ChangeRef> {
        self.entries
            .iter()
            .filter(|e| e.actor == actor && e.change.seq > seq)
            .filter(|e| artboard.is_none_or(|a| e.artboards.contains(a)))
            .map(|e| e.change.clone())
            .collect()
    }
}

/// The artboards that contain the nodes `ops` target, as of `doc`.
pub fn artboards_of(doc: &Document, ops: &[Op]) -> BTreeSet<NodeId> {
    let mut out = BTreeSet::new();
    for op in ops {
        let mut add = |id: &str| {
            if let Some(board) = doc.artboard_of(id) {
                out.insert(board.id.clone());
            }
        };
        add(op.id());
        if let Op::Create { node } = op
            && let Some(parent) = &node.parent
        {
            add(parent);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Node, Origin};

    fn doc() -> Document {
        let mut board = Node::element("board", "div");
        board.index = "V".into();
        let mut child = Node::element("child", "div");
        child.parent = Some("board".into());
        child.index = "V".into();
        let mut text = Node::text("text", "Hi");
        text.parent = Some("child".into());
        text.index = "V".into();
        let mut other = Node::element("other", "div");
        other.index = "W".into();
        Document::from_nodes([board, child, text, other])
    }

    fn change(seq: u64, actor: &str, id: &str) -> Change {
        Change {
            seq,
            actor: actor.into(),
            origin: Origin::Edit,
            label: format!("Edit {id}"),
            ops: vec![Op::Set {
                id: id.into(),
                key: crate::PropKey::Name,
                value: None,
            }],
        }
    }

    #[test]
    fn anchors_must_exist_and_match() {
        let doc = doc();
        assert_eq!(check_anchor(&doc, Some("board"), Some("child")), Ok(()));
        assert_eq!(check_anchor(&doc, None, None), Ok(()));
        assert!(matches!(
            check_anchor(&doc, Some("child"), None),
            Err(CommentError::NodeNotFound(_))
        ));
        assert!(matches!(
            check_anchor(&doc, Some("other"), Some("child")),
            Err(CommentError::NotInArtboard { .. })
        ));
    }

    #[test]
    fn log_links_only_the_actors_changes_on_the_artboard() {
        let doc = doc();
        let mut log = ChangeLog::default();
        log.record(&change(1, "a", "child"), &doc, BTreeSet::new());
        log.record(&change(2, "b", "child"), &doc, BTreeSet::new());
        log.record(&change(3, "a", "other"), &doc, BTreeSet::new());
        log.record(&change(4, "a", "child"), &doc, BTreeSet::new());

        let linked = log.since("a", 1, Some("board"));
        assert_eq!(linked.iter().map(|c| c.seq).collect::<Vec<_>>(), [4]);
        assert_eq!(linked[0].node_ids, ["child"]);
        assert_eq!(log.since("a", 0, None).len(), 3);

        // A text edit links the element that holds the text.
        log.record(&change(5, "a", "text"), &doc, BTreeSet::new());
        assert_eq!(log.since("a", 4, None)[0].node_ids, ["child"]);
    }

    #[test]
    fn bodies_are_trimmed_and_checked() {
        assert_eq!(check_body("  hi \n").as_deref(), Ok("hi"));
        assert_eq!(check_body(" \n"), Err(CommentError::Empty));
        assert_eq!(check_body(&"x".repeat(MAX_BODY + 1)), Err(CommentError::TooLong));
    }
}
