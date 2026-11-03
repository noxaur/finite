//! The browser's copy of a design's document, as the web viewer drives it.
//!
//! Inputs and results are JSON, so a whole change crosses into WebAssembly
//! in one call, however many ops it holds. Each op's result says what the
//! op touched, which is all the viewer needs to keep its own read cache of
//! nodes and sibling order in step without knowing the rules.

use std::collections::BTreeSet;

use finite_design::{
    Document, Node, NodeId, Op, Page, PropKey, components, html,
    tokens::{self, Mode, Values},
    user_edit::{self, UserEdit},
};
use serde::Serialize;

/// What applying one op touched. The viewer's `Applied` type in
/// `apps/web/src/design/replica.ts` reads this shape.
#[derive(Serialize)]
#[serde(tag = "op", rename_all = "camelCase")]
enum Applied<'a> {
    /// The node is the one in the op. `before` is its next sibling, or
    /// `None` when it's the last child.
    Create {
        before: Option<&'a str>,
    },
    /// `removed` lists the deleted node and its descendants, parents first.
    Delete {
        parent: Option<&'a str>,
        removed: Vec<&'a str>,
    },
    Set {
        node: &'a Node,
    },
    Move {
        node: &'a Node,
        /// The parent the node moved away from.
        from: Option<&'a str>,
        before: Option<&'a str>,
    },
    /// The old shared stylesheet changed. Only journals from before
    /// tokens hold it, so the viewer has nothing to draw.
    Css,
    /// The token `name` now has `values`, all its modes' values, or is gone
    /// when it's `None`.
    Token {
        name: &'a str,
        values: Option<&'a Values>,
    },
    /// The mode `id` is now `mode`, or was removed when it's `None`.
    Mode {
        id: &'a str,
        mode: Option<&'a Mode>,
    },
    /// The page `id` is now `page`, or was removed when it's `None`.
    Page {
        id: &'a str,
        page: Option<&'a Page>,
    },
}

#[derive(Debug, Default)]
pub struct Replica {
    /// The server's document with this tab's own edits on top: `pending`,
    /// then `draft`. With neither, it's the server's document exactly.
    doc: Document,
    /// Instances whose content changed since [`Replica::take_dirty`], so
    /// the viewer can draw them again.
    dirty: BTreeSet<NodeId>,
    /// Edits this tab sent that the server hasn't answered yet, oldest first.
    pending: Vec<Local>,
    /// The edits of the gesture in progress. They're never sent as they
    /// are: the gesture replaces them every frame, then proposes them.
    draft: Option<Local>,
    /// The expanded view of the document under the draft, which a gesture
    /// plans against every frame. Expanding a big design with instances
    /// takes tens of milliseconds, and the draft doesn't change it.
    base_view: Option<Document>,
    /// The tab's id in its stamps. New nodes' ids are made from it, as the
    /// server makes them (`user_edit::new_ids`).
    client: String,
}

/// One of this tab's edits, applied before the server confirms it.
#[derive(Debug)]
struct Local {
    /// The mutation's id in this tab, `None` for the draft.
    mid: Option<u64>,
    /// The mutation id its new nodes' ids are made from. The draft's is
    /// the id it will be sent as, so proposing it keeps them.
    seed: u64,
    edits: Vec<UserEdit>,
    /// Undoes it, read from the document it applied to.
    inverse: Vec<Op>,
}

/// What a call on the local layer did, as JSON for the viewer: every op
/// it applied, in order, with what each touched, as [`Replica::apply`]
/// reports it.
#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Outcome {
    patches: Vec<serde_json::Value>,
    /// Why the edits asked for couldn't be planned.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    /// Pending mutations that no longer plan on the server's newer
    /// document, so they were dropped.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    dropped: Vec<u64>,
    /// Why the draft no longer plans, after the server's change.
    #[serde(skip_serializing_if = "Option::is_none")]
    draft_lost: Option<String>,
}

impl Replica {
    pub fn document(&self) -> &Document {
        &self.doc
    }

    /// Replaces the document with the nodes in `nodes`, a JSON array.
    /// Returns every parent's children in sibling order, as JSON pairs of
    /// parent id (`null` for artboards) and child ids.
    ///
    /// A snapshot replaces this tab's own edits too: the ones it sent may
    /// be in it already, and resending them could do them twice.
    pub fn load(&mut self, nodes: &str) -> Result<String, String> {
        let nodes: Vec<Node> = serde_json::from_str(nodes).map_err(|e| e.to_string())?;
        self.doc = Document::from_nodes(nodes);
        self.dirty.clear();
        self.pending.clear();
        self.draft = None;
        self.base_view = None;
        let lists: Vec<(Option<&str>, Vec<&str>)> = self
            .doc
            .child_lists()
            .map(|(parent, children)| (parent, children.collect()))
            .collect();
        Ok(serde_json::to_string(&lists).expect("ids serialize"))
    }

    /// Applies `ops`, a JSON array, in order, with the same rules as the
    /// server (`Document::apply`). Returns a JSON array with one entry per
    /// op: what it touched, or `null` when it didn't apply.
    pub fn apply(&mut self, ops: &str) -> Result<String, String> {
        let ops: Vec<Op> = serde_json::from_str(ops).map_err(|e| e.to_string())?;
        self.base_view = None;
        let mut out = Vec::with_capacity(ops.len() * 24 + 2);
        out.push(b'[');
        for (i, op) in ops.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            if self
                .step(op, |applied| {
                    serde_json::to_writer(&mut out, applied).expect("results serialize")
                })
                .is_none()
            {
                out.extend_from_slice(b"null");
            }
        }
        out.push(b']');
        Ok(String::from_utf8(out).expect("serde_json writes UTF-8"))
    }

    /// Applies one op, notes the instances it changes, and hands what it
    /// touched to `each`. Returns its inverse, or `None` if it didn't apply.
    fn step(&mut self, op: &Op, each: impl FnOnce(&Applied)) -> Option<Vec<Op>> {
        let before = self.shown_by(op, true);
        let inverse = self.doc.apply(op)?;
        self.dirty.extend(before);
        let after = self.shown_by(op, false);
        self.dirty.extend(after);
        each(&describe(&self.doc, op, &inverse));
        Some(inverse)
    }

    /// Applies `ops` and adds each one that applied to `outcome`, with what
    /// it touched. Returns the ops that undo them all.
    fn run(&mut self, ops: &[Op], outcome: &mut Outcome) -> Vec<Op> {
        let mut inverses = Vec::new();
        for op in ops {
            let mut touched = serde_json::Value::Null;
            if let Some(inverse) = self.step(op, |applied| {
                touched = serde_json::to_value(applied).expect("results serialize");
            }) {
                outcome
                    .patches
                    .push(serde_json::json!({ "op": op, "touched": touched }));
                inverses.push(inverse);
            }
        }
        inverses.into_iter().rev().flatten().collect()
    }

    /// Plans `edits` against the document as it is now, with the same
    /// function the server runs, and applies them.
    fn plan(
        &mut self,
        mid: Option<u64>,
        seed: u64,
        edits: Vec<UserEdit>,
        outcome: &mut Outcome,
    ) -> Result<Local, String> {
        let view = self
            .base_view
            .get_or_insert_with(|| components::expand(&self.doc).into_owned());
        // The server makes the same ids, unless its document has one already.
        let ops = user_edit::plan(
            &self.doc,
            view,
            &edits,
            &mut user_edit::new_ids(&self.doc, &self.client, seed),
        )
        .map_err(|e| e.0)?;
        let inverse = self.run(&ops, outcome);
        Ok(Local {
            mid,
            seed,
            edits,
            inverse,
        })
    }

    /// Undoes the draft, then the pending edits, newest first, so the
    /// document is the server's again. Each inverse runs on exactly the
    /// document it was read from, so this puts it back exactly.
    fn roll_back(&mut self, outcome: &mut Outcome) -> Vec<Local> {
        let mut locals = std::mem::take(&mut self.pending);
        locals.extend(self.draft.take());
        for local in locals.iter().rev() {
            self.run(&local.inverse, outcome);
        }
        locals
    }

    /// Plans `locals` again, oldest first, on the document as it is now.
    fn replay(&mut self, locals: Vec<Local>, outcome: &mut Outcome) {
        for local in locals {
            let is_draft = local.mid.is_none();
            // Each plans against the document the ones before it left.
            self.base_view = None;
            match self.plan(local.mid, local.seed, local.edits, outcome) {
                Ok(local) if is_draft => self.draft = Some(local),
                Ok(local) => self.pending.push(local),
                Err(error) => match local.mid {
                    Some(mid) => outcome.dropped.push(mid),
                    None => outcome.draft_lost = Some(error),
                },
            }
        }
        // The cached view is the draft's base only when the draft was the last to plan.
        if self.draft.is_none() {
            self.base_view = None;
        }
    }

    /// Whether this tab has edits the server hasn't confirmed, or a gesture's draft.
    pub fn has_local(&self) -> bool {
        self.draft.is_some() || !self.pending.is_empty()
    }

    /// Names the tab in the stamps of its mutations.
    pub fn set_client(&mut self, client: &str) {
        self.client = client.to_owned();
    }

    /// Replaces the gesture's draft with `edits` (a JSON array), or clears
    /// it when `edits` is `null`. `seed` is the mutation id it will be sent
    /// as. When the edits don't plan, like a move inside an instance,
    /// there's no draft and `error` says why.
    pub fn draft(&mut self, seed: u64, edits: &str) -> Result<String, String> {
        let edits: Option<Vec<UserEdit>> =
            serde_json::from_str(edits).map_err(|e| e.to_string())?;
        let mut outcome = Outcome::default();
        if let Some(old) = self.draft.take() {
            self.run(&old.inverse, &mut outcome);
        }
        if let Some(edits) = edits {
            match self.plan(None, seed, edits, &mut outcome) {
                Ok(local) => self.draft = Some(local),
                Err(error) => outcome.error = Some(error),
            }
        }
        Ok(to_json(&outcome))
    }

    /// Makes `edits` (a JSON array) this tab's mutation `mid`, waiting for
    /// the server. When they're the draft's edits, the draft just becomes
    /// pending and nothing changes on screen.
    pub fn propose(&mut self, mid: u64, edits: &str) -> Result<String, String> {
        let edits: Vec<UserEdit> = serde_json::from_str(edits).map_err(|e| e.to_string())?;
        let mut outcome = Outcome::default();
        match self.draft.take() {
            Some(mut draft) if draft.edits == edits && draft.seed == mid => {
                draft.mid = Some(mid);
                self.pending.push(draft);
            }
            old => {
                if let Some(old) = old {
                    self.run(&old.inverse, &mut outcome);
                }
                match self.plan(Some(mid), mid, edits, &mut outcome) {
                    Ok(local) => self.pending.push(local),
                    Err(error) => outcome.error = Some(error),
                }
            }
        }
        self.base_view = None;
        Ok(to_json(&outcome))
    }

    /// Applies a change from the server (`ops`, a JSON array). `mine` is
    /// its mutation's id when this tab sent it. This tab's own edits are
    /// taken off first and planned again on top, so the server's ops apply
    /// to the document they were made for.
    pub fn receive(&mut self, ops: &str, mine: Option<u64>) -> Result<String, String> {
        let ops: Vec<Op> = serde_json::from_str(ops).map_err(|e| e.to_string())?;
        let mut outcome = Outcome::default();
        let mut locals = self.roll_back(&mut outcome);
        self.run(&ops, &mut outcome);
        if let Some(mid) = mine {
            locals.retain(|l| l.mid != Some(mid));
        }
        self.replay(locals, &mut outcome);
        Ok(to_json(&outcome))
    }

    /// Drops mutation `mid`, which the server answered without a change,
    /// and plans the rest of this tab's edits again without it.
    pub fn settle(&mut self, mid: u64) -> String {
        let mut outcome = Outcome::default();
        let mut locals = self.roll_back(&mut outcome);
        locals.retain(|l| l.mid != Some(mid));
        self.replay(locals, &mut outcome);
        to_json(&outcome)
    }

    /// The design's pages in order, as a JSON array of `{id, name}`. Never
    /// empty: a design without pages has its implicit first page.
    pub fn pages(&self) -> String {
        #[derive(Serialize)]
        struct Listed<'a> {
            id: &'a str,
            name: &'a str,
        }
        let pages: Vec<Listed> = self
            .doc
            .pages()
            .into_iter()
            .map(|(id, page)| Listed {
                id,
                name: &page.name,
            })
            .collect();
        serde_json::to_string(&pages).expect("pages serialize")
    }

    /// The design's modes in order and its tokens by name, as JSON
    /// `{"modes": [{id, name}], "tokens": {name: {modeId: value}}}`. Never
    /// without a mode: a design without modes has its implicit first one.
    pub fn tokens(&self) -> String {
        #[derive(Serialize)]
        struct Listed<'a> {
            id: &'a str,
            name: &'a str,
        }
        #[derive(Serialize)]
        struct Tokens<'a> {
            modes: Vec<Listed<'a>>,
            tokens: &'a std::collections::BTreeMap<String, Values>,
        }
        let modes = self
            .doc
            .modes()
            .into_iter()
            .map(|(id, mode)| Listed {
                id,
                name: &mode.name,
            })
            .collect();
        serde_json::to_string(&Tokens {
            modes,
            tokens: self.doc.tokens(),
        })
        .expect("tokens serialize")
    }

    /// The tokens for artboard `id` in its mode, as a `<style>` element's
    /// text (see [`tokens::style`]), for a shadow root when `shadow` is
    /// set. Empty when the design has no tokens or there's no such artboard.
    pub fn token_style(&self, id: &str, shadow: bool) -> String {
        match self.doc.get(id) {
            Some(board) => tokens::style(&self.doc, self.doc.mode_of(board), shadow),
            None => String::new(),
        }
    }

    /// The subtree at `id` as compact HTML, as screenshots render it, with
    /// instances expanded. With `ids`, every element carries its node id,
    /// for sandboxed artboards. Empty when there's no such node.
    pub fn export(&self, id: &str, ids: bool) -> String {
        // Expanding the whole design is only worth it when the subtree
        // shows an instance, or is inside one (a virtual id).
        let shows_instance =
            !self.doc.contains(id) || self.doc.subtree(id).into_iter().any(|n| n.is_instance());
        let view = if shows_instance {
            components::expand(&self.doc)
        } else {
            std::borrow::Cow::Borrowed(&self.doc)
        };
        let html = if ids {
            html::export_for_viewer(&view, id)
        } else {
            html::export_compact(&view, id)
        };
        html.unwrap_or_default()
    }

    /// Instance `id` as it renders, as a JSON array of nodes: its root,
    /// then what's inside it, parents first and siblings in order. Nodes
    /// inside it have virtual ids (`instance/node`). `[]` if it isn't one.
    pub fn expand(&self, id: &str) -> String {
        serde_json::to_string(&components::expand_instance(&self.doc, id)).expect("nodes serialize")
    }

    /// The instances to draw again since the last call, as a JSON array
    /// of ids, and forgets them.
    pub fn take_dirty(&mut self) -> String {
        let dirty: Vec<NodeId> = std::mem::take(&mut self.dirty)
            .into_iter()
            .filter(|id| self.doc.contains(id))
            .collect();
        serde_json::to_string(&dirty).expect("ids serialize")
    }

    /// What node `id` (real or virtual) is to components, as JSON: the
    /// instance it's in and its component, or the component it's in, with
    /// its name and instance count. `null` when it's neither.
    pub fn component_info(&self, id: &str) -> String {
        serde_json::to_string(&components::info(&self.doc, id)).expect("info serializes")
    }

    /// The instances whose content `op` changes, read before it applies
    /// (`before`) or after: where its node was, and where it is.
    fn shown_by(&self, op: &Op, before: bool) -> BTreeSet<NodeId> {
        let doc = &self.doc;
        if !doc.has_instances() {
            return BTreeSet::new();
        }
        let mut out = BTreeSet::new();
        let mut add = |id: &str| out.extend(components::affected(doc, id));
        match (op, before) {
            (Op::Create { node }, false) => {
                add(&node.id);
                if let Some(parent) = &node.parent {
                    add(parent);
                }
            }
            (Op::Delete { id }, true) => {
                if let Some(parent) = doc.get(id).and_then(|n| n.parent.clone()) {
                    add(&parent);
                }
                // Its components' other instances lose what they showed.
                out.extend(components::orphaned_by(doc, id));
            }
            (Op::Move { id, .. }, _) => add(id),
            (Op::Set { id, key, .. }, _) => {
                add(id);
                if *key == PropKey::Component || *key == PropKey::InstanceOf {
                    out.insert(id.clone());
                    out.extend(doc.instances_of(id).map(str::to_owned));
                }
            }
            _ => {}
        }
        out
    }
}

fn to_json(outcome: &Outcome) -> String {
    serde_json::to_string(outcome).expect("outcomes serialize")
}

/// What `op` touched, read from the document right after it applied.
/// `inverse` is what applying it returned.
fn describe<'a>(doc: &'a Document, op: &'a Op, inverse: &'a [Op]) -> Applied<'a> {
    let next = |id: &str| doc.next_sibling(id).map(|n| n.id.as_str());
    let node = |id: &str| doc.get(id).expect("an op that applied leaves its node");
    match op {
        Op::Create { node } => Applied::Create {
            before: next(&node.id),
        },
        // The inverse recreates the subtree, parents first.
        Op::Delete { .. } => Applied::Delete {
            parent: match inverse.first() {
                Some(Op::Create { node }) => node.parent.as_deref(),
                _ => None,
            },
            removed: inverse.iter().map(Op::id).collect(),
        },
        Op::Set { id, .. } => Applied::Set { node: node(id) },
        Op::Move { id, .. } => Applied::Move {
            node: node(id),
            from: match inverse.first() {
                Some(Op::Move { parent, .. }) => parent.as_deref(),
                _ => None,
            },
            before: next(id),
        },
        Op::Css { .. } => Applied::Css,
        Op::Token { name, .. } => Applied::Token {
            name,
            values: doc.tokens().get(name),
        },
        Op::Mode { id, .. } => Applied::Mode {
            id,
            mode: doc.mode_map().get(id),
        },
        Op::Page { id, .. } => Applied::Page {
            id,
            page: doc.page_map().get(id),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn node(id: &str, parent: Option<&str>, index: &str) -> Value {
        json!({ "id": id, "parent": parent, "index": index, "type": "element", "tag": "div" })
    }

    fn replica() -> Replica {
        let mut r = Replica::default();
        let nodes = json!([
            node("a", None, "V"),
            node("b", Some("a"), "V"),
            node("c", Some("a"), "k"),
            node("d", Some("b"), "V"),
        ]);
        r.load(&nodes.to_string()).unwrap();
        r
    }

    fn apply(r: &mut Replica, ops: Value) -> Value {
        serde_json::from_str(&r.apply(&ops.to_string()).unwrap()).unwrap()
    }

    #[test]
    fn load_returns_sibling_order() {
        let mut r = Replica::default();
        let nodes = json!([
            node("a", None, "V"),
            node("c", Some("a"), "k"),
            node("b", Some("a"), "V")
        ]);
        let mut lists: Vec<(Option<String>, Vec<String>)> =
            serde_json::from_str(&r.load(&nodes.to_string()).unwrap()).unwrap();
        lists.sort();
        assert_eq!(
            lists,
            [
                (None, vec!["a".to_owned()]),
                (Some("a".to_owned()), vec!["b".to_owned(), "c".to_owned()]),
            ]
        );
    }

    #[test]
    fn each_result_says_what_its_op_touched() {
        let mut r = replica();
        let results = apply(
            &mut r,
            json!([
                { "op": "create", "node": node("e", Some("a"), "F") },
                { "op": "set", "id": "e", "key": "style:color", "value": "red" },
                { "op": "set", "id": "e", "key": "style:color", "value": "red" },
                { "op": "move", "id": "d", "parent": "a", "index": "z" },
                { "op": "delete", "id": "b" },
            ]),
        );
        assert_eq!(results[0], json!({ "op": "create", "before": "b" }));
        assert_eq!(results[1]["op"], "set");
        assert_eq!(results[1]["node"]["styles"], json!({ "color": "red" }));
        // Setting the same value again changes nothing, so it didn't apply.
        assert_eq!(results[2], Value::Null);
        assert_eq!(results[3]["from"], "b");
        assert_eq!(results[3]["before"], Value::Null);
        assert_eq!(results[3]["node"]["parent"], "a");
        assert_eq!(
            results[4],
            json!({ "op": "delete", "parent": "a", "removed": ["b"] })
        );
    }

    #[test]
    fn token_and_mode_results_hold_the_new_values() {
        let mut r = replica();
        let dark = json!({ "name": "Dark", "index": "W" });
        let results = apply(
            &mut r,
            json!([
                { "op": "mode", "id": "mode-1", "mode": { "name": "Light", "index": "V" } },
                { "op": "mode", "id": "dark", "mode": dark },
                { "op": "token", "name": "--bg", "modeId": "mode-1", "value": "#fff" },
                { "op": "token", "name": "--bg", "modeId": "dark", "value": "#111" },
                { "op": "token", "name": "--bg", "modeId": "dark", "value": "#111" },
                { "op": "set", "id": "a", "key": "mode", "value": "dark" },
                { "op": "token", "name": "--gone", "modeId": "dark", "value": null },
            ]),
        );
        assert_eq!(
            results[1],
            json!({ "op": "mode", "id": "dark", "mode": dark })
        );
        assert_eq!(
            results[3],
            json!({ "op": "token", "name": "--bg", "values": { "mode-1": "#fff", "dark": "#111" } })
        );
        assert_eq!(results[4], Value::Null);
        assert_eq!(results[6], Value::Null);
        assert_eq!(
            r.token_style("a", true),
            "@layer finite-tokens { :host { --bg: #111; } }"
        );
        assert_eq!(r.token_style("missing", true), "");
        let listed: Value = serde_json::from_str(&r.tokens()).unwrap();
        assert_eq!(
            listed["modes"],
            json!([{ "id": "mode-1", "name": "Light" }, { "id": "dark", "name": "Dark" }])
        );
        assert_eq!(listed["tokens"]["--bg"]["dark"], "#111");
    }

    #[test]
    fn page_results_hold_the_new_page() {
        let mut r = replica();
        let page = json!({ "name": "Components", "index": "V" });
        let results = apply(
            &mut r,
            json!([
                { "op": "page", "id": "p", "page": page },
                { "op": "page", "id": "p", "page": page },
                { "op": "page", "id": "p", "page": null },
            ]),
        );
        assert_eq!(results[0], json!({ "op": "page", "id": "p", "page": page }));
        assert_eq!(results[1], Value::Null);
        assert_eq!(results[2], json!({ "op": "page", "id": "p", "page": null }));
    }

    #[test]
    fn pages_are_listed_in_order_with_the_implicit_first_page() {
        let mut r = replica();
        let listed = |r: &Replica| serde_json::from_str::<Value>(&r.pages()).unwrap();
        assert_eq!(listed(&r), json!([{ "id": "page-1", "name": "Page 1" }]));
        apply(
            &mut r,
            json!([
                { "op": "page", "id": "b", "page": { "name": "Second", "index": "k" } },
                { "op": "page", "id": "a", "page": { "name": "First", "index": "F" } },
            ]),
        );
        assert_eq!(
            listed(&r),
            json!([{ "id": "a", "name": "First" }, { "id": "b", "name": "Second" }])
        );
    }

    #[test]
    fn a_deleted_subtree_lists_parents_first() {
        let mut r = replica();
        let results = apply(&mut r, json!([{ "op": "delete", "id": "a" }]));
        assert_eq!(results[0]["parent"], Value::Null);
        assert_eq!(results[0]["removed"], json!(["a", "b", "d", "c"]));
        assert!(r.document().is_empty());
    }

    #[test]
    fn bad_json_is_an_error_and_changes_nothing() {
        let mut r = replica();
        assert!(r.apply("[{\"op\":\"nope\"}]").is_err());
        assert!(r.load("{").is_err());
        assert_eq!(r.document().len(), 4);
    }

    #[test]
    fn instances_expand_and_say_when_to_draw_again() {
        let mut r = replica();
        apply(
            &mut r,
            json!([
                { "op": "set", "id": "b", "key": "component", "value": true },
                { "op": "create", "node": {
                    "id": "i", "parent": "c", "index": "V", "type": "element", "tag": "div",
                    "instanceOf": "b" } },
            ]),
        );
        assert_eq!(r.take_dirty(), r#"["i"]"#);
        assert_eq!(r.take_dirty(), "[]");
        let nodes: Value = serde_json::from_str(&r.expand("i")).unwrap();
        let ids: Vec<&str> = nodes
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["i", "i/d"]);
        assert_eq!(nodes[1]["parent"], "i");
        // Editing the component marks its instance.
        apply(
            &mut r,
            json!([{ "op": "set", "id": "d", "key": "style:color", "value": "red" }]),
        );
        assert_eq!(r.take_dirty(), r#"["i"]"#);
        assert!(
            r.export("c", true)
                .contains(r#"data-finite-id="i/d" style="color: red""#)
        );
        let info: Value = serde_json::from_str(&r.component_info("i/d")).unwrap();
        assert_eq!(info["instance"], "i");
        assert_eq!(info["component"], "b");
        assert_eq!(info["instances"], 1);
        assert_eq!(r.component_info("a"), "null");
        // Deleting the component marks it too: it has nothing to show now.
        apply(&mut r, json!([{ "op": "delete", "id": "b" }]));
        assert_eq!(r.take_dirty(), r#"["i"]"#);
    }

    #[test]
    fn exports_with_and_without_ids() {
        let r = replica();
        assert_eq!(
            r.export("b", true),
            r#"<div data-finite-id="b"><div data-finite-id="d"></div></div>"#
        );
        assert_eq!(r.export("b", false), "<div><div></div></div>");
        assert_eq!(r.export("missing", false), "");
    }

    /// Each parent's children, in order.
    type Lists = Vec<(Option<String>, Vec<String>)>;

    /// Every node as JSON, sorted by id, and every parent's children in order.
    fn state(doc: &Document) -> (Vec<Value>, Lists) {
        let mut nodes: Vec<Value> = doc
            .nodes()
            .map(|n| serde_json::to_value(n).unwrap())
            .collect();
        nodes.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
        let mut lists: Lists = doc
            .child_lists()
            .map(|(p, c)| (p.map(str::to_owned), c.map(str::to_owned).collect()))
            .filter(|(_, c): &(_, Vec<String>)| !c.is_empty())
            .collect();
        lists.sort();
        (nodes, lists)
    }

    fn outcome(json: &str) -> Value {
        serde_json::from_str(json).unwrap()
    }

    fn style(id: &str, value: &str) -> UserEdit {
        UserEdit::SetStyles {
            ids: vec![id.into()],
            styles: [("left".to_owned(), Some(value.to_owned()))].into(),
        }
    }

    #[test]
    fn a_draft_becomes_pending_and_its_own_change_touches_nothing_twice() {
        let mut r = replica();
        let edits = serde_json::to_string(&[style("b", "4px")]).unwrap();
        let drafted = outcome(&r.draft(1, &edits).unwrap());
        assert_eq!(drafted["patches"][0]["op"]["key"], "style:left");
        // Proposing the same edits keeps what's on screen.
        assert_eq!(
            outcome(&r.propose(1, &edits).unwrap())["patches"],
            json!([])
        );
        assert!(r.has_local());
        // The server's change for it: taken off, applied, and nothing left on top.
        let ops = json!([{ "op": "set", "id": "b", "key": "style:left", "value": "4px" }]);
        let received = outcome(&r.receive(&ops.to_string(), Some(1)).unwrap());
        assert_eq!(received["patches"].as_array().unwrap().len(), 2);
        assert!(!r.has_local());
        assert_eq!(r.document().get("b").unwrap().styles["left"], "4px");
    }

    #[test]
    fn a_draft_that_cannot_plan_says_why() {
        let mut r = replica();
        let edits = json!([{ "kind": "place", "ids": ["a"], "parent": "d", "before": null }]);
        let drafted = outcome(&r.draft(1, &edits.to_string()).unwrap());
        assert!(drafted["error"].as_str().unwrap().contains("into itself"));
        assert!(!r.has_local());
    }

    #[test]
    fn a_change_that_deletes_the_dragged_node_loses_the_draft() {
        let mut r = replica();
        r.draft(1, &serde_json::to_string(&[style("d", "1px")]).unwrap())
            .unwrap();
        let ops = json!([{ "op": "delete", "id": "b" }]);
        let received = outcome(&r.receive(&ops.to_string(), None).unwrap());
        assert!(
            received["draftLost"]
                .as_str()
                .unwrap()
                .contains("not found")
        );
        assert!(!r.has_local());
    }

    /// A small deterministic random number generator, so a failure repeats.
    struct Rng(u64);

    impl Rng {
        fn below(&mut self, n: usize) -> usize {
            self.0 ^= self.0 << 13;
            self.0 ^= self.0 >> 7;
            self.0 ^= self.0 << 17;
            (self.0 % n as u64) as usize
        }
    }

    /// Agents edit the server's design while a tab drafts, proposes and gets
    /// answers in every order. Whenever the tab has nothing of its own left,
    /// its document must be the server's exactly.
    #[test]
    fn the_tab_ends_up_with_the_servers_document() {
        use finite_design::{Design, DesignMeta, edit};

        for seed in 1..200u64 {
            let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
            let mut server = Design::new(DesignMeta {
                id: "d".into(),
                name: "Race".into(),
                created_at: 0,
                updated_at: 0,
            });
            let ids = ["a", "b", "c", "d", "e", "f"];
            let mut ops = vec![Op::Create {
                node: Node {
                    x: Some(0.0),
                    y: Some(0.0),
                    ..Node::element("a", "div")
                },
            }];
            for (i, id) in ids[1..].iter().enumerate() {
                ops.push(Op::Create {
                    node: Node {
                        parent: Some(ids[i / 2].into()),
                        index: format!("{}", (b'a' + i as u8) as char),
                        ..Node::element(*id, "div")
                    },
                });
            }
            server.commit("agent", "Build", &ops, 0).unwrap();
            let mut tab = Replica::default();
            let nodes: Vec<&Node> = server.doc().nodes().collect();
            tab.load(&serde_json::to_string(&nodes).unwrap()).unwrap();

            // Mutations sent and not yet run by the server, and changes the
            // server made that the tab hasn't received, each in order.
            let mut sent: Vec<(u64, Vec<UserEdit>)> = Vec::new();
            let mut inbox: Vec<(Vec<Op>, Option<u64>, Option<u64>)> = Vec::new();
            let mut mid = 0;
            let mut n = 0;
            let random_edit = |rng: &mut Rng| -> UserEdit {
                let id = ids[rng.below(ids.len())].to_owned();
                match rng.below(8) {
                    0 => style(&id, &format!("{}px", rng.below(5))),
                    1 => UserEdit::Place {
                        ids: vec![id],
                        parent: Some(ids[rng.below(3)].into()),
                        before: Some(ids[rng.below(ids.len())].into()),
                    },
                    2 => UserEdit::SetPosition {
                        moves: vec![finite_design::user_edit::Position {
                            id: "a".into(),
                            x: rng.below(9) as f64,
                            y: 0.0,
                        }],
                    },
                    3 => UserEdit::Duplicate { ids: vec![id] },
                    4 => UserEdit::Group {
                        ids: vec![id, ids[rng.below(ids.len())].to_owned()],
                    },
                    5 => UserEdit::Ungroup { ids: vec![id] },
                    6 => UserEdit::SetText {
                        id,
                        text: format!("t{}", rng.below(3)),
                    },
                    _ => UserEdit::Delete { ids: vec![id] },
                }
            };
            for _ in 0..60 {
                match rng.below(7) {
                    // An agent edits the server's design.
                    0 => {
                        let id = ids[rng.below(ids.len())];
                        let built = match rng.below(3) {
                            0 => edit::update_styles(
                                server.doc(),
                                &[id.into()],
                                &[("left".to_owned(), Some(format!("{}px", rng.below(5))))].into(),
                            ),
                            1 => edit::move_nodes(
                                server.doc(),
                                &[id.into()],
                                Some(ids[rng.below(3)]),
                                Some(0),
                            ),
                            _ => {
                                n += 1;
                                let node = Node {
                                    parent: Some(id.into()),
                                    index: "V".into(),
                                    ..Node::element(format!("agent{n}"), "p")
                                };
                                Ok(vec![Op::Create { node }])
                            }
                        };
                        if let Ok(ops) = built
                            && let Some(change) = server.commit("agent", "Edit", &ops, 0)
                        {
                            inbox.push((change.ops, None, None));
                        }
                    }
                    // The person drags, or lets go.
                    1 => {
                        let edits = vec![random_edit(&mut rng)];
                        tab.draft(mid + 1, &serde_json::to_string(&edits).unwrap())
                            .unwrap();
                    }
                    2 => {
                        if let Some(draft) = &tab.draft {
                            let edits = draft.edits.clone();
                            mid += 1;
                            tab.propose(mid, &serde_json::to_string(&edits).unwrap())
                                .unwrap();
                            sent.push((mid, edits));
                        }
                    }
                    // The server runs the oldest mutation it was sent.
                    3 | 4 if !sent.is_empty() => {
                        let (mid, edits) = sent.remove(0);
                        let planned = user_edit::plan(
                            server.doc(),
                            server.view(),
                            &edits,
                            &mut user_edit::new_ids(server.doc(), "", mid),
                        );
                        let change = planned
                            .ok()
                            .and_then(|ops| server.commit("user:p", "Edit", &ops, 0));
                        match change {
                            Some(change) => inbox.push((change.ops, Some(mid), None)),
                            None => inbox.push((Vec::new(), None, Some(mid))),
                        }
                    }
                    // The tab receives the oldest message the server sent it.
                    _ if !inbox.is_empty() => {
                        let (ops, mine, settled) = inbox.remove(0);
                        match settled {
                            Some(mid) => {
                                tab.settle(mid);
                            }
                            None => {
                                tab.receive(&serde_json::to_string(&ops).unwrap(), mine)
                                    .unwrap();
                            }
                        }
                    }
                    _ => {}
                }
                if !tab.has_local() && sent.is_empty() && inbox.is_empty() {
                    assert_eq!(state(&tab.doc), state(server.doc()), "seed {seed}");
                }
            }
            // Let everything land.
            tab.draft(mid + 1, "null").unwrap();
            while !sent.is_empty() || !inbox.is_empty() {
                if let Some((mid, edits)) = (!sent.is_empty()).then(|| sent.remove(0)) {
                    let ops = user_edit::plan(
                        server.doc(),
                        server.view(),
                        &edits,
                        &mut user_edit::new_ids(server.doc(), "", mid),
                    );
                    match ops
                        .ok()
                        .and_then(|ops| server.commit("user:p", "Edit", &ops, 0))
                    {
                        Some(change) => inbox.push((change.ops, Some(mid), None)),
                        None => inbox.push((Vec::new(), None, Some(mid))),
                    }
                }
                while let Some((ops, mine, settled)) = (!inbox.is_empty()).then(|| inbox.remove(0))
                {
                    match settled {
                        Some(mid) => {
                            tab.settle(mid);
                        }
                        None => {
                            tab.receive(&serde_json::to_string(&ops).unwrap(), mine)
                                .unwrap();
                        }
                    }
                }
            }
            assert!(!tab.has_local(), "seed {seed}");
            assert_eq!(state(&tab.doc), state(server.doc()), "seed {seed}");
        }
    }
}
