//! Times common operations on a large design.
//! `cargo run --release -p finite-design --example big_design`

use std::time::Instant;

use finite_design::{
    Document, Node, Op,
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
}
