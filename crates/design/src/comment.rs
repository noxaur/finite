//! Comments: threads that users pin to the canvas to ask agents for changes.
//!
//! Comments sit beside the document, not in it, so they're never part of an
//! undo step. [`crate::Design`] owns them and enforces the thread rules:
//!
//! - A new comment must point at a real artboard, and its node must be inside it.
//! - An agent's reply links the edits that agent made to the comment's
//!   artboard since the thread's previous message (from [`ChangeLog`]). That's
//!   how a viewer goes from a comment to the change that answered it.
//! - A user's reply reopens a resolved comment. An agent's reply keeps the
//!   current state unless it asks to resolve or reopen.
//! - A person can edit their own message while it's the thread's newest, so
//!   never one an agent has already answered.

use std::{
    collections::{BTreeSet, HashSet, VecDeque},
    fmt,
};

use serde::{Deserialize, Serialize};

use crate::{ActorId, Change, Document, NodeId, NodeKind, Op};

/// The longest comment or reply accepted, in characters.
pub const MAX_BODY: usize = 4000;
/// The longest name a person can comment under, in characters.
pub const MAX_NAME: usize = 48;
/// The longest id a browser can pick for a person, in characters.
pub const MAX_USER_ID: usize = 64;
/// How many open comments a design can have. Anyone who can see a design can
/// comment on it, and every comment is saved, sent to every viewer and
/// loaded with the design, so there has to be a limit.
pub const MAX_OPEN: usize = 500;
/// How many messages one comment's thread can hold.
pub const MAX_MESSAGES: usize = 200;
/// How many elements one comment can point at, counting `node_id`.
pub const MAX_SELECTION: usize = 50;
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
    /// When its author last changed the body, in milliseconds since the Unix epoch.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub edited_at: Option<u64>,
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
    /// The other elements the user selected with it, in the order they picked them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extra_node_ids: Vec<NodeId>,
    pub x: f64,
    pub y: f64,
    pub resolved: bool,
    /// When it was last resolved, in milliseconds since the Unix epoch.
    /// Viewers no longer read it: a resolved pin leaves the canvas at once.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<u64>,
    pub created_at: u64,
    /// The first message is the comment itself; the rest are replies.
    pub messages: Vec<Message>,
    /// Where the pin was on the canvas when its artboard was deleted (or moved
    /// into another element). Viewers pin it there until the artboard is back.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detached_at: Option<Point>,
    /// The revision: 0 when posted, and one more after every change. A viewer
    /// gets a comment both on the socket and in reply to its own requests, and
    /// keeps whichever copy is newer.
    #[serde(default)]
    pub rev: u64,
}

/// A point on the canvas.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

impl Comment {
    /// The `seq` of the latest message, or 0 for an empty thread.
    pub fn last_seq(&self) -> u64 {
        self.messages.last().map_or(0, |m| m.seq)
    }

    /// Whether an agent should act on this: it's open, and a user wrote last.
    pub fn awaits_agent(&self) -> bool {
        !self.resolved
            && self
                .messages
                .last()
                .is_some_and(|m| m.author.kind == AuthorKind::User)
    }
}

/// Where a new comment is pinned. `x` and `y` are relative to the artboard's
/// top-left corner, or canvas coordinates when `artboard_id` is `None`.
#[derive(Clone, Debug, PartialEq)]
pub struct Anchor {
    pub artboard_id: Option<NodeId>,
    pub node_id: Option<NodeId>,
    /// More elements in the same artboard. They need a `node_id`.
    pub extra_node_ids: Vec<NodeId>,
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CommentError {
    NotFound(String),
    NodeNotFound(NodeId),
    NotInArtboard {
        node: NodeId,
        artboard: NodeId,
    },
    Empty,
    TooLong,
    BadPosition,
    TooManyOpen,
    ThreadFull,
    TooManyNodes,
    /// The same element twice, or extra elements without a `node_id`.
    BadSelection,
    /// Only the newest message can be edited, and only by its author.
    NotEditable,
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
            Self::BadPosition => f.write_str("x and y must be finite numbers"),
            Self::TooManyOpen => write!(
                f,
                "this design has {MAX_OPEN} open comments, the most it can have; resolve some first"
            ),
            Self::ThreadFull => write!(
                f,
                "this thread has {MAX_MESSAGES} messages, the most it can have; start a new comment"
            ),
            Self::TooManyNodes => {
                write!(f, "a comment can point at {MAX_SELECTION} elements at most")
            }
            Self::BadSelection => f.write_str(
                "a comment's elements must be different, and extra elements need a nodeId",
            ),
            Self::NotEditable => f.write_str(
                "only your own message can be edited, while it's the newest in the thread",
            ),
        }
    }
}

impl std::error::Error for CommentError {}

/// Trims `body` and checks its length.
pub(crate) fn check_body(body: &str) -> Result<String, CommentError> {
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
/// every node is a different element inside it.
pub(crate) fn check_anchor(doc: &Document, anchor: &Anchor) -> Result<(), CommentError> {
    if !anchor.x.is_finite() || !anchor.y.is_finite() {
        return Err(CommentError::BadPosition);
    }
    if anchor.node_id.is_none() && !anchor.extra_node_ids.is_empty() {
        return Err(CommentError::BadSelection);
    }
    let nodes: Vec<&str> = anchor
        .node_id
        .iter()
        .chain(&anchor.extra_node_ids)
        .map(|id| id.as_str())
        .collect();
    if nodes.len() > MAX_SELECTION {
        return Err(CommentError::TooManyNodes);
    }
    if nodes.iter().collect::<HashSet<_>>().len() < nodes.len() {
        return Err(CommentError::BadSelection);
    }
    let Some(artboard) = anchor.artboard_id.as_deref() else {
        return match nodes.first() {
            Some(node) => Err(CommentError::NodeNotFound((*node).into())),
            None => Ok(()),
        };
    };
    match doc.get(artboard) {
        Some(board) if board.is_artboard() => {}
        _ => return Err(CommentError::NodeNotFound(artboard.into())),
    }
    for node in nodes {
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

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Logged {
    actor: ActorId,
    change: ChangeRef,
    artboards: BTreeSet<NodeId>,
}

/// The most recent changes to a design, with the artboards each one touched,
/// so a reply can link the edits its author made for a comment. It's saved
/// with full snapshots, so replies still link edits made before a restart.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ChangeLog {
    entries: VecDeque<Logged>,
}

impl ChangeLog {
    /// Records `change`. `doc` is the document after it applied; `before` adds
    /// artboards it touched that no longer contain the node (such as a delete).
    pub(crate) fn record(&mut self, change: &Change, doc: &Document, before: BTreeSet<NodeId>) {
        let mut artboards = before;
        artboards.extend(artboards_of(doc, &change.ops));
        // A set, not a list: a big write touches tens of thousands of nodes,
        // and checking a list for each one took seconds.
        let mut node_ids: Vec<&str> = Vec::new();
        let mut touched: HashSet<&str> = HashSet::new();
        for op in &change.ops {
            let Some(node) = doc.get(op.id()) else {
                continue;
            };
            let id = match (&node.kind, &node.parent) {
                (NodeKind::Text, Some(parent)) => parent.as_str(),
                _ => node.id.as_str(),
            };
            if touched.insert(id) {
                node_ids.push(id);
            }
        }
        // The outermost: nodes with no touched ancestor. Walking up is at most
        // `MAX_DEPTH` steps per node.
        let has_touched_ancestor = |id: &str| {
            let mut parent = doc.get(id).and_then(|n| n.parent.as_deref());
            while let Some(p) = parent {
                if touched.contains(p) {
                    return true;
                }
                parent = doc.get(p).and_then(|n| n.parent.as_deref());
            }
            false
        };
        let outermost: Vec<NodeId> = node_ids
            .iter()
            .filter(|id| !has_touched_ancestor(id))
            .take(NODE_LIMIT)
            .map(|id| (*id).to_owned())
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
    pub(crate) fn since(&self, actor: &str, seq: u64, artboard: Option<&str>) -> Vec<ChangeRef> {
        self.entries
            .iter()
            .filter(|e| e.actor == actor && e.change.seq > seq)
            .filter(|e| artboard.is_none_or(|a| e.artboards.contains(a)))
            .map(|e| e.change.clone())
            .collect()
    }
}

/// The artboards that contain the nodes `ops` target, as of `doc`. An
/// edit to a component counts for the artboards its instances are on too,
/// since it changes what they show.
pub(crate) fn artboards_of<'a>(
    doc: &Document,
    ops: impl IntoIterator<Item = &'a Op>,
) -> BTreeSet<NodeId> {
    let mut out = BTreeSet::new();
    let mut seen = std::collections::HashSet::new();
    for op in ops {
        let mut add = |id: &str| {
            if !seen.insert(id.to_owned()) {
                return;
            }
            if let Some(board) = doc.artboard_of(id) {
                out.insert(board.id.clone());
            }
            for instance in crate::components::affected(doc, id) {
                if let Some(board) = doc.artboard_of(&instance) {
                    out.insert(board.id.clone());
                }
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

    fn anchor(artboard: Option<&str>, node: Option<&str>) -> Anchor {
        Anchor {
            artboard_id: artboard.map(Into::into),
            node_id: node.map(Into::into),
            extra_node_ids: Vec::new(),
            x: 0.0,
            y: 0.0,
        }
    }

    fn selection(nodes: &[&str]) -> Anchor {
        Anchor {
            extra_node_ids: nodes[1..].iter().map(|&id| id.into()).collect(),
            ..anchor(Some("board"), nodes.first().copied())
        }
    }

    #[test]
    fn anchors_must_exist_and_match() {
        let doc = doc();
        assert_eq!(
            check_anchor(&doc, &anchor(Some("board"), Some("child"))),
            Ok(())
        );
        assert_eq!(check_anchor(&doc, &anchor(None, None)), Ok(()));
        assert!(matches!(
            check_anchor(&doc, &anchor(Some("child"), None)),
            Err(CommentError::NodeNotFound(_))
        ));
        assert!(matches!(
            check_anchor(&doc, &anchor(Some("other"), Some("child"))),
            Err(CommentError::NotInArtboard { .. })
        ));
        let nowhere = Anchor {
            x: f64::NAN,
            ..anchor(None, None)
        };
        assert_eq!(check_anchor(&doc, &nowhere), Err(CommentError::BadPosition));
    }

    #[test]
    fn a_selection_is_different_elements_in_the_artboard() {
        let doc = doc();
        assert_eq!(check_anchor(&doc, &selection(&["child", "board"])), Ok(()));
        assert_eq!(
            check_anchor(&doc, &selection(&["child", "child"])),
            Err(CommentError::BadSelection)
        );
        assert!(matches!(
            check_anchor(&doc, &selection(&["child", "other"])),
            Err(CommentError::NotInArtboard { .. })
        ));
        let headless = Anchor {
            extra_node_ids: vec!["child".into()],
            ..anchor(Some("board"), None)
        };
        assert_eq!(
            check_anchor(&doc, &headless),
            Err(CommentError::BadSelection)
        );
        let many: Vec<String> = (0..=MAX_SELECTION).map(|i| format!("n{i}")).collect();
        let many: Vec<&str> = many.iter().map(String::as_str).collect();
        assert_eq!(
            check_anchor(&doc, &selection(&many)),
            Err(CommentError::TooManyNodes)
        );
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
        assert_eq!(
            check_body(&"x".repeat(MAX_BODY + 1)),
            Err(CommentError::TooLong)
        );
    }

    #[test]
    fn a_comment_awaits_an_agent_until_one_answers() {
        let message = |kind| Message {
            author: Author {
                id: "x".into(),
                name: "X".into(),
                kind,
            },
            body: "Hi".into(),
            at: 0,
            seq: 0,
            changes: Vec::new(),
            edited_at: None,
        };
        let mut comment = Comment {
            id: "c".into(),
            artboard_id: None,
            node_id: None,
            extra_node_ids: Vec::new(),
            x: 0.0,
            y: 0.0,
            resolved: false,
            resolved_at: None,
            created_at: 0,
            messages: vec![message(AuthorKind::User)],
            detached_at: None,
            rev: 0,
        };
        assert!(comment.awaits_agent());
        comment.messages.push(message(AuthorKind::Agent));
        assert!(!comment.awaits_agent(), "an agent answered");
        comment.messages.push(message(AuthorKind::User));
        assert!(comment.awaits_agent(), "the user replied");
        comment.resolved = true;
        assert!(!comment.awaits_agent(), "resolved");
    }
}
