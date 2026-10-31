//! Times common operations on a large design.
//! `cargo run --release -p finite-design --example big_design`

use std::time::Instant;

use finite_design::{Document, Node, Op, fractional};

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
}
