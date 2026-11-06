//! Attributes, links, routes, text, layer names and positions.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::{
    document::{Document, Op},
    flow, fractional,
    html::{self},
    label,
    node::{Node, NodeId, NodeKind, PropKey},
};

use super::{Result, element, err, node};

/// Sets attributes (`src`, `alt`, `href`, SVG attributes, ...). A `None` value removes it.
pub fn update_attributes(
    doc: &Document,
    ids: &[NodeId],
    attrs: &BTreeMap<String, Option<String>>,
) -> Result<Vec<Op>> {
    let mut ops = Vec::new();
    for id in ids {
        element(doc, id)?;
        for (name, value) in attrs {
            let lower = name.to_ascii_lowercase();
            if lower == "style" {
                return err(format!(
                    "#{id}: style isn't an attribute; change inline styles with a css op, like {{\"op\": \"css\", \"select\": \"#{id}\", \"css\": \"color: red\"}}"
                ));
            }
            if lower.starts_with("on") {
                return err(format!(
                    "event handler attributes like {name:?} aren't supported; add a <script> that calls addEventListener"
                ));
            }
            if !html::is_attr_name(name) {
                return err(format!("{name:?} isn't a valid attribute name"));
            }
            // A layer's name is `Node.name`, not an attribute; write_html maps
            // data-name the same way. Clear any stale copy left in attrs.
            if lower == html::NAME_ATTR {
                ops.push(Op::Set {
                    id: id.clone(),
                    key: PropKey::Name,
                    value: value
                        .as_deref()
                        .map(|n| Value::String(label::clip(n, label::LAYER_NAME))),
                });
                for stale in element(doc, id)?
                    .attrs
                    .keys()
                    .filter(|k| k.eq_ignore_ascii_case(html::NAME_ATTR))
                {
                    ops.push(Op::Set {
                        id: id.clone(),
                        key: PropKey::Attr(stale.clone()),
                        value: None,
                    });
                }
                continue;
            }
            if lower == html::ID_ATTR {
                return err("data-id is the node id and can't be changed");
            }
            // The same rules write_html applies when it parses HTML.
            if let Some(value) = value
                && !html::is_safe_attr(name, value)
            {
                return err(format!(
                    "{name}={value:?} isn't allowed: no srcdoc, and no javascript: or vbscript: URLs"
                ));
            }
            if let Some(value) = value
                && lower == "src"
                && element(doc, id)?
                    .tag()
                    .is_some_and(|tag| tag.eq_ignore_ascii_case("script"))
                && !html::is_safe_script_src(value)
            {
                return err(format!(
                    "src={value:?} isn't allowed on a <script>: scripts load only from https:// URLs"
                ));
            }
            ops.push(Op::Set {
                id: id.clone(),
                key: PropKey::Attr(name.clone()),
                value: value.clone().map(Value::String),
            });
        }
    }
    Ok(ops)
}

/// Points links (`<a>` or `<area>`) at artboard `to` (see [`flow`]), or
/// takes their `href` away when `to` is `None`.
pub fn set_link(doc: &Document, ids: &[NodeId], to: Option<&str>) -> Result<Vec<Op>> {
    if let Some(to) = to
        && !doc.get(to).is_some_and(Node::is_artboard)
    {
        return err(format!(
            "{to:?} isn't an artboard; a link goes to an artboard"
        ));
    }
    let mut ops = Vec::with_capacity(ids.len());
    for id in ids {
        if !matches!(element(doc, id)?.tag(), Some("a" | "area")) {
            return err("only a link (<a>) can go to an artboard; put the element inside one");
        }
        ops.push(Op::Set {
            id: id.clone(),
            key: PropKey::Attr("href".to_owned()),
            value: to.map(|to| Value::from(flow::link_href(to))),
        });
    }
    Ok(ops)
}

/// Puts artboard `id` on `route` (see [`flow`]), or on a route made from its
/// name when `route` is `None`.
pub fn set_route(doc: &Document, id: &str, route: Option<&str>) -> Result<Vec<Op>> {
    if !node(doc, id)?.is_artboard() {
        return err(format!(
            "node {id:?} isn't an artboard; routes are set on artboards"
        ));
    }
    let route = route.map(str::trim).filter(|r| !r.is_empty());
    if let Some(route) = route
        && !flow::is_route(route)
    {
        return err(format!(
            "{route:?} isn't a route: start with / and use letters, digits and - . _ ~, like /checkout/done; a segment can't be just `.` or `..`"
        ));
    }
    Ok(vec![Op::Set {
        id: id.to_owned(),
        key: PropKey::Attr(flow::ROUTE_ATTR.to_owned()),
        value: route.map(Value::from),
    }])
}

/// Replaces the text of a node. On a text node this sets its text; on an
/// element it reuses a lone text child, or replaces all children with one.
pub fn set_text(
    doc: &Document,
    id: &str,
    text: &str,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<Vec<Op>> {
    let target = node(doc, id)?;
    let set = |id: &str| Op::Set {
        id: id.to_owned(),
        key: PropKey::Text,
        value: Some(Value::String(text.to_owned())),
    };
    if target.kind == NodeKind::Text {
        return Ok(vec![set(id)]);
    }
    let children = doc.children(Some(id));
    if let [only] = children.as_slice()
        && only.kind == NodeKind::Text
    {
        return Ok(vec![set(&only.id)]);
    }
    let mut ops: Vec<Op> = children
        .iter()
        .map(|c| Op::Delete { id: c.id.clone() })
        .collect();
    ops.push(Op::Create {
        node: Node {
            parent: Some(id.to_owned()),
            index: fractional::key_between(None, None),
            ..Node::text(new_id(), text)
        },
    });
    Ok(ops)
}

pub fn rename(doc: &Document, id: &str, name: Option<&str>) -> Result<Vec<Op>> {
    node(doc, id)?;
    Ok(vec![Op::Set {
        id: id.to_owned(),
        key: PropKey::Name,
        value: name.map(|n| Value::String(label::clip(n, label::LAYER_NAME))),
    }])
}

pub fn set_position(doc: &Document, id: &str, x: f64, y: f64) -> Result<Vec<Op>> {
    if !node(doc, id)?.is_artboard() {
        return err(format!(
            "node {id:?} isn't an artboard; only artboards have a canvas position"
        ));
    }
    Ok(vec![
        Op::Set {
            id: id.to_owned(),
            key: PropKey::X,
            value: Some(Value::from(x)),
        },
        Op::Set {
            id: id.to_owned(),
            key: PropKey::Y,
            value: Some(Value::from(y)),
        },
    ])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::{support::*, *};

    #[test]
    fn long_layer_names_are_cut() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let long = "x".repeat(500);
        let html = format!(r#"<div data-name="  {long}  "></div>"#);
        let (ops, roots) =
            write_html(&doc, &board, &html, WriteMode::Append, None, &mut ids()).unwrap();
        doc.apply_all(&ops);
        let name = |doc: &Document| doc.get(&roots[0]).unwrap().name.clone().unwrap();
        assert_eq!(name(&doc).len(), label::LAYER_NAME);
        doc.apply_all(&rename(&doc, &roots[0], Some(&long)).unwrap());
        assert_eq!(name(&doc).len(), label::LAYER_NAME);
    }

    #[test]
    fn set_text_reuses_lone_text_child() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let mut new_id = ids();
        let (ops, roots) = write_html(
            &doc,
            &board,
            "<p>old</p>",
            WriteMode::Append,
            None,
            &mut new_id,
        )
        .unwrap();
        doc.apply_all(&ops);
        let text_id = doc.children(Some(&roots[0]))[0].id.clone();
        let ops = set_text(&doc, &roots[0], "new", &mut new_id).unwrap();
        doc.apply_all(&ops);
        assert_eq!(doc.get(&text_id).unwrap().text.as_deref(), Some("new"));
    }

    #[test]
    fn update_attributes_follows_the_same_rules_as_write_html() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let set = |name: &str, value: &str| {
            let attrs = BTreeMap::from([(name.to_owned(), Some(value.to_owned()))]);
            update_attributes(&doc, std::slice::from_ref(&board), &attrs)
        };
        assert!(set("href", "https://example.com").is_ok());
        assert!(set("viewBox", "0 0 10 10").is_ok());
        assert!(set("xlink:href", "#icon").is_ok());
        assert!(set("href", " JavaScript:alert(1)").is_err());
        assert!(set("srcdoc", "<p>hi</p>").is_err());
        assert!(set("onclick", "x()").is_err());
        assert!(set("x\" onload=\"alert(1)", "y").is_err());
        assert!(set("", "y").is_err());
        assert!(set("data-id", "n9").is_err());
        let style = set("style", "color: red").unwrap_err();
        assert!(
            style
                .0
                .contains(&format!("#{board}: style isn't an attribute"))
                && style.0.contains("\"op\": \"css\""),
            "{style}"
        );
    }

    #[test]
    fn update_attributes_renames_a_layer_through_data_name() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let mut set = |value: Option<&str>| {
            let attrs = BTreeMap::from([("data-name".to_owned(), value.map(str::to_owned))]);
            let ops = update_attributes(&doc, std::slice::from_ref(&board), &attrs).unwrap();
            assert!(ops.iter().all(|op| matches!(
                op,
                Op::Set {
                    key: PropKey::Name,
                    ..
                }
            )));
            doc.apply_all(&ops);
            doc.get(&board).unwrap().name.clone()
        };
        assert_eq!(set(Some("Header")).as_deref(), Some("Header"));
        let long = "x".repeat(label::LAYER_NAME + 20);
        assert_eq!(set(Some(&long)).unwrap().chars().count(), label::LAYER_NAME);
        assert_eq!(set(None), None);
        assert!(doc.get(&board).unwrap().attrs.is_empty());
    }

    #[test]
    fn update_attributes_clears_every_stale_data_name_copy() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        // Older calls could leave the same attribute under two spellings.
        for key in ["data-name", "DATA-NAME"] {
            doc.apply_all(&[Op::Set {
                id: board.clone(),
                key: PropKey::Attr(key.to_owned()),
                value: Some("Old".into()),
            }]);
        }
        let attrs = BTreeMap::from([("data-name".to_owned(), None)]);
        let ops = update_attributes(&doc, std::slice::from_ref(&board), &attrs).unwrap();
        doc.apply_all(&ops);
        assert!(doc.get(&board).unwrap().attrs.is_empty());
    }
}
