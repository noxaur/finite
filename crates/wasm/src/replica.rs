//! The browser's copy of a design's document, as the web viewer drives it.
//!
//! Inputs and results are JSON, so a whole change crosses into WebAssembly
//! in one call, however many ops it holds. Each op's result says what the
//! op touched, which is all the viewer needs to keep its own read cache of
//! nodes and sibling order in step without knowing the rules.

use finite_design::{Document, Node, Op, html};
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
}

#[derive(Debug, Default)]
pub struct Replica {
    doc: Document,
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
            match self.doc.apply(op) {
                Some(inverse) => {
                    let applied = describe(&self.doc, op, &inverse);
                    serde_json::to_writer(&mut out, &applied).expect("results serialize");
                }
                None => out.extend_from_slice(b"null"),
            }
        }
        out.push(b']');
        Ok(String::from_utf8(out).expect("serde_json writes UTF-8"))
    }

    /// The subtree at `id` as compact HTML, as screenshots render it. With
    /// `ids`, every element carries its node id, for sandboxed artboards.
    /// Empty when there's no such node.
    pub fn export(&self, id: &str, ids: bool) -> String {
        let html = if ids {
            html::export_for_viewer(&self.doc, id)
        } else {
            html::export_compact(&self.doc, id)
        };
        html.unwrap_or_default()
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
