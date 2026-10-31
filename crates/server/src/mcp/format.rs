//! How tools describe the document to agents: compact outlines and node JSON.

use std::fmt::Write;

use finite_design::{Document, NodeKind};

/// One line per node, indented by depth: `tag "Name" #id [width×height] "text"`.
pub(super) fn outline(doc: &Document, id: &str, max_depth: usize) -> String {
    let mut out = String::new();
    outline_into(doc, id, 0, max_depth, &mut out);
    out
}

fn outline_into(doc: &Document, id: &str, depth: usize, max_depth: usize, out: &mut String) {
    let Some(node) = doc.get(id) else { return };
    let pad = "  ".repeat(depth);
    match &node.kind {
        NodeKind::Text => {
            let _ = writeln!(out, "{pad}text #{} {:?}", node.id, node.display_name());
            return;
        }
        NodeKind::Element { tag } => {
            let _ = write!(out, "{pad}{tag}");
            if let Some(name) = &node.name {
                let _ = write!(out, " {name:?}");
            }
            let _ = write!(out, " #{}", node.id);
            if node.is_artboard() {
                let _ = write!(
                    out,
                    " (artboard at {}, {})",
                    node.x.unwrap_or(0.0),
                    node.y.unwrap_or(0.0)
                );
            }
            let size = |k: &str| node.styles.get(k).map(String::as_str);
            if let (Some(w), Some(h)) = (size("width"), size("height")) {
                let _ = write!(out, " [{w} × {h}]");
            }
            if let Some(display) = size("display") {
                let direction = size("flex-direction").unwrap_or("");
                let _ = write!(out, " {display} {direction}");
            }
        }
    }
    let children = doc.children(Some(id));
    match children.as_slice() {
        [] => out.push('\n'),
        [only] if only.kind == NodeKind::Text => {
            let _ = writeln!(out, " {:?}", only.display_name());
        }
        _ if depth >= max_depth => {
            let _ = writeln!(out, " … {} children", children.len());
        }
        _ => {
            out.push('\n');
            for child in children {
                outline_into(doc, &child.id, depth + 1, max_depth, out);
            }
        }
    }
}

pub(super) fn node_json(doc: &Document, id: &str) -> serde_json::Value {
    let Some(node) = doc.get(id) else {
        return serde_json::json!({ "id": id, "error": "not found" });
    };
    let children: Vec<&str> = doc
        .children(Some(id))
        .iter()
        .map(|c| c.id.as_str())
        .collect();
    serde_json::json!({
        "id": node.id,
        "type": if node.kind == NodeKind::Text { "text" } else { "element" },
        "tag": node.tag(),
        "name": node.display_name(),
        "parentId": node.parent,
        "artboardId": doc.artboard_of(id).map(|a| &a.id),
        "x": node.x,
        "y": node.y,
        "text": node.text,
        "styles": node.styles,
        "attributes": node.attrs,
        "childIds": children,
    })
}

// Tool parameters. Doc comments become the JSON Schema descriptions agents see.
