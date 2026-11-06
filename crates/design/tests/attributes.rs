//! Which attributes may be set. `write_html` drops the unsafe ones and
//! `update_attributes` refuses them. The web viewer checks again before it sets
//! an attribute, by calling this same function through WebAssembly.

use finite_design::html;

/// Each attribute, and whether it's safe.
const CASES: &[(&str, &str, bool)] = &[
    ("href", "https://example.com", true),
    ("href", "#section", true),
    ("title", "Checkout", true),
    ("onclick", "alert(1)", false),
    ("OnMouseOver", "alert(1)", false),
    ("srcdoc", "<p>hi</p>", false),
    ("href", "javascript:alert(1)", false),
    ("href", " JaVaScRiPt:alert(1)", false),
    ("href", "java\tscript:alert(1)", false),
    ("href", "java\u{1}script:alert(1)", false),
    ("href", "vbscript:msgbox(1)", false),
    // SVG animation sets `href` from a list at runtime.
    ("values", "0;javascript:alert(1)", false),
    ("to", "javascript:alert(1)", false),
    ("xlink:href", "javascript:alert(1)", false),
    ("src", "data:image/png;base64,AAAA", true),
];

#[test]
fn attribute_rules() {
    for &(name, value, safe) in CASES {
        assert_eq!(html::is_safe_attr(name, value), safe, "{name}={value:?}");
    }
}

/// The SVG case end to end: the parser drops the attribute, so the stored
/// node never has it.
#[test]
fn an_svg_animation_cant_smuggle_in_a_script_url() {
    let html = r#"<svg><a><animate attributeName="href" values="0;javascript:alert(1)"/><text>Go</text></a></svg>"#;
    let fragments = html::parse(html).unwrap();
    let animate = &fragments[0].children[0].children[0];
    assert!(
        animate.attrs.contains_key("attributeName"),
        "{:?}",
        animate.attrs
    );
    assert!(!animate.attrs.contains_key("values"), "{:?}", animate.attrs);
}
