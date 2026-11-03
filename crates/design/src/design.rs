use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::{
    NodeId,
    comment::{self, Anchor, Author, AuthorKind, ChangeLog, Comment, CommentError, Message, Point},
    document::{Applied, Document, Op, Page, Rejected},
    history::{Entry, History},
    import::ImportRecord,
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
    /// The shared stylesheet (see [`Document::css`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub css: Option<String>,
    /// The design's pages by id (see [`Page`]). Absent when it has only its
    /// implicit first page.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub pages: BTreeMap<String, Page>,
    #[serde(default)]
    pub comments: Vec<Comment>,
    /// Each actor's undo and redo stacks. Only in saved snapshots: the ones
    /// sent to viewers leave them out. See [`Design::snapshot_to_save`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub histories: Option<HashMap<ActorId, History>>,
    /// Recent changes, for linking replies to edits. Only in saved snapshots, like `histories`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub log: Option<ChangeLog>,
    /// Every import into the design, oldest first. Only in saved snapshots,
    /// like `histories`: viewers don't need them to draw the design.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub imports: Vec<ImportRecord>,
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

/// One entry in a design's journal: something that happened after its last
/// saved snapshot. Replaying a snapshot's journal with [`Design::replay`]
/// rebuilds the design, so the server can append small records instead of
/// rewriting the whole snapshot after every edit.
///
/// Replaying is idempotent: changes at or below the design's `seq` are
/// skipped, and comments and meta replace what's there. So a journal that
/// overlaps its snapshot (after a crash mid-compaction) replays safely.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum Record {
    Change {
        change: Change,
    },
    /// The whole comment, as it is after an update.
    Comment {
        comment: Comment,
    },
    CommentDeleted {
        id: String,
    },
    Meta {
        meta: DesignMeta,
    },
    /// An import and the change that added its nodes, in one record, so a
    /// crash can't keep one without the other. `change` is `None` when the
    /// import added nothing, like a file whose content was all quarantined.
    Import {
        import: ImportRecord,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        change: Option<Change>,
    },
}

/// A design (one canvas): its document, change counter, per-actor histories,
/// and comment threads.
///
/// The server holds one of these per open design and serializes access to it,
/// so it is the single source of truth. All edits go through [`Design::commit`],
/// [`Design::undo`] or [`Design::redo`], and all comment updates through
/// [`Design::add_comment`], [`Design::reply`], [`Design::set_resolved`],
/// [`Design::edit_message`] or [`Design::delete_comment`].
#[derive(Debug)]
pub struct Design {
    pub meta: DesignMeta,
    doc: Document,
    seq: u64,
    histories: HashMap<ActorId, History>,
    /// Comment threads, oldest first. They aren't part of the document or its undo history.
    comments: Vec<Comment>,
    /// Recent changes, so a reply can link the edits that answered a comment.
    log: ChangeLog,
    /// Ids of comments that a change updated, for [`Design::take_comment_updates`].
    comment_updates: Vec<String>,
    /// Every import, oldest first. See [`Design::import`].
    imports: Vec<ImportRecord>,
    /// The document with its instances expanded, made when first asked for
    /// after a change. See [`Design::view`].
    view: std::sync::OnceLock<Document>,
}

/// An edit being staged by [`Design::import`]. Ops apply as soon as they're
/// added, so each step sees the ones before it, and they're rolled back if
/// the import fails.
pub struct Transaction<'a> {
    doc: &'a mut Document,
    applied: Vec<Op>,
    /// Each applied op's inverse, in the order the ops applied.
    inverse: Vec<Vec<Op>>,
}

impl Transaction<'_> {
    /// The document with every op so far applied.
    pub fn doc(&self) -> &Document {
        self.doc
    }

    /// Applies `ops` in order, or fails at the first one that doesn't apply.
    /// The ops before it stay applied until the import finishes or fails.
    pub fn apply(&mut self, ops: &[Op]) -> Result<(), Rejected> {
        for op in ops {
            if let Applied::Changed(inverse) = self.doc.try_apply(op)? {
                self.applied.push(op.clone());
                self.inverse.push(inverse);
            }
        }
        Ok(())
    }

    fn roll_back(self) {
        for inverse in self.inverse.into_iter().rev() {
            self.doc.apply_all(&inverse);
        }
    }
}

impl Design {
    pub fn new(meta: DesignMeta) -> Self {
        Self {
            meta,
            doc: Document::default(),
            seq: 0,
            histories: HashMap::new(),
            comments: Vec::new(),
            log: ChangeLog::default(),
            comment_updates: Vec::new(),
            imports: Vec::new(),
            view: Default::default(),
        }
    }

    pub fn from_snapshot(snapshot: Snapshot) -> Self {
        Self {
            meta: snapshot.meta,
            doc: Document::from_nodes(snapshot.nodes)
                .with_css(snapshot.css)
                .with_pages(snapshot.pages),
            seq: snapshot.seq,
            comments: snapshot.comments,
            histories: snapshot.histories.unwrap_or_default(),
            log: snapshot.log.unwrap_or_default(),
            comment_updates: Vec::new(),
            imports: snapshot.imports,
            view: Default::default(),
        }
    }

    pub fn snapshot(&self) -> Snapshot {
        let mut nodes: Vec<Node> = self.doc.nodes().cloned().collect();
        nodes.sort_by(|a, b| a.id.cmp(&b.id));
        Snapshot {
            meta: self.meta.clone(),
            seq: self.seq,
            nodes,
            css: self.doc.css().map(str::to_owned),
            pages: self.doc.page_map().clone(),
            comments: self.comments.clone(),
            histories: None,
            log: None,
            imports: Vec::new(),
        }
    }

    /// A snapshot for the store: [`Design::snapshot`] plus every actor's
    /// history and the change log, so undo and reply links survive a restart.
    pub fn snapshot_to_save(&self) -> Snapshot {
        Snapshot {
            histories: (!self.histories.is_empty()).then(|| self.histories.clone()),
            log: Some(self.log.clone()),
            imports: self.imports.clone(),
            ..self.snapshot()
        }
    }

    pub fn doc(&self) -> &Document {
        &self.doc
    }

    /// The document as it renders: every instance shows its component's
    /// content, as nodes with virtual ids (see [`crate::components`]). It's
    /// the document itself when there are no instances. Tools that read
    /// the design read this, and edits are built against it.
    pub fn view(&self) -> &Document {
        if !self.doc.has_instances() {
            return &self.doc;
        }
        self.view
            .get_or_init(|| crate::components::expand(&self.doc).into_owned())
    }

    pub fn seq(&self) -> u64 {
        self.seq
    }

    pub fn history(&self, actor: &str) -> Option<&History> {
        self.histories.get(actor)
    }

    /// Records when `actor` was last active, for saving. Does nothing if
    /// the actor has no history here.
    pub fn set_last_used(&mut self, actor: &str, at: u64) {
        if let Some(history) = self.histories.get_mut(actor) {
            history.set_last_used(at);
        }
    }

    pub fn history_mut(&mut self, actor: &str) -> &mut History {
        self.histories.entry(actor.to_owned()).or_default()
    }

    /// Every actor with undo or redo history here.
    pub fn actors(&self) -> impl Iterator<Item = &str> {
        self.histories.keys().map(String::as_str)
    }

    /// Whether any actor still has undo or redo history here.
    pub fn has_histories(&self) -> bool {
        !self.histories.is_empty()
    }

    pub fn forget_actor(&mut self, actor: &str) {
        self.histories.remove(actor);
    }

    /// Applies an edit and records its inverse on `actor`'s undo stack.
    /// Returns `None` when nothing changed.
    pub fn commit(&mut self, actor: &str, label: &str, ops: &[Op], now: u64) -> Option<Change> {
        let before = comment::artboards_of(&self.doc, ops);
        let places = board_places(&self.doc, &before);
        let (applied, inverse) = self.doc.apply_all(ops);
        if applied.is_empty() {
            return None;
        }
        self.view.take();
        self.history_mut(actor).record(label.to_owned(), inverse);
        reattach(
            &self.doc,
            &mut self.comments,
            &mut self.comment_updates,
            &places,
        );
        Some(self.finish(actor, Origin::Edit, label, applied, before, now))
    }

    /// Imports into the design as one all-or-nothing change. `build` stages
    /// ops through the [`Transaction`], each against the document as the
    /// ops before it left it, and returns the import's record. If `build`
    /// fails, the document is put back as it was and nothing is recorded.
    /// Otherwise the ops become one undo step for `actor`, and the record is
    /// kept for good: undoing the change doesn't remove it.
    pub fn import<T, E>(
        &mut self,
        actor: &str,
        label: &str,
        now: u64,
        build: impl FnOnce(&mut Transaction<'_>) -> Result<(ImportRecord, T), E>,
    ) -> Result<(Option<Change>, T), E> {
        let mut tx = Transaction {
            doc: &mut self.doc,
            applied: Vec::new(),
            inverse: Vec::new(),
        };
        let (import, output) = match build(&mut tx) {
            Ok(built) => built,
            Err(error) => {
                tx.roll_back();
                self.view.take();
                return Err(error);
            }
        };
        let Transaction {
            applied, inverse, ..
        } = tx;
        // The expanded view was made before the import's nodes existed.
        self.view.take();
        self.imports.push(import);
        if applied.is_empty() {
            return Ok((None, output));
        }
        let inverse = inverse.into_iter().rev().flatten().collect();
        self.history_mut(actor).record(label.to_owned(), inverse);
        // An import only adds nodes, so no comment needs to move, and no
        // artboard was touched before it.
        let change = self.finish(actor, Origin::Edit, label, applied, BTreeSet::new(), now);
        Ok((Some(change), output))
    }

    /// Every import, oldest first.
    pub fn imports(&self) -> &[ImportRecord] {
        &self.imports
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
            let before = comment::artboards_of(&self.doc, &entry.ops);
            let places = board_places(&self.doc, &before);
            let (applied, inverse) = self.doc.apply_all(&entry.ops);
            if applied.is_empty() {
                continue;
            }
            self.view.take();
            reattach(
                &self.doc,
                &mut self.comments,
                &mut self.comment_updates,
                &places,
            );
            let reverse = Entry {
                label: entry.label.clone(),
                ops: inverse,
            };
            match origin {
                Origin::Undo => history.push_redo(reverse),
                _ => history.push_undo(reverse),
            }
            return Some(self.finish(actor, origin, &entry.label, applied, before, now));
        }
    }

    /// Numbers a change that has been applied and logs it. `before` holds the
    /// artboards its nodes were on before it applied, so a change that deletes
    /// nodes still counts as touching their artboard.
    fn finish(
        &mut self,
        actor: &str,
        origin: Origin,
        label: &str,
        ops: Vec<Op>,
        before: BTreeSet<NodeId>,
        now: u64,
    ) -> Change {
        self.seq += 1;
        self.meta.updated_at = now;
        let change = Change {
            seq: self.seq,
            actor: actor.to_owned(),
            origin,
            label: label.to_owned(),
            ops,
        };
        self.log.record(&change, &self.doc, before);
        change
    }

    /// Applies a journal record. A change also updates its actor's undo
    /// history the way the live call did (see `replay_with_history`), so
    /// undo keeps working after a crash.
    pub fn replay(&mut self, record: Record) {
        match record {
            Record::Change { change } => self.replay_change(change),
            Record::Import { import, change } => {
                if !self.imports.iter().any(|i| i.id == import.id) {
                    self.imports.push(import);
                }
                if let Some(change) = change {
                    self.replay_change(change);
                }
            }
            Record::Comment { comment } => {
                match self.comments.iter_mut().find(|c| c.id == comment.id) {
                    Some(existing) => *existing = comment,
                    None => self.comments.push(comment),
                }
            }
            Record::CommentDeleted { id } => self.comments.retain(|c| c.id != id),
            Record::Meta { meta } => self.meta = meta,
        }
    }

    fn replay_change(&mut self, change: Change) {
        if change.seq > self.seq {
            let before = comment::artboards_of(&self.doc, &change.ops);
            if !self.replay_with_history(&change) {
                self.doc.apply_all(&change.ops);
                // The saved undo steps don't explain this change, so
                // they may no longer fit the document. Drop them
                // rather than undo the wrong thing.
                self.histories.clear();
            }
            self.view.take();
            self.seq = change.seq;
            self.log.record(&change, &self.doc, before);
        }
    }

    /// Applies a journaled change and updates its actor's history the way the
    /// live call did, so undo still works after a crash. An edit records its
    /// inverse, as [`Design::commit`] does. An undo or redo takes the entry
    /// the live call took: the first from the top that still applies. If that
    /// entry doesn't produce the journaled ops, it's put back and this returns
    /// `false` with the document unchanged.
    fn replay_with_history(&mut self, change: &Change) -> bool {
        if change.origin == Origin::Edit {
            let (_, inverse) = self.doc.apply_all(&change.ops);
            self.history_mut(&change.actor)
                .record(change.label.clone(), inverse);
            return true;
        }
        let Some(mut history) = self.histories.get(&change.actor).cloned() else {
            return false;
        };
        loop {
            let entry = match change.origin {
                Origin::Undo => history.pop_undo(),
                _ => history.pop_redo(),
            };
            let Some(entry) = entry else { return false };
            let (applied, inverse) = self.doc.apply_all(&entry.ops);
            if applied.is_empty() {
                continue;
            }
            if applied != change.ops {
                self.doc.apply_all(&inverse);
                return false;
            }
            let reverse = Entry {
                label: entry.label,
                ops: inverse,
            };
            match change.origin {
                Origin::Undo => history.push_redo(reverse),
                _ => history.push_undo(reverse),
            }
            self.histories.insert(change.actor.clone(), history);
            return true;
        }
    }

    /// Comments a change has updated since the last call, so the server can
    /// send them to viewers and save them.
    pub fn take_comment_updates(&mut self) -> Vec<Comment> {
        let ids = std::mem::take(&mut self.comment_updates);
        self.comments
            .iter()
            .filter(|c| ids.contains(&c.id))
            .cloned()
            .collect()
    }

    pub fn comments(&self) -> &[Comment] {
        &self.comments
    }

    /// Pins a new comment, with `body` as its first message. `new_id` must
    /// return a fresh random id; it's called again if the id is taken.
    pub fn add_comment(
        &mut self,
        author: Author,
        anchor: Anchor,
        body: &str,
        new_id: &mut impl FnMut() -> String,
        now: u64,
    ) -> Result<&Comment, CommentError> {
        let body = comment::check_body(body)?;
        comment::check_anchor(self.view(), &anchor)?;
        self.check_room_to_open()?;
        let id = loop {
            let id = new_id();
            if !self.comments.iter().any(|c| c.id == id) {
                break id;
            }
        };
        self.comments.push(Comment {
            id,
            artboard_id: anchor.artboard_id,
            node_id: anchor.node_id,
            extra_node_ids: anchor.extra_node_ids,
            x: anchor.x,
            y: anchor.y,
            resolved: false,
            resolved_at: None,
            created_at: now,
            messages: vec![Message {
                author,
                body,
                at: now,
                seq: self.seq,
                changes: Vec::new(),
                edited_at: None,
            }],
            detached_at: None,
            rev: 0,
        });
        Ok(self.comments.last().expect("just pushed"))
    }

    /// Adds a reply to comment `id`. See [`crate::comment`] for how replies
    /// link changes and change the resolved state. `resolve` sets the state
    /// explicitly.
    pub fn reply(
        &mut self,
        id: &str,
        author: Author,
        body: &str,
        resolve: Option<bool>,
        now: u64,
    ) -> Result<&Comment, CommentError> {
        let body = comment::check_body(body)?;
        let room_to_open = self.check_room_to_open();
        let comment = find(&mut self.comments, id)?;
        if comment.messages.len() >= comment::MAX_MESSAGES {
            return Err(CommentError::ThreadFull);
        }
        let resolved = resolve.unwrap_or(comment.resolved && author.kind == AuthorKind::Agent);
        if comment.resolved && !resolved {
            room_to_open?;
        }
        let changes = match author.kind {
            AuthorKind::Agent => self.log.since(
                &author.id,
                comment.last_seq(),
                comment.artboard_id.as_deref(),
            ),
            AuthorKind::User => Vec::new(),
        };
        mark_resolved(comment, resolved, now);
        comment.messages.push(Message {
            author,
            body,
            at: now,
            seq: self.seq,
            changes,
            edited_at: None,
        });
        comment.rev += 1;
        Ok(comment)
    }

    pub fn set_resolved(
        &mut self,
        id: &str,
        resolved: bool,
        now: u64,
    ) -> Result<&Comment, CommentError> {
        let room_to_open = self.check_room_to_open();
        let comment = find(&mut self.comments, id)?;
        if comment.resolved && !resolved {
            room_to_open?;
        }
        mark_resolved(comment, resolved, now);
        comment.rev += 1;
        Ok(comment)
    }

    /// Replaces the body of comment `id`'s newest message, which must be by
    /// `author_id`.
    pub fn edit_message(
        &mut self,
        id: &str,
        author_id: &str,
        body: &str,
        now: u64,
    ) -> Result<&Comment, CommentError> {
        let body = comment::check_body(body)?;
        let comment = find(&mut self.comments, id)?;
        let message = comment
            .messages
            .last_mut()
            .filter(|m| m.author.id == author_id)
            .ok_or(CommentError::NotEditable)?;
        message.body = body;
        message.edited_at = Some(now);
        comment.rev += 1;
        Ok(comment)
    }

    pub fn delete_comment(&mut self, id: &str) -> Result<(), CommentError> {
        let index = self
            .comments
            .iter()
            .position(|c| c.id == id)
            .ok_or_else(|| CommentError::NotFound(id.into()))?;
        self.comments.remove(index);
        Ok(())
    }
}

/// Sets the resolved state, and when it went to resolved.
fn mark_resolved(comment: &mut Comment, resolved: bool, now: u64) {
    if resolved && !comment.resolved {
        comment.resolved_at = Some(now);
    }
    comment.resolved = resolved;
}

impl Design {
    /// Refuses another open comment, new or reopened, past [`comment::MAX_OPEN`].
    fn check_room_to_open(&self) -> Result<(), CommentError> {
        let open = self.comments.iter().filter(|c| !c.resolved).count();
        if open >= comment::MAX_OPEN {
            return Err(CommentError::TooManyOpen);
        }
        Ok(())
    }
}

/// Canvas positions of the given artboards, before a change applies.
fn board_places(doc: &Document, boards: &BTreeSet<NodeId>) -> Vec<(NodeId, Point)> {
    boards
        .iter()
        .filter_map(|id| doc.get(id))
        .filter(|board| board.is_artboard())
        .map(|board| {
            let at = Point {
                x: board.x.unwrap_or(0.0),
                y: board.y.unwrap_or(0.0),
            };
            (board.id.clone(), at)
        })
        .collect()
}

/// After a change: pins whose artboard is gone stay where they were on the
/// canvas, and pins whose artboard came back (by undo, say) follow it again.
/// The ids of comments it changes go on `updates`.
fn reattach(
    doc: &Document,
    comments: &mut [Comment],
    updates: &mut Vec<String>,
    places: &[(NodeId, Point)],
) {
    for comment in comments {
        let Some(board_id) = comment.artboard_id.as_deref() else {
            continue;
        };
        let on_canvas = doc.get(board_id).is_some_and(|n| n.is_artboard());
        let detached = match (on_canvas, comment.detached_at) {
            (true, Some(_)) => None,
            (false, None) => match places.iter().find(|(id, _)| id == board_id) {
                Some((_, at)) => Some(Point {
                    x: at.x + comment.x,
                    y: at.y + comment.y,
                }),
                None => continue,
            },
            _ => continue,
        };
        comment.detached_at = detached;
        comment.rev += 1;
        updates.push(comment.id.clone());
    }
}

fn find<'a>(comments: &'a mut [Comment], id: &str) -> Result<&'a mut Comment, CommentError> {
    comments
        .iter_mut()
        .find(|c| c.id == id)
        .ok_or_else(|| CommentError::NotFound(id.into()))
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
    fn an_import_shows_in_the_view_that_was_read_before_it() {
        let mut d = design();
        let mut ops = vec![create("a", None), create("bar", Some("a"))];
        ops.push(Op::Set {
            id: "bar".into(),
            key: PropKey::Component,
            value: Some(json!(true)),
        });
        let mut instance = Node::element("i", "div");
        instance.parent = Some("a".into());
        instance.index = "W".into();
        instance.instance_of = Some("bar".into());
        ops.push(Op::Create { node: instance });
        d.commit("alice", "setup", &ops, 1);
        // Reading the expanded view caches it.
        assert!(d.view().get("b").is_none());

        let record = crate::import::ImportRecord {
            id: "imp".into(),
            artifact: crate::import::BlobHash::of(b"x"),
            format: "html".into(),
            input_kind: "html".into(),
            file_name: None,
            received_at: 0,
            nodes: Default::default(),
            dependencies: Vec::new(),
            quarantined: Vec::new(),
        };
        let (change, ()) = d
            .import::<_, Rejected>("alice", "Import", 2, |tx| {
                tx.apply(&[create("b", None)])?;
                Ok((record, ()))
            })
            .unwrap();
        assert!(change.is_some());
        assert!(d.view().get("b").is_some(), "the import is in the view");
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

    fn author(id: &str, kind: AuthorKind) -> Author {
        Author {
            id: id.into(),
            name: id.into(),
            kind,
        }
    }

    fn pin(d: &mut Design, artboard: &str) -> String {
        let anchor = Anchor {
            artboard_id: Some(artboard.into()),
            node_id: Some(artboard.into()),
            extra_node_ids: Vec::new(),
            x: 10.0,
            y: 20.0,
        };
        let user = author("user:1", AuthorKind::User);
        let mut n = 0;
        let mut ids = || {
            n += 1;
            format!("c{n}")
        };
        d.add_comment(user, anchor, "Make it red", &mut ids, 0)
            .unwrap()
            .id
            .clone()
    }

    #[test]
    fn agent_reply_links_its_changes_and_resolves() {
        let mut d = design();
        d.commit(
            "agent",
            "boards",
            &[create("a", None), create("b", None)],
            1,
        );
        let id = pin(&mut d, "a");

        // Only the agent's change to the comment's artboard, made after the comment, is linked.
        d.commit("agent", "b red", &[color("b", "red")], 2);
        d.commit("other", "a blue", &[color("a", "blue")], 3);
        d.commit("agent", "a red", &[color("a", "red")], 4);
        let agent = author("agent", AuthorKind::Agent);
        let replied = d.reply(&id, agent, "Made it red", Some(true), 5).unwrap();
        assert!(replied.resolved);
        let reply = replied.messages.last().unwrap();
        assert_eq!(
            reply
                .changes
                .iter()
                .map(|c| c.label.as_str())
                .collect::<Vec<_>>(),
            ["a red"]
        );
        assert_eq!(reply.changes[0].node_ids, ["a"]);

        // A user's reply reopens the comment and links nothing.
        let user = author("user:1", AuthorKind::User);
        let reopened = d.reply(&id, user, "Darker", None, 6).unwrap();
        assert!(!reopened.resolved);
        assert!(reopened.messages.last().unwrap().changes.is_empty());
        assert_eq!(d.snapshot().comments.len(), 1);
    }

    #[test]
    fn only_the_newest_message_can_be_edited_by_its_author() {
        let mut d = design();
        d.commit("agent", "board", &[create("a", None)], 1);
        let id = pin(&mut d, "a");
        let edited = d.edit_message(&id, "user:1", " Make it blue ", 2).unwrap();
        assert_eq!(edited.messages[0].body, "Make it blue");
        assert_eq!(edited.messages[0].edited_at, Some(2));
        assert_eq!(edited.rev, 1);
        assert_eq!(
            d.edit_message(&id, "user:2", "Mine now", 3).unwrap_err(),
            CommentError::NotEditable
        );
        // Once an agent answers, the person's message isn't the newest.
        d.reply(&id, author("agent", AuthorKind::Agent), "Done", None, 4)
            .unwrap();
        assert_eq!(
            d.edit_message(&id, "user:1", "Actually red", 5)
                .unwrap_err(),
            CommentError::NotEditable
        );
    }

    #[test]
    fn resolving_stamps_when_and_deleting_survives_replay() {
        let mut d = design();
        d.commit("agent", "board", &[create("a", None)], 1);
        let id = pin(&mut d, "a");
        assert_eq!(d.set_resolved(&id, true, 7).unwrap().resolved_at, Some(7));
        // Resolving again keeps the first time.
        assert_eq!(d.set_resolved(&id, true, 9).unwrap().resolved_at, Some(7));
        let agent = author("agent", AuthorKind::Agent);
        d.set_resolved(&id, false, 10).unwrap();
        let resolved = d.reply(&id, agent, "Done", Some(true), 11).unwrap();
        assert_eq!(resolved.resolved_at, Some(11));

        let comment = resolved.clone();
        d.delete_comment(&id).unwrap();
        assert!(d.comments().is_empty());
        assert!(matches!(
            d.delete_comment(&id),
            Err(CommentError::NotFound(_))
        ));
        let mut restored = design();
        restored.replay(Record::Comment { comment });
        restored.replay(Record::CommentDeleted { id });
        assert!(restored.comments().is_empty());
    }

    #[test]
    fn shared_css_is_undoable_and_saved() {
        let mut d = design();
        let css = |css: &str| Op::Css {
            css: Some(css.into()),
        };
        d.commit("alice", "css", &[css(":root { --brand: red; }")], 1);
        d.commit("alice", "css", &[css(":root { --brand: blue; }")], 2);
        d.undo("alice", 3).unwrap();
        assert_eq!(d.doc().css(), Some(":root { --brand: red; }"));
        d.redo("alice", 4).unwrap();
        let saved = serde_json::to_string(&d.snapshot_to_save()).unwrap();
        let mut back = Design::from_snapshot(serde_json::from_str(&saved).unwrap());
        assert_eq!(back.doc().css(), Some(":root { --brand: blue; }"));
        back.undo("alice", 5).unwrap();
        back.undo("alice", 6).unwrap();
        assert_eq!(back.doc().css(), None);
        // A design without shared CSS doesn't mention it.
        assert!(
            serde_json::to_value(back.snapshot())
                .unwrap()
                .get("css")
                .is_none()
        );
    }

    #[test]
    fn every_comment_change_bumps_its_revision() {
        let mut d = design();
        d.commit("agent", "board", &[create("a", None)], 1);
        let id = pin(&mut d, "a");
        let rev = |d: &Design| d.comments()[0].rev;
        assert_eq!(rev(&d), 0);
        d.reply(&id, author("agent", AuthorKind::Agent), "Done", None, 2)
            .unwrap();
        d.set_resolved(&id, true, 3).unwrap();
        assert_eq!(rev(&d), 2);
        // Deleting the artboard moves the pin, and that's a change too.
        d.commit("agent", "delete", &[Op::Delete { id: "a".into() }], 3);
        assert_eq!(rev(&d), 3);
    }

    #[test]
    fn undo_that_deletes_nodes_still_links_to_their_artboard() {
        let mut d = design();
        d.commit("agent", "board", &[create("a", None)], 1);
        let id = pin(&mut d, "a");
        d.commit("agent", "child", &[create("b", Some("a"))], 2);
        // Undoing the child deletes it, so after the undo it's on no artboard.
        d.undo("agent", 3).unwrap();
        let agent = author("agent", AuthorKind::Agent);
        let replied = d.reply(&id, agent, "Tried and reverted", None, 4).unwrap();
        let seqs: Vec<_> = replied.messages[1].changes.iter().map(|c| c.seq).collect();
        assert_eq!(seqs, [2, 3]);
    }

    #[test]
    fn comments_and_threads_have_limits() {
        let mut d = design();
        d.commit("agent", "board", &[create("a", None)], 1);
        let ids: Vec<String> = (0..comment::MAX_OPEN).map(|_| pin(&mut d, "a")).collect();
        let anchor = Anchor {
            artboard_id: Some("a".into()),
            node_id: None,
            extra_node_ids: Vec::new(),
            x: 0.0,
            y: 0.0,
        };
        let user = author("user:1", AuthorKind::User);
        let more = d.add_comment(
            user.clone(),
            anchor.clone(),
            "One more",
            &mut || "z".into(),
            0,
        );
        assert_eq!(more.unwrap_err(), CommentError::TooManyOpen);

        // Resolving one makes room, and reopening it is refused once that room is taken.
        d.set_resolved(&ids[0], true, 0).unwrap();
        d.add_comment(user.clone(), anchor, "One more", &mut || "z".into(), 0)
            .unwrap();
        assert_eq!(
            d.set_resolved(&ids[0], false, 0).unwrap_err(),
            CommentError::TooManyOpen
        );
        // A person's reply would reopen it too.
        assert_eq!(
            d.reply(&ids[0], user.clone(), "Not done", None, 0)
                .unwrap_err(),
            CommentError::TooManyOpen
        );

        // A thread holds at most MAX_MESSAGES.
        let thread = &ids[1];
        for _ in 1..comment::MAX_MESSAGES {
            d.reply(thread, user.clone(), "And another thing", None, 0)
                .unwrap();
        }
        assert_eq!(
            d.reply(thread, user, "Too many", None, 0).unwrap_err(),
            CommentError::ThreadFull
        );
    }

    #[test]
    fn comments_must_point_at_real_nodes() {
        let mut d = design();
        let anchor = Anchor {
            artboard_id: Some("missing".into()),
            node_id: None,
            extra_node_ids: Vec::new(),
            x: 0.0,
            y: 0.0,
        };
        let user = author("user:1", AuthorKind::User);
        let result = d.add_comment(user, anchor, "Hi", &mut || "c".into(), 0);
        assert!(matches!(result, Err(CommentError::NodeNotFound(_))));
        let agent = author("agent", AuthorKind::Agent);
        assert!(matches!(
            d.reply("nope", agent, "Hi", None, 0),
            Err(CommentError::NotFound(_))
        ));
    }

    #[test]
    fn replaying_a_journal_rebuilds_the_design() {
        let mut live = design();
        let mut journal = Vec::new();
        for (seq, ops) in [(1, vec![create("a", None)]), (2, vec![color("a", "red")])] {
            let change = live.commit("alice", "edit", &ops, seq).unwrap();
            journal.push(Record::Change { change });
        }
        let id = pin(&mut live, "a");
        let comment = live.set_resolved(&id, true, 3).unwrap().clone();
        journal.push(Record::Comment { comment });
        live.meta.name = "Renamed".into();
        journal.push(Record::Meta {
            meta: live.meta.clone(),
        });

        let mut restored = design();
        // Replaying twice, as after a crash mid-compaction, changes nothing.
        for record in journal.iter().chain(&journal).cloned() {
            restored.replay(record);
        }
        let (a, b) = (live.snapshot(), restored.snapshot());
        assert_eq!(
            (a.seq, &a.nodes, &a.comments),
            (b.seq, &b.nodes, &b.comments)
        );
        assert_eq!(b.meta.name, "Renamed");
    }

    #[test]
    fn histories_survive_a_saved_snapshot_and_a_replayed_journal() {
        let mut live = design();
        live.commit("alice", "board", &[create("a", None)], 1);
        live.commit("alice", "red", &[color("a", "red")], 2);
        assert!(
            live.snapshot().histories.is_none(),
            "viewers never get histories"
        );

        // A clean restart: alice can still undo.
        let mut restored = Design::from_snapshot(live.snapshot_to_save());
        assert_eq!(restored.undo("alice", 3).unwrap().label, "red");
        assert_eq!(color_of(&restored, "a"), None);

        // After a crash, the journal replays what happened since the snapshot:
        // edits by two actors, an undo and a redo.
        let saved = live.snapshot_to_save();
        let mut journal = vec![
            live.commit("bob", "blue", &[color("a", "blue")], 3)
                .unwrap(),
            live.commit("alice", "green", &[color("a", "green")], 4)
                .unwrap(),
        ];
        journal.push(live.undo("alice", 5).unwrap());
        journal.push(live.undo("alice", 6).unwrap());
        journal.push(live.redo("alice", 7).unwrap());
        let mut crashed = Design::from_snapshot(saved);
        for change in journal {
            crashed.replay(Record::Change { change });
        }
        // Both now undo the same steps the same way.
        for actor in ["alice", "bob", "alice", "alice"] {
            let (a, b) = (live.undo(actor, 8), crashed.undo(actor, 8));
            assert_eq!(a.map(|c| c.ops), b.map(|c| c.ops), "{actor}");
            assert_eq!(color_of(&live, "a"), color_of(&crashed, "a"));
        }
    }

    #[test]
    fn replies_link_edits_made_before_a_restart() {
        let mut live = design();
        live.commit("agent", "board", &[create("a", None)], 1);
        let id = pin(&mut live, "a");
        live.commit("agent", "red", &[color("a", "red")], 2);
        let saved = live.snapshot_to_save();
        assert!(live.snapshot().log.is_none(), "viewers never get the log");
        let blue = live
            .commit("agent", "blue", &[color("a", "blue")], 3)
            .unwrap();

        // A clean restart from the snapshot, then a crash that replays the journal.
        let mut restored = Design::from_snapshot(saved);
        restored.replay(Record::Change { change: blue });
        let agent = author("agent", AuthorKind::Agent);
        let replied = restored.reply(&id, agent, "Done", None, 4).unwrap();
        let labels: Vec<&str> = replied.messages[1]
            .changes
            .iter()
            .map(|c| c.label.as_str())
            .collect();
        assert_eq!(labels, ["red", "blue"]);
    }

    #[test]
    fn a_change_its_history_doesnt_explain_drops_the_histories() {
        let mut live = design();
        live.commit("alice", "board", &[create("a", None)], 1);
        live.commit("alice", "red", &[color("a", "red")], 2);
        let saved = live.snapshot_to_save();
        // A journaled undo that doesn't match alice's saved top entry, as if
        // the saved history were from another timeline.
        let odd = Change {
            seq: 3,
            actor: "alice".into(),
            origin: Origin::Undo,
            label: "red".into(),
            ops: vec![color("a", "purple")],
        };
        let mut crashed = Design::from_snapshot(saved);
        crashed.replay(Record::Change { change: odd });
        assert_eq!(color_of(&crashed, "a").as_deref(), Some("purple"));
        assert!(crashed.undo("alice", 4).is_none());
    }

    #[test]
    fn pins_stay_put_when_their_artboard_goes_and_follow_it_back() {
        let mut d = design();
        let mut board = Node::element("a", "div");
        board.index = "V".into();
        board.x = Some(100.0);
        board.y = Some(50.0);
        d.commit("agent", "board", &[Op::Create { node: board }], 1);
        let id = pin(&mut d, "a");
        assert!(d.take_comment_updates().is_empty());

        d.commit("agent", "delete", &[Op::Delete { id: "a".into() }], 2);
        let updated = d.take_comment_updates();
        assert_eq!(updated.len(), 1);
        // The pin was 10, 20 into the artboard at 100, 50.
        assert_eq!(updated[0].detached_at, Some(Point { x: 110.0, y: 70.0 }));

        d.undo("agent", 3).unwrap();
        let updated = d.take_comment_updates();
        assert_eq!(updated[0].id, id);
        assert_eq!(updated[0].detached_at, None, "back on its artboard");
    }
}
