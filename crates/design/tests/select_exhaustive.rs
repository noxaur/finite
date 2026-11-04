//! Bounded exhaustive refinement check of the real selector implementation.
use finite_design::{
    Document, Node,
    select::{self, Matcher, Scope},
};
use serde_json::json;

fn ancestor(parents: &[Option<usize>], a: usize, mut b: usize) -> bool {
    while let Some(p) = parents[b] {
        if p == a {
            return true;
        }
        b = p;
    }
    false
}

fn visit(parents: &[Option<usize>], parent: Option<usize>, order: &mut Vec<usize>) {
    for i in 0..parents.len() {
        if parents[i] == parent {
            order.push(i);
            visit(parents, Some(i), order);
        }
    }
}

#[test]
fn exhaustive_selector_refinement() {
    let sources = [
        "*",
        ".a",
        ".b",
        ":root",
        ":empty",
        ":first-child",
        ":last-child",
        ":only-child",
        ":nth-child(2)",
        ":nth-child(odd)",
        ":nth-last-child(2)",
        ":is(.a,.b)",
        ":not(.a)",
        ".a,.a,.b",
        ".a > .b",
        ".a .b",
        ".a + .b",
        ".a ~ .b",
        ".a:has(> .b)",
        ".a:has(.b)",
        ".a:has(+ .b)",
        ".a:has(~ .b)",
        ":nth-child(2 of .a)",
        "[class~=a]",
        "[data-id='0node']",
        "#0node",
    ];
    let lists: Vec<_> = sources.iter().map(|s| select::parse(s).unwrap()).collect();
    let mut forests = 0;
    let mut comparisons = 0;
    for n in 0..=5 {
        // Mixed-radix enumeration: node i is a root or a child of 0..i.
        let shapes: usize = (1..=n).product();
        for shape in 0..shapes {
            let mut code = shape;
            let parents: Vec<_> = (0..n)
                .map(|i| {
                    let p = code % (i + 1);
                    code /= i + 1;
                    p.checked_sub(1)
                })
                .collect();
            let mut order = Vec::new();
            visit(&parents, None, &mut order);
            for bits in 0..(1usize << n) {
                forests += 1;
                let a = |i: usize| bits & (1 << i) != 0;
                let ids: Vec<_> = (0..n).map(|i| format!("{i}node")).collect();
                let nodes: Vec<Node> = (0..n)
                    .map(|i| {
                        serde_json::from_value(json!({
                            "id": ids[i], "parent": parents[i].map(|p| &ids[p]),
                            "index": format!("a{i}"), "type": "element", "tag": "div",
                            "attrs": {"class": if a(i) {"a"} else {"b"}}
                        }))
                        .unwrap()
                    })
                    .collect();
                let doc = Document::from_nodes(nodes);
                // A declarative specification over parent relations, independent
                // of Matcher's flattened index and Servo's matching algorithm.
                let expected: Vec<Vec<String>> = (0..sources.len())
                    .map(|s| {
                        order
                            .iter()
                            .copied()
                            .filter(|&i| {
                                let siblings: Vec<_> =
                                    (0..n).filter(|&j| parents[j] == parents[i]).collect();
                                let pos = siblings.iter().position(|&j| j == i).unwrap();
                                let related = |j: usize, relation: usize| match relation {
                                    0 => parents[i] == Some(j),
                                    1 => ancestor(&parents, j, i),
                                    2 => parents[i].is_some() && pos > 0 && siblings[pos - 1] == j,
                                    3 => parents[i].is_some() && j < i && parents[j] == parents[i],
                                    _ => unreachable!(),
                                };
                                let has = |relation| {
                                    (0..n).any(|j| {
                                        !a(j)
                                            && match relation {
                                                0 => parents[j] == Some(i),
                                                1 => ancestor(&parents, i, j),
                                                2 => {
                                                    parents[i].is_some()
                                                        && siblings.get(pos + 1) == Some(&j)
                                                }
                                                3 => {
                                                    parents[i].is_some()
                                                        && j > i
                                                        && parents[j] == parents[i]
                                                }
                                                _ => unreachable!(),
                                            }
                                    })
                                };
                                match s {
                                    0 | 11 | 13 => true,
                                    1 | 23 => a(i),
                                    2 | 12 => !a(i),
                                    3 => parents[i].is_none(),
                                    4 => !parents.contains(&Some(i)),
                                    // Artboards are separate CSS roots, not siblings.
                                    5 => parents[i].is_none() || pos == 0,
                                    6 => parents[i].is_none() || pos + 1 == siblings.len(),
                                    7 => parents[i].is_none() || siblings.len() == 1,
                                    8 => parents[i].is_some() && pos == 1,
                                    9 => parents[i].is_none() || pos % 2 == 0,
                                    10 => parents[i].is_some() && pos + 2 == siblings.len(),
                                    14..=17 => !a(i) && (0..n).any(|j| a(j) && related(j, s - 14)),
                                    18..=21 => a(i) && has(s - 18),
                                    22 => {
                                        a(i) && parents[i].is_some()
                                            && siblings[..pos].iter().filter(|&&j| a(j)).count()
                                                == 1
                                    }
                                    24 | 25 => i == 0,
                                    _ => unreachable!(),
                                }
                            })
                            .map(|i| ids[i].clone())
                            .collect()
                    })
                    .collect();
                let matcher = Matcher::new(&doc, Scope::Design);
                for (s, list) in lists.iter().enumerate() {
                    assert_eq!(
                        matcher.select(list),
                        expected[s],
                        "parents={parents:?} bits={bits} selector={}",
                        sources[s]
                    );
                    comparisons += 1;
                }
                for mask in 0..(1usize << n) {
                    let roots: Vec<_> = (0..n).filter(|i| mask & (1 << i) != 0).collect();
                    let within: Vec<_> = roots.iter().map(|&i| ids[i].clone()).collect();
                    let matcher = Matcher::new(&doc, Scope::Within(&within));
                    for (s, list) in lists.iter().enumerate() {
                        let scoped: Vec<_> = expected[s]
                            .iter()
                            .filter(|id| {
                                let i = ids.iter().position(|x| x == *id).unwrap();
                                roots.iter().any(|&r| ancestor(&parents, r, i))
                            })
                            .cloned()
                            .collect();
                        assert_eq!(
                            matcher.select(list),
                            scoped,
                            "parents={parents:?} bits={bits} scope={mask} selector={}",
                            sources[s]
                        );
                        comparisons += 1;
                    }
                }
            }
        }
    }
    eprintln!("verified {forests} labelled forests; {comparisons} exact result comparisons");
}
