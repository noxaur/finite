//! Copies that stop following their components: `duplicate_detached` and
//! `detach_all` turn every instance in a copy into plain elements, however
//! deep they nest, so a component edit made later leaves the copy alone.

use std::collections::{BTreeMap, HashSet};

use finite_design::{
    Design, DesignMeta, Document, NodeId, Op,
    edit::{self, NewArtboard, WriteMode},
    html,
};

fn ids() -> impl FnMut() -> NodeId {
    let mut n = 0;
    move || {
        n += 1;
        format!("n{n}")
    }
}

fn commit(design: &mut Design, label: &str, ops: &[Op]) {
    design.commit("agent", label, ops, 0).unwrap();
}

fn write(design: &mut Design, target: &str, source: &str, new_id: &mut impl FnMut() -> NodeId) {
    let ops = edit::write_html(
        design.view(),
        target,
        source,
        WriteMode::Append,
        None,
        new_id,
    )
    .unwrap()
    .0;
    commit(design, "Write", &ops);
}

fn artboard(design: &mut Design, id: &str) {
    let spec = NewArtboard {
        name: id.into(),
        width: 400.0,
        height: Some(300.0),
        position: None,
        page: None,
        styles: BTreeMap::new(),
    };
    let ops = edit::create_artboard(design.doc(), id.into(), spec).unwrap();
    commit(design, "Create artboard", &ops);
}

/// A design whose "Bar" component holds an instance of "Logo", with one
/// instance of Bar on artboard `a` and its component on artboard `home`.
fn design(new_id: &mut impl FnMut() -> NodeId) -> (Design, NodeId, NodeId) {
    let mut d = Design::new(DesignMeta {
        id: "d".into(),
        name: "Detach".into(),
        created_at: 0,
        updated_at: 0,
    });
    artboard(&mut d, "home");
    artboard(&mut d, "a");
    write(
        &mut d,
        "home",
        r#"<span data-component="Logo">Finite</span>"#,
        new_id,
    );
    let logo = d.doc().nodes().find(|n| n.component).unwrap().id.clone();
    write(
        &mut d,
        "home",
        &format!(
            r#"<header data-component="Bar"><span data-instance-of="{logo}"></span><h1>Home</h1></header>"#
        ),
        new_id,
    );
    let bar = d
        .doc()
        .nodes()
        .find(|n| n.component && n.id != logo)
        .unwrap()
        .id
        .clone();
    write(
        &mut d,
        "a",
        &format!(r#"<header data-instance-of="{bar}"></header><p>Body</p>"#),
        new_id,
    );
    (d, logo, bar)
}

fn copy_text(doc: &Document, root: &str) -> String {
    html::export(doc, root, true).unwrap()
}

#[test]
fn a_copy_follows_its_components_unless_detached() {
    let mut next = ids();
    let (mut d, _, bar) = design(&mut next);
    let (ops, roots) = edit::duplicate(d.view(), &["a".into()], &mut next).unwrap();
    commit(&mut d, "Copy", &ops);
    assert_eq!(
        edit::instances_in(d.view(), &roots).len(),
        1,
        "the copy holds an instance of Bar"
    );

    let (ops, frozen) = edit::duplicate_detached(d.view(), &["a".into()], &mut next).unwrap();
    commit(&mut d, "Frozen copy", &ops);
    assert!(edit::instances_in(d.view(), &frozen).is_empty());
    assert!(
        copy_text(d.view(), &frozen[0]).contains("Finite")
            && copy_text(d.view(), &frozen[0]).contains("Home"),
        "{}",
        copy_text(d.view(), &frozen[0])
    );

    // Editing the component changes the copy that follows it and not the frozen one.
    let heading = d.doc().children(Some(&bar))[1].id.clone();
    let ops = edit::set_text(d.view(), &heading, "Start", &mut next).unwrap();
    commit(&mut d, "Rename", &ops);
    assert!(copy_text(d.view(), &roots[0]).contains("Start"));
    let frozen_text = copy_text(d.view(), &frozen[0]);
    assert!(
        frozen_text.contains("Home") && !frozen_text.contains("Start"),
        "{frozen_text}"
    );
}

#[test]
fn detach_all_reaches_instances_nested_in_instances() {
    let mut next = ids();
    let (d, logo, bar) = design(&mut next);
    // On artboard a, Bar is an instance and so is the Logo it shows.
    let ops = edit::detach_all(d.doc(), &["a".into()], &mut next).unwrap();
    assert_eq!(
        edit::detached_count(&ops),
        2,
        "Bar, then the Logo inside it"
    );
    let mut doc = d.doc().clone();
    doc.apply_all(&ops);
    let view = finite_design::components::expand(&doc);
    assert!(edit::instances_in(&view, &["a".into()]).is_empty());
    assert!(
        [&logo, &bar]
            .iter()
            .all(|id| view.get(id).is_some_and(|n| n.component)),
        "detaching leaves the components alone"
    );
    assert!(copy_text(&view, "a").contains("Finite"));
}

#[test]
fn a_frozen_copy_is_one_undo_step() {
    let mut next = ids();
    let (mut d, _, _) = design(&mut next);
    let before = copy_text(d.view(), "a");
    let (ops, roots) = edit::duplicate_detached(d.view(), &["a".into()], &mut next).unwrap();
    commit(&mut d, "Frozen copy", &ops);
    assert!(d.doc().get(&roots[0]).is_some());
    d.undo("agent", 0).unwrap();
    assert!(
        d.doc().get(&roots[0]).is_none(),
        "the copy and its detaching go together"
    );
    assert_eq!(copy_text(d.view(), "a"), before);
    d.redo("agent", 0).unwrap();
    assert!(edit::instances_in(d.view(), &roots).is_empty());
}

#[test]
fn a_copy_without_instances_adds_nothing_to_duplicate() {
    let mut d = Design::new(DesignMeta {
        id: "e".into(),
        name: "Blank".into(),
        created_at: 0,
        updated_at: 0,
    });
    artboard(&mut d, "x");
    let plain = edit::duplicate(d.view(), &["x".into()], &mut ids()).unwrap();
    let frozen = edit::duplicate_detached(d.view(), &["x".into()], &mut ids()).unwrap();
    assert_eq!(plain, frozen);
}

/// Freezes the instances under `roots` the way the `component` op does:
/// built against the staged document, applied as one transaction.
fn freeze(design: &mut Design, roots: &[NodeId], new_id: &mut impl FnMut() -> NodeId) -> usize {
    let (_, detached) = design
        .transact(
            "agent",
            "Detach",
            0,
            |tx| -> Result<usize, edit::EditError> {
                let ops = edit::detach_all(tx.doc(), roots, &mut || tx.new_id(&mut *new_id))?;
                let detached = edit::detached_count(&ops);
                tx.edit(ops, new_id)?;
                Ok(detached)
            },
        )
        .unwrap();
    detached
}

fn component(design: &Design, name: &str) -> NodeId {
    design
        .doc()
        .nodes()
        .find(|n| n.component && n.name.as_deref() == Some(name))
        .unwrap_or_else(|| panic!("no component {name}"))
        .id
        .clone()
}

/// Writes `source` into artboard `board` and returns the id of its one root.
fn root_of(
    design: &mut Design,
    board: &str,
    source: &str,
    new_id: &mut impl FnMut() -> NodeId,
) -> NodeId {
    let before: HashSet<NodeId> = design
        .doc()
        .children(Some(board))
        .iter()
        .map(|n| n.id.clone())
        .collect();
    write(design, board, source, new_id);
    design
        .doc()
        .children(Some(board))
        .iter()
        .map(|n| n.id.clone())
        .find(|id| !before.contains(id))
        .unwrap()
}

/// `html` without its `data-` attributes, which differ by id and instance.
fn bare(html: &str) -> String {
    let mut out = String::new();
    let mut rest = html;
    while let Some(at) = rest.find(" data-") {
        out.push_str(&rest[..at]);
        let attr = &rest[at + 1..];
        let end = attr
            .find("=\"")
            .map_or(0, |q| q + 2 + attr[q + 2..].find('"').unwrap() + 1);
        rest = &attr[end..];
    }
    out.push_str(rest);
    out
}

fn count(text: &str, needle: &str) -> usize {
    text.matches(needle).count()
}

#[test]
fn a_component_definition_in_the_selection_is_not_rewritten() {
    let mut next = ids();
    let mut d = Design::new(DesignMeta {
        id: "d".into(),
        name: "Detach".into(),
        created_at: 0,
        updated_at: 0,
    });
    artboard(&mut d, "s");
    artboard(&mut d, "o");
    root_of(
        &mut d,
        "s",
        r#"<span data-component="Logo">Finite</span>"#,
        &mut next,
    );
    let logo = component(&d, "Logo");
    root_of(
        &mut d,
        "s",
        &format!(
            r#"<header data-component="Bar"><span data-instance-of="{logo}"></span><h1>Home</h1></header>"#
        ),
        &mut next,
    );
    let bar = component(&d, "Bar");
    root_of(
        &mut d,
        "s",
        &format!(r#"<header data-instance-of="{bar}"></header>"#),
        &mut next,
    );
    let other = root_of(
        &mut d,
        "o",
        &format!(r#"<header data-instance-of="{bar}"></header>"#),
        &mut next,
    );

    // An instance of Bar elsewhere renames the Logo it shows.
    let logo_text = d
        .view()
        .subtree(&other)
        .into_iter()
        .find(|n| n.text.as_deref() == Some("Finite"))
        .expect("the Logo's text is shown")
        .id
        .clone();
    d.transact("agent", "Rename", 0, |tx| -> Result<(), edit::EditError> {
        let ops = edit::set_text(tx.view(), &logo_text, "Settings", &mut next)?;
        tx.edit(ops, &mut next)
    })
    .unwrap();
    assert!(copy_text(d.view(), "o").contains("Settings"));

    // Freezing the artboard with the definitions detaches Bar's instance on
    // it, and leaves Bar, with the Logo instance in it, as it was.
    let detached = freeze(&mut d, &["s".into()], &mut next);
    assert_eq!(detached, 2, "the Bar instance, then the Logo it showed");
    assert!(
        d.doc().children(Some(&bar)).iter().any(|n| n.is_instance()),
        "Bar still holds an instance of Logo"
    );
    let text = copy_text(d.view(), "o");
    assert!(
        text.contains("Settings") && !text.contains("Finite"),
        "the override survives: {text}"
    );
}

#[test]
fn nested_components_freeze_to_one_copy_of_each_part() {
    let mut next = ids();
    let mut d = Design::new(DesignMeta {
        id: "d".into(),
        name: "Detach".into(),
        created_at: 0,
        updated_at: 0,
    });
    artboard(&mut d, "s");
    root_of(
        &mut d,
        "s",
        r#"<span data-component="Logo">Finite</span>"#,
        &mut next,
    );
    let logo = component(&d, "Logo");
    root_of(
        &mut d,
        "s",
        &format!(
            r#"<header data-component="Bar"><span data-instance-of="{logo}"></span><h1>Home</h1></header>"#
        ),
        &mut next,
    );
    let bar = component(&d, "Bar");
    root_of(
        &mut d,
        "s",
        &format!(
            r#"<main data-component="Page"><header data-instance-of="{bar}"></header></main>"#
        ),
        &mut next,
    );
    let page = component(&d, "Page");
    let screen = root_of(
        &mut d,
        "s",
        &format!(r#"<main data-instance-of="{page}"></main>"#),
        &mut next,
    );
    let before = copy_text(d.view(), &screen);

    let detached = freeze(&mut d, &["s".into()], &mut next);
    assert_eq!(detached, 3, "Page, Bar and Logo");
    assert!(edit::instances_in(d.view(), &["s".into()]).is_empty());
    let after = copy_text(d.view(), &screen);
    assert_eq!(count(&after, "Finite"), 1, "{after}");
    assert_eq!(count(&after, "Home"), 1, "{after}");
    assert_eq!(bare(&after), bare(&before), "it shows what it did");
    let plain = d
        .doc()
        .subtree(&screen)
        .into_iter()
        .filter(|n| n.text.as_deref() == Some("Finite"))
        .count();
    assert_eq!(plain, 1, "no stale copy of the Logo's text");

    d.undo("agent", 0).unwrap();
    assert!(d.doc().get(&screen).unwrap().is_instance());
    assert_eq!(copy_text(d.view(), &screen), before);
}

#[test]
fn chains_deeper_than_thirty_two_levels_freeze() {
    let mut next = ids();
    let mut d = Design::new(DesignMeta {
        id: "d".into(),
        name: "Detach".into(),
        created_at: 0,
        updated_at: 0,
    });
    artboard(&mut d, "s");
    root_of(
        &mut d,
        "s",
        r#"<span data-component="C0">Deep</span>"#,
        &mut next,
    );
    let mut inner = component(&d, "C0");
    const LEVELS: usize = 40;
    for level in 1..=LEVELS {
        root_of(
            &mut d,
            "s",
            &format!(
                r#"<div data-component="C{level}"><div data-instance-of="{inner}"></div></div>"#
            ),
            &mut next,
        );
        inner = component(&d, &format!("C{level}"));
    }
    let top = root_of(
        &mut d,
        "s",
        &format!(r#"<div data-instance-of="{inner}"></div>"#),
        &mut next,
    );

    let detached = freeze(&mut d, &["s".into()], &mut next);
    assert_eq!(detached, LEVELS + 1);
    assert!(edit::instances_in(d.view(), &["s".into()]).is_empty());
    assert_eq!(count(&copy_text(d.view(), &top), "Deep"), 1);
}
