//! Several edits staged as one change (`Design::transact`): each step sees
//! the ones before it, and the whole lot commits, undoes and redoes as one,
//! or not at all.

use std::collections::BTreeMap;

use finite_design::{
    Design, DesignMeta, Op, PropKey, Rejected,
    comment::{Anchor, Author, AuthorKind},
    edit::{self, EditError, NewArtboard, WriteMode},
    html::{self, ExportOptions},
    import::{BlobHash, ImportRecord},
};

fn design() -> Design {
    let mut design = Design::new(DesignMeta {
        id: "d".into(),
        name: "Transact".into(),
        created_at: 0,
        updated_at: 0,
    });
    let ops = edit::create_artboard(design.doc(), "board".into(), artboard()).unwrap();
    design.commit("A", "Create artboard", &ops, 0).unwrap();
    design
}

fn artboard() -> NewArtboard {
    NewArtboard {
        name: "Page".into(),
        width: 600.0,
        height: Some(400.0),
        position: None,
        page: None,
        styles: BTreeMap::new(),
    }
}

/// Ids `n1`, `n2`, … in order.
fn ids() -> impl FnMut() -> String {
    let mut n = 0;
    move || {
        n += 1;
        format!("n{n}")
    }
}

fn styles(name: &str, value: &str) -> BTreeMap<String, Option<String>> {
    BTreeMap::from([(name.to_owned(), Some(value.to_owned()))])
}

/// Everything the design saves, to show nothing changed.
fn saved(design: &Design) -> String {
    serde_json::to_string(&design.snapshot_to_save()).unwrap()
}

fn style(design: &Design, id: &str, name: &str) -> Option<String> {
    design
        .doc()
        .get(id)?
        .get(&PropKey::Style(name.into()))
        .and_then(|v| v.as_str().map(str::to_owned))
}

/// A second artboard with a card in it, then the card styled and given a
/// heading, each step built against the document the step before left.
fn build_card(design: &mut Design) -> (Option<finite_design::Change>, String) {
    let mut make_id = ids();
    design
        .transact("A", "Add a card", 1, |tx| {
            let board = tx.new_id(&mut make_id);
            let ops = edit::create_artboard(tx.doc(), board.clone(), artboard())?;
            tx.apply(&ops)?;
            let mut new_id = || tx.new_id(&mut make_id);
            let (ops, roots) = edit::write_html(
                tx.view(),
                &board,
                "<div class=\"card\">Card</div>",
                WriteMode::Append,
                None,
                &mut new_id,
            )?;
            tx.edit(ops, &mut make_id)?;
            let ops = edit::update_styles(tx.view(), &roots, &styles("color", "red"))?;
            tx.edit(ops, &mut make_id)?;
            let (ops, _) = edit::write_html(
                tx.view(),
                &roots[0],
                "<h2>Title</h2>",
                WriteMode::Append,
                Some(0),
                &mut || tx.new_id(&mut make_id),
            )?;
            tx.edit(ops, &mut make_id)?;
            Ok::<_, EditError>(roots[0].clone())
        })
        .unwrap()
}

#[test]
fn each_step_sees_the_steps_before_it_and_all_commit_as_one_change() {
    let mut design = design();
    let seq = design.seq();
    let (change, card) = build_card(&mut design);
    let change = change.unwrap();
    assert_eq!(design.seq(), seq + 1, "one change");
    assert_eq!(change.label, "Add a card");
    assert_eq!(style(&design, &card, "color").as_deref(), Some("red"));
    let options = ExportOptions {
        indent: false,
        ..ExportOptions::default()
    };
    let html = html::export_with(design.doc(), &card, &options)
        .unwrap()
        .html;
    assert!(html.contains("<h2>Title</h2>Card</div>"), "{html}");
    // Every node it made has its own id, though each step asked for one.
    let created: Vec<&str> = change
        .ops
        .iter()
        .filter_map(|op| match op {
            Op::Create { node } => Some(node.id.as_str()),
            _ => None,
        })
        .collect();
    assert_eq!(created, ["n1", "n2", "n3", "n4", "n5"]);
    let labels: Vec<&str> = design.history("A").unwrap().undo_labels().collect();
    assert_eq!(labels, ["Add a card", "Create artboard"]);
}

#[test]
fn one_undo_reverses_every_step_and_redo_brings_them_back() {
    let mut design = design();
    let before = design.snapshot().nodes;
    build_card(&mut design);
    let after = design.snapshot().nodes;
    let undo = design.undo("A", 2).unwrap();
    assert_eq!(undo.label, "Add a card");
    assert_eq!(design.snapshot().nodes, before);
    design.redo("A", 3).unwrap();
    assert_eq!(design.snapshot().nodes, after);
}

#[test]
fn a_failing_step_leaves_the_design_untouched() {
    let mut design = design();
    let saved_before = saved(&design);
    let result = design.transact("A", "Broken", 1, |tx| {
        let ops = edit::update_styles(tx.doc(), &["board".into()], &styles("color", "red"))?;
        tx.apply(&ops)?;
        let ops = edit::create_artboard(tx.doc(), "second".into(), artboard())?;
        tx.apply(&ops)?;
        // The third step fails, after two applied.
        tx.apply(&[Op::Delete { id: "gone".into() }])?;
        Ok::<_, EditError>(())
    });
    assert_eq!(result.unwrap_err().0, "node \"gone\" doesn't exist");
    assert_eq!(
        saved(&design),
        saved_before,
        "document, history and log as they were"
    );
    assert!(design.take_comment_updates().is_empty());
    assert_eq!(design.undo("A", 2).unwrap().label, "Create artboard");
}

#[test]
fn a_dry_run_says_what_would_apply_and_keeps_nothing() {
    let mut design = design();
    let saved_before = saved(&design);
    let mut make_id = ids();
    let (ops, roots) = design
        .dry_run("A", |tx| {
            let (ops, roots) = edit::write_html(
                tx.view(),
                "board",
                "<p>Hi</p>",
                WriteMode::Append,
                None,
                &mut || tx.new_id(&mut make_id),
            )?;
            tx.edit(ops, &mut make_id)?;
            let ops = edit::update_styles(tx.view(), &roots, &styles("color", "red"))?;
            tx.edit(ops, &mut make_id)?;
            Ok::<_, EditError>(roots)
        })
        .unwrap();
    assert_eq!(roots, ["n1"]);
    assert_eq!(
        ops.len(),
        3,
        "the paragraph, its text and its color: {ops:?}"
    );
    assert_eq!(saved(&design), saved_before);
    // A failing dry run is put back too.
    let failed = design.dry_run("A", |tx| {
        tx.apply(&edit::create_artboard(tx.doc(), "x".into(), artboard()).unwrap())?;
        tx.apply(&[Op::Delete { id: "gone".into() }])
    });
    assert_eq!(failed.unwrap_err(), Rejected::Missing("gone".into()));
    assert_eq!(saved(&design), saved_before);
}

#[test]
fn a_comment_reply_links_the_transaction_by_its_label() {
    let mut design = design();
    let anchor = Anchor {
        artboard_id: Some("board".into()),
        node_id: Some("board".into()),
        extra_node_ids: Vec::new(),
        x: 10.0,
        y: 20.0,
    };
    let user = Author {
        id: "user:1".into(),
        name: "Per".into(),
        kind: AuthorKind::User,
    };
    let comment = design
        .add_comment(user, anchor, "Fill it in", &mut || "c1".into(), 1)
        .unwrap()
        .id
        .clone();
    let mut make_id = ids();
    design
        .transact("A", "Filled in the page", 2, |tx| {
            let (ops, _) = edit::write_html(
                tx.view(),
                "board",
                "<h1>Hi</h1><p>There</p>",
                WriteMode::Append,
                None,
                &mut || tx.new_id(&mut make_id),
            )?;
            tx.edit(ops, &mut make_id)?;
            let ops = edit::update_styles(tx.view(), &["board".into()], &styles("gap", "8px"))?;
            tx.edit(ops, &mut make_id)
        })
        .unwrap();
    let agent = Author {
        id: "A".into(),
        name: "A".into(),
        kind: AuthorKind::Agent,
    };
    let replied = design
        .reply(&comment, agent, "Done", Some(true), 3)
        .unwrap();
    let labels: Vec<&str> = replied.messages[1]
        .changes
        .iter()
        .map(|c| c.label.as_str())
        .collect();
    assert_eq!(labels, ["Filled in the page"]);
}

#[test]
fn deleting_an_artboard_in_a_transaction_leaves_its_pins_where_they_were() {
    let mut design = design();
    let anchor = Anchor {
        artboard_id: Some("board".into()),
        node_id: Some("board".into()),
        extra_node_ids: Vec::new(),
        x: 10.0,
        y: 20.0,
    };
    let user = Author {
        id: "user:1".into(),
        name: "Per".into(),
        kind: AuthorKind::User,
    };
    design
        .add_comment(user, anchor, "Hm", &mut || "c1".into(), 1)
        .unwrap();
    design
        .transact("A", "Move and delete", 2, |tx| {
            tx.apply(&[Op::Set {
                id: "board".into(),
                key: PropKey::X,
                value: Some(serde_json::json!(500.0)),
            }])?;
            tx.apply(&[Op::Delete { id: "board".into() }])
        })
        .unwrap();
    let updated = design.take_comment_updates();
    assert_eq!(updated.len(), 1);
    // Where the artboard was before the transaction, 10, 20 in.
    let at = updated[0].detached_at.unwrap();
    assert_eq!((at.x, at.y), (10.0, 20.0));
}

#[test]
fn an_import_is_a_transaction_that_keeps_its_record() {
    let mut design = design();
    let record = ImportRecord {
        id: "i1".into(),
        artifact: BlobHash::of(b"i1"),
        format: "html".into(),
        input_kind: "html".into(),
        file_name: None,
        received_at: 1,
        nodes: Default::default(),
        dependencies: Vec::new(),
        quarantined: Vec::new(),
    };
    let saved_before = saved(&design);
    let failed = design.import("A", "Import", 1, |tx| {
        tx.apply(&edit::create_artboard(tx.doc(), "x".into(), artboard()).unwrap())?;
        tx.apply(&[Op::Delete { id: "gone".into() }])?;
        Ok::<_, Rejected>((record.clone(), ()))
    });
    assert!(failed.is_err());
    assert_eq!(saved(&design), saved_before, "no record and no change");
    let (change, ()) = design
        .import("A", "Import", 1, |tx| {
            tx.apply(&edit::create_artboard(tx.doc(), "x".into(), artboard()).unwrap())?;
            Ok::<_, Rejected>((record.clone(), ()))
        })
        .unwrap();
    assert_eq!(change.unwrap().label, "Import");
    assert_eq!(design.imports(), [record]);
    design.undo("A", 2).unwrap();
    assert!(!design.doc().contains("x"));
    assert_eq!(design.imports().len(), 1, "undo keeps the record");
}

#[test]
fn a_transaction_keeps_the_imports_it_recorded_only_if_it_succeeds() {
    let mut design = design();
    let record = |id: &str| ImportRecord {
        id: id.into(),
        artifact: BlobHash::of(id.as_bytes()),
        format: "html".into(),
        input_kind: "html".into(),
        file_name: None,
        received_at: 1,
        nodes: Default::default(),
        dependencies: Vec::new(),
        quarantined: Vec::new(),
    };
    let failed = design.transact("A", "Edit", 1, |tx| {
        tx.record_import(record("lost"));
        tx.apply(&[Op::Delete { id: "gone".into() }])
    });
    assert!(failed.is_err());
    assert!(design.imports().is_empty());
    // An import that added nothing is still kept, with no change.
    let (change, ()) = design
        .transact("A", "Edit", 1, |tx| {
            tx.record_import(record("empty"));
            Ok::<_, Rejected>(())
        })
        .unwrap();
    assert!(change.is_none());
    assert_eq!(design.imports(), [record("empty")]);
    let (_, ()) = design
        .dry_run("A", |tx| {
            tx.record_import(record("dry"));
            Ok::<_, Rejected>(())
        })
        .unwrap();
    assert_eq!(design.imports().len(), 1, "a dry run keeps nothing");
}

const SECTION: &str = r#"<section style="padding: 24px"><h2>Pro</h2><button style="color: white">Buy</button></section>"#;

/// The rewrite `get_html` HTML would be, with ids and the read mark.
fn read(design: &Design, id: &str) -> String {
    let options = ExportOptions {
        ids: true,
        indent: false,
        read_at: Some(design.seq()),
        ..ExportOptions::default()
    };
    html::export_with(design.doc(), id, &options).unwrap().html
}

#[test]
fn a_staged_rewrite_merges_against_its_read_mark() {
    let mut design = design();
    let mut make_id = ids();
    let (ops, roots) = edit::write_html(
        design.doc(),
        "board",
        SECTION,
        WriteMode::Append,
        None,
        &mut make_id,
    )
    .unwrap();
    design.commit("A", "Write HTML", &ops, 1).unwrap();
    let section = roots[0].clone();
    let button = design.doc().children(Some(&section))[1].id.clone();
    let html = read(&design, &section);
    // B rounds the button after A read the section.
    let ops = edit::update_styles(
        design.doc(),
        std::slice::from_ref(&button),
        &styles("border-radius", "8px"),
    )
    .unwrap();
    design.commit("B", "Update styles", &ops, 2).unwrap();

    // A's transaction: a padding first, then its stale copy with a new heading.
    let rewrite = html.replace(">Pro<", ">Team<");
    let seq = design.seq();
    let (change, merged) = design
        .transact("A", "Restyle the plan", 3, |tx| {
            let ops = edit::update_styles(
                tx.view(),
                std::slice::from_ref(&section),
                &styles("padding", "8px"),
            )?;
            tx.edit(ops, &mut make_id)?;
            let parsed = edit::parse_html_reporting(&rewrite)?;
            let (ops, _) = edit::write_fragments(
                tx.view(),
                &section,
                parsed.fragments,
                WriteMode::Replace,
                None,
                &mut || tx.new_id(&mut make_id),
            )?;
            let merged = tx.merge(parsed.read_at.unwrap(), ops);
            tx.edit(merged.ops, &mut make_id)?;
            Ok::<_, EditError>((merged.kept, merged.reached))
        })
        .unwrap();
    assert!(change.is_some());
    assert_eq!(design.seq(), seq + 1);
    let (kept, reached) = merged;
    assert!(reached);
    // B's radius stays, and so does A's own padding from the step before:
    // the stale HTML still has the padding A read.
    assert_eq!(kept.len(), 1, "{kept:?}");
    assert_eq!(
        (kept[0].id.as_str(), kept[0].by.as_str()),
        (button.as_str(), "B")
    );
    assert_eq!(
        style(&design, &button, "border-radius").as_deref(),
        Some("8px")
    );
    assert_eq!(style(&design, &section, "padding").as_deref(), Some("8px"));
    let html = html::export_with(design.doc(), &section, &ExportOptions::default())
        .unwrap()
        .html;
    assert!(html.contains("<h2>Team</h2>"), "{html}");

    // The set log holds the transaction as one change by A: a rewrite read
    // just before it keeps both the padding and the heading.
    let heading = design.doc().children(Some(&section))[0].id.clone();
    let text = design.doc().children(Some(&heading))[0].id.clone();
    let stale = [
        Op::Set {
            id: section.clone(),
            key: PropKey::Style("padding".into()),
            value: Some(serde_json::json!("30px")),
        },
        Op::Set {
            id: text.clone(),
            key: PropKey::Text,
            value: Some(serde_json::json!("Solo")),
        },
    ];
    let merged = design.merge("C", seq, stale.to_vec());
    assert!(merged.ops.is_empty());
    let by: Vec<&str> = merged.kept.iter().map(|k| k.by.as_str()).collect();
    assert_eq!(by, ["A", "A"]);
    // Undo takes back the whole transaction, leaving B's radius.
    design.undo("A", 4).unwrap();
    assert_eq!(style(&design, &section, "padding").as_deref(), Some("24px"));
    assert_eq!(
        style(&design, &button, "border-radius").as_deref(),
        Some("8px")
    );
}
