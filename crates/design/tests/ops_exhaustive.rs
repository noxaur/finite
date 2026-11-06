//! Bounded exhaustive check of `Document::try_apply`, the rule every undo,
//! redo, transaction rollback and dry run relies on: applying an op hands
//! back ops that put the document back exactly as it was.
//!
//! Starting from an empty document, it visits every document reachable with
//! up to `DEPTH` ops from `ops()`, and at each one tries every op in `ops()`.
//! See `.agents/skills/verify-ops/SKILL.md` for the rules and the bounds.
use std::collections::{BTreeMap, HashSet, VecDeque};

use finite_design::{
    Applied, Design, DesignMeta, Document, FIRST_PAGE, Node, NodeKind, Op, Page, PropKey, Record,
    fractional, tokens::Mode,
};
use serde_json::{Value, json};

const IDS: [&str; 3] = ["a", "b", "c"];
/// `0` ends in the digit `0`, which `fractional::is_valid` refuses.
const INDEXES: [&str; 3] = ["V", "a", "0"];
const DEPTH: usize = 3;

fn ops() -> Vec<Op> {
    let mut ops = Vec::new();
    let parents = || std::iter::once(None).chain(IDS.map(Some));
    for id in IDS {
        for parent in parents() {
            for index in INDEXES {
                let base = |node: Node| Node {
                    parent: parent.map(str::to_owned),
                    index: index.to_owned(),
                    ..node
                };
                for node in [
                    base(Node::element(id, "div")),
                    base(Node::text(id, "t")),
                    base(Node {
                        component: true,
                        ..Node::element(id, "div")
                    }),
                    base(Node {
                        instance_of: Some("a".into()),
                        ..Node::element(id, "div")
                    }),
                ] {
                    ops.push(Op::Create { node });
                }
                ops.push(Op::Move {
                    id: id.into(),
                    parent: parent.map(str::to_owned),
                    index: index.into(),
                });
            }
        }
        ops.push(Op::Delete { id: id.into() });
        let sets: [(PropKey, Option<Value>); 17] = [
            (PropKey::Name, Some(json!("n"))),
            (PropKey::Text, Some(json!("u"))),
            (PropKey::Text, None),
            (PropKey::X, Some(json!(1))),
            (PropKey::X, Some(json!(1.0))),
            (PropKey::X, Some(json!("1"))),
            (PropKey::Style("color".into()), Some(json!("red"))),
            (PropKey::Attr("title".into()), Some(json!(""))),
            (PropKey::Page, Some(json!("p"))),
            (PropKey::Component, Some(json!(true))),
            (PropKey::Component, Some(json!(false))),
            (PropKey::InstanceOf, Some(json!("a"))),
            (PropKey::InstanceOf, Some(json!("b"))),
            (PropKey::InstanceOf, None),
            (PropKey::Override("text".into()), Some(json!("v"))),
            (PropKey::Override("text".into()), Some(json!(false))),
            (PropKey::Override("text".into()), None),
        ];
        for (key, value) in sets {
            ops.push(Op::Set {
                id: id.into(),
                key,
                value,
            });
        }
    }
    for page in [
        Some(Page {
            name: "P".into(),
            index: "V".into(),
            background: None,
        }),
        Some(Page {
            name: "P".into(),
            index: "V".into(),
            background: Some("#e8eef0".into()),
        }),
        Some(Page {
            name: "P".into(),
            index: "0".into(),
            background: None,
        }),
        None,
    ] {
        ops.push(Op::Page {
            id: "p".into(),
            page,
        });
    }
    // The implicit first page goes into the page map and comes out again.
    for explicit in [true, false] {
        ops.push(Op::FirstPage { explicit });
    }
    // On `p` and the first page once they're in the page map.
    for id in ["p", FIRST_PAGE] {
        ops.push(Op::PageName {
            id: id.into(),
            name: "Q".into(),
        });
        for background in [Some("#000"), None] {
            ops.push(Op::PageBackground {
                id: id.into(),
                background: background.map(str::to_owned),
            });
        }
    }
    for mode in [
        Some(Mode {
            name: "Dark".into(),
            index: "V".into(),
        }),
        None,
    ] {
        ops.push(Op::Mode {
            id: "m".into(),
            mode,
        });
    }
    for value in [Some("red"), Some("not a value;"), None] {
        ops.push(Op::Token {
            name: "--brand".into(),
            mode_id: "m".into(),
            value: value.map(str::to_owned),
        });
    }
    for css in [Some("p{}"), Some(""), None] {
        ops.push(Op::Css {
            css: css.map(str::to_owned),
        });
    }
    ops
}

/// Everything about a document that a reader can see, in a fixed order, so
/// two documents are the same exactly when their states are equal.
fn state(doc: &Document) -> String {
    let mut nodes: Vec<&Node> = doc.nodes().collect();
    nodes.sort_by(|a, b| a.id.cmp(&b.id));
    let children: BTreeMap<Option<&str>, Vec<&str>> = doc
        .child_lists()
        .map(|(parent, ids)| (parent, ids.collect()))
        .collect();
    let instances: BTreeMap<&str, Vec<&str>> = doc
        .instance_lists()
        .map(|(component, ids)| (component, ids.collect()))
        .collect();
    format!(
        "{nodes:?}\n{children:?}\n{instances:?}\n{:?}\n{:?}\n{:?}\n{:?}",
        doc.css(),
        doc.page_map(),
        doc.tokens(),
        doc.mode_map()
    )
}

/// The tree rules every document keeps: each parent exists and can hold
/// children, the tree has no cycles, and the child and instance indexes
/// say exactly what the nodes say.
fn well_formed(doc: &Document) -> Result<(), String> {
    let mut children: BTreeMap<Option<&str>, Vec<(&str, &str)>> = BTreeMap::new();
    let mut instances: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for node in doc.nodes() {
        if let Some(p) = &node.parent {
            let parent = doc
                .get(p)
                .ok_or(format!("{}'s parent {p} is missing", node.id))?;
            if parent.instance_of.is_some() || parent.kind == NodeKind::Text {
                return Err(format!(
                    "{} is under {p}, which can't hold children",
                    node.id
                ));
            }
        }
        let mut at = node;
        for _ in 0..=doc.len() {
            match &at.parent {
                Some(p) => at = doc.get(p).expect("checked above"),
                None => break,
            }
            if at.id == node.id {
                return Err(format!("{} is its own ancestor", node.id));
            }
        }
        children
            .entry(node.parent.as_deref())
            .or_default()
            .push((&node.index, &node.id));
        if let Some(c) = &node.instance_of {
            instances.entry(c).or_default().push(&node.id);
        }
    }
    let children: BTreeMap<Option<&str>, Vec<&str>> = children
        .into_iter()
        .map(|(parent, mut ids)| {
            ids.sort();
            (parent, ids.into_iter().map(|(_, id)| id).collect())
        })
        .collect();
    for ids in instances.values_mut() {
        ids.sort();
    }
    let indexed: BTreeMap<Option<&str>, Vec<&str>> = doc
        .child_lists()
        .map(|(parent, ids)| (parent, ids.collect()))
        .collect();
    if indexed != children {
        return Err(format!("child index {indexed:?}, nodes say {children:?}"));
    }
    let linked: BTreeMap<&str, Vec<&str>> = doc
        .instance_lists()
        .map(|(c, ids)| (c, ids.collect()))
        .collect();
    if linked != instances {
        return Err(format!(
            "instance index {linked:?}, nodes say {instances:?}"
        ));
    }
    Ok(())
}

/// `check.py --mutations` sets `FINITE_FAIL_FAST`, so a broken copy fails
/// at its first new break instead of finishing the search.
fn fail_fast() -> bool {
    std::env::var_os("FINITE_FAIL_FAST").is_some()
}

/// A broken rule: which one, and what the check saw.
struct Broken {
    rule: &'static str,
    detail: String,
    /// For "undo skipped": the inverse ops that didn't apply.
    skipped: Vec<Op>,
}

fn broken(rule: &'static str, detail: String) -> Broken {
    Broken {
        rule,
        detail,
        skipped: Vec::new(),
    }
}

/// Checks the rules for `op` on `doc`, returning the document after it.
fn check(doc: &Document, op: &Op) -> Result<Document, Broken> {
    let before = state(doc);
    let mut after = doc.clone();
    let result = after.try_apply(op);
    well_formed(&after).map_err(|e| broken("well formed", e))?;
    let inverse = match result {
        Ok(Applied::Changed(inverse)) => inverse,
        Ok(Applied::Unchanged) | Err(_) => {
            if state(&after) != before {
                return Err(broken(
                    "a skipped op leaves no trace",
                    format!("{result:?}, but the document changed"),
                ));
            }
            return Ok(after);
        }
    };
    if state(&after) == before {
        return Err(broken(
            "a change changes something",
            format!("nothing changed, inverse {inverse:?}"),
        ));
    }
    let mut undone = after.clone();
    let (applied, redo) = undone.apply_all(&inverse);
    if applied.len() != inverse.len() {
        let skipped: Vec<Op> = inverse
            .iter()
            .filter(|op| !applied.contains(op))
            .cloned()
            .collect();
        return Err(Broken {
            rule: "undo applies in full",
            detail: format!("skipped {skipped:?}"),
            skipped,
        });
    }
    if state(&undone) != before {
        return Err(broken(
            "undo restores the document",
            format!("{inverse:?} left\n{}", state(&undone)),
        ));
    }
    let (applied, _) = undone.apply_all(&redo);
    if applied.len() != redo.len() || state(&undone) != state(&after) {
        return Err(broken(
            "redo restores the change",
            format!("{redo:?} didn't bring it back"),
        ));
    }
    Ok(after)
}

/// The findings the code has today (see "Known findings" in the skill).
/// Each is matched narrowly, so a new bug of the same rule still fails.
fn known(op: &Op, broken: &Broken) -> Option<&'static str> {
    match (broken.rule, op) {
        // `Create` keeps a sibling index that `Move` refuses, so moving the
        // node can't be undone.
        ("undo applies in full", Op::Move { .. })
            if broken
                .skipped
                .iter()
                .all(|op| matches!(op, Op::Move { index, .. } if !fractional::is_valid(index))) =>
        {
            Some("finding 1: create keeps a bad index")
        }
        // `x: 1` and `x: 1.0` are the same position but unequal JSON.
        (
            "a change changes something",
            Op::Set {
                key: PropKey::X | PropKey::Y,
                value: Some(Value::Number(n)),
                ..
            },
        ) if !n.is_f64() => Some("finding 2: an integer position is a change"),
        _ => None,
    }
}

const KNOWN: [&str; 2] = [
    "finding 1: create keeps a bad index",
    "finding 2: an integer position is a change",
];

#[test]
#[ignore = "about a minute in release; run .agents/skills/verify-ops/check.py"]
fn every_op_undoes_exactly() {
    let ops = ops();
    let mut seen = HashSet::from([state(&Document::default())]);
    let mut queue = VecDeque::from([(Document::default(), Vec::<usize>::new())]);
    let mut checked = 0usize;
    // The shortest path to each broken rule, by finding or rule.
    let mut failures: BTreeMap<String, (Vec<usize>, usize, String)> = BTreeMap::new();
    while let Some((doc, path)) = queue.pop_front() {
        for (i, op) in ops.iter().enumerate() {
            checked += 1;
            match check(&doc, op) {
                Ok(next) => {
                    if path.len() < DEPTH && seen.insert(state(&next)) {
                        let mut next_path = path.clone();
                        next_path.push(i);
                        queue.push_back((next, next_path));
                    }
                }
                Err(b) => {
                    let name =
                        known(op, &b).map_or_else(|| format!("NEW: {}", b.rule), str::to_owned);
                    if fail_fast() && name.starts_with("NEW") {
                        panic!("{name}: {}", b.detail);
                    }
                    failures.entry(name).or_insert((path.clone(), i, b.detail));
                }
            }
        }
    }
    println!(
        "{} ops, {} documents within {DEPTH} ops, {checked} checks",
        ops.len(),
        seen.len()
    );
    for (name, (path, i, detail)) in &failures {
        println!("\n{name}\n  {detail}\n  from an empty document:");
        for &step in path {
            println!("    {:?}", ops[step]);
        }
        println!("  then: {:?}", ops[*i]);
    }
    let new: Vec<&String> = failures.keys().filter(|k| k.starts_with("NEW")).collect();
    assert!(new.is_empty(), "rules broken in a new way: {new:?}");
    let gone: Vec<&&str> = KNOWN
        .iter()
        .filter(|k| !failures.contains_key(**k))
        .collect();
    assert!(
        gone.is_empty(),
        "fixed? {gone:?} no longer happens: remove it from KNOWN and the skill"
    );
}

/// One step a person or agent takes in `undo_survives_a_restart`.
#[derive(Clone, Copy, Debug)]
enum Step {
    Edit(&'static str, usize),
    Undo(&'static str),
    Redo(&'static str),
}

const ACTORS: [&str; 2] = ["alice", "bob"];
/// Steps in the longest sequence `undo_survives_a_restart` tries.
const STEPS: usize = 6;

/// Edits as the edit commands build them: valid indexes, `f64` positions,
/// and the first page put in the page map before a page op that needs it.
fn edits() -> Vec<Vec<Op>> {
    let create = |id: &str, parent: Option<&str>, index: &str| Op::Create {
        node: Node {
            parent: parent.map(str::to_owned),
            index: index.into(),
            ..Node::element(id, "div")
        },
    };
    let color = |id: &str, value: &str| Op::Set {
        id: id.into(),
        key: PropKey::Style("color".into()),
        value: Some(json!(value)),
    };
    let to = |parent: Option<&str>, index: &str| Op::Move {
        id: "b".into(),
        parent: parent.map(str::to_owned),
        index: index.into(),
    };
    let first_page = |op: Op| vec![Op::FirstPage { explicit: true }, op];
    let mut edits: Vec<Vec<Op>> = [
        create("a", None, "V"),
        create("b", Some("a"), "V"),
        create("b", None, "W"),
        color("a", "red"),
        color("a", "blue"),
        color("b", "red"),
        Op::Delete { id: "a".into() },
        to(None, "W"),
        to(Some("a"), "V"),
    ]
    .map(|op| vec![op])
    .into();
    edits.extend([
        // As `edit::create_page` adds a second page.
        first_page(Op::Page {
            id: "p".into(),
            page: Some(Page {
                name: "P".into(),
                index: "W".into(),
                background: Some("#e8eef0".into()),
            }),
        }),
        first_page(Op::PageName {
            id: FIRST_PAGE.into(),
            name: "Home".into(),
        }),
        first_page(Op::PageBackground {
            id: FIRST_PAGE.into(),
            background: Some("#000".into()),
        }),
    ]);
    edits
}

/// Each actor's undo and redo stacks as saved, without the clock.
fn histories(design: &Design) -> Vec<Value> {
    ACTORS
        .iter()
        .map(|actor| {
            let mut saved =
                serde_json::to_value(design.history(actor).cloned().unwrap_or_default())
                    .expect("a history serializes");
            if let Some(fields) = saved.as_object_mut() {
                fields.remove("lastUsed");
            }
            saved
        })
        .collect()
}

/// What a restart must rebuild: the document, the seq and every history.
fn restored(design: &Design) -> (String, u64, Vec<Value>) {
    (state(design.doc()), design.seq(), histories(design))
}

/// Runs `steps` live, saving a snapshot before the first and the journal
/// records after it, as the server does. Returns `None` when a step changes
/// nothing, since a shorter sequence already covers it.
fn run(steps: &[Step], edits: &[Vec<Op>]) -> Option<(Design, Vec<String>, Vec<String>)> {
    let mut design = Design::new(DesignMeta {
        id: "d".into(),
        name: "Test".into(),
        created_at: 0,
        updated_at: 0,
    });
    let mut snapshots = vec![serde_json::to_string(&design.snapshot_to_save()).unwrap()];
    let mut journal = Vec::new();
    for (now, step) in steps.iter().enumerate() {
        let now = now as u64 + 1;
        let change = match *step {
            Step::Edit(actor, i) => {
                let ops = &edits[i];
                design.commit(actor, &format!("{ops:?}"), ops, now)
            }
            Step::Undo(actor) => design.undo(actor, now),
            Step::Redo(actor) => design.redo(actor, now),
        }?;
        journal.push(serde_json::to_string(&Record::Change { change }).unwrap());
        snapshots.push(serde_json::to_string(&design.snapshot_to_save()).unwrap());
    }
    Some((design, snapshots, journal))
}

/// A server that restarts after any step rebuilds the design from its last
/// snapshot and the journal after it (`DesignState::restore` in
/// crates/server/src/hub/design.rs). The rebuilt design must have the same
/// document, seq and undo and redo stacks as the live one, so the next undo
/// reverses the same thing it would have without the restart.
#[test]
#[ignore = "about a minute in release; run .agents/skills/verify-ops/check.py"]
fn undo_survives_a_restart() {
    let edits = edits();
    let mut alphabet = Vec::new();
    for actor in ACTORS {
        alphabet.extend((0..edits.len()).map(|i| Step::Edit(actor, i)));
        alphabet.push(Step::Undo(actor));
        alphabet.push(Step::Redo(actor));
    }
    let mut frontier = vec![Vec::<Step>::new()];
    let mut sequences = 0usize;
    let mut restarts = 0usize;
    let mut failures: BTreeMap<String, String> = BTreeMap::new();
    for _ in 0..STEPS {
        let mut next = Vec::new();
        for prefix in &frontier {
            for &step in &alphabet {
                let mut steps = prefix.clone();
                steps.push(step);
                let Some((live, snapshots, journal)) = run(&steps, &edits) else {
                    continue;
                };
                sequences += 1;
                let want = restored(&live);
                // Restart from each saved snapshot, replaying what came after.
                for (cut, snapshot) in snapshots.iter().enumerate() {
                    restarts += 1;
                    let mut rebuilt =
                        Design::from_snapshot(serde_json::from_str(snapshot).unwrap());
                    for record in &journal[cut..] {
                        rebuilt.replay(serde_json::from_str(record).unwrap());
                    }
                    let got = restored(&rebuilt);
                    if got != want {
                        let what = if got.0 != want.0 {
                            "document"
                        } else if got.1 != want.1 {
                            "seq"
                        } else {
                            "histories"
                        };
                        if fail_fast() {
                            panic!("a restart changes the {what}: steps {steps:?}");
                        }
                        failures.entry(what.to_owned()).or_insert(format!(
                            "steps {steps:?}\n  restart after step {cut}\n  live: {:?}\n  rebuilt: {:?}",
                            want.2, got.2
                        ));
                    }
                }
                next.push(steps);
            }
        }
        frontier = next;
    }
    println!("{sequences} sequences of up to {STEPS} steps, {restarts} restarts");
    for (what, detail) in &failures {
        println!("\nBROKEN: a restart changes the {what}\n  {detail}");
    }
    assert!(failures.is_empty(), "{} rules broken", failures.len());
}
