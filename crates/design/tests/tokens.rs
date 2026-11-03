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
        values: Some(BTreeMap::from([(
            FIRST_MODE.into(),
            "} body { color: red".into(),
        )])),
    };
    assert!(doc.try_apply(&op).is_err());
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
