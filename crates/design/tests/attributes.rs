//! Records which attributes are safe to set in `fixtures/attributes.json`.
//! The viewer's `isSafeAttr` must agree on every case
//! (`apps/web/src/design/attributes.test.ts`), because it guards the same
//! shadow roots the server's checks do.
//!
//! Regenerate with `FINITE_UPDATE_FIXTURES=1` after changing a rule.

use std::{fs, path::PathBuf};

use finite_design::html;
use serde_json::{Value, json};

const CASES: &[(&str, &str)] = &[
    ("href", "https://example.com"),
    ("href", "#section"),
    ("title", "Checkout"),
    ("onclick", "alert(1)"),
    ("OnMouseOver", "alert(1)"),
    ("srcdoc", "<p>hi</p>"),
    ("href", "javascript:alert(1)"),
    ("href", " JaVaScRiPt:alert(1)"),
    ("href", "java\tscript:alert(1)"),
    ("href", "java\u{1}script:alert(1)"),
    ("href", "vbscript:msgbox(1)"),
    // SVG animation sets `href` from a list at runtime.
    ("values", "0;javascript:alert(1)"),
    ("to", "javascript:alert(1)"),
    ("xlink:href", "javascript:alert(1)"),
    ("src", "data:image/png;base64,AAAA"),
];

#[test]
fn attribute_rules_match_the_shared_fixture() {
    let cases: Vec<Value> = CASES
        .iter()
        .map(|(name, value)| json!({ "name": name, "value": value, "safe": html::is_safe_attr(name, value) }))
        .collect();
    let fixture = json!({
        "about": "Which attributes may be set, recorded from crates/design/tests/attributes.rs. apps/web/src/design/attributes.test.ts checks the viewer's isSafeAttr against it.",
        "cases": cases,
    });
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/attributes.json");
    if std::env::var_os("FINITE_UPDATE_FIXTURES").is_some() {
        fs::write(
            &path,
            serde_json::to_string_pretty(&fixture).unwrap() + "\n",
        )
        .unwrap();
        return;
    }
    let stored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        fixture, stored,
        "an attribute rule changed; regenerate the fixture"
    );
}

/// The SVG case end to end: the parser drops the attribute, so the stored
/// node never has it.
#[test]
fn an_svg_animation_cant_smuggle_in_a_script_url() {
    let html = r#"<svg><a><animate attributeName="href" values="0;javascript:alert(1)"/><text>Go</text></a></svg>"#;
    let fragments = html::parse(html);
    let animate = &fragments[0].children[0].children[0];
    assert!(
        animate.attrs.contains_key("attributeName"),
        "{:?}",
        animate.attrs
    );
    assert!(!animate.attrs.contains_key("values"), "{:?}", animate.attrs);
}
