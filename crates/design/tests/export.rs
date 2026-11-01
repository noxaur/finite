//! Runs the export cases in `fixtures/export.json`, a record of the HTML
//! screenshots render (`html::export_compact`). The web viewer exports with
//! this same code through WebAssembly; `apps/web/src/design/html.test.ts`
//! runs the cases through that boundary, so text survives the trip as UTF-8.
//!
//! Regenerate with `FINITE_UPDATE_FIXTURES=1` after changing the export.

use std::{fs, path::PathBuf};

use finite_design::{Document, Node, html};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    about: String,
    cases: Vec<Case>,
}

#[derive(Serialize, Deserialize)]
struct Case {
    name: String,
    root: String,
    nodes: Vec<Node>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    expect: Option<String>,
}

fn run(case: &Case) -> String {
    let doc = Document::from_nodes(case.nodes.clone());
    html::export_compact(&doc, &case.root).expect("the root exists")
}

#[test]
fn export_matches_the_shared_fixture() {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/export.json");
    let mut fixture: Fixture = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    if std::env::var_os("FINITE_UPDATE_FIXTURES").is_some() {
        for case in &mut fixture.cases {
            case.expect = Some(run(case));
        }
        fs::write(
            &path,
            serde_json::to_string_pretty(&fixture).unwrap() + "\n",
        )
        .unwrap();
        return;
    }
    for case in &fixture.cases {
        assert_eq!(Some(run(case)), case.expect, "case {:?}", case.name);
    }
}
