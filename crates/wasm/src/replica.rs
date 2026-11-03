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
    /// The token `name` now has `values`, or was deleted when it's `None`.
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
    doc: Document,
    /// Instances whose content changed since [`Replica::take_dirty`], so
    /// the viewer can draw them again.
    dirty: BTreeSet<NodeId>,
}

impl Replica {
    pub fn document(&self) -> &Document {
        &self.doc
    }

    /// Replaces the document with the nodes in `nodes`, a JSON array.
    /// Returns every parent's children in sibling order, as JSON pairs of
    /// parent id (`null` for artboards) and child ids.
    pub fn load(&mut self, nodes: &str) -> Result<String, String> {
        let nodes: Vec<Node> = serde_json::from_str(nodes).map_err(|e| e.to_string())?;
        self.doc = Document::from_nodes(nodes);
        self.dirty.clear();
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
        let mut out = Vec::with_capacity(ops.len() * 24 + 2);
        out.push(b'[');
        for (i, op) in ops.iter().enumerate() {
            if i > 0 {
                out.push(b',');
            }
            let before = self.shown_by(op, true);
            match self.doc.apply(op) {
                Some(inverse) => {
                    self.dirty.extend(before);
                    let after = self.shown_by(op, false);
                    self.dirty.extend(after);
                    let applied = describe(&self.doc, op, &inverse);
                    serde_json::to_writer(&mut out, &applied).expect("results serialize");
                }
                None => out.extend_from_slice(b"null"),
            }
        }
        out.push(b']');
        Ok(String::from_utf8(out).expect("serde_json writes UTF-8"))
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
                { "op": "token", "name": "--bg", "values": { "mode-1": "#fff", "dark": "#111" } },
                { "op": "token", "name": "--bg", "values": { "mode-1": "#fff", "dark": "#111" } },
                { "op": "set", "id": "a", "key": "mode", "value": "dark" },
                { "op": "token", "name": "--gone", "values": null },
            ]),
        );
        assert_eq!(
            results[1],
            json!({ "op": "mode", "id": "dark", "mode": dark })
        );
        assert_eq!(
            results[2],
            json!({ "op": "token", "name": "--bg", "values": { "mode-1": "#fff", "dark": "#111" } })
        );
        assert_eq!(results[3], Value::Null);
        assert_eq!(results[5], Value::Null);
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
}
