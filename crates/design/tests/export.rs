//! Runs the export cases in `fixtures/export.json` and records the shared CSS
//! and content policy. The web viewer checks its `exportHtml`, `BASE_CSS` and
//! `CSP` against the same file (`apps/web/src/design/html.test.ts`), so a
//! screenshot and the live view render an artboard from the same HTML.
//!
//! Regenerate with `FINITE_UPDATE_FIXTURES=1` after changing the export.

use std::{fs, path::PathBuf};

use finite_design::{Document, Node, html};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    about: String,
    #[serde(default)]
    base_css: String,
    #[serde(default)]
    csp: String,
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
        fixture.base_css = html::BASE_CSS.into();
        fixture.csp = html::CSP.into();
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
    assert_eq!(fixture.base_css, html::BASE_CSS, "regenerate the fixture");
    assert_eq!(fixture.csp, html::CSP, "regenerate the fixture");
    for case in &fixture.cases {
        assert_eq!(Some(run(case)), case.expect, "case {:?}", case.name);
    }
}
