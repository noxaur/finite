//! Runs the op cases in `fixtures/apply.json`. The web app's `Replica` runs the
//! same file (`apps/web/src/design/conformance.test.ts`), so the Rust and
//! TypeScript op rules can't drift apart.
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
}

fn run(case: &Case) -> Expect {
    let mut doc = Document::from_nodes(case.nodes.clone());
    let applied = case.ops.iter().map(|op| doc.apply(op).is_some()).collect();
    let mut nodes: Vec<Node> = doc.nodes().cloned().collect();
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    Expect { applied, nodes }
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
