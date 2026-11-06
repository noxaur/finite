//! Model logic the server used to hold: selectors in a stylesheet, merging a
//! stylesheet, setting tokens, link-breaking ops, and the shape of ids.

use std::collections::BTreeMap;

use finite_design::{
    Design, DesignMeta, Document, Op, PropKey, css,
    edit::{self, NewArtboard, TokenChange, WriteMode},
    flow, id,
};

fn design() -> Design {
    Design::new(DesignMeta {
        id: "d".into(),
        name: "Moved".into(),
        created_at: 0,
        updated_at: 0,
    })
}

fn ids() -> impl FnMut() -> String {
    ids_from("n")
}

fn ids_from(prefix: &'static str) -> impl FnMut() -> String {
    let mut n = 0;
    move || {
        n += 1;
        format!("{prefix}{n}")
    }
}

fn with_board(html: &str) -> Design {
    let mut d = design();
    let ops = edit::create_artboard(
        d.doc(),
        "b".into(),
        NewArtboard {
            name: "B".into(),
            width: 100.0,
            height: Some(100.0),
            ..Default::default()
        },
    )
    .unwrap();
    d.commit("agent", "Board", &ops, 0).unwrap();
    if !html.is_empty() {
        let ops = edit::write_html(d.doc(), "b", html, WriteMode::Append, None, &mut ids())
            .unwrap()
            .0;
        d.commit("agent", "Write", &ops, 0).unwrap();
    }
    d
}

#[test]
fn selector_ids_read_hash_tokens_only() {
    assert_eq!(css::selector_ids("#a .b #c"), ["a", "c"]);
    assert_eq!(css::selector_ids(r"#inst\/part"), ["inst/part"]);
    assert_eq!(css::selector_ids("#inst/part"), ["inst/part"]);
    assert!(css::selector_ids(r##"[href="#x"] /* #y */"##).is_empty());
    assert!(css::selector_ids("a[src=url(#z)]").is_empty());
}

#[test]
fn a_rule_cannot_reach_inside_an_instance() {
    let d = with_board("");
    assert_eq!(
        edit::instance_path_in_rules(d.doc(), "#b/x { color: red }").unwrap(),
        None
    );
    assert_eq!(
        edit::instance_path_in_rules(d.doc(), ".a { color: red }").unwrap(),
        None
    );
}

#[test]
fn merge_style_adds_a_sheet_then_keeps_what_the_patch_skips() {
    let mut d = with_board("<p>hi</p>");
    let first = edit::merge_style(
        d.doc(),
        "b",
        ".a { color: red } .b { margin: 0 }",
        &mut ids_from("t"),
    )
    .unwrap();
    assert!(first.created);
    d.commit("agent", "Style", &first.ops, 0).unwrap();
    let second = edit::merge_style(d.doc(), "b", ".a { color: blue }", &mut ids_from("s")).unwrap();
    assert!(!second.created);
    assert_eq!(second.sheet, first.sheet);
    assert!(!second.changes.is_empty());
    d.commit("agent", "Style", &second.ops, 0).unwrap();
    let text = d
        .doc()
        .children(Some(&first.sheet))
        .iter()
        .map(|n| n.text.clone().unwrap_or_default())
        .collect::<String>();
    assert!(text.contains("blue") && text.contains("margin"), "{text}");
    let again = edit::merge_style(d.doc(), "b", ".a { color: blue }", &mut ids_from("s")).unwrap();
    assert!(again.ops.is_empty());
}

#[test]
fn token_changes_read_from_json() {
    let all: TokenChange = serde_json::from_str(r##""#fff""##).unwrap();
    assert_eq!(all, TokenChange::All("#fff".into()));
    let none: Option<TokenChange> = serde_json::from_str("null").unwrap();
    assert!(none.is_none());
    let modes: TokenChange = serde_json::from_str(r##"{"Dark": "#000", "Light": null}"##).unwrap();
    assert!(matches!(modes, TokenChange::Modes(m) if m.len() == 2));
}

#[test]
fn edit_tokens_names_modes_and_sets_values_in_one_go() {
    let mut d = design();
    let modes = vec!["Light".to_owned(), "Dark".to_owned()];
    let tokens = BTreeMap::from([("--color-bg".to_owned(), TokenChange::All("#f7f9fa".into()))]);
    let ops = edit::edit_tokens(d.doc(), Some(&modes), &tokens, &mut ids()).unwrap();
    d.commit("agent", "Tokens", &ops, 0).unwrap();
    assert_eq!(d.doc().mode_map().len(), 2);
    assert!(d.doc().tokens().contains_key("--color-bg"));
    let gone = BTreeMap::from([("--color-bg".to_owned(), TokenChange::Delete)]);
    let ops = edit::edit_tokens(d.doc(), None, &gone, &mut ids()).unwrap();
    d.commit("agent", "Tokens", &ops, 0).unwrap();
    assert!(!d.doc().tokens().contains_key("--color-bg"));
}

#[test]
fn only_some_ops_can_break_a_link() {
    let d = with_board("<a id=\"x\">go</a>");
    let delete = [Op::Delete { id: "b".into() }];
    assert!(flow::can_break(d.doc(), &delete));
    let restyle = [Op::Set {
        id: "b".into(),
        key: PropKey::Style("color".into()),
        value: Some("red".into()),
    }];
    assert!(!flow::can_break(d.doc(), &restyle));
    let href = [Op::Set {
        id: "b".into(),
        key: PropKey::Attr("href".into()),
        value: Some("#finite-artboard=b".into()),
    }];
    assert!(flow::can_break(d.doc(), &href));
}

#[test]
fn ids_have_one_shape() {
    assert!(id::is_design_id("k7jo11y14e"));
    assert!(!id::is_design_id("k7jo11y14"));
    assert!(!id::is_design_id("K7jo11y14e"));
    let fresh = id::fresh(&mut ids(), |id| id != "n2");
    assert_eq!(fresh, "n2");
}

#[allow(dead_code)]
fn unused(_: &Document) {}
