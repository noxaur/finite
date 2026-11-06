//! Rewriting HTML with `replace` or `replace-children`: elements written
//! with their data-id keep their node, and a rewrite of HTML read at an
//! earlier seq keeps what other agents changed or added since (`Design::merge`).

use std::collections::BTreeMap;

use finite_design::{
    Design, DesignMeta, KeptNode, Merged, Op, PropKey, Snapshot,
    comment::{Anchor, Audience, Author, AuthorKind},
    edit::{self, NewArtboard, WriteMode},
    html::{self, ExportOptions},
};

const SECTION: &str = r#"<section data-name="Plan" style="padding: 24px"><h2>Pro</h2><button data-name="Buy" style="color: white">Buy</button></section>"#;

struct Board {
    design: Design,
    next: u32,
}

impl Board {
    /// A design with artboard `board` holding [`SECTION`], written by "A".
    fn new() -> Self {
        let mut design = Design::new(DesignMeta {
            id: "d".into(),
            name: "Rewrite".into(),
            created_at: 0,
            updated_at: 0,
        });
        let spec = NewArtboard {
            name: "Page".into(),
            width: 600.0,
            height: Some(400.0),
            position: None,
            page: None,
            styles: BTreeMap::new(),
            ..Default::default()
        };
        let ops = edit::create_artboard(design.doc(), "board".into(), spec).unwrap();
        design.commit("A", "Create artboard", &ops, 0).unwrap();
        let mut board = Self { design, next: 0 };
        board.write("A", "board", SECTION, WriteMode::Append);
        board
    }

    fn write(
        &mut self,
        actor: &str,
        target: &str,
        html: &str,
        mode: WriteMode,
    ) -> Vec<finite_design::Kept> {
        let merged = self.write_merged(actor, target, html, mode);
        assert!(merged.reached);
        merged.kept
    }

    /// Writes `html` as `write_html` does, merging it if it has a read mark.
    fn write_merged(&mut self, actor: &str, target: &str, html: &str, mode: WriteMode) -> Merged {
        let next = &mut self.next;
        let mut new_id = || {
            *next += 1;
            format!("n{next}")
        };
        let parsed = edit::parse_html_reporting(html).unwrap();
        let (ops, _) = edit::write_fragments(
            self.design.doc(),
            target,
            parsed.fragments,
            mode,
            None,
            &mut new_id,
        )
        .unwrap();
        let merged = match parsed.read_at {
            Some(seq) => self.design.merge(actor, seq, ops),
            None => Merged {
                ops,
                kept: Vec::new(),
                kept_nodes: Vec::new(),
                reached: true,
            },
        };
        self.design.commit(actor, "Write HTML", &merged.ops, 0);
        merged
    }

    fn style(&mut self, actor: &str, id: &str, name: &str, value: &str) {
        let styles = BTreeMap::from([(name.to_owned(), Some(value.to_owned()))]);
        let ops = edit::update_styles(self.design.doc(), &[id.to_owned()], &styles).unwrap();
        self.design.commit(actor, "Update styles", &ops, 0).unwrap();
    }

    /// What `read` returns for `id`, with the read mark.
    fn read(&self, id: &str) -> String {
        let options = ExportOptions {
            ids: true,
            indent: false,
            read_at: Some(self.design.seq()),
            ..ExportOptions::default()
        };
        html::export_with(self.design.doc(), id, &options)
            .unwrap()
            .html
    }

    fn id(&self, tag: &str) -> String {
        self.ids(tag).remove(0)
    }

    fn ids(&self, tag: &str) -> Vec<String> {
        let mut nodes: Vec<_> = self
            .design
            .doc()
            .nodes()
            .filter(|n| n.tag() == Some(tag))
            .collect();
        nodes.sort_by(|a, b| {
            let parent = |n: &finite_design::Node| n.parent.clone();
            parent(a).cmp(&parent(b)).then(a.index.cmp(&b.index))
        });
        nodes.into_iter().map(|n| n.id.clone()).collect()
    }

    fn text_of(&self, id: &str) -> String {
        let doc = self.design.doc();
        doc.children(Some(id))
            .iter()
            .filter_map(|c| c.text.clone())
            .collect()
    }

    fn style_of(&self, id: &str, name: &str) -> Option<String> {
        self.design.doc().get(id)?.styles.get(name).cloned()
    }
}

#[test]
fn replace_keeps_the_ids_html_names() {
    let mut b = Board::new();
    let (section, button) = (b.id("section"), b.id("button"));
    let html = b.read(&section).replace(">Buy<", ">Upgrade<");
    b.write("A", &section, &html, WriteMode::Replace);
    assert_eq!((b.id("section"), b.id("button")), (section, button.clone()));
    assert_eq!(b.text_of(&button), "Upgrade");
    // Only the text changed.
    let change = b.design.undo("A", 0).unwrap();
    assert_eq!(change.ops.len(), 1, "{:?}", change.ops);
}

#[test]
fn replace_children_keeps_the_ids_html_names() {
    let mut b = Board::new();
    let section = b.id("section");
    let (h2, button) = (b.id("h2"), b.id("button"));
    let inner = b.read(&section);
    let inner = &inner[inner.find("<h2").unwrap()..inner.rfind("</section>").unwrap()];
    let inner = inner
        .replace("padding", "margin")
        .replace("color: white", "color: red");
    b.write("A", &section, &inner, WriteMode::ReplaceChildren);
    assert_eq!((b.id("h2"), b.id("button")), (h2, button.clone()));
    assert_eq!(b.style_of(&button, "color").as_deref(), Some("red"));
}

#[test]
fn a_comment_pinned_to_a_rewritten_element_still_finds_it() {
    let mut b = Board::new();
    let (section, button) = (b.id("section"), b.id("button"));
    let author = Author {
        id: "u".into(),
        name: "Per".into(),
        kind: AuthorKind::User,
    };
    let anchor = Anchor {
        artboard_id: Some("board".into()),
        node_id: Some(button.clone()),
        extra_node_ids: Vec::new(),
        x: 10.0,
        y: 10.0,
    };
    b.design
        .add_comment(
            author,
            anchor,
            Audience::Agents,
            "Say Upgrade",
            &mut || "c".into(),
            0,
        )
        .unwrap();
    let html = b.read(&section).replace(">Buy<", ">Upgrade<");
    b.write("A", &section, &html, WriteMode::Replace);
    let pinned = b.design.comments()[0].node_id.clone().unwrap();
    assert_eq!(pinned, button);
    assert!(b.design.doc().contains(&pinned));
}

#[test]
fn another_agents_undo_still_works_after_a_rewrite() {
    let mut b = Board::new();
    let (section, button) = (b.id("section"), b.id("button"));
    b.style("B", &button, "border-radius", "999px");
    let html = b.read(&section).replace(">Buy<", ">Upgrade<");
    b.write("A", &section, &html, WriteMode::Replace);
    assert_eq!(
        b.style_of(&button, "border-radius").as_deref(),
        Some("999px")
    );
    let undone = b.design.undo("B", 0).expect("B's step still applies");
    assert_eq!(undone.label, "Update styles");
    assert_eq!(b.style_of(&button, "border-radius"), None);
    assert_eq!(b.text_of(&button), "Upgrade");
}

#[test]
fn a_stale_rewrite_keeps_what_another_agent_changed_since() {
    let mut b = Board::new();
    let (section, button) = (b.id("section"), b.id("button"));
    let read = b.read(&section);
    assert!(read.contains(&format!("data-read-at=\"{}\"", b.design.seq())));
    b.style("B", &button, "border-radius", "999px");
    // A writes back its old copy, with only the text changed.
    let kept = b.write(
        "A",
        &section,
        &read.replace(">Buy<", ">Upgrade<"),
        WriteMode::Replace,
    );
    assert_eq!(
        b.style_of(&button, "border-radius").as_deref(),
        Some("999px")
    );
    assert_eq!(b.text_of(&button), "Upgrade");
    assert_eq!(kept.len(), 1);
    assert_eq!(
        (
            kept[0].id.as_str(),
            &kept[0].key,
            kept[0].by.as_str(),
            kept[0].conflict
        ),
        (
            button.as_str(),
            &PropKey::Style("border-radius".into()),
            "B",
            false
        )
    );
    // B can still undo its own change.
    b.design.undo("B", 0).unwrap();
    assert_eq!(b.style_of(&button, "border-radius"), None);
}

#[test]
fn when_both_change_a_value_the_other_agents_is_kept_and_named() {
    let mut b = Board::new();
    let (section, button) = (b.id("section"), b.id("button"));
    let read = b.read(&section);
    b.style("B", &button, "color", "red");
    let kept = b.write(
        "A",
        &section,
        &read.replace("color: white", "color: blue"),
        WriteMode::Replace,
    );
    assert_eq!(b.style_of(&button, "color").as_deref(), Some("red"));
    assert_eq!(kept.len(), 1);
    assert!(kept[0].conflict);
    // Its own change since the read is the author's to replace.
    let read = b.read(&section);
    b.style("A", &button, "color", "green");
    let kept = b.write(
        "A",
        &section,
        &read.replace("color: red", "color: blue"),
        WriteMode::Replace,
    );
    assert_eq!(b.style_of(&button, "color").as_deref(), Some("blue"));
    assert!(kept.is_empty());
}

#[test]
fn without_a_mark_the_rewrite_wins() {
    let mut b = Board::new();
    let (section, button) = (b.id("section"), b.id("button"));
    let read = b.read(&section).replace(" data-read-at=", " data-x=");
    b.style("B", &button, "border-radius", "999px");
    b.write("A", &section, &read, WriteMode::Replace);
    assert_eq!(b.style_of(&button, "border-radius"), None);
    assert_eq!(b.id("button"), button);
}

#[test]
fn a_mark_older_than_the_log_is_not_merged() {
    let b = Board::new();
    let seq = b.design.seq();
    // A design loaded from a snapshot remembers no old values.
    let loaded = Design::from_snapshot(Snapshot {
        histories: None,
        ..b.design.snapshot_to_save()
    });
    let op = Op::Set {
        id: b.id("button"),
        key: PropKey::Style("color".into()),
        value: None,
    };
    let merged = loaded.merge("A", seq - 1, vec![op.clone()]);
    assert!(!merged.reached);
    assert_eq!(merged.ops, std::slice::from_ref(&op));
    assert!(loaded.merge("A", seq, vec![op]).reached);
}

#[test]
fn reordering_moves_only_what_moved() {
    let mut b = Board::new();
    let section = b.id("section");
    b.write(
        "A",
        &section,
        "<p>One</p><p>Two</p><p>Three</p>",
        WriteMode::Append,
    );
    let ps = b.ids("p");
    let html = b.read(&section);
    // Move the last <p> to the front.
    let last = html.find(&format!("<p data-id=\"{}\"", ps[2])).unwrap();
    let end = last + html[last..].find("</p>").unwrap() + 4;
    let moved = &html[last..end];
    let first = html.find("<h2").unwrap();
    let html = format!(
        "{}{moved}{}{}",
        &html[..first],
        &html[first..last],
        &html[end..]
    );
    b.write("A", &section, &html, WriteMode::Replace);
    let children: Vec<String> = b
        .design
        .doc()
        .children(Some(&section))
        .iter()
        .map(|n| n.id.clone())
        .collect();
    assert_eq!(
        children,
        [
            ps[2].clone(),
            b.id("h2"),
            b.id("button"),
            ps[0].clone(),
            ps[1].clone()
        ]
    );
    let undone = b.design.undo("A", 0).unwrap();
    assert!(
        matches!(undone.ops.as_slice(), [Op::Move { .. }]),
        "{:?}",
        undone.ops
    );
}

#[test]
fn adding_and_removing_children_keeps_the_rest() {
    let mut b = Board::new();
    let section = b.id("section");
    let (h2, button) = (b.id("h2"), b.id("button"));
    let html = b.read(&section);
    // Drop the heading, add a paragraph before the button and a span inside it.
    let start = html.find("<h2").unwrap();
    let end = html.find("</h2>").unwrap() + 5;
    let html = format!("{}<p>New</p>{}", &html[..start], &html[end..])
        .replace(">Buy<", "><span>Buy</span><");
    b.write("A", &section, &html, WriteMode::Replace);
    assert!(!b.design.doc().contains(&h2));
    assert_eq!(b.id("button"), button);
    let children: Vec<_> = b
        .design
        .doc()
        .children(Some(&section))
        .iter()
        .map(|n| n.tag().map(str::to_owned))
        .collect();
    assert_eq!(children, [Some("p".to_owned()), Some("button".to_owned())]);
    assert_eq!(b.design.doc().children(Some(&button)).len(), 1);
    assert_eq!(b.ids("span").len(), 1);
}

#[test]
fn html_without_ids_replaces_the_nodes() {
    let mut b = Board::new();
    let (section, button) = (b.id("section"), b.id("button"));
    b.write("A", &section, SECTION, WriteMode::Replace);
    assert!(!b.design.doc().contains(&section));
    assert!(!b.design.doc().contains(&button));
    let section = b.id("section");
    b.write(
        "A",
        &section,
        "<h2>Pro</h2><button>Buy</button>",
        WriteMode::ReplaceChildren,
    );
    assert_eq!(b.ids("button").len(), 1);
    assert_ne!(b.id("button"), button);
}

#[test]
fn a_changed_tag_is_a_new_node() {
    let mut b = Board::new();
    let (section, button) = (b.id("section"), b.id("button"));
    let html = b
        .read(&section)
        .replace("<button", "<a")
        .replace("</button>", "</a>");
    b.write("A", &section, &html, WriteMode::Replace);
    assert_eq!(b.id("section"), section);
    assert!(!b.design.doc().contains(&button));
    assert_eq!(b.ids("a").len(), 1);
}

#[test]
fn a_rewrite_holding_a_component_redefines_it_as_before() {
    let mut b = Board::new();
    let section = b.id("section");
    b.write(
        "A",
        &section,
        r#"<nav data-component="Top bar"><b>Home</b></nav>"#,
        WriteMode::Append,
    );
    let nav = b.id("nav");
    let html = b.read(&section).replace(">Home<", ">Start<");
    b.write("A", &section, &html, WriteMode::Replace);
    // The component keeps its id by name, as a rewrite always did.
    assert_eq!(b.id("nav"), nav);
    assert!(b.design.doc().get(&nav).unwrap().component);
    assert_eq!(b.text_of(&b.id("b")), "Start");
}

/// The tags of `id`'s children, in order.
fn child_tags(b: &Board, id: &str) -> Vec<String> {
    b.design
        .doc()
        .children(Some(id))
        .iter()
        .filter_map(|n| n.tag().map(str::to_owned))
        .collect()
}

#[test]
fn a_stale_rewrite_keeps_an_element_another_agent_added_since() {
    let mut b = Board::new();
    let section = b.id("section");
    let read = b.read(&section);
    b.write("B", &section, "<p>New</p>", WriteMode::Append);
    let p = b.id("p");
    let merged = b.write_merged(
        "A",
        &section,
        &read.replace(">Buy<", ">Upgrade<"),
        WriteMode::Replace,
    );
    assert!(merged.reached);
    assert_eq!(
        merged.kept_nodes,
        [KeptNode {
            id: p.clone(),
            by: "B".into(),
            moved: false
        }]
    );
    assert_eq!(child_tags(&b, &section), ["h2", "button", "p"]);
    assert_eq!(b.text_of(&b.id("button")), "Upgrade");
    // B can still undo its add, and A its rewrite.
    let undone = b.design.undo("B", 0).expect("B's add still applies");
    assert_eq!(undone.label, "Write HTML");
    assert!(!b.design.doc().contains(&p));
    b.design.undo("A", 0).unwrap();
    assert_eq!(b.text_of(&b.id("button")), "Buy");
}

#[test]
fn a_stale_rewrite_keeps_an_element_another_agent_moved_in_since() {
    let mut b = Board::new();
    let section = b.id("section");
    b.write("B", "board", "<p>Elsewhere</p>", WriteMode::Append);
    let p = b.id("p");
    let read = b.read(&section);
    let ops = edit::move_nodes(
        b.design.doc(),
        std::slice::from_ref(&p),
        Some(&section),
        None,
    )
    .unwrap();
    b.design.commit("B", "Move", &ops, 0).unwrap();
    let merged = b.write_merged("A", &section, &read, WriteMode::Replace);
    assert_eq!(
        merged.kept_nodes,
        [KeptNode {
            id: p.clone(),
            by: "B".into(),
            moved: true
        }]
    );
    assert_eq!(
        b.design.doc().get(&p).unwrap().parent.as_deref(),
        Some(section.as_str())
    );
}

#[test]
fn a_stale_rewrite_still_removes_what_its_author_added_since() {
    let mut b = Board::new();
    let section = b.id("section");
    let read = b.read(&section);
    b.write("A", &section, "<p>Mine</p>", WriteMode::Append);
    let merged = b.write_merged("A", &section, &read, WriteMode::Replace);
    assert!(merged.kept_nodes.is_empty());
    assert_eq!(child_tags(&b, &section), ["h2", "button"]);
}

#[test]
fn a_stale_rewrite_still_removes_what_existed_at_the_read() {
    let mut b = Board::new();
    let section = b.id("section");
    let h2 = b.id("h2");
    let read = b.read(&section);
    b.write("B", &section, "<p>New</p>", WriteMode::Append);
    // B also moves the heading after the button, inside the same section.
    let ops = edit::move_nodes(
        b.design.doc(),
        std::slice::from_ref(&h2),
        Some(&section),
        None,
    )
    .unwrap();
    b.design.commit("B", "Move", &ops, 0).unwrap();
    let start = read.find("<h2").unwrap();
    let end = read.find("</h2>").unwrap() + 5;
    let without = format!("{}{}", &read[..start], &read[end..]);
    let merged = b.write_merged("A", &section, &without, WriteMode::Replace);
    assert_eq!(merged.kept_nodes.len(), 1);
    assert!(!b.design.doc().contains(&h2));
    assert_eq!(child_tags(&b, &section), ["button", "p"]);
}

#[test]
fn without_a_mark_a_rewrite_removes_what_others_added() {
    let mut b = Board::new();
    let section = b.id("section");
    let read = b.read(&section);
    b.write("B", &section, "<p>New</p>", WriteMode::Append);
    let start = read.find(" data-read-at=").unwrap();
    let end = start + read[start + 1..].find(' ').unwrap() + 1;
    let unmarked = format!("{}{}", &read[..start], &read[end..]);
    assert!(!unmarked.contains("data-read-at"), "{unmarked}");
    b.write("A", &section, &unmarked, WriteMode::Replace);
    assert_eq!(child_tags(&b, &section), ["h2", "button"]);
}

#[test]
fn a_mark_older_than_the_log_removes_what_others_added() {
    let mut b = Board::new();
    let section = b.id("section");
    let read = b.read(&section);
    b.write("B", &section, "<p>New</p>", WriteMode::Append);
    // A design loaded from a snapshot remembers nothing before the load.
    b.design = Design::from_snapshot(Snapshot {
        histories: None,
        ..b.design.snapshot_to_save()
    });
    let merged = b.write_merged("A", &section, &read, WriteMode::Replace);
    assert!(!merged.reached);
    assert!(merged.kept_nodes.is_empty());
    assert_eq!(child_tags(&b, &section), ["h2", "button"]);
}
