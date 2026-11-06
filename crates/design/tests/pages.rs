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

#[test]
fn undoing_a_background_or_a_rename_leaves_the_other_actors_change() {
    fn as_(d: &mut Design, actor: &str, build: impl FnOnce(&Document) -> edit::Result<Vec<Op>>) {
        let ops = build(d.doc()).unwrap();
        d.commit(actor, "Edit", &ops, 0).unwrap();
    }
    let page = |d: &Design, id: &str| {
        let page = d.doc().page(id).unwrap();
        (page.name.clone(), page.background.clone())
    };
    // On the implicit first page and on a page made with create_page.
    let start = |id: &str| {
        let mut d = design();
        if id != FIRST_PAGE {
            commit(&mut d, |doc| edit::create_page(doc, id.into(), "Kit"));
        }
        d
    };
    for (id, name) in [(FIRST_PAGE, "Page 1"), ("kit", "Kit")] {
        // Alice sets a background, Bob renames the page, Alice undoes.
        let mut d = start(id);
        as_(&mut d, "alice", |doc| {
            edit::set_page_background(doc, id, Some("#000"))
        });
        as_(&mut d, "bob", |doc| edit::rename_page(doc, id, "Home"));
        d.undo("alice", 0).unwrap();
        assert_eq!(page(&d, id), ("Home".into(), None), "{id}");
        d.redo("alice", 0).unwrap();
        assert_eq!(page(&d, id), ("Home".into(), Some("#000".into())), "{id}");

        // Bob renames the page, Alice sets a background, Bob undoes.
        let mut d = start(id);
        as_(&mut d, "bob", |doc| edit::rename_page(doc, id, "Home"));
        as_(&mut d, "alice", |doc| {
            edit::set_page_background(doc, id, Some("#000"))
        });
        d.undo("bob", 0).unwrap();
        assert_eq!(page(&d, id), (name.into(), Some("#000".into())), "{id}");

        // Undoing both leaves the page as it started. The first page stays
        // in the page map: Bob's undo didn't take it out, as Alice had
        // changed it since.
        d.undo("alice", 0).unwrap();
        assert_eq!(page(&d, id), (name.into(), None), "{id}");
    }
}

#[test]
fn undoing_a_new_page_keeps_a_background_set_on_the_first_page_since() {
    let background = |d: &Design| d.doc().page(FIRST_PAGE).unwrap().background.clone();
    // With the first page implicit, and saved in the page map as it starts.
    let explicit = || {
        let mut d = design();
        let first = Op::Page {
            id: FIRST_PAGE.into(),
            page: Some(d.doc().page(FIRST_PAGE).unwrap().clone()),
        };
        d.commit("other", "Save", &[first], 0).unwrap();
        d
    };
    let starts: [fn() -> Design; 2] = [design, explicit];
    for start in starts {
        let mut d = start();
        let map = d.doc().page_map().clone();
        // Alice sets a background and undoes it: the page map is as it was.
        let ops = edit::set_page_background(d.doc(), FIRST_PAGE, Some("#000")).unwrap();
        d.commit("alice", "Background", &ops, 0).unwrap();
        d.undo("alice", 0).unwrap();
        assert_eq!(d.doc().page_map(), &map);

        // Bob adds a page, Carol sets the first page's background, Bob undoes.
        let ops = edit::create_page(d.doc(), "kit".into(), "Kit").unwrap();
        d.commit("bob", "Add page", &ops, 0).unwrap();
        let ops = edit::set_page_background(d.doc(), FIRST_PAGE, Some("#123")).unwrap();
        d.commit("carol", "Background", &ops, 0).unwrap();
        d.undo("bob", 0).unwrap();
        assert!(d.doc().page("kit").is_none());
        assert_eq!(background(&d).as_deref(), Some("#123"), "{map:?}");
        // Carol's undo then leaves the first page as it started.
        d.undo("carol", 0).unwrap();
        assert_eq!(background(&d), None);
        assert_eq!(d.doc().pages().len(), 1);
    }
}
