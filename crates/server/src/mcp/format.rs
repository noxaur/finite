//! How tools describe the document to agents: compact outlines and node JSON.

use std::fmt::Write;

use finite_design::{Design, Document, NodeKind, comment::Comment};

/// The most text one tool result returns, about 15,000 tokens. Claude Code
/// cuts MCP results at 25,000 tokens by default, wherever that falls, and a
/// long result crowds out the rest of the agent's context anyway.
pub(super) const OUTPUT_LIMIT: usize = 60_000;

/// Cuts `text` to [`OUTPUT_LIMIT`] at the end of a line, and says how to see
/// the rest with `hint`.
pub(super) fn cut(text: String, hint: &str) -> String {
    if text.len() <= OUTPUT_LIMIT {
        return text;
    }
    let mut end = OUTPUT_LIMIT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let end = text[..end].rfind('\n').map_or(end, |i| i + 1);
    let shown = text[..end].lines().count();
    let total = text.lines().count();
    format!(
        "{}… cut off after {shown} of {total} lines. {hint}\n",
        &text[..end]
    )
}

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

/// Comments as agents see them: what was asked, where, and the thread so far.
pub(super) fn comments_json<'a>(
    design: &Design,
    comments: impl Iterator<Item = &'a Comment>,
) -> Vec<serde_json::Value> {
    let doc = design.doc();
    comments
        .map(|c| {
            let artboard = c.artboard_id.as_deref().and_then(|id| doc.get(id));
            // The outline line for the element, like `button "CTA" #ab12 "Sign up"`.
            let node = c
                .node_id
                .as_deref()
                .filter(|id| doc.contains(id))
                .map(|id| outline(doc, id, 0).lines().next().unwrap_or("").to_owned());
            let thread: Vec<_> = c
                .messages
                .iter()
                .map(|m| {
                    serde_json::json!({
                        "author": m.author.name,
                        "from": m.author.kind,
                        "message": m.body,
                        "at": m.at,
                        "changes": m.changes.iter().map(|c| &c.label).collect::<Vec<_>>(),
                    })
                })
                .collect();
            let relative_to = if c.artboard_id.is_some() {
                "artboard"
            } else {
                "canvas"
            };
            serde_json::json!({
                "commentId": c.id,
                "resolved": c.resolved,
                "artboardId": c.artboard_id,
                "artboardName": artboard.map(|a| a.display_name()),
                // The artboard was deleted; the pin stays where it was.
                "artboardDeleted": c.detached_at.is_some(),
                "nodeId": c.node_id,
                "node": node,
                "pin": { "x": c.x.round(), "y": c.y.round(), "relativeTo": relative_to },
                "thread": thread,
            })
        })
        .collect()
}
