//! Runs the op cases in `fixtures/apply.json`, a record of what the op rules
//! do. A change to `Document::apply` that alters a result fails here first.
//!
//! The browser runs these same rules through WebAssembly (`crates/wasm`).
//! `apps/web/src/design/conformance.test.ts` runs the same cases through
//! that boundary and checks that the viewer's cache of nodes and sibling
//! order ends up where the document does.
//!
//! The expected results are generated from these Rust rules. To change a case,
//! edit its inputs and run with `FINITE_UPDATE_FIXTURES=1` to regenerate them.

use std::{fs, path::PathBuf};

use finite_design::{Document, Node, Op};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
struct Fixture {
    about: String,
    cases: Vec<Case>,
}

#[derive(Serialize, Deserialize)]
struct Case {
    name: String,
    nodes: Vec<Node>,
    ops: Vec<Op>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expect: Option<Expect>,
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct Expect {
    /// Whether each op applied.
    applied: Vec<bool>,
    /// The document afterwards, sorted by id.
    nodes: Vec<Node>,
    /// Each parent's children in sibling order (`None` for artboards), sorted by parent.
    #[serde(default)]
    children: Vec<(Option<String>, Vec<String>)>,
}

fn run(case: &Case) -> Expect {
    let mut doc = Document::from_nodes(case.nodes.clone());
    let applied = case.ops.iter().map(|op| doc.apply(op).is_some()).collect();
    let mut nodes: Vec<Node> = doc.nodes().cloned().collect();
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    let mut children: Vec<(Option<String>, Vec<String>)> = doc
        .child_lists()
        .map(|(parent, ids)| (parent.map(Into::into), ids.map(Into::into).collect()))
        .collect();
    children.sort();
    Expect {
        applied,
        nodes,
        children,
    }
}

#[test]
fn op_rules_match_the_shared_fixture() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/apply.json");
    let mut fixture: Fixture = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    if std::env::var_os("FINITE_UPDATE_FIXTURES").is_some() {
        for case in &mut fixture.cases {
            case.expect = Some(run(case));
        }
        let json = serde_json::to_string_pretty(&fixture).unwrap() + "\n";
        fs::write(&path, json).unwrap();
        return;
    }
    for case in &fixture.cases {
        let expect = case
            .expect
            .as_ref()
            .unwrap_or_else(|| panic!("case {:?} has no expect; regenerate", case.name));
        assert_eq!(&run(case), expect, "case {:?}", case.name);
    }
}
