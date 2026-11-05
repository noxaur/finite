//! How tools describe the document to agents: compact outlines and node JSON.

use std::{borrow::Cow, cell::OnceCell, fmt::Write};

use finite_design::{
    Design, Document, NodeKind,
    comment::{Audience, Comment},
    tokens,
};

use super::layout::{layout_notes, overlap_note};

/// The most text one tool result returns, about 10,000 tokens. Claude Code
/// cuts MCP results at 25,000 tokens by default, wherever that falls, and
/// other clients cap lower: a 56,000-character read went over one's limit
/// twice. A long result crowds out the rest of the agent's context anyway.
pub(super) const OUTPUT_LIMIT: usize = 40_000;

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

/// The first `shown` of `ids` like `#a, #b, #c, … +8`, for lines that name
/// many nodes at once.
pub(super) fn some_ids<S: AsRef<str>>(ids: &[S], shown: usize) -> String {
    let mut text: Vec<String> = ids
        .iter()
        .take(shown)
        .map(|id| format!("#{}", id.as_ref()))
        .collect();
    if ids.len() > shown {
        text.push(format!("… +{}", ids.len() - shown));
    }
    text.join(", ")
}

/// One line per node, indented by depth: `tag "Name" #id [width×height] "text"`.
pub(super) fn outline(doc: &Document, id: &str, max_depth: usize) -> String {
    let mut out = String::new();
    outline_into(doc, id, 0, max_depth, &OnceCell::new(), &mut out);
    out
}

/// `sheets` holds the artboard's `<style>` text once an element needs it.
fn outline_into(
    doc: &Document,
    id: &str,
    depth: usize,
    max_depth: usize,
    sheets: &OnceCell<String>,
    out: &mut String,
) {
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
            if let Some(component) = &node.instance_of {
                match doc.get(component) {
                    Some(c) => {
                        let _ = write!(out, " (instance of {:?} #{component})", c.display_name());
                    }
                    None => {
                        let _ = write!(out, " (instance of missing component #{component})");
                    }
                }
            }
            if node.component {
                out.push_str(" (component)");
            }
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
                let (w, h) = (
                    resolve_vars(doc, node, w, sheets),
                    resolve_vars(doc, node, h, sheets),
                );
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
                outline_into(doc, &child.id, depth + 1, max_depth, sheets, out);
            }
        }
    }
}

/// `value` with each `var(--token)` the design defines replaced by the
/// token's value in the mode of `node`'s artboard, so an outline shows
/// `44px` where the style says `var(--button-h)`. A `var()` naming no token
/// takes its fallback, or stays as it is. A `var()` stays as written where
/// `node` or an ancestor sets that property in its style attribute, or the
/// artboard's `<style>` blocks mention setting it: the renderers compute
/// something else there, and the outline doesn't evaluate stylesheets.
fn resolve_vars<'a>(
    doc: &Document,
    node: &finite_design::Node,
    value: &'a str,
    sheets: &OnceCell<String>,
) -> Cow<'a, str> {
    if !value.contains("var(") {
        return Cow::Borrowed(value);
    }
    let mode = doc.artboard_of(&node.id).map(|board| doc.mode_of(board));
    let mode = mode.unwrap_or(doc.first_mode());
    let set_nearer = |name: &str| {
        let mut at = Some(node);
        while let Some(n) = at {
            if n.styles.contains_key(name) {
                return true;
            }
            at = n.parent.as_deref().and_then(|p| doc.get(p));
        }
        let sheets = sheets.get_or_init(|| {
            let mut text = doc.css().unwrap_or("").to_owned();
            if let Some(board) = doc.artboard_of(&node.id) {
                for n in doc.subtree(&board.id) {
                    if n.tag().is_some_and(|t| t.eq_ignore_ascii_case("style")) {
                        for child in doc.children(Some(&n.id)) {
                            text.push_str(child.text.as_deref().unwrap_or(""));
                        }
                    }
                }
            }
            text
        });
        sets_property(sheets, name)
    };
    Cow::Owned(substitute(doc, mode, value, 0, &set_nearer))
}

/// Whether `css` declares the custom property `name`, as in `--name: 1px`.
fn sets_property(css: &str, name: &str) -> bool {
    // A whole name: `--gap` isn't set by `--component--gap: 24px`.
    let ident = |c: char| c.is_alphanumeric() || c == '-' || c == '_' || !c.is_ascii();
    css.match_indices(name).any(|(i, _)| {
        !css[..i].chars().next_back().is_some_and(ident)
            && css[i + name.len()..].trim_start().starts_with(':')
    })
}

/// How deep a token's value may itself use `var()` before it stays as written.
const VAR_DEPTH: usize = 4;

fn substitute(
    doc: &Document,
    mode: &str,
    text: &str,
    depth: usize,
    set_nearer: &dyn Fn(&str) -> bool,
) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find("var(") {
        out.push_str(&rest[..start]);
        let inner = &rest[start + 4..];
        // The matching close paren, so a fallback like `calc(1px + 2px)` stays whole.
        let mut open = 1;
        let end = inner.find(|c| {
            match c {
                '(' => open += 1,
                ')' => open -= 1,
                _ => {}
            }
            open == 0
        });
        let Some(end) = end else { break };
        let (name, fallback) = match inner[..end].split_once(',') {
            Some((name, fallback)) => (name.trim(), Some(fallback.trim())),
            None => (inner[..end].trim(), None),
        };
        let value = if set_nearer(name) {
            None
        } else {
            doc.tokens()
                .get(name)
                .and_then(|values| tokens::value(doc, values, mode))
                .or(fallback)
        };
        match value {
            Some(value) if depth < VAR_DEPTH => {
                out.push_str(&substitute(doc, mode, value, depth + 1, set_nearer))
            }
            _ => out.push_str(&rest[start..start + 4 + end + 1]),
        }
        rest = &inner[end + 1..];
    }
    out.push_str(rest);
    out
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
    let mut json = serde_json::json!({
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
    });
    if node.component {
        json["component"] = true.into();
        // The view also counts instances shown inside other instances.
        json["instanceCount"] = doc
            .instances_of(&node.id)
            .filter(|i| !finite_design::components::is_virtual(i))
            .count()
            .into();
    }
    if let Some(component) = &node.instance_of {
        json["instanceOf"] = component.clone().into();
        if !node.overrides.is_empty() {
            json["overrides"] = serde_json::to_value(&node.overrides).expect("strings serialize");
        }
    }
    if let Some((instance, _)) = finite_design::components::split(id) {
        json["insideInstance"] = instance.into();
    }
    json
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
/// Comments as agents read them. `me` is the reading agent, so each comment
/// can say who it's for.
pub(super) fn comments_json<'a>(
    design: &Design,
    me: &str,
    listening: &dyn Fn(&str, &Comment) -> bool,
    comments: impl Iterator<Item = &'a Comment>,
) -> Vec<serde_json::Value> {
    let doc = design.view();
    comments
        .map(|c| {
            let artboard = c.artboard_id.as_deref().and_then(|id| doc.get(id));
            // The outline line for an element, like `button "CTA" #ab12 "Sign up"`.
            let line = |id: &str| {
                doc.contains(id)
                    .then(|| outline(doc, id, 0).lines().next().unwrap_or("").to_owned())
            };
            let node = c.node_id.as_deref().and_then(line);
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
                    let mut message = serde_json::json!({
                        "author": m.author.name,
                        "from": m.author.kind,
                        "message": m.body,
                        "at": m.at,
                        "changes": m.changes.iter().map(|c| &c.label).collect::<Vec<_>>(),
                    });
                    if m.edited_at.is_some() {
                        message["edited"] = true.into();
                    }
                    message
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
            let mut comment = serde_json::json!({
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
            });
            // The other elements the user selected, without their HTML: a
            // selection can hold 50.
            let also: Vec<_> = c
                .extra_node_ids
                .iter()
                .filter_map(|id| {
                    line(id).map(|node| serde_json::json!({ "nodeId": id, "node": node }))
                })
                .collect();
            if !also.is_empty() {
                comment["alsoSelected"] = also.into();
            }
            // Left out when it goes to whichever agent asks first.
            let audience = match (&c.audience, design.routed_to(c, |id| listening(id, c))) {
                (Audience::People, _) => Some("people".to_owned()),
                (_, Some(to)) if to == me => Some("you".to_owned()),
                (_, Some(to)) => Some(format!("{} (another agent)", c.agent_name(to))),
                (_, None) => None,
            };
            if let Some(audience) = audience {
                comment["for"] = audience.into();
            }
            if !c.passed_by.is_empty() {
                let names: Vec<_> = c.passed_by.iter().map(|a| a.name.as_str()).collect();
                comment["passedBy"] = names.into();
            }
            comment
        })
        .collect()
}

/// What a screenshot shows, after its image: where it is in the artboard,
/// and anything the agent should know about it.
pub(super) fn shot(image: &crate::screenshot::Image) -> String {
    let px = |v: f64| format!("{}", (v * 10.0).round() / 10.0);
    let a = &image.area;
    let b = &image.bounds;
    // The shot is snapped out to whole pixels, so each of its edges is under
    // one from the box's; that isn't worth a second set of numbers.
    let same = (a.x - b.x).abs() < 1.0
        && (a.y - b.y).abs() < 1.0
        && ((a.x + a.width) - (b.x + b.width)).abs() < 1.0
        && ((a.y + a.height) - (b.y + b.height)).abs() < 1.0;
    let mut out = if image.node == image.artboard {
        format!("Artboard #{}", image.artboard)
    } else {
        format!("#{} in artboard #{}", image.node, image.artboard)
    };
    if same {
        let _ = write!(
            out,
            ": shows the node's box, {}×{} at ({}, {}). {}×{} pixels.",
            px(b.width),
            px(b.height),
            px(b.x),
            px(b.y),
            image.pixel_width,
            image.pixel_height,
        );
    } else {
        let _ = write!(
            out,
            ": shows {}×{} at ({}, {}); the node's box is {}×{} at ({}, {}). {}×{} pixels.",
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
    }
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
    out
}

/// Which of `images` have scripts or animations, and how long they ran
/// before capture. Every image waits the same, so a call says it once.
pub(super) fn settled_note<'a>(
    images: impl Iterator<Item = &'a crate::screenshot::Image>,
) -> Option<String> {
    let mut settled = None;
    let mut nodes = Vec::new();
    for image in images {
        if let Some(wait) = image.settled {
            settled = Some(wait);
            nodes.push(image.node.as_str());
        }
    }
    let wait = settled?;
    Some(format!(
        "{} {} scripts or animations, so {} captured {:.1}s after load.",
        some_ids(&nodes, 3),
        if nodes.len() == 1 { "has" } else { "have" },
        if nodes.len() == 1 {
            "it was"
        } else {
            "they were"
        },
        wait.as_secs_f64()
    ))
}

/// The subtree at `root` as an outline with where each element rendered,
/// relative to its artboard, then what the layout check found in it:
/// content cut off by the artboard's edge, text overflowing its box, and
/// text overlapping other text.
pub(super) fn rendered_outline(
    doc: &Document,
    root: &str,
    max_depth: usize,
    boxes: &[crate::screenshot::ElementBox],
    surface: super::Surface,
) -> String {
    use std::collections::HashMap;
    let by_id: HashMap<&str, &crate::screenshot::ElementBox> =
        boxes.iter().map(|b| (b.id.as_str(), b)).collect();
    let Some(board) = boxes.first() else {
        return "The page couldn't be measured.".into();
    };
    let mut out = String::new();
    let mut ids = Vec::new();
    rendered_into(doc, root, 0, max_depth, &by_id, board, &mut out, &mut ids);

    let mut notes = Vec::new();
    // Cut-off content and spilling text, for the elements shown.
    let shown: std::collections::HashSet<&str> = ids.iter().map(String::as_str).collect();
    let in_scope: Vec<crate::screenshot::ElementBox> = boxes
        .iter()
        .filter(|b| {
            b.id == board.id || shown.contains(b.id.as_str()) || doc.is_ancestor(root, &b.id)
        })
        .cloned()
        .collect();
    let checked = layout_notes(doc, &board.id, &in_scope, surface);
    if !checked.starts_with("Layout: nothing is cut off") {
        notes.push(checked);
    }
    notes.extend(overlap_note(doc, board, &in_scope));
    if notes.is_empty() {
        out.push_str("Layout: nothing is cut off, no text overflows its box, and no text overlaps other text.\n");
    } else {
        out.push_str(&notes.join("\n"));
        out.push('\n');
    }
    out
}

#[allow(clippy::too_many_arguments)]
fn rendered_into(
    doc: &Document,
    id: &str,
    depth: usize,
    max_depth: usize,
    boxes: &std::collections::HashMap<&str, &crate::screenshot::ElementBox>,
    board: &crate::screenshot::ElementBox,
    out: &mut String,
    ids: &mut Vec<String>,
) {
    let Some(node) = doc.get(id) else { return };
    let NodeKind::Element { tag } = &node.kind else {
        return;
    };
    ids.push(id.to_owned());
    let pad = "  ".repeat(depth);
    let _ = write!(out, "{pad}{tag}");
    if let Some(name) = &node.name {
        let _ = write!(out, " {name:?}");
    }
    let _ = write!(out, " #{}", node.id);
    let children = doc.children(Some(id));
    let own_text: String = children
        .iter()
        .filter(|c| c.kind == NodeKind::Text)
        .filter_map(|c| c.text.as_deref())
        .collect::<String>();
    let own_text = own_text.trim();
    if !own_text.is_empty() && !RAW_TEXT.contains(&tag.to_ascii_lowercase().as_str()) {
        let mut snippet: String = own_text.chars().take(40).collect();
        if snippet.len() < own_text.len() {
            snippet.push('…');
        }
        let _ = write!(out, " {snippet:?}");
    }
    match boxes.get(id) {
        Some(b) => {
            let _ = write!(
                out,
                " @ {:.0},{:.0} {:.0}×{:.0}",
                b.x - board.x,
                b.y - board.y,
                b.width,
                b.height
            );
            // A block's text can sit in a small part of its box, so say
            // where the text itself is when it's much smaller.
            if let Some(t) = b.text
                && (t.width < b.width * 0.8 || t.height < b.height * 0.6)
            {
                let _ = write!(
                    out,
                    " (text @ {:.0},{:.0} {:.0}×{:.0})",
                    t.x - board.x,
                    t.y - board.y,
                    t.width,
                    t.height
                );
            }
        }
        None if RAW_TEXT.contains(&tag.to_ascii_lowercase().as_str()) => {}
        None => out.push_str(" (not rendered: hidden or empty)"),
    }
    let elements: Vec<_> = children
        .iter()
        .filter(|c| c.kind != NodeKind::Text)
        .collect();
    if elements.is_empty() {
        out.push('\n');
    } else if depth >= max_depth {
        let _ = writeln!(out, " … {} children", elements.len());
    } else {
        out.push('\n');
        for child in elements {
            rendered_into(doc, &child.id, depth + 1, max_depth, boxes, board, out, ids);
        }
    }
}

/// Elements whose content is code, not text.
const RAW_TEXT: &[&str] = &["style", "script"];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::screenshot::{Image, Overflow, Rect};
    use std::time::Duration;

    fn image(node: &str, artboard: &str, settled: Option<u64>) -> Image {
        let rect = Rect::new(0.0, 0.0, 100.0, 50.0);
        Image {
            data: Vec::new(),
            mime: "image/png",
            node: node.into(),
            artboard: artboard.into(),
            element: node.into(),
            area: rect,
            bounds: rect,
            pixel_width: 100,
            pixel_height: 50,
            scale: 1.0,
            requested_scale: 1.0,
            cut_off: false,
            overflow: Overflow::default(),
            overflow_shown: false,
            settled: settled.map(Duration::from_secs),
            boxes: None,
        }
    }

    #[test]
    fn a_shot_snapped_to_whole_pixels_does_not_report_a_second_box() {
        let shot_of = |area, bounds| {
            shot(&Image {
                area,
                bounds,
                ..image("n", "a", None)
            })
        };
        let snapped = shot_of(
            Rect::new(0.0, 0.0, 390.0, 338.0),
            Rect::new(0.0, 0.4, 390.0, 337.0),
        );
        assert!(
            snapped.contains("shows the node's box, 390×337"),
            "{snapped}"
        );
        assert!(!snapped.contains("the node's box is"), "{snapped}");
        let moved = shot_of(
            Rect::new(0.0, 0.0, 390.0, 338.0),
            Rect::new(0.0, 0.0, 390.0, 300.0),
        );
        assert!(moved.contains("the node's box is 390×300"), "{moved}");
    }

    #[test]
    fn a_shot_of_the_artboard_does_not_name_it_twice() {
        assert!(shot(&image("ab", "ab", None)).starts_with("Artboard #ab: shows"));
        assert!(shot(&image("n1", "ab", None)).starts_with("#n1 in artboard #ab: shows"));
        assert!(!shot(&image("ab", "ab", Some(3))).contains("scripts"));
    }

    #[test]
    fn the_wait_for_scripts_is_said_once_per_call() {
        let images = [
            image("a", "a", Some(3)),
            image("b", "b", None),
            image("c", "c", Some(3)),
        ];
        assert_eq!(
            settled_note(images.iter()).unwrap(),
            "#a, #c have scripts or animations, so they were captured 3.0s after load."
        );
        assert_eq!(settled_note(images[1..2].iter()), None);
    }

    #[test]
    fn some_ids_names_the_first_few_and_counts_the_rest() {
        let ids: Vec<String> = (1..=11).map(|i| format!("n{i}")).collect();
        assert_eq!(some_ids(&ids, 3), "#n1, #n2, #n3, … +8");
        assert_eq!(some_ids(&ids[..2], 3), "#n1, #n2");
        assert_eq!(some_ids::<&str>(&[], 3), "");
    }
}
