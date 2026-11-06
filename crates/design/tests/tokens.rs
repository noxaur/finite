//! Design tokens: CSS custom properties with a value per mode, which every
//! artboard renders in its own mode. Old shared CSS migrates into them.

use std::collections::BTreeMap;

use finite_design::{
    Change, Design, DesignMeta, Document, Op, Origin, Record, Snapshot,
    edit::{self, NewArtboard, TokenChange},
    html,
    tokens::{self, FIRST_MODE},
};

fn design() -> Design {
    Design::new(DesignMeta {
        id: "d".into(),
        name: "Tokens".into(),
        created_at: 0,
        updated_at: 0,
    })
}

fn artboard(design: &mut Design, id: &str) {
    let spec = NewArtboard {
        name: id.into(),
        width: 100.0,
        height: Some(100.0),
        position: None,
        page: None,
        styles: BTreeMap::new(),
        ..Default::default()
    };
    let ops = edit::create_artboard(design.doc(), id.into(), spec).unwrap();
    design.commit("agent", "Create artboard", &ops, 0).unwrap();
}

fn commit(design: &mut Design, build: impl FnOnce(&Document) -> edit::Result<Vec<Op>>) {
    let ops = build(design.doc()).unwrap();
    design.commit("agent", "Edit", &ops, 0).unwrap();
}

fn set(design: &mut Design, changes: &[(&str, TokenChange)]) {
    let changes: Vec<(String, TokenChange)> = changes
        .iter()
        .map(|(name, change)| ((*name).to_owned(), change.clone()))
        .collect();
    commit(design, |doc| {
        edit::set_tokens(doc, &edit::mode_list(doc), &changes)
    });
}

fn by_mode(values: &[(&str, &str)]) -> TokenChange {
    TokenChange::Modes(
        values
            .iter()
            .map(|(mode, value)| ((*mode).to_owned(), Some((*value).to_owned())))
            .collect(),
    )
}

fn style_of(design: &Design, board: &str) -> String {
    let doc = design.doc();
    tokens::style(doc, doc.mode_of(doc.get(board).unwrap()), true)
}

#[test]
fn tokens_render_in_each_artboards_mode() {
    let mut d = design();
    artboard(&mut d, "light");
    artboard(&mut d, "dark");
    set(
        &mut d,
        &[
            ("--brand", TokenChange::All("#c2410c".into())),
            ("--bg", TokenChange::All("#fff".into())),
        ],
    );
    assert_eq!(
        style_of(&d, "light"),
        "@layer finite-tokens { :host { --bg: #fff; --brand: #c2410c; } }"
    );

    // Naming the modes renames the implicit one, then adds the rest.
    let mut n = 0;
    let names = ["Light".to_owned(), "Dark".to_owned()];
    let (ops, modes) = edit::set_modes(d.doc(), &names, &mut || {
        n += 1;
        format!("m{n}")
    })
    .unwrap();
    d.commit("agent", "Modes", &ops, 0).unwrap();
    assert_eq!(
        modes,
        [
            (FIRST_MODE.to_owned(), "Light".to_owned()),
            ("m1".to_owned(), "Dark".to_owned())
        ]
    );
    set(&mut d, &[("--bg", by_mode(&[("dark", "#111")]))]);
    commit(&mut d, |doc| {
        edit::set_artboard_mode(doc, &["dark".into()], Some("Dark"))
    });

    // Dark has its own --bg, and falls back to the first mode for --brand.
    assert_eq!(
        style_of(&d, "dark"),
        "@layer finite-tokens { :host { --bg: #111; --brand: #c2410c; } }"
    );
    assert!(style_of(&d, "light").contains("--bg: #fff;"));

    // Saved and loaded, it renders the same.
    let saved = serde_json::to_string(&d.snapshot_to_save()).unwrap();
    let back = Design::from_snapshot(serde_json::from_str(&saved).unwrap());
    assert_eq!(style_of(&back, "dark"), style_of(&d, "dark"));

    // Deleting Dark takes its values with it and sends its artboard back to Light.
    commit(&mut d, |doc| edit::delete_mode(doc, "m1"));
    assert_eq!(style_of(&d, "dark"), style_of(&d, "light"));
    assert_eq!(d.doc().tokens()["--bg"].len(), 1);
    // And undo brings them back.
    d.undo("agent", 0).unwrap();
    assert!(style_of(&d, "dark").contains("--bg: #111;"));
}

#[test]
fn set_tokens_refuses_what_css_wouldnt_take() {
    let d = design();
    let modes = edit::mode_list(d.doc());
    let refused = |name: &str, change: TokenChange| {
        edit::set_tokens(d.doc(), &modes, &[(name.to_owned(), change)])
            .unwrap_err()
            .0
    };
    assert!(refused("brand", TokenChange::All("red".into())).contains("start with --"));
    assert!(refused("--brand", TokenChange::All("red; color: blue".into())).contains(";"));
    assert!(refused("--brand", by_mode(&[("Dark", "#000")])).contains("no mode \"Dark\""));

    // A raw op that breaks the rules doesn't apply either, wherever it came from.
    let mut doc = Document::default();
    let op = Op::Token {
        name: "--x".into(),
        mode_id: FIRST_MODE.into(),
        value: Some("} body { color: red".into()),
    };
    assert!(doc.try_apply(&op).is_err());
}

#[test]
fn undo_takes_back_only_the_modes_an_agent_changed() {
    let mut d = design();
    let mut n = 0;
    let names = ["Light".to_owned(), "Dark".to_owned()];
    let (ops, _) = edit::set_modes(d.doc(), &names, &mut || {
        n += 1;
        format!("m{n}")
    })
    .unwrap();
    d.commit("agent", "Modes", &ops, 0).unwrap();
    set(&mut d, &[("--bg", by_mode(&[("Light", "white")]))]);
    // Alice changes Light, then Bob sets Dark.
    let modes = edit::mode_list(d.doc());
    let ops = edit::set_tokens(
        d.doc(),
        &modes,
        &[("--bg".into(), by_mode(&[("Light", "red")]))],
    )
    .unwrap();
    d.commit("alice", "Light", &ops, 0).unwrap();
    let ops = edit::set_tokens(
        d.doc(),
        &modes,
        &[("--bg".into(), by_mode(&[("Dark", "black")]))],
    )
    .unwrap();
    d.commit("bob", "Dark", &ops, 0).unwrap();
    // Alice's undo puts Light back and leaves Bob's Dark value.
    d.undo("alice", 0).unwrap();
    assert_eq!(
        d.doc().tokens()["--bg"],
        BTreeMap::from([
            (FIRST_MODE.to_owned(), "white".to_owned()),
            ("m1".to_owned(), "black".to_owned())
        ])
    );
}

#[test]
fn custom_properties_past_the_token_limit_stay_in_the_artboards() {
    let mut d = design();
    artboard(&mut d, "a");
    let vars: Vec<String> = (0..=tokens::MAX_TOKENS)
        .map(|i| format!("--v{i:04}: {i}px"))
        .collect();
    d.commit(
        "agent",
        "Old",
        &[Op::Css {
            css: Some(format!(
                "@import url(a.css);\n:root {{ {} }}",
                vars.join("; ")
            )),
        }],
        0,
    )
    .unwrap();
    let mut n = 0;
    d.migrate_css(0, &mut || {
        n += 1;
        format!("s{n}")
    })
    .unwrap();
    assert_eq!(d.doc().tokens().len(), tokens::MAX_TOKENS);
    let style = d.doc().children(Some("a"))[0];
    let text = d.doc().children(Some(&style.id))[0].text.clone().unwrap();
    assert!(
        text.contains(":is(:root, :host) { --v2000: 2000px; }"),
        "{text}"
    );
    // The import stays first, where it still loads.
    assert!(
        text.starts_with("@import url(a.css) layer(finite-shared);"),
        "{text}"
    );
}

#[test]
fn old_shared_css_moves_into_tokens_and_each_artboard() {
    let mut d = design();
    artboard(&mut d, "a");
    artboard(&mut d, "b");
    let css = "@import url('https://fonts.example/a.css');\n\
               :root { --ink: #111; --paper: #fff }\n\
               .btn { color: var(--ink) }";
    // A journal from before tokens holds the old op, and still replays.
    let old: Op = serde_json::from_value(serde_json::json!({ "op": "css", "css": css })).unwrap();
    d.replay(Record::Change {
        change: Change {
            seq: d.seq() + 1,
            actor: "agent".into(),
            origin: Origin::Edit,
            label: "Set shared CSS".into(),
            ops: vec![old],
        },
    });
    assert_eq!(d.doc().css(), Some(css));

    let mut n = 0;
    let change = d
        .migrate_css(0, &mut || {
            n += 1;
            format!("s{n}")
        })
        .unwrap()
        .expect("something moved");
    assert_eq!(change.label, "Moved shared CSS into tokens");
    assert_eq!(d.doc().css(), None);
    assert_eq!(
        d.doc().tokens().keys().collect::<Vec<_>>(),
        ["--ink", "--paper"]
    );
    // Nobody can undo back to the old stylesheet.
    assert!(d.history("agent").is_none());

    // Each artboard starts with the rest, in the layer the shared CSS had.
    for board in ["a", "b"] {
        let first = d.doc().children(Some(board))[0];
        assert_eq!(first.tag(), Some("style"));
        let text = d.doc().children(Some(&first.id))[0].text.clone().unwrap();
        assert_eq!(
            text,
            html::layered_style(
                "@import url('https://fonts.example/a.css');\n.btn { color: var(--ink) }"
            )
        );
    }

    // A saved design doesn't mention the old CSS, and loading it moves nothing.
    let saved: Snapshot =
        serde_json::from_str(&serde_json::to_string(&d.snapshot_to_save()).unwrap()).unwrap();
    assert!(saved.css.is_none());
    let mut back = Design::from_snapshot(saved);
    assert!(
        back.migrate_css(0, &mut || unreachable!())
            .unwrap()
            .is_none()
    );
}

#[test]
fn shared_css_cleared_before_tokens_cant_come_back_through_undo() {
    let mut d = design();
    let css = |css: Option<&str>| Op::Css {
        css: css.map(str::to_owned),
    };
    d.commit("agent", "Set", &[css(Some(".x { color: red }"))], 0)
        .unwrap();
    d.commit("agent", "Clear", &[css(None)], 0).unwrap();
    let mut back = Design::from_snapshot(d.snapshot_to_save());
    assert!(
        back.migrate_css(0, &mut || unreachable!())
            .unwrap()
            .is_none()
    );
    assert!(back.undo("agent", 0).is_none());
}

#[test]
fn a_token_named_twice_in_one_edit_ends_with_its_last_value() {
    let mut d = design();
    set(&mut d, &[("--brand", TokenChange::All("red".into()))]);
    set(
        &mut d,
        &[
            ("--brand", TokenChange::All("blue".into())),
            ("--brand", TokenChange::All("green".into())),
        ],
    );
    assert_eq!(d.doc().tokens()["--brand"][FIRST_MODE], "green");
}

#[test]
fn a_token_deleted_in_an_edit_frees_its_place_at_the_limit() {
    let mut d = design();
    let fill: Vec<(String, TokenChange)> = (1..tokens::MAX_TOKENS)
        .map(|i| (format!("--v{i}"), TokenChange::All("1px".into())))
        .collect();
    commit(&mut d, |doc| {
        edit::set_tokens(doc, &edit::mode_list(doc), &fill)
    });
    set(
        &mut d,
        &[
            ("--a", TokenChange::All("red".into())),
            ("--b", TokenChange::All("blue".into())),
            ("--a", TokenChange::Delete),
        ],
    );
    assert_eq!(d.doc().tokens().len(), tokens::MAX_TOKENS);
    assert_eq!(d.doc().tokens()["--b"][FIRST_MODE], "blue");
    assert!(!d.doc().tokens().contains_key("--a"));
}

#[test]
fn replacing_in_tokens_matches_colors_in_any_notation() {
    let mut design = design();
    set(
        &mut design,
        &[
            ("--brand", TokenChange::All("rgb(59 130 246)".into())),
            ("--ring", TokenChange::All("0 0 0 2px #3b82f680".into())),
            ("--gap", TokenChange::All("8px".into())),
        ],
    );
    let (ops, lines) =
        finite_design::search::replace_in_tokens(design.doc(), "#3B82F6", "#f97316").unwrap();
    assert_eq!(
        lines,
        [
            "--brand: rgb(59 130 246) → #f97316",
            "--ring: 0 0 0 2px #3b82f680 → 0 0 0 2px rgba(249, 115, 22, 0.502)",
        ]
    );
    design.commit("agent", "Replace", &ops, 0).unwrap();
    assert_eq!(
        finite_design::search::find_in_tokens(design.doc(), "rgb(249, 115, 22)"),
        [
            "--brand: #f97316",
            "--ring: 0 0 0 2px rgba(249, 115, 22, 0.502)"
        ]
    );
    assert_eq!(
        finite_design::search::find_in_tokens(design.doc(), "GAP"),
        ["--gap: 8px"]
    );
    let (ops, lines) =
        finite_design::search::replace_in_tokens(design.doc(), "#000", "red").unwrap();
    assert!(ops.is_empty() && lines.is_empty());
}
