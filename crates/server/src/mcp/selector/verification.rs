//! Exhaustive checks of the MCP adapter's finite selector-input domain.
use super::*;
use finite_design::Node;
use serde_json::json;

#[test]
fn exhaustive_selector_adapter() {
    let refs = HashMap::from([
        ("a".into(), "0aaaaaaa".into()),
        ("b".into(), "1bbbbbbb".into()),
    ]);
    let nodes: Vec<Node> = [
        json!({"id":"0aaaaaaa", "parent":null, "index":"a0", "type":"element", "tag":"div", "page":"p0"}),
        json!({"id":"1bbbbbbb", "parent":null, "index":"a1", "type":"element", "tag":"div", "page":"p1"}),
        json!({"id":"text0", "parent":"0aaaaaaa", "index":"a0", "type":"text", "text":"hello"}),
        json!({"id":"text1", "parent":"1bbbbbbb", "index":"a0", "type":"text", "text":"world"}),
    ].into_iter().map(|v| serde_json::from_value(v).unwrap()).collect();
    let doc = Document::from_nodes(nodes).with_pages(std::collections::BTreeMap::from([
        (
            "p0".into(),
            finite_design::Page {
                name: "Zero".into(),
                index: "a0".into(),
                background: None,
            },
        ),
        (
            "p1".into(),
            finite_design::Page {
                name: "One".into(),
                index: "a1".into(),
                background: None,
            },
        ),
    ]));
    let spellings = ["@a", "@b", "0aaaaaaa", "1bbbbbbb", "#0aaaaaaa", "#1bbbbbbb"];
    // Every ordered list of length 1..3, in both JSON forms, with repeats.
    for len in 1..=3u32 {
        for mut code in 0..6usize.pow(len) {
            let mut parts = Vec::new();
            let mut present = [false; 2];
            for _ in 0..len {
                let digit = code % 6;
                code /= 6;
                parts.push(spellings[digit]);
                present[digit % 2] = true;
            }
            for value in [json!(parts.join(", ")), json!(parts)] {
                let selector = selector_text(&value, &refs).unwrap();
                for page in [None, Some("p0"), Some("p1"), Some("missing")] {
                    let want: Vec<_> = ["0aaaaaaa", "1bbbbbbb"]
                        .into_iter()
                        .enumerate()
                        .filter(|(i, _)| {
                            present[*i]
                                && (page.is_none()
                                    || page == Some(if *i == 0 { "p0" } else { "p1" }))
                        })
                        .map(|(_, id)| id.to_owned())
                        .collect();
                    assert_eq!(
                        matched(&doc, &selector, page).unwrap(),
                        want,
                        "input={value} page={page:?}"
                    );
                }
            }
        }
    }
    for (selector, expected) in [
        ("#text0", vec!["text0"]),
        ("#text1, #text0", vec!["text1", "text0"]),
        // Element matches take precedence over the text-only fallback.
        ("#text0, #1bbbbbbb", vec!["1bbbbbbb"]),
        ("div > #text0", vec![]),
    ] {
        assert_eq!(matched(&doc, selector, None).unwrap(), expected);
    }
    assert!(matched(&doc, "#text0", Some("p1")).unwrap().is_empty());
    assert!(selector_text(&json!("@missing"), &refs).is_err());
    for literal in ["@a", "a,b", "#0aaaaaaa", "é,@b", "x\\\"@a"] {
        let selector = format!("[title=\"{literal}\"], :contains(\"{literal}\")");
        assert_eq!(selector_text(&json!(selector), &refs).unwrap(), selector);
    }
}
