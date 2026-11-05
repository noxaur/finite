//! Copies that stop following their components: `duplicate_detached` and
//! `detach_all` turn every instance in a copy into plain elements, however
//! deep they nest, so a component edit made later leaves the copy alone.

use std::collections::BTreeMap;

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
    let ops = edit::detach_all(d.view(), &["a".into()], &mut next).unwrap();
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
