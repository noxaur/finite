//! The edits people make on the canvas (`user_edit`): what each plans to,
//! and the golden file the web app's schema decodes
//! (`apps/web/src/design/wire.test.ts`).
//!
//! Regenerate `fixtures/user_edits.json` with `FINITE_UPDATE_FIXTURES=1`.

use std::{collections::BTreeMap, fs, path::PathBuf};

use finite_design::{
    Design, DesignMeta, Node, Op,
    user_edit::{self, Position, UserEdit},
};
use serde_json::Value;

fn design() -> Design {
    let mut board = Node::element("board", "div");
    board.index = "V".into();
    board.x = Some(0.0);
    board.y = Some(0.0);
    let mut nodes = vec![board];
    for (id, index) in [("a", "a"), ("b", "b"), ("c", "c")] {
        nodes.push(Node {
            parent: Some("board".into()),
            index: index.into(),
            ..Node::element(id, "div")
        });
    }
    let mut design = Design::new(DesignMeta {
        id: "d".into(),
        name: "People".into(),
        created_at: 0,
        updated_at: 0,
    });
    let ops: Vec<Op> = nodes.into_iter().map(|node| Op::Create { node }).collect();
    design.commit("agent", "Build", &ops, 0).unwrap();
    design
}

fn plan(design: &Design, edits: &[UserEdit]) -> Result<Vec<Op>, String> {
    let mut new_id = user_edit::new_ids(design.doc(), "tab", 1);
    user_edit::plan(design.doc(), design.view(), edits, &mut new_id).map_err(|e| e.0)
}

fn apply(design: &mut Design, edits: &[UserEdit]) {
    let ops = plan(design, edits).unwrap();
    design
        .commit("user:p", user_edit::label(edits), &ops, 0)
        .unwrap();
}

fn order(design: &Design) -> Vec<String> {
    design
        .doc()
        .children(Some("board"))
        .into_iter()
        .map(|n| n.id.clone())
        .collect()
}

fn place(ids: &[&str], before: Option<&str>) -> UserEdit {
    UserEdit::Place {
        ids: ids.iter().map(|s| s.to_string()).collect(),
        parent: Some("board".into()),
        before: before.map(Into::into),
    }
}

#[test]
fn place_puts_nodes_right_before_their_anchor() {
    let mut d = design();
    apply(&mut d, &[place(&["c"], Some("a"))]);
    assert_eq!(order(&d), ["c", "a", "b"]);
    apply(&mut d, &[place(&["c", "a"], None)]);
    assert_eq!(order(&d), ["b", "c", "a"]);
}

#[test]
fn place_before_its_own_next_sibling_changes_nothing_visible() {
    let mut d = design();
    // `a` already sits before `b`; the moved node never anchors itself.
    let ops = plan(&d, &[place(&["a"], Some("b"))]).unwrap();
    d.commit("user:p", "Move", &ops, 0);
    assert_eq!(order(&d), ["a", "b", "c"]);
}

#[test]
fn an_anchor_that_is_gone_puts_nodes_at_the_end() {
    let mut d = design();
    apply(&mut d, &[place(&["a"], Some("gone"))]);
    assert_eq!(order(&d), ["b", "c", "a"]);
}

#[test]
fn place_refuses_a_cycle() {
    let d = design();
    let edit = UserEdit::Place {
        ids: vec!["board".into()],
        parent: Some("a".into()),
        before: None,
    };
    assert!(plan(&d, &[edit]).unwrap_err().contains("into itself"));
}

#[test]
fn positions_are_whole_pixels_on_artboards_only() {
    let mut d = design();
    let at = |id: &str, x: f64| UserEdit::SetPosition {
        moves: vec![Position {
            id: id.into(),
            x,
            y: 10.4,
        }],
    };
    apply(&mut d, &[at("board", 99.6)]);
    let board = d.doc().get("board").unwrap();
    assert_eq!((board.x, board.y), (Some(100.0), Some(10.0)));
    assert!(
        plan(&d, &[at("a", 1.0)])
            .unwrap_err()
            .contains("isn't an artboard")
    );
    assert!(plan(&d, &[at("board", f64::NAN)]).is_err());
}

#[test]
fn one_gesture_is_one_undo_step() {
    let mut d = design();
    let styles = UserEdit::SetStyles {
        ids: vec!["a".into()],
        styles: BTreeMap::from([("left".into(), Some("12px".into()))]),
    };
    apply(&mut d, &[place(&["a"], None), styles]);
    assert_eq!(order(&d), ["b", "c", "a"]);
    d.undo("user:p", 0).unwrap();
    assert_eq!(order(&d), ["a", "b", "c"]);
    assert!(d.doc().get("a").unwrap().styles.is_empty());
}

#[test]
fn a_tab_and_the_server_make_the_same_new_ids() {
    let d = design();
    let duplicate = [UserEdit::Duplicate {
        ids: vec!["a".into()],
    }];
    let plan_as = |client: &str, mid: u64| {
        user_edit::plan(
            d.doc(),
            d.view(),
            &duplicate,
            &mut user_edit::new_ids(d.doc(), client, mid),
        )
        .unwrap()
    };
    assert_eq!(plan_as("tab", 1), plan_as("tab", 1));
    assert_ne!(plan_as("tab", 1), plan_as("tab", 2));
    assert_ne!(plan_as("tab", 1), plan_as("other", 1));
}

#[test]
fn group_wraps_siblings_where_the_first_was_and_ungroup_undoes_it() {
    let mut d = design();
    apply(
        &mut d,
        &[UserEdit::Group {
            ids: vec!["c".into(), "b".into()],
        }],
    );
    let [first, group]: [String; 2] = order(&d).try_into().unwrap();
    assert_eq!(first, "a");
    let wrapped: Vec<String> = d
        .doc()
        .children(Some(&group))
        .into_iter()
        .map(|n| n.id.clone())
        .collect();
    assert_eq!(wrapped, ["b", "c"]);
    assert_eq!(d.doc().get(&group).unwrap().name.as_deref(), Some("Group"));
    apply(&mut d, &[UserEdit::Ungroup { ids: vec![group] }]);
    assert_eq!(order(&d), ["a", "b", "c"]);
}

#[test]
fn group_refuses_artboards_and_nodes_with_different_parents() {
    let d = design();
    let group = |ids: &[&str]| UserEdit::Group {
        ids: ids.iter().map(|s| s.to_string()).collect(),
    };
    assert!(
        plan(&d, &[group(&["board"])])
            .unwrap_err()
            .contains("artboards")
    );
    assert!(plan(&d, &[group(&["a", "board"])]).is_err());
}

#[test]
fn duplicate_and_text_edits() {
    let mut d = design();
    apply(
        &mut d,
        &[UserEdit::Duplicate {
            ids: vec!["a".into()],
        }],
    );
    assert_eq!(order(&d).len(), 4);
    assert_eq!(order(&d)[0], "a");
    apply(
        &mut d,
        &[UserEdit::SetText {
            id: "b".into(),
            text: "Hi".into(),
        }],
    );
    let text: Vec<_> = d
        .doc()
        .children(Some("b"))
        .into_iter()
        .filter_map(|n| n.text.clone())
        .collect();
    assert_eq!(text, ["Hi"]);
}

/// A person makes an element a component and detaches an instance of it,
/// and undo reverses each.
#[test]
fn components_are_made_and_detached() {
    let mut d = design();
    let make = [UserEdit::MakeComponent {
        id: "a".into(),
        name: Some("Card".into()),
    }];
    assert_eq!(user_edit::label(&make), "Make component");
    apply(&mut d, &make);
    let a = d.doc().get("a").unwrap();
    assert!(a.component);
    assert_eq!(a.name.as_deref(), Some("Card"));
    let (ops, instance) =
        finite_design::edit::insert_instance(d.doc(), "a", "board", None, None, &[], &mut || {
            "i".to_owned()
        })
        .unwrap();
    d.commit("agent", "Instance", &ops, 0).unwrap();
    // A component can't be made from inside an instance, nor detached from one.
    assert!(
        plan(
            &d,
            &[UserEdit::Detach {
                ids: vec!["a".into()]
            }]
        )
        .is_err()
    );
    apply(
        &mut d,
        &[UserEdit::Detach {
            ids: vec![instance.clone()],
        }],
    );
    assert!(!d.doc().get(&instance).unwrap().is_instance());
    d.undo("user:p", 0).unwrap();
    assert!(d.doc().get(&instance).unwrap().is_instance());
    d.undo("user:p", 0).unwrap();
    assert!(!d.doc().get("a").unwrap().component);
}

#[test]
fn labels_name_the_gesture() {
    let delete = UserEdit::Delete {
        ids: vec!["a".into()],
    };
    assert_eq!(user_edit::label(&[place(&["a"], None)]), "Move");
    assert_eq!(user_edit::label(std::slice::from_ref(&delete)), "Delete");
    assert_eq!(user_edit::label(&[place(&["a"], None), delete]), "Edit");
}

#[test]
fn examples_match_the_shared_fixture() {
    let examples = serde_json::to_value(UserEdit::examples()).unwrap();
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("fixtures/user_edits.json");
    if std::env::var_os("FINITE_UPDATE_FIXTURES").is_some() {
        fs::write(
            &path,
            serde_json::to_string_pretty(&examples).unwrap() + "\n",
        )
        .unwrap();
        return;
    }
    let stored: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(
        examples, stored,
        "a user edit changed; regenerate the fixture"
    );
    // Every example reads back as itself.
    let back: Vec<UserEdit> = serde_json::from_value(stored).unwrap();
    assert_eq!(back, UserEdit::examples());
}

fn attrs(ids: &[&str], attrs: &[(&str, Option<&str>)]) -> UserEdit {
    UserEdit::SetAttributes {
        ids: ids.iter().map(|s| s.to_string()).collect(),
        attrs: attrs
            .iter()
            .map(|(k, v)| (k.to_string(), v.map(Into::into)))
            .collect(),
    }
}

#[test]
fn attributes_rename_hide_and_lock_layers() {
    let mut d = design();
    let rename = attrs(&["a"], &[("data-name", Some("Header"))]);
    assert_eq!(user_edit::label(std::slice::from_ref(&rename)), "Rename");
    apply(&mut d, &[rename]);
    assert_eq!(d.doc().get("a").unwrap().name.as_deref(), Some("Header"));

    let hide = attrs(&["a", "b"], &[("hidden", Some(""))]);
    assert_eq!(user_edit::label(std::slice::from_ref(&hide)), "Hide");
    apply(&mut d, &[hide]);
    assert!(d.doc().get("b").unwrap().attrs.contains_key("hidden"));
    apply(&mut d, &[attrs(&["a", "b"], &[("hidden", None)])]);
    assert!(!d.doc().get("b").unwrap().attrs.contains_key("hidden"));

    let lock = attrs(&["c"], &[("data-locked", Some(""))]);
    assert_eq!(user_edit::label(std::slice::from_ref(&lock)), "Lock");
    assert!(
        plan(&d, &[attrs(&["c"], &[("onclick", Some("x"))])])
            .unwrap_err()
            .contains("event handler")
    );
}

#[test]
fn pages_are_added_renamed_moved_to_and_deleted() {
    let mut d = design();
    apply(
        &mut d,
        &[UserEdit::CreatePage {
            name: "Flows".into(),
        }],
    );
    let pages = d.doc().pages();
    assert_eq!(pages.len(), 2);
    let id = pages[1].0.to_owned();

    apply(
        &mut d,
        &[UserEdit::RenamePage {
            id: id.clone(),
            name: "Drafts".into(),
        }],
    );
    assert_eq!(d.doc().page(&id).unwrap().name, "Drafts");

    apply(
        &mut d,
        &[UserEdit::MoveToPage {
            ids: vec!["board".into()],
            page: id.clone(),
        }],
    );
    assert_eq!(
        d.doc().get("board").unwrap().page.as_deref(),
        Some(id.as_str())
    );

    apply(&mut d, &[UserEdit::DeletePage { id: id.clone() }]);
    assert!(d.doc().page(&id).is_none());
    assert!(d.doc().get("board").is_none(), "its artboards go with it");
}
