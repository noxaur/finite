//! Times common operations on a large design.
//! `cargo run --release -p finite-design --example big_design`

use std::time::Instant;

use finite_design::{
    Design, DesignMeta, Document, Node, Op,
    edit::{self, WriteMode},
    fractional,
};

fn main() {
    // One artboard with 200 sections of 100 children each: 20,201 nodes.
    let mut nodes = vec![Node {
        index: "V".into(),
        ..Node::element("board", "div")
    }];
    let section_keys = fractional::keys_between(None, None, 200);
    let child_keys = fractional::keys_between(None, None, 100);
    for (s, key) in section_keys.iter().enumerate() {
        nodes.push(Node {
            parent: Some("board".into()),
            index: key.clone(),
            ..Node::element(format!("s{s}"), "section")
        });
        for (c, key) in child_keys.iter().enumerate() {
            nodes.push(Node {
                parent: Some(format!("s{s}")),
                index: key.clone(),
                ..Node::element(format!("s{s}c{c}"), "div")
            });
        }
    }
    let mut doc = Document::from_nodes(nodes);
    println!("{} nodes", doc.len());

    let t = Instant::now();
    for _ in 0..100 {
        doc.insertion_indexes(Some("s0"), None, 1);
    }
    println!("insert position, x100: {:?}", t.elapsed());

    let t = Instant::now();
    let (_, inverse) = doc.apply_all(&[Op::Delete { id: "board".into() }]);
    println!("delete the artboard:   {:?}", t.elapsed());

    let t = Instant::now();
    doc.apply_all(&inverse);
    println!("undo the delete:       {:?}", t.elapsed());

    // The largest write_html one MCP call can carry, 4 MB of siblings, would
    // be about 600,000 nodes and 92 MB of ops. It's over the node limit.
    let html = "<i></i>".repeat((4 << 20) / 7);
    let mut n = 0;
    let mut new_id = || {
        n += 1;
        format!("w{n}")
    };
    let t = Instant::now();
    let refused = edit::write_html(&doc, "s0", &html, WriteMode::Append, None, &mut new_id);
    println!(
        "refuse a 4 MB write:   {:?} ({})",
        t.elapsed(),
        refused.unwrap_err()
    );

    // The biggest write that fits: 33,000 cards, 99,000 nodes, committed the
    // way the server does, with its change log entry.
    let mut design = Design::new(DesignMeta {
        id: "big".into(),
        name: "Big".into(),
        created_at: 0,
        updated_at: 0,
    });
    let ops = edit::create_artboard(
        design.doc(),
        "page".into(),
        edit::NewArtboard {
            name: "Page".into(),
            width: 1440.0,
            height: 900.0,
            position: None,
            page: None,
            styles: Default::default(),
        },
    )
    .unwrap();
    design.commit("agent", "Add page", &ops, 0);
    let card = r#"<div data-name="Card" style="padding: 8px"><p>A product</p></div>"#;
    let fragments = edit::parse_html(&card.repeat(33_000)).unwrap();
    let (ops, _) = edit::write_fragments(
        design.doc(),
        "page",
        fragments,
        WriteMode::Append,
        None,
        &mut new_id,
    )
    .unwrap();
    let t = Instant::now();
    design.commit("agent", "Write cards", &ops, 1);
    println!("commit a {}-node write: {:?}", ops.len(), t.elapsed());
}
