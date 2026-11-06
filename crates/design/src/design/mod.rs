use std::collections::{BTreeMap, BTreeSet, HashMap};

use serde::{Deserialize, Serialize};

use crate::{
    ActorId, NodeId, actor,
    comment::{self, ChangeLog, Comment, Point},
    document::{Applied, Document, Op, Page, Rejected},
    edit::{self, EditError},
    history::{Entry, History},
    import::ImportRecord,
    node::Node,
    tokens::{Mode, Values},
};

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
    /// The old shared stylesheet, in designs saved before tokens. Loading
    /// one migrates it (see [`Design::migrate_css`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub css: Option<String>,
    /// The design's tokens by name (see [`crate::tokens`]).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub tokens: BTreeMap<String, Values>,
    /// The design's modes by id. Absent when it has only its implicit first mode.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub modes: BTreeMap<String, Mode>,
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
/// [`Design::transact`], [`Design::undo`] or [`Design::redo`], and all comment updates through
/// [`Design::add_comment`], [`Design::reply`], [`Design::set_resolved`],
/// [`Design::edit_message`], [`Design::set_audience`], [`Design::take`],
/// [`Design::pass`] or [`Design::delete_comment`].
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
    /// What recent changes set, for [`Design::merge`].
    sets: SetLog,
    /// Ids of comments that a change updated, for [`Design::take_comment_updates`].
    comment_updates: Vec<String>,
    /// Every import, oldest first. See [`Design::import`].
    imports: Vec<ImportRecord>,
    /// The document with its instances expanded, made when first asked for
    /// after a change. See [`Design::view`].
    view: std::sync::OnceLock<Document>,
}

/// An edit being staged by [`Design::transact`]. Ops apply as soon as
/// they're added, so each step sees the ones before it, and they're rolled
/// back if the transaction fails.
pub struct Transaction<'a> {
    doc: &'a mut Document,
    actor: &'a str,
    sets: &'a SetLog,
    comments: &'a [Comment],
    applied: Vec<Op>,
    /// Each applied op's inverse, in the order the ops applied.
    inverse: Vec<Vec<Op>>,
    /// The artboards the ops' nodes were on before the transaction, and
    /// where each of them was, as [`Design::commit`] notes them.
    before: BTreeSet<NodeId>,
    places: Vec<(NodeId, Point)>,
    /// [`Transaction::view`], made when first asked for after an op applied.
    view: std::cell::OnceCell<Document>,
    /// The imports this transaction made, kept with the change.
    imports: Vec<ImportRecord>,
}

impl<'a> Transaction<'a> {
    fn new(
        doc: &'a mut Document,
        actor: &'a str,
        sets: &'a SetLog,
        comments: &'a [Comment],
    ) -> Self {
        Self {
            doc,
            actor,
            sets,
            comments,
            applied: Vec::new(),
            inverse: Vec::new(),
            before: BTreeSet::new(),
            places: Vec::new(),
            view: std::cell::OnceCell::new(),
            imports: Vec::new(),
        }
    }

    /// The design's comments as they were when the transaction began. Edits
    /// never change them, so an op can warn about the ones it would orphan.
    pub fn comments(&self) -> &[Comment] {
        self.comments
    }

    /// The document with every op so far applied.
    pub fn doc(&self) -> &Document {
        self.doc
    }

    /// [`Transaction::doc`] as it renders, with instances expanded, like
    /// [`Design::view`]. Build edits against this and apply them with
    /// [`Transaction::edit`].
    pub fn view(&self) -> &Document {
        if !self.doc.has_instances() {
            return self.doc;
        }
        self.view
            .get_or_init(|| crate::components::expand(self.doc).into_owned())
    }

    /// Applies `ops` in order, or fails at the first one that doesn't apply.
    /// The ops before it stay applied until the transaction finishes or fails.
    pub fn apply(&mut self, ops: &[Op]) -> Result<(), Rejected> {
        // A created node wasn't on any artboard before, and the change log
        // finds where it ended up, so only the other ops need looking at.
        let creates = |op: &&Op| !matches!(op, Op::Create { .. });
        let boards = comment::artboards_of(self.doc, ops.iter().filter(creates));
        let new: BTreeSet<NodeId> = boards.difference(&self.before).cloned().collect();
        self.places.extend(board_places(self.doc, &new));
        self.before.extend(new);
        for op in ops {
            if let Applied::Changed(inverse) = self.doc.try_apply(op)? {
                self.applied.push(op.clone());
                self.inverse.push(inverse);
                self.view.take();
            }
        }
        Ok(())
    }

    /// Applies ops built against [`Transaction::view`]: edits inside an
    /// instance become its overrides first (`components::redirect`).
    /// `make_id` makes ids for those; ones already taken are skipped.
    pub fn edit(
        &mut self,
        ops: Vec<Op>,
        make_id: &mut impl FnMut() -> NodeId,
    ) -> Result<(), EditError> {
        let mut new_id = || self.new_id(make_id);
        let ops = crate::components::redirect(self.doc, ops, &mut new_id)?;
        Ok(self.apply(&ops)?)
    }

    /// An id from `make_id` that no node has, counting the nodes this
    /// transaction made, so ids stay unique across all of its steps.
    pub fn new_id(&self, make_id: &mut impl FnMut() -> NodeId) -> NodeId {
        crate::id::fresh(make_id, |id| self.doc.contains(id))
    }

    /// [`Design::merge`] against the document as staged. What this
    /// transaction applied so far counts as `actor`'s latest change.
    pub fn merge(&self, read_at: u64, ops: Vec<Op>) -> Merged {
        let staged = Sets::of(0, self.actor, self.inverse.iter().rev().flatten());
        merge(
            self.sets,
            staged.as_ref(),
            self.doc,
            self.actor,
            read_at,
            ops,
        )
    }

    /// Keeps `import`'s record with the design if the transaction
    /// succeeds. Undoing its change doesn't remove the record.
    pub fn record_import(&mut self, import: ImportRecord) {
        self.imports.push(import);
    }

    /// The ops applied so far, in order.
    pub fn applied(&self) -> &[Op] {
        &self.applied
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
            sets: SetLog::default(),
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
                .with_pages(snapshot.pages)
                .with_tokens(snapshot.tokens, snapshot.modes),
            seq: snapshot.seq,
            comments: snapshot.comments,
            histories: snapshot.histories.unwrap_or_default(),
            log: snapshot.log.unwrap_or_default(),
            sets: SetLog::starting_at(snapshot.seq),
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
            tokens: self.doc.tokens().clone(),
            modes: self.doc.mode_map().clone(),
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

    /// Moves a design's old shared CSS into tokens and its artboards'
    /// `<style>`s, once, after it loads (see [`edit::migrate_css`]). The
    /// saved undo steps may set the old CSS again, so they're dropped, and
    /// so is any history that could, even once the CSS was cleared.
    /// Returns the change to save, or `None` when there was nothing to move.
    /// `new_id` can return an id that's taken; it's asked again.
    pub fn migrate_css(
        &mut self,
        now: u64,
        new_id: &mut impl FnMut() -> NodeId,
    ) -> Result<Option<Change>, EditError> {
        if self.doc.css().is_none() {
            self.histories
                .retain(|_, history| !history.ops().any(|op| matches!(op, Op::Css { .. })));
            return Ok(None);
        }
        let doc = &self.doc;
        let mut fresh = || crate::id::fresh(new_id, |id| doc.contains(id));
        let ops = edit::migrate_css(doc, &mut fresh)?;
        self.histories.clear();
        let change = self.commit(actor::MIGRATION, "Moved shared CSS into tokens", &ops, now);
        self.forget_actor(actor::MIGRATION);
        Ok(change)
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

    /// The artboards changed after change `seq`, or `None` when that isn't
    /// known or a change (such as a token's) may have changed them all.
    pub fn artboards_changed_since(&self, seq: u64) -> Option<BTreeSet<NodeId>> {
        self.log.artboards_since(seq)
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

    pub(crate) fn history_mut(&mut self, actor: &str) -> &mut History {
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
        reattach(
            &self.doc,
            &mut self.comments,
            &mut self.comment_updates,
            &places,
        );
        let change = self.finish(actor, Origin::Edit, label, applied, &inverse, before, now);
        self.history_mut(actor).record(label.to_owned(), inverse);
        Some(change)
    }

    /// Runs `build` as one all-or-nothing change. `build` stages ops
    /// through the [`Transaction`], each against the document as the ops
    /// before it left it. If `build` fails, the document is put back as it
    /// was, and nothing is numbered, logged or recorded. Otherwise the ops
    /// become one change labelled `label` and one undo step for `actor`, and
    /// comments follow their artboards as after [`Design::commit`]. The
    /// imports `build` recorded ([`Transaction::record_import`]) are kept,
    /// even when they added nothing.
    pub fn transact<T, E>(
        &mut self,
        actor: &str,
        label: &str,
        now: u64,
        build: impl FnOnce(&mut Transaction<'_>) -> Result<T, E>,
    ) -> Result<(Option<Change>, T), E> {
        let mut tx = Transaction::new(&mut self.doc, actor, &self.sets, &self.comments);
        let output = match build(&mut tx) {
            Ok(output) => output,
            Err(error) => {
                if !tx.applied.is_empty() {
                    tx.roll_back();
                    self.view.take();
                }
                return Err(error);
            }
        };
        let Transaction {
            applied,
            inverse,
            before,
            places,
            imports,
            ..
        } = tx;
        self.imports.extend(imports);
        if applied.is_empty() {
            return Ok((None, output));
        }
        self.view.take();
        reattach(
            &self.doc,
            &mut self.comments,
            &mut self.comment_updates,
            &places,
        );
        let inverse: Vec<Op> = inverse.into_iter().rev().flatten().collect();
        let change = self.finish(actor, Origin::Edit, label, applied, &inverse, before, now);
        self.history_mut(actor).record(label.to_owned(), inverse);
        Ok((Some(change), output))
    }

    /// Stages `build` as [`Design::transact`] would and returns the ops that
    /// would apply, then puts the document back whatever happened. Nothing
    /// is numbered, logged or recorded.
    pub fn dry_run<T, E>(
        &mut self,
        actor: &str,
        build: impl FnOnce(&mut Transaction<'_>) -> Result<T, E>,
    ) -> Result<(Vec<Op>, T), E> {
        let mut tx = Transaction::new(&mut self.doc, actor, &self.sets, &self.comments);
        let result = build(&mut tx);
        let applied = std::mem::take(&mut tx.applied);
        if !applied.is_empty() {
            tx.roll_back();
            self.view.take();
        }
        result.map(|output| (applied, output))
    }

    /// Imports into the design with [`Design::transact`], and keeps the
    /// import's record that `build` returns for good: undoing the change
    /// doesn't remove it.
    pub fn import<T, E>(
        &mut self,
        actor: &str,
        label: &str,
        now: u64,
        build: impl FnOnce(&mut Transaction<'_>) -> Result<(ImportRecord, T), E>,
    ) -> Result<(Option<Change>, T), E> {
        self.transact(actor, label, now, |tx| {
            let (import, output) = build(tx)?;
            tx.record_import(import);
            Ok(output)
        })
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
        loop {
            let history = self.histories.get_mut(actor)?;
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
            let change = self.finish(actor, origin, &entry.label, applied, &inverse, before, now);
            let reverse = Entry {
                label: entry.label,
                ops: inverse,
            };
            let history = self
                .histories
                .get_mut(actor)
                .expect("the entry came from it");
            match origin {
                Origin::Undo => history.push_redo(reverse),
                _ => history.push_undo(reverse),
            }
            return Some(change);
        }
    }

    /// Numbers a change that has been applied and logs it. `inverse` undoes
    /// it. `before` holds the artboards its nodes were on before it applied,
    /// so a change that deletes nodes still counts as touching their artboard.
    #[allow(clippy::too_many_arguments)]
    fn finish(
        &mut self,
        actor: &str,
        origin: Origin,
        label: &str,
        ops: Vec<Op>,
        inverse: &[Op],
        before: BTreeSet<NodeId>,
        now: u64,
    ) -> Change {
        self.seq += 1;
        self.sets.record(self.seq, actor, inverse);
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
            // Replay doesn't keep inverses, so a merge can't look back past it.
            self.sets = SetLog::starting_at(change.seq);
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
}

mod comments;
mod three_way;

use comments::{board_places, reattach};
pub use three_way::{Kept, KeptNode, Merged};
use three_way::{SetLog, Sets, merge};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::comment::{Anchor, Audience, Author, AuthorKind};
    use crate::node::PropKey;
    use serde_json::json;

    pub(super) fn design() -> Design {
        Design::new(DesignMeta {
            id: "d".into(),
            name: "Test".into(),
            created_at: 0,
            updated_at: 0,
        })
    }

    pub(super) fn create(id: &str, parent: Option<&str>) -> Op {
        let mut node = Node::element(id, "div");
        node.parent = parent.map(Into::into);
        node.index = "V".into();
        Op::Create { node }
    }

    pub(super) fn color(id: &str, value: &str) -> Op {
        Op::Set {
            id: id.into(),
            key: PropKey::Style("color".into()),
            value: Some(json!(value)),
        }
    }

    pub(super) fn color_of(d: &Design, id: &str) -> Option<String> {
        d.doc().get(id)?.styles.get("color").cloned()
    }

    pub(super) fn author(id: &str, kind: AuthorKind) -> Author {
        Author {
            id: id.into(),
            name: id.into(),
            kind,
        }
    }

    pub(super) fn pin(d: &mut Design, artboard: &str) -> String {
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
        d.add_comment(user, anchor, Audience::Agents, "Make it red", &mut ids, 0)
            .unwrap()
            .id
            .clone()
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
    fn noop_edits_do_not_bump_seq() {
        let mut d = design();
        d.commit("alice", "board", &[create("a", None)], 1);
        d.commit("alice", "red", &[color("a", "red")], 2);
        assert!(d.commit("alice", "red", &[color("a", "red")], 3).is_none());
        assert_eq!(d.seq(), 2);
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
}
