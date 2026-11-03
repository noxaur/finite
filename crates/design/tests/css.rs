//! Merging a patch into a `<style>` block's CSS (`css::merge_sheet`).

use finite_design::css::{self, PatchRule};

fn merge(existing: &str, patch: &str) -> (String, Vec<String>) {
    let (css, changes) = css::merge_sheet(existing, patch).unwrap();
    (css, changes.iter().map(ToString::to_string).collect())
}

#[test]
fn a_rule_takes_the_patchs_declarations_and_says_how_each_changed() {
    let (css, changes) = merge(
        ".bar { color: red; padding: 4px; }",
        ".bar { color: blue; padding: unset; margin: 0 }",
    );
    assert_eq!(css, ".bar { color: blue; margin: 0; }");
    assert_eq!(
        changes,
        [".bar: color: red → blue, padding: 4px → removed, margin: 0 (new)"]
    );
}

#[test]
fn untouched_rules_and_comments_keep_their_exact_text() {
    let existing = "/* Brand */\n.a{color:red}\n\n  .b {\n    color: red; /* why */\n    padding: 4px;\n  }\n\n.c > .d , .e { margin : 0 }\n";
    let (css, changes) = merge(existing, ".b { padding: 8px }");
    assert_eq!(
        css,
        "/* Brand */\n.a{color:red}\n\n  .b {\n    color: red; /* why */\n    padding: 8px;\n  }\n\n.c > .d , .e { margin : 0 }\n"
    );
    assert_eq!(changes, [".b: padding: 4px → 8px"]);
    // A patch that changes nothing leaves every byte.
    let (same, changes) = merge(existing, ".c>.d,.e { margin: 0 }");
    assert_eq!(same, existing);
    assert_eq!(changes, [".c>.d,.e: already had those values"]);
}

#[test]
fn selectors_match_with_whitespace_normalised() {
    let (css, _) = merge(
        ".card   >  h2,\n.x { color: red }",
        ".card>h2, .x { color: blue }",
    );
    assert_eq!(css, ".card   >  h2,\n.x { color: blue; }");
}

#[test]
fn new_rules_go_at_the_end_on_their_own_line_without_their_unsets() {
    let (css, changes) = merge(
        ".a { color: red }\n.b { color: red }\n",
        ".c { color: blue; padding: unset }\n.d { margin: unset }",
    );
    assert_eq!(
        css,
        ".a { color: red }\n.b { color: red }\n.c { color: blue; }\n"
    );
    assert_eq!(changes, ["added .c"]);
    let (css, _) = merge("", ".c { color: blue }");
    assert_eq!(css, ".c { color: blue }");
}

#[test]
fn an_empty_rule_removes_the_rule() {
    let (css, changes) = merge(
        ".a { color: red }\n.b { color: red }\n.c {}",
        ".b {}\n.gone { }",
    );
    assert_eq!(css, ".a { color: red }\n.c {}");
    assert_eq!(changes, ["removed .b"]);
}

#[test]
fn rules_merge_inside_their_own_media_query() {
    let existing = ".a { color: red }\n@media (max-width: 600px) {\n  .a { color: green }\n}\n";
    let (css, changes) = merge(
        existing,
        "@media (max-width:  600px) { .a { color: blue } .b { margin: 0 } }",
    );
    assert_eq!(
        css,
        ".a { color: red }\n@media (max-width: 600px) {\n  .a { color: blue; }\n  .b { margin: 0 }\n}\n"
    );
    assert_eq!(
        changes,
        [
            "@media (max-width: 600px) .a: color: green → blue",
            "added @media (max-width: 600px) .b"
        ]
    );
    // A query the sheet doesn't have is added whole, and the top-level rule
    // isn't the one inside the query.
    let (css, changes) = merge(existing, "@media print { .a { color: black } }");
    assert!(
        css.ends_with("}\n@media print { .a { color: black } }\n"),
        "{css}"
    );
    assert_eq!(changes, ["added @media print"]);
}

#[test]
fn media_queries_nest() {
    let existing = "@supports (display: grid) {\n  @media (min-width: 900px) {\n    .grid { display: grid; gap: 8px }\n  }\n}";
    let (css, changes) = merge(
        existing,
        "@supports (display: grid) { @media (min-width: 900px) { .grid { gap: 16px } } }",
    );
    assert_eq!(
        css,
        "@supports (display: grid) {\n  @media (min-width: 900px) {\n    .grid { display: grid; gap: 16px; }\n  }\n}"
    );
    assert_eq!(
        changes,
        ["@supports (display: grid) @media (min-width: 900px) .grid: gap: 8px → 16px"]
    );
}

#[test]
fn keyframes_replace_by_name() {
    let existing = "@keyframes spin { from { rotate: 0 } to { rotate: 90deg } }\n@keyframes fade { to { opacity: 0 } }";
    let (css, changes) = merge(existing, "@keyframes spin { to { rotate: 360deg } }");
    assert_eq!(
        css,
        "@keyframes spin { to { rotate: 360deg } }\n@keyframes fade { to { opacity: 0 } }"
    );
    assert_eq!(changes, ["replaced @keyframes spin"]);
    let (css, changes) = merge(existing, "@keyframes pulse { 50% { scale: 1.1 } }");
    assert!(
        css.ends_with("\n@keyframes pulse { 50% { scale: 1.1 } }"),
        "{css}"
    );
    assert_eq!(changes, ["added @keyframes pulse"]);
}

#[test]
fn values_with_functions_and_important_survive_whole() {
    let (css, changes) = merge(
        ".a:is(.b, .c) { background: rgb(1, 2, 3); color: red }",
        ".a:is(.b,.c) { background: linear-gradient(red, rgb(0 0 0 / 50%)); color: red !important }",
    );
    assert_eq!(
        css,
        ".a:is(.b, .c) { background: linear-gradient(red, rgb(0 0 0 / 50%)); color: red !important; }"
    );
    assert_eq!(
        changes,
        [
            ".a:is(.b,.c): background: rgb(1, 2, 3) → linear-gradient(red, rgb(0 0 0 / 50%)), color: red → red !important"
        ]
    );
}

#[test]
fn a_repeated_property_becomes_one() {
    let (css, _) = merge(
        ".a { color: red; COLOR: green; margin: 0 }",
        ".a { color: blue }",
    );
    assert_eq!(css, ".a { color: blue; margin: 0 }");
    // Custom properties are case-sensitive.
    let (css, _) = merge(".a { --Brand: red }", ".a { --brand: blue }");
    assert_eq!(css, ".a { --Brand: red; --brand: blue; }");
}

#[test]
fn at_rules_with_declarations_merge_like_rules() {
    let existing = "@font-face { font-family: Inter; src: url(a.woff2) }\n@font-face { font-family: Mono; src: url(m.woff2) }";
    let (css, changes) = merge(
        existing,
        "@font-face { font-family: Inter; src: url(b.woff2) }",
    );
    assert_eq!(
        css,
        "@font-face { font-family: Inter; src: url(b.woff2); }\n@font-face { font-family: Mono; src: url(m.woff2) }"
    );
    assert_eq!(changes, ["@font-face: src: url(a.woff2) → url(b.woff2)"]);
}

#[test]
fn imports_go_first_and_arent_repeated() {
    let (css, changes) = merge(
        "@import url(a.css);\n.a { color: red }",
        "@import url(b.css);\n@import url(a.css);",
    );
    assert_eq!(
        css,
        "@import url(a.css);\n@import url(b.css);\n.a { color: red }"
    );
    assert_eq!(changes, ["added @import url(b.css)"]);
    let (css, _) = merge(".a { color: red }", "@import url(b.css);");
    assert_eq!(css, "@import url(b.css);\n.a { color: red }");
}

#[test]
fn a_sheet_that_ends_inside_a_rule_is_closed_before_a_new_rule() {
    let (css, _) = merge(".a { color: red", ".b { color: blue }");
    assert_eq!(css, ".a { color: red}\n.b { color: blue }");
}

#[test]
fn a_patch_that_isnt_rules_is_refused() {
    let refused = |patch: &str| css::merge_sheet(".a {}", patch).unwrap_err().to_string();
    assert_eq!(
        refused("color: red;"),
        "`color: red` isn't a rule. Put declarations in one, like `.card { color: red; }`."
    );
    assert_eq!(
        refused(".a { color: red } }"),
        "the CSS has a } that closes nothing."
    );
    assert_eq!(
        refused(".a { color red }"),
        "`color red` isn't a declaration, like `color: red`."
    );
    assert_eq!(
        refused(".a { &:hover { color: red } }"),
        "nested rules aren't merged: write `&:hover { color: red }` as a rule of its own."
    );
}

#[test]
fn patch_rules_name_what_each_rule_sets() {
    let rules = css::patch_rules(
        ".a { color: red; Padding-Top: 0; margin: unset }\n@media print { .b { color: black } }\n@keyframes x { to { opacity: 0 } }",
    )
    .unwrap();
    assert_eq!(
        rules,
        [
            PatchRule {
                context: vec![],
                selector: ".a".into(),
                properties: vec!["color".into(), "padding-top".into()],
            },
            PatchRule {
                context: vec!["@media print".into()],
                selector: ".b".into(),
                properties: vec!["color".into()],
            },
        ]
    );
}

#[test]
fn inline_styles_that_beat_a_rule_are_named() {
    let rule = &css::patch_rules(".card { padding-top: 8px; color: red; margin: 0 }").unwrap()[0];
    let matched = vec![
        ("a".to_owned(), vec!["padding".to_owned()]),
        ("b".to_owned(), vec!["Color".to_owned(), "width".to_owned()]),
        ("c".to_owned(), vec!["margin-left".to_owned()]),
        (
            "d".to_owned(),
            vec!["padding-topper".to_owned(), "colors".to_owned()],
        ),
    ];
    let conflicts: Vec<(String, Vec<String>)> = css::inline_conflicts(rule, &matched)
        .into_iter()
        .map(|c| (c.property, c.nodes))
        .collect();
    assert_eq!(
        conflicts,
        [
            ("padding-top".to_owned(), vec!["a".to_owned()]),
            ("color".to_owned(), vec!["b".to_owned()]),
            ("margin".to_owned(), vec!["c".to_owned()]),
        ]
    );
}
