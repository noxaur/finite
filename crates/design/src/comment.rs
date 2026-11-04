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
//! - A waiting comment goes to one agent, picked by [`Comment::routed_to`]:
//!   the agent a person picked, else the agent that took it, else the agent
//!   that last edited its artboard, as long as that agent is listening.
//!   Otherwise the first listening agent to ask takes it.
//!   [`crate::Design::awaits`] is the one rule for "should this agent act now".
//! - A comment's [`Audience`] can make it a note between people, which never
//!   goes to an agent. An agent that reads a note can mark it so.
//! - An agent can pass on a comment, so it goes to another agent. A person's
//!   new message, an edit of it, or a new audience clears the passes.

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

/// Who a comment is for. It's any agent unless someone changes it with
/// [`crate::Design::set_audience`]. It holds for the whole thread.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Audience {
    /// Whichever agent [`Comment::routed_to`] picks. The default, so
    /// comments saved before audiences existed still wake agents.
    #[default]
    Agents,
    /// A note between people. It never wakes an agent.
    People,
    /// One agent, by actor id (`agent:…` or `mcp:…`), while it's listening.
    /// `name` is its name when it was picked, so a viewer can label the pin
    /// after the agent has gone.
    Agent { id: ActorId, name: String },
}

impl Audience {
    pub fn is_agents(&self) -> bool {
        matches!(self, Self::Agents)
    }
}

/// Whether `id` is an agent's actor id: `agent:…` or `mcp:…`.
pub fn is_agent(id: &str) -> bool {
    id.starts_with("agent:") || id.starts_with("mcp:")
}

/// Checks an audience a person picked: one agent must have an agent's id.
/// An empty name becomes the id, and a long one is clipped.
pub(crate) fn check_audience(audience: Audience) -> Result<Audience, CommentError> {
    let Audience::Agent { id, name } = audience else {
        return Ok(audience);
    };
    let rest = id.split_once(':').map(|(_, rest)| rest);
    if !is_agent(&id)
        || rest.is_none_or(|rest| rest.is_empty() || rest.chars().count() > MAX_USER_ID)
    {
        return Err(CommentError::BadAudience);
    }
    let name = match crate::label::clip(&name, MAX_NAME) {
        name if name.is_empty() => crate::label::clip(&id, MAX_NAME),
        name => name,
    };
    Ok(Audience::Agent { id, name })
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
    #[serde(default, skip_serializing_if = "Audience::is_agents")]
    pub audience: Audience,
    /// Agents that passed on it since a person last wrote in it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub passed_by: Vec<Author>,
    /// The agent that last took it to work on or replied in it, so a
    /// person's follow-up goes back to the same agent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub taken_by: Option<Author>,
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

    /// Whether an agent should act on it: it's open, a person wrote last, and
    /// it isn't a note for people.
    pub fn waiting(&self) -> bool {
        let person_last = self
            .messages
            .last()
            .is_some_and(|m| m.author.kind == AuthorKind::User);
        !self.resolved && person_last && self.audience != Audience::People
    }

    pub fn passed(&self, agent: &str) -> bool {
        self.passed_by.iter().any(|p| p.id == agent)
    }

    /// The agent this comment goes to, or `None` for the first agent that
    /// asks. It's the first of these that is `listening` and hasn't passed on
    /// it: the agent a person picked, the agent that took it, and
    /// `last_editor`, the agent that last edited its artboard.
    pub fn routed_to<'a>(
        &'a self,
        last_editor: Option<&'a str>,
        listening: impl Fn(&str) -> bool,
    ) -> Option<&'a str> {
        let picked = match &self.audience {
            Audience::Agent { id, .. } => Some(id.as_str()),
            _ => None,
        };
        [
            picked,
            self.taken_by.as_ref().map(|a| a.id.as_str()),
            last_editor,
        ]
        .into_iter()
        .flatten()
        .find(|id| listening(id) && !self.passed(id))
    }

    /// The name of agent `id`, as this comment knows it, or the id.
    pub fn agent_name<'a>(&'a self, id: &'a str) -> &'a str {
        match &self.audience {
            Audience::Agent { id: a, name } if a == id => name,
            _ => match &self.taken_by {
                Some(a) if a.id == id => &a.name,
                _ => id,
            },
        }
    }
}

/// What an agent listens to, for one `comments` call. The default admits
/// every comment.
#[derive(Clone, Debug, Default)]
pub struct Listening {
    /// Elements. A comment is in scope when its artboard or one of its
    /// elements is one of these or inside one.
    pub within: Option<HashSet<NodeId>>,
    /// A page id. A comment is in scope when its artboard is on that page.
    pub page: Option<String>,
    /// Only comments a person addressed to the agent itself.
    pub mentions: bool,
}

impl Listening {
    pub fn admits(&self, doc: &Document, comment: &Comment, me: &str) -> bool {
        if self.mentions && !matches!(&comment.audience, Audience::Agent { id, .. } if id == me) {
            return false;
        }
        let board = comment.artboard_id.as_deref().and_then(|id| doc.get(id));
        if let Some(page) = &self.page
            && board.is_none_or(|board| board.parent.is_some() || doc.page_of(board) != page)
        {
            return false;
        }
        let Some(within) = &self.within else {
            return true;
        };
        let inside = |id: &str| {
            let mut at = Some(id);
            while let Some(id) = at {
                if within.contains(id) {
                    return true;
                }
                at = doc.get(id).and_then(|n| n.parent.as_deref());
            }
            false
        };
        comment
            .artboard_id
            .iter()
            .chain(&comment.node_id)
            .chain(&comment.extra_node_ids)
            .any(|id| doc.contains(id) && inside(id))
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
    /// One agent named by an id that isn't an agent's.
    BadAudience,
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
            Self::BadAudience => f.write_str(
                "a comment can be for agents, for people, or for one agent by its id (agent:… or mcp:…)",
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

    /// The agent that made the latest logged change to `artboard`.
    pub(crate) fn last_agent_on(&self, artboard: &str) -> Option<&str> {
        self.entries
            .iter()
            .rev()
            .find(|e| is_agent(&e.actor) && e.artboards.contains(artboard))
            .map(|e| e.actor.as_str())
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

    fn message(kind: AuthorKind) -> Message {
        Message {
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
        }
    }

    fn comment(audience: Audience) -> Comment {
        Comment {
            id: "c".into(),
            artboard_id: Some("board".into()),
            node_id: Some("child".into()),
            extra_node_ids: Vec::new(),
            x: 0.0,
            y: 0.0,
            resolved: false,
            resolved_at: None,
            created_at: 0,
            messages: vec![message(AuthorKind::User)],
            detached_at: None,
            rev: 0,
            audience,
            passed_by: Vec::new(),
            taken_by: None,
        }
    }

    #[test]
    fn a_comment_waits_until_an_agent_answers() {
        let mut comment = comment(Audience::Agents);
        assert!(comment.waiting());
        comment.messages.push(message(AuthorKind::Agent));
        assert!(!comment.waiting(), "an agent answered");
        comment.messages.push(message(AuthorKind::User));
        assert!(comment.waiting(), "the user replied");
        comment.resolved = true;
        assert!(!comment.waiting(), "resolved");
        assert!(!self::comment(Audience::People).waiting(), "a note");
    }

    #[test]
    fn a_comment_goes_to_the_first_listening_agent_in_line() {
        let agent = |id: &str| Author {
            id: id.into(),
            name: id.into(),
            kind: AuthorKind::Agent,
        };
        let all = |_: &str| true;
        let mut c = comment(Audience::Agents);
        assert_eq!(c.routed_to(None, all), None, "anyone");
        assert_eq!(c.routed_to(Some("agent:e"), all), Some("agent:e"));
        c.taken_by = Some(agent("agent:t"));
        assert_eq!(c.routed_to(Some("agent:e"), all), Some("agent:t"));
        c.audience = Audience::Agent {
            id: "agent:p".into(),
            name: "P".into(),
        };
        assert_eq!(c.routed_to(Some("agent:e"), all), Some("agent:p"));
        assert_eq!(c.agent_name("agent:p"), "P");
        assert_eq!(
            c.routed_to(Some("agent:e"), |id| id != "agent:p"),
            Some("agent:t"),
            "the picked agent isn't listening"
        );
        c.passed_by.push(agent("agent:t"));
        assert_eq!(
            c.routed_to(Some("agent:e"), |id| id != "agent:p"),
            Some("agent:e"),
            "the agent that took it passed"
        );
        assert_eq!(c.routed_to(None, |id| id != "agent:p"), None);
    }

    #[test]
    fn an_audience_names_an_agent_by_its_id() {
        let agent = |id: &str, name: &str| Audience::Agent {
            id: id.into(),
            name: name.into(),
        };
        assert_eq!(
            check_audience(agent("agent:a", "  ")),
            Ok(agent("agent:a", "agent:a"))
        );
        assert_eq!(
            check_audience(agent("mcp:s1", "Claude")),
            Ok(agent("mcp:s1", "Claude"))
        );
        for id in ["", "agent:", "b7f3", "user:x"] {
            assert_eq!(
                check_audience(agent(id, "X")),
                Err(CommentError::BadAudience),
                "{id:?}"
            );
        }
        assert_eq!(check_audience(Audience::People), Ok(Audience::People));
    }

    #[test]
    fn old_comments_are_for_agents() {
        let mut json = serde_json::to_value(comment(Audience::Agents)).unwrap();
        assert!(json.get("audience").is_none(), "the default isn't written");
        json.as_object_mut().unwrap().remove("passedBy");
        let loaded: Comment = serde_json::from_value(json).unwrap();
        assert_eq!(loaded.audience, Audience::Agents);
        assert!(loaded.passed_by.is_empty());
        let people = serde_json::to_value(comment(Audience::People)).unwrap();
        assert_eq!(people["audience"], serde_json::json!({"kind": "people"}));
    }

    #[test]
    fn listening_admits_comments_on_its_part() {
        let doc = doc();
        let on_board = comment(Audience::Agents);
        let elsewhere = Comment {
            artboard_id: Some("other".into()),
            node_id: None,
            ..comment(Audience::Agents)
        };
        let canvas = Comment {
            artboard_id: None,
            node_id: None,
            ..comment(Audience::Agents)
        };
        let all = Listening::default();
        assert!(all.admits(&doc, &on_board, "agent:a"));
        assert!(all.admits(&doc, &canvas, "agent:a"));

        let within = |ids: &[&str]| Listening {
            within: Some(ids.iter().map(|&id| id.to_owned()).collect()),
            ..Listening::default()
        };
        assert!(within(&["board"]).admits(&doc, &on_board, "agent:a"));
        assert!(within(&["child"]).admits(&doc, &on_board, "agent:a"));
        assert!(!within(&["text"]).admits(&doc, &on_board, "agent:a"));
        assert!(!within(&["board"]).admits(&doc, &elsewhere, "agent:a"));
        assert!(!within(&["board"]).admits(&doc, &canvas, "agent:a"));

        let page = Listening {
            page: Some(crate::FIRST_PAGE.into()),
            ..Listening::default()
        };
        assert!(page.admits(&doc, &on_board, "agent:a"));
        assert!(
            !page.admits(&doc, &canvas, "agent:a"),
            "canvas pins are on no page"
        );

        let mentions = Listening {
            mentions: true,
            ..Listening::default()
        };
        assert!(!mentions.admits(&doc, &on_board, "agent:a"));
        let mine = comment(Audience::Agent {
            id: "agent:a".into(),
            name: "A".into(),
        });
        assert!(mentions.admits(&doc, &mine, "agent:a"));
        assert!(!mentions.admits(&doc, &mine, "agent:b"));
    }
}
