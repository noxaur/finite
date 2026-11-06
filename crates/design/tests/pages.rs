//! Pages: named groups of artboards that the viewer shows one at a time. A
//! design without pages has one implicit page, and every artboard is on a
//! page, falling back to the first one.

use std::collections::BTreeMap;

use finite_design::{
    Design, DesignMeta, Document, FIRST_PAGE, Op, Snapshot,
    edit::{self, NewArtboard},
};

fn design() -> Design {
    Design::new(DesignMeta {
        id: "d".into(),
        name: "Pages".into(),
        created_at: 0,
        updated_at: 0,
    })
}

fn artboard(design: &mut Design, id: &str, page: Option<&str>) {
    let spec = NewArtboard {
        name: id.into(),
        width: 100.0,
        height: Some(100.0),
        position: None,
        page: page.map(Into::into),
        styles: BTreeMap::new(),
    };
    let ops = edit::create_artboard(design.doc(), id.into(), spec).unwrap();
    design.commit("agent", "Create artboard", &ops, 0).unwrap();
}

fn commit(design: &mut Design, build: impl FnOnce(&Document) -> edit::Result<Vec<Op>>) {
    let ops = build(design.doc()).unwrap();
    design.commit("agent", "Edit", &ops, 0).unwrap();
}

fn on(doc: &Document, page: &str) -> Vec<String> {
    doc.artboards_on(page)
        .iter()
        .map(|b| b.id.clone())
        .collect()
}

fn names(doc: &Document) -> Vec<String> {
    doc.pages().iter().map(|(_, p)| p.name.clone()).collect()
}

#[test]
fn a_design_starts_with_one_implicit_page() {
    let mut d = design();
    artboard(&mut d, "home", None);
    assert_eq!(names(d.doc()), ["Page 1"]);
    assert_eq!(on(d.doc(), FIRST_PAGE), ["home"]);
    assert!(d.snapshot().pages.is_empty());
    // It can be renamed like any page, which makes it a real one.
    commit(&mut d, |doc| edit::rename_page(doc, FIRST_PAGE, "Screens"));
    assert_eq!(names(d.doc()), ["Screens"]);
    assert_eq!(on(d.doc(), FIRST_PAGE), ["home"]);
}

#[test]
fn artboards_on_a_new_page_are_placed_apart_from_the_first() {
    let mut d = design();
    artboard(&mut d, "home", None);
    commit(&mut d, |doc| {
        edit::create_page(doc, "kit".into(), "Components")
    });
    // The implicit page became a real one, so its artboards stayed on it.
    assert_eq!(names(d.doc()), ["Page 1", "Components"]);
    assert_eq!(on(d.doc(), FIRST_PAGE), ["home"]);

    artboard(&mut d, "button", Some("kit"));
    assert_eq!(on(d.doc(), "kit"), ["button"]);
    // The first artboard on a page starts at the origin, not beside the
    // artboards on other pages.
    let button = d.doc().get("button").unwrap();
    assert_eq!((button.x, button.y), (Some(0.0), Some(0.0)));

    let unknown = NewArtboard {
        name: "x".into(),
        width: 1.0,
        height: Some(1.0),
        position: None,
        page: Some("nope".into()),
        styles: BTreeMap::new(),
    };
    let error = edit::create_artboard(d.doc(), "x".into(), unknown).unwrap_err();
    assert!(error.0.contains("page \"nope\" not found"), "{error}");
}

#[test]
fn moving_and_copying_keep_artboards_on_pages() {
    let mut d = design();
    artboard(&mut d, "home", None);
    artboard(&mut d, "card", None);
    commit(&mut d, |doc| {
        edit::create_page(doc, "kit".into(), "Components")
    });
    commit(&mut d, |doc| {
        edit::move_to_page(doc, &["card".into()], "kit")
    });
    assert_eq!(on(d.doc(), FIRST_PAGE), ["home"]);
    assert_eq!(on(d.doc(), "kit"), ["card"]);
    assert_eq!(d.doc().get("card").unwrap().x, Some(0.0));
    // Already there: nothing to do.
    assert_eq!(
        edit::move_to_page(d.doc(), &["card".into()], "kit"),
        Ok(vec![])
    );

    let mut n = 0;
    let mut new_id = || {
        n += 1;
        format!("copy{n}")
    };
    let (ops, roots) = edit::duplicate(d.doc(), &["card".into()], &mut new_id).unwrap();
    d.commit("agent", "Duplicate", &ops, 0).unwrap();
    assert_eq!(on(d.doc(), "kit"), ["card", roots[0].as_str()]);

    // An element pulled out of an artboard becomes an artboard on its page.
    let ops = edit::write_html(
        d.doc(),
        "card",
        "<p>Hi</p>",
        edit::WriteMode::Append,
        None,
        &mut new_id,
    )
    .unwrap();
    let p = ops.0[0].id().to_owned();
    d.commit("agent", "Write", &ops.0, 0).unwrap();
    commit(&mut d, |doc| {
        edit::move_nodes(doc, std::slice::from_ref(&p), None, None)
    });
    assert!(on(d.doc(), "kit").contains(&p));
    // And back into an artboard, it leaves its page behind.
    commit(&mut d, |doc| {
        edit::move_nodes(doc, std::slice::from_ref(&p), Some("home"), None)
    });
    assert_eq!(d.doc().get(&p).unwrap().page, None);
}

#[test]
fn deleting_a_page_deletes_its_artboards_and_undo_brings_them_back() {
    let mut d = design();
    artboard(&mut d, "home", None);
    commit(&mut d, |doc| {
        edit::create_page(doc, "kit".into(), "Components")
    });
    artboard(&mut d, "button", Some("kit"));

    commit(&mut d, |doc| edit::delete_page(doc, "kit"));
    assert_eq!(names(d.doc()), ["Page 1"]);
    assert!(d.doc().get("button").is_none());
    let error = edit::delete_page(d.doc(), FIRST_PAGE).unwrap_err();
    assert!(error.0.contains("only page"), "{error}");

    d.undo("agent", 0).unwrap();
    assert_eq!(on(d.doc(), "kit"), ["button"]);
}

#[test]
fn an_artboard_whose_page_is_gone_falls_back_to_the_first_page() {
    let mut d = design();
    artboard(&mut d, "home", None);
    commit(&mut d, |doc| {
        edit::create_page(doc, "kit".into(), "Components")
    });
    artboard(&mut d, "button", Some("kit"));
    // Another agent removes the page without its artboards, as undoing its
    // create_page would.
    let remove = [Op::Page {
        id: "kit".into(),
        page: None,
    }];
    d.commit("other", "Remove page", &remove, 0).unwrap();
    assert_eq!(on(d.doc(), FIRST_PAGE), ["home", "button"]);
}

#[test]
fn pages_survive_a_snapshot() {
    let mut d = design();
    commit(&mut d, |doc| {
        edit::create_page(doc, "kit".into(), "Components")
    });
    artboard(&mut d, "button", Some("kit"));
    let json = serde_json::to_string(&d.snapshot()).unwrap();
    let back = Design::from_snapshot(serde_json::from_str::<Snapshot>(&json).unwrap());
    assert_eq!(names(back.doc()), ["Page 1", "Components"]);
    assert_eq!(on(back.doc(), "kit"), ["button"]);
}

#[test]
fn a_page_background_saves_and_undoes_back_to_unset() {
    let mut d = design();
    artboard(&mut d, "home", None);
    let background = |d: &Design| d.doc().page(FIRST_PAGE).and_then(|p| p.background.clone());
    commit(&mut d, |doc| {
        edit::set_page_background(doc, FIRST_PAGE, Some(" #e8eef0 "))
    });
    assert_eq!(background(&d).as_deref(), Some("#e8eef0"));
    // Renaming keeps it, and it survives a save.
    commit(&mut d, |doc| edit::rename_page(doc, FIRST_PAGE, "Screens"));
    let json = serde_json::to_string(&d.snapshot()).unwrap();
    assert!(json.contains("\"background\":\"#e8eef0\""), "{json}");
    let back = Design::from_snapshot(serde_json::from_str::<Snapshot>(&json).unwrap());
    assert_eq!(background(&back).as_deref(), Some("#e8eef0"));

    // One undo each: the name, then the color, back to the implicit page.
    d.undo("agent", 0).unwrap();
    assert_eq!(background(&d).as_deref(), Some("#e8eef0"));
    d.undo("agent", 0).unwrap();
    assert_eq!(background(&d), None);
    assert!(d.doc().page_map().is_empty());

    commit(&mut d, |doc| {
        edit::set_page_background(doc, FIRST_PAGE, Some("rgb(10 20 30)"))
    });
    commit(&mut d, |doc| {
        edit::set_page_background(doc, FIRST_PAGE, None)
    });
    assert_eq!(background(&d), None);
    // A page without a background saves without the field.
    let page = serde_json::to_string(d.doc().page(FIRST_PAGE).unwrap()).unwrap();
    assert_eq!(page, r#"{"name":"Page 1","index":"V"}"#);
    d.undo("agent", 0).unwrap();
    assert_eq!(background(&d).as_deref(), Some("rgb(10 20 30)"));

    for color in [
        "var(--bg)",
        "color-mix(in srgb, var(--bg) 50%, transparent)",
        "#e8eef080",
        "rebeccapurple",
        "oklch(0.7 0.1 200)",
    ] {
        assert!(
            edit::set_page_background(d.doc(), FIRST_PAGE, Some(color)).is_ok(),
            "{color}"
        );
    }
    for bad in [
        "red; x",
        "url(x)",
        "var(--bg) url(x)",
        "var(--a));background:url(x",
        "",
    ] {
        let error = edit::set_page_background(d.doc(), FIRST_PAGE, Some(bad)).unwrap_err();
        assert!(error.0.contains("isn't a color"), "{bad}: {error}");
    }
    let error = edit::set_page_background(d.doc(), "nope", Some("#000")).unwrap_err();
    assert!(error.0.contains("not found"), "{error}");
}
