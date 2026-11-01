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
            let _ = writeln!(out, "{pad}text #{} {:?}", node.id, text_snippet(node));
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
            let _ = writeln!(out, " {:?}", text_snippet(only));
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

/// How much of a text node the outline shows. Layer names stop at 24
/// characters, but agents read the outline to proofread and to find copy, so
/// it shows a sentence.
const OUTLINE_TEXT: usize = 100;

/// A text node's text, trimmed and cut at [`OUTLINE_TEXT`] characters.
fn text_snippet(node: &finite_design::Node) -> String {
    let text = node.text.as_deref().unwrap_or("").trim();
    let mut snippet: String = text.chars().take(OUTLINE_TEXT).collect();
    if snippet.len() < text.len() {
        snippet.push('…');
    }
    snippet
}

pub(super) fn node_json(doc: &Document, id: &str) -> serde_json::Value {
    let Some(node) = doc.get(id) else {
        return serde_json::json!({ "id": id, "error": "not found" });
    };
    let children = doc.children(Some(id));
    let child_ids: Vec<&str> = children
        .iter()
        .take(CHILD_IDS)
        .map(|c| c.id.as_str())
        .collect();
    let shorten = |map: &std::collections::BTreeMap<String, String>| {
        map.iter()
            .map(|(k, v)| (k.clone(), short(v)))
            .collect::<std::collections::BTreeMap<_, _>>()
    };
    serde_json::json!({
        "id": node.id,
        "type": if node.kind == NodeKind::Text { "text" } else { "element" },
        "tag": node.tag(),
        "name": node.display_name(),
        "parentId": node.parent,
        "artboardId": doc.artboard_of(id).map(|a| &a.id),
        "x": node.x,
        "y": node.y,
        "text": node.text.as_deref().map(short),
        "styles": shorten(&node.styles),
        "attributes": shorten(&node.attrs),
        "childCount": children.len(),
        "childIds": child_ids,
    })
}

/// How many child ids `get_node_info` lists; `get_children` pages through the rest.
const CHILD_IDS: usize = 200;
/// Values longer than this are shortened in `get_node_info`.
const VALUE_LIMIT: usize = 2_000;

/// `value`, or its start and its length if it's longer than [`VALUE_LIMIT`].
/// An image's inline `data:` URL can be megabytes of base64 that an agent
/// has no use for in full.
fn short(value: &str) -> String {
    if value.len() <= VALUE_LIMIT {
        return value.to_owned();
    }
    let mut end = 200;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}… ({} characters in all)", &value[..end], value.len())
}

// Tool parameters. Doc comments become the JSON Schema descriptions agents see.

/// The longest element HTML a comment includes. Longer elements are
/// usually whole sections, and get_html reads them.
const COMMENT_NODE_HTML: usize = 2_000;

/// How many of a thread's latest messages agents see, after its first.
const THREAD_SHOWN: usize = 10;

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
            // A thread can hold 200 messages of 4,000 characters. Keep the
            // request that started it and the latest few.
            let skipped = c.messages.len().saturating_sub(THREAD_SHOWN + 1);
            let shown = c
                .messages
                .iter()
                .take(1)
                .chain(c.messages.iter().skip(1 + skipped));
            let thread: Vec<_> = shown
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
            // The element's HTML, when it's short, so the agent can change it
            // without reading it first.
            let node_html = c
                .node_id
                .as_deref()
                .and_then(|id| finite_design::html::export(doc, id, true))
                .filter(|html| html.len() <= COMMENT_NODE_HTML);
            serde_json::json!({
                "commentId": c.id,
                "resolved": c.resolved,
                "artboardId": c.artboard_id,
                "artboardName": artboard.map(|a| a.display_name()),
                // The artboard was deleted; the pin stays where it was.
                "artboardDeleted": c.detached_at.is_some(),
                "nodeId": c.node_id,
                "node": node,
                "nodeHtml": node_html,
                "pin": { "x": c.x.round(), "y": c.y.round(), "relativeTo": relative_to },
                "thread": thread,
                "messagesNotShown": skipped,
            })
        })
        .collect()
}

/// What a screenshot shows, after its image: where it is in the artboard,
/// and anything the agent should know about it.
pub(super) fn shot(image: &crate::screenshot::Image) -> String {
    let px = |v: f64| format!("{}", (v * 10.0).round() / 10.0);
    let a = &image.area;
    let b = &image.bounds;
    let mut out = format!(
        "#{} in artboard #{}: shows {}×{} at ({}, {}); the node's box is {}×{} at ({}, {}). {}×{} pixels.",
        image.node,
        image.artboard,
        px(a.width),
        px(a.height),
        px(a.x),
        px(a.y),
        px(b.width),
        px(b.height),
        px(b.x),
        px(b.y),
        image.pixel_width,
        image.pixel_height,
    );
    if image.element != image.node {
        let _ = write!(out, " A text node: captured its parent #{}.", image.element);
    }
    if image.scale < image.requested_scale {
        let _ = write!(
            out,
            " Captured at {:.2}× instead of {}×, so its longer side fits in {} pixels.",
            image.scale,
            image.requested_scale,
            crate::screenshot::MAX_OUTPUT_SIDE
        );
    }
    if image.cut_off {
        out.push_str(" Part of it is past the artboard's edge and isn't shown.");
    }
    if image.overflow.any() {
        let _ = write!(
            out,
            " The artboard's content overflows it by {}px right and {}px down",
            px(image.overflow.right),
            px(image.overflow.bottom)
        );
        out.push_str(if image.overflow_shown {
            ", shown here."
        } else {
            ", and is cut off there; pass revealOverflow to see it."
        });
    }
    if let Some(settled) = image.settled {
        let _ = write!(
            out,
            " It has scripts or animations, captured {:.1}s after load.",
            settled.as_secs_f64()
        );
    }
    out
}

/// How many elements a layout note names before it says how many more.
const LAYOUT_NAMED: usize = 8;

/// What a screenshot's measurements say about an artboard's layout: content
/// cut off at its edges, and text that runs past its own box. Agents only
/// spotted these in the image before, and often didn't, so the note names
/// the elements and says what to change.
pub(super) fn layout_notes(
    doc: &Document,
    artboard: &str,
    boxes: &[crate::screenshot::ElementBox],
) -> String {
    use std::collections::{HashMap, HashSet};
    let by_id: HashMap<&str, &crate::screenshot::ElementBox> =
        boxes.iter().map(|b| (b.id.as_str(), b)).collect();
    let Some(board) = by_id.get(artboard) else {
        return String::new();
    };
    let line = |id: &str| {
        outline(doc, id, 0)
            .lines()
            .next()
            .unwrap_or("")
            .trim()
            .to_owned()
    };
    // Elements reaching past the artboard's bottom or right edge. Only the
    // outermost is named: its children stick out because it does.
    let (bottom, right) = (board.y + board.height, board.x + board.width);
    let out: HashSet<&str> = boxes
        .iter()
        .filter(|b| {
            b.id != artboard && (b.y + b.height > bottom + 1.0 || b.x + b.width > right + 1.0)
        })
        .map(|b| b.id.as_str())
        .collect();
    let mut notes = Vec::new();
    if !out.is_empty() {
        let content_bottom = boxes.iter().map(|b| b.y + b.height).fold(bottom, f64::max) - board.y;
        let content_right = boxes.iter().map(|b| b.x + b.width).fold(right, f64::max) - board.x;
        let outermost: Vec<&str> = boxes
            .iter()
            .map(|b| b.id.as_str())
            .filter(|id| out.contains(id))
            .filter(|id| {
                doc.get(id)
                    .and_then(|n| n.parent.as_deref())
                    .is_none_or(|p| !out.contains(p))
            })
            .collect();
        let mut text = String::from("Layout: content is cut off by the artboard's edge.");
        if content_bottom > board.height + 1.0 {
            let _ = write!(
                text,
                " It is {content_bottom:.0} px tall, but the artboard is {:.0} px. If it should all show, make the artboard taller with update_styles {{\"updates\": [{{\"nodeIds\": [\"{artboard}\"], \"styles\": {{\"height\": \"{content_bottom:.0}px\"}}}}]}}.",
                board.height
            );
        }
        if content_right > board.width + 1.0 {
            let _ = write!(
                text,
                " It is {content_right:.0} px wide, but the artboard is {:.0} px.",
                board.width
            );
        }
        text.push_str(" Sticking out:");
        for id in outermost.iter().take(LAYOUT_NAMED) {
            let b = by_id[id];
            let _ = write!(
                text,
                "\n  {} (ends at x {:.0}, y {:.0})",
                line(id),
                b.x + b.width - board.x,
                b.y + b.height - board.y
            );
        }
        if outermost.len() > LAYOUT_NAMED {
            let _ = write!(text, "\n  … and {} more", outermost.len() - LAYOUT_NAMED);
        }
        notes.push(text);
    }
    let spilling: Vec<&crate::screenshot::ElementBox> = boxes
        .iter()
        // Down, a few pixels is a tall glyph, like an emoji, in a tight line height.
        .filter(|b| b.text_overflow.0 > 2.0 || b.text_overflow.1 > 8.0)
        .collect();
    if !spilling.is_empty() {
        let mut text =
            String::from("Layout: text runs past its box, so it may overlap or be clipped:");
        for b in spilling.iter().take(LAYOUT_NAMED) {
            let _ = write!(text, "\n  {} ", line(&b.id));
            match b.text_overflow {
                (x, y) if x > 2.0 && y > 8.0 => {
                    let _ = write!(text, "({x:.0} px too wide, {y:.0} px too tall)");
                }
                (x, _) if x > 2.0 => {
                    let _ = write!(text, "({x:.0} px too wide)");
                }
                (_, y) => {
                    let _ = write!(text, "({y:.0} px too tall)");
                }
            }
        }
        if spilling.len() > LAYOUT_NAMED {
            let _ = write!(text, "\n  … and {} more", spilling.len() - LAYOUT_NAMED);
        }
        notes.push(text);
    }
    if notes.is_empty() {
        let used = boxes
            .iter()
            .filter(|b| b.id != artboard)
            .map(|b| b.y + b.height)
            .fold(board.y, f64::max)
            - board.y;
        return format!(
            "Layout: nothing is cut off, and no text overflows. The lowest element ends at y {used:.0}; the artboard is {:.0} px tall.",
            board.height
        );
    }
    notes.join("\n")
}
