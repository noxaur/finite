//! The `read` tool's views of a design: the overview, and for what a
//! selector matches, its outline, HTML, CSS or JSX, or a search inside it.

use std::{collections::HashMap, sync::Arc};

use finite_design::{
    Design, Document, NodeId, css, html,
    search::{self, Query},
    select,
};
use finite_transfer::jsx;
use rmcp::handler::server::wrapper::Parameters;

use super::{ReadParams, describe, label, line, matched, ops::Kind, page_id, selector_text};
use crate::{
    hub::{Actor, DesignHandle},
    mcp::{
        FiniteMcp, ToolResult, cut, fail, format::OUTPUT_LIMIT, html_component_note, ok, outline,
        params::ExportParams, search::found_text, tokens::listed,
    },
};

/// How many matches a view shows before it asks to narrow select.
const SHOWN: usize = 20;

pub(super) async fn read(
    mcp: &FiniteMcp,
    handle: &Arc<DesignHandle>,
    actor: &Actor,
    p: ReadParams,
) -> ToolResult {
    let view = p.view.as_deref().map(|v| v.trim().to_ascii_lowercase());
    let found = handle.read(|d| -> Result<(Option<String>, Option<Vec<NodeId>>), String> {
        let doc = d.view();
        let page = p
            .page
            .as_deref()
            .map(|page| page_id(doc, page, &HashMap::new()))
            .transpose()?;
        let Some(select) = &p.select else {
            return Ok((page, None));
        };
        let selector = selector_text(&select.value(), &HashMap::new())?;
        let ids = matched(doc, &selector, page.as_deref())?;
        if ids.is_empty() {
            return Err(format!(
                "{selector:?} matches no element{}. read with no select shows the outline with every id.",
                p.page
                    .as_deref()
                    .map(|n| format!(" on page {n:?}"))
                    .unwrap_or_default()
            ));
        }
        Ok((page, Some(ids)))
    });
    let (page, ids) = match found {
        Ok(found) => found,
        Err(error) => return fail(error),
    };
    if let Some(format) = &p.export {
        return export(mcp, handle, &p.design_id, format, ids.as_deref()).await;
    }
    if view.as_deref() == Some("jsx") {
        let Some(ids) = ids else {
            return fail(
                "as: \"jsx\" needs select, like {\"select\": \"#k3x9a2bq\", \"as\": \"jsx\"}.",
            );
        };
        return ok(handle.read(|d| jsx_view(d.view(), &ids, p.tailwind)));
    }
    if let Some(needle) = p.contains.as_deref().filter(|c| !c.is_empty()) {
        return ok(handle.read(|d| contains(d.view(), needle, ids.as_deref(), page.as_deref())));
    }
    match (view.as_deref(), ids) {
        (Some("css"), ids) => ok(handle.read(|d| css_view(d.view(), ids.as_deref()))),
        (Some("html"), None) => fail(
            "as: \"html\" needs select, like {\"select\": \":root\", \"as\": \"html\"} for every artboard.",
        ),
        (_, None) => {
            let presence = handle.presence();
            ok(handle.with_routes(|d, listening| {
                overview(d, listening, &presence, actor, page.as_deref(), p.depth)
            }))
        }
        (Some("html"), Some(ids)) => ok(handle.read(|d| html_view(d, &ids, p.depth, p.offset))),
        (Some("outline") | None, Some(ids)) => {
            ok(handle.read(|d| outline_view(d.view(), &ids, p.depth)))
        }
        (Some(other), _) => fail(format!(
            "as {other:?} isn't one of outline (default), html, css or jsx."
        )),
    }
}

/// The comment before each match when there are several, naming its artboard.
fn heading(doc: &Document, ids: &[NodeId], i: usize) -> String {
    if ids.len() < 2 {
        return String::new();
    }
    let id = &ids[i];
    let board = doc
        .artboard_of(id)
        .filter(|b| b.id != *id)
        .map(|b| format!(" · artboard {:?} #{}", b.display_name(), b.id))
        .unwrap_or_default();
    format!("<!-- {} of {}{board} -->\n", i + 1, ids.len())
}

/// The note after a view that showed only the first [`SHOWN`] matches.
fn more(ids: &[NodeId]) -> String {
    if ids.len() > SHOWN {
        format!(
            "\nShowing {SHOWN} of {} matches. Narrow select for the rest.",
            ids.len()
        )
    } else {
        String::new()
    }
}

fn overview(
    design: &Design,
    listening: &dyn Fn(&str, &finite_design::comment::Comment) -> bool,
    presence: &[crate::hub::Presence],
    me: &Actor,
    page: Option<&str>,
    depth: Option<usize>,
) -> String {
    let doc = design.view();
    let count = |n: usize, what: &str| format!("{n} {what}{}", if n == 1 { "" } else { "s" });
    let boards = doc.artboards();
    let open = design.comments().iter().filter(|c| !c.resolved).count();
    let mine = design
        .comments()
        .iter()
        .filter(|c| design.awaits(c, &me.id, |id| listening(id, c)))
        .count();
    let comments = match open {
        0 => count(open, "open comment"),
        _ => format!("{} ({mine} waiting for you)", count(open, "open comment")),
    };
    let mut lines = vec![format!(
        "Design {:?} (designId {:?}): {}, {}, {comments}, {}.",
        design.meta.name,
        design.meta.id,
        count(boards.len(), "artboard"),
        count(doc.len(), "node"),
        count(doc.tokens().len(), "token"),
    )];
    let pages = doc.pages();
    if pages.len() > 1 || page.is_some() {
        let listed: Vec<String> = pages
            .iter()
            .map(|(id, p)| {
                format!(
                    "{:?} ({id}, {})",
                    p.name,
                    count(doc.artboards_on(id).len(), "artboard")
                )
            })
            .collect();
        lines.push(format!("Pages: {}.", listed.join(", ")));
    }
    for other in presence.iter().filter(|p| p.actor != me.id) {
        let nodes: Vec<String> = other.node_ids.iter().map(|id| format!("#{id}")).collect();
        lines.push(format!(
            "{} is working on {}{}. Edits never wait for each other, and rewriting html you read keeps values others changed since.",
            other.name,
            nodes.join(", "),
            other
                .status
                .as_deref()
                .map(|s| format!(": {s:?}"))
                .unwrap_or_default()
        ));
    }
    match mine {
        0 => {}
        1 => lines.push("1 comment is waiting for you: call comments to read it.".into()),
        n => lines.push(format!(
            "{n} comments are waiting for you: call comments to read them."
        )),
    }
    if let Some(list) = components_line(design.doc()) {
        lines.push(list);
    }
    if boards.is_empty() {
        lines.push(format!(
            "No artboards yet. Add one with edit: {}",
            Kind::Artboard.example()
        ));
        return lines.join("\n");
    }
    let depth = depth.unwrap_or(4);
    let mut text = lines.join("\n");
    text.push_str("\n\n");
    if pages.len() > 1 || page.is_some() {
        for (id, p) in pages
            .iter()
            .filter(|(id, _)| page.is_none_or(|page| page == *id))
        {
            let on = doc.artboards_on(id);
            text.push_str(&format!("Page {:?}:\n", p.name));
            if on.is_empty() {
                text.push_str("(no artboards)\n");
            }
            for board in on {
                text.push_str(&outline(doc, &board.id, depth));
            }
            text.push('\n');
        }
    } else {
        for board in boards {
            text.push_str(&outline(doc, &board.id, depth));
        }
    }
    cut(
        text,
        "read with select on one artboard, or a smaller depth, shows the rest.",
    )
}

/// The design's components, with how many instances each has, for the
/// overview. `None` when it has none.
fn components_line(doc: &Document) -> Option<String> {
    const LISTED: usize = 20;
    let mut found: Vec<_> = doc.nodes().filter(|n| n.component).collect();
    if found.is_empty() {
        return None;
    }
    found.sort_by(|a, b| {
        a.display_name()
            .cmp(&b.display_name())
            .then(a.id.cmp(&b.id))
    });
    let total = found.len();
    let mut listed: Vec<String> = found
        .into_iter()
        .take(LISTED)
        .map(|c| {
            let n = doc.instances_of(&c.id).count();
            format!(
                "{:?} #{} ({n} instance{})",
                c.display_name(),
                c.id,
                if n == 1 { "" } else { "s" }
            )
        })
        .collect();
    if total > LISTED {
        listed.push(format!("and {} more", total - LISTED));
    }
    Some(format!(
        "Components: {}. Edit a component to change its instances; <div data-instance-of=\"id\"></div> in html adds one.",
        listed.join(", ")
    ))
}

fn outline_view(doc: &Document, ids: &[NodeId], depth: Option<usize>) -> String {
    let depth = depth.unwrap_or(4);
    let mut text = String::new();
    for (i, id) in ids.iter().take(SHOWN).enumerate() {
        if i > 0 {
            text.push('\n');
        }
        text.push_str(&heading(doc, ids, i));
        text.push_str(&outline(doc, id, depth));
    }
    text.push_str(&more(ids));
    cut(
        text,
        "Pass select for one part, or a smaller depth, to see the rest.",
    )
}

fn html_view(design: &Design, ids: &[NodeId], depth: Option<usize>, offset: usize) -> String {
    let doc = design.view();
    let shown = ids.len().min(SHOWN);
    let limit = OUTPUT_LIMIT / shown.max(1);
    let mut parts = Vec::new();
    for (i, id) in ids.iter().take(SHOWN).enumerate() {
        let mut text = heading(doc, ids, i);
        text.push_str(&html_of(design, id, depth, offset, limit));
        parts.push(text.trim_end().to_owned());
    }
    let mut text = parts.join("\n\n");
    text.push_str(&more(ids));
    text
}

/// The longest `<style>` or `<script>` code read shows inside an element's
/// HTML. A page's stylesheet can be most of an artboard's HTML, and reading
/// the element on its own shows all of it.
const CODE_SHOWN: usize = 2_000;

/// One node's HTML, as an html op takes it back, cut to fit `limit`.
fn html_of(design: &Design, id: &str, depth: Option<usize>, offset: usize, limit: usize) -> String {
    let doc = design.view();
    if let Some(page) = code_page(doc, id, offset, limit) {
        return page;
    }
    let options = html::ExportOptions {
        ids: true,
        styles: true,
        depth,
        max_code_len: (!doc.get(id).and_then(|n| n.tag()).is_some_and(|tag| {
            tag.eq_ignore_ascii_case("style") || tag.eq_ignore_ascii_case("script")
        }))
        .then_some(CODE_SHOWN),
        read_at: Some(design.seq()),
        ..Default::default()
    };
    let Some((export, used)) = html::export_within(doc, id, &options, limit) else {
        return format!("node {id:?} not found");
    };
    let children = doc.children(Some(id));
    if export.html.len() > limit && children.is_empty() {
        // Long attribute values, like an image's inline data: cutting them
        // here would lose them if the HTML were written back.
        return format!(
            "{}'s HTML is {} characters, more than a result holds, and it has no children: its attribute values are long.",
            label(doc, id),
            export.html.len()
        );
    }
    let lowered = used != depth;
    if export.html.len() > limit || (lowered && used == Some(0)) {
        return format!(
            "{}'s HTML is more than a result holds. Read one of its children with select and as: \"html\":\n{}",
            label(doc, id),
            outline(doc, id, 1).trim_end()
        );
    }
    let mut out = export.html;
    if export.collapsed > 0 {
        let levels = used.unwrap_or(0);
        let reason = if lowered {
            "The HTML asked for is more than a result holds, so this"
        } else {
            "This"
        };
        out.push_str(&format!(
            "\n{reason} shows {levels} level{} below the node. {} element{} marked \"not shown\" {}: read with select on {} data-id and as: \"html\".",
            if levels == 1 { "" } else { "s" },
            export.collapsed,
            if export.collapsed == 1 { "" } else { "s" },
            if export.collapsed == 1 { "holds more" } else { "hold more" },
            if export.collapsed == 1 { "its" } else { "their" },
        ));
    }
    if export.shortened > 0 {
        out.push_str(&format!(
            "\n{} value{} cut short, ending in …. Don't write this HTML back as it is.",
            export.shortened,
            if export.shortened == 1 {
                " was"
            } else {
                "s were"
            },
        ));
    }
    if export.hidden_code > 0 {
        out.push_str(&format!(
            "\n{} <style> or <script> {} replaced by a comment saying how to read {}. Don't write this HTML back as it is.",
            export.hidden_code,
            if export.hidden_code == 1 {
                "body was"
            } else {
                "bodies were"
            },
            if export.hidden_code == 1 { "it" } else { "them" },
        ));
    }
    if let Some(note) = html_component_note(design, id, &out) {
        out.push('\n');
        out.push_str(&note);
    }
    if export.stylesheets > 0 {
        out.push_str(&format!(
            "\nThe first {} <style> element{} {} from elsewhere in the artboard, not inside this node.",
            export.stylesheets,
            if export.stylesheets == 1 { "" } else { "s" },
            if export.stylesheets == 1 { "is" } else { "are" },
        ));
    }
    out
}

/// A `<style>` or `<script>` whose code is more than a result holds (or any
/// of it from `offset` on), as the characters that fit and the offset of the
/// rest. `None` when the element isn't one, or all its code fits.
fn code_page(doc: &Document, id: &str, offset: usize, limit: usize) -> Option<String> {
    /// Room for the heading line and the element's tag.
    const HEADING: usize = 300;
    let node = doc.get(id)?;
    let tag = node.tag()?;
    if !(tag.eq_ignore_ascii_case("style") || tag.eq_ignore_ascii_case("script")) {
        return None;
    }
    let code: String = doc
        .children(Some(id))
        .iter()
        .filter_map(|c| c.text.as_deref())
        .collect();
    let total = code.chars().count();
    if offset == 0 && code.len() + HEADING <= limit {
        return None;
    }
    if offset >= total {
        return Some(format!(
            "{} has {total} characters of code; offset {offset} is past the end.",
            label(doc, id)
        ));
    }
    let start = code
        .char_indices()
        .nth(offset)
        .map_or(code.len(), |(i, _)| i);
    let mut end = code.len().min(start + limit.saturating_sub(HEADING));
    while !code.is_char_boundary(end) {
        end -= 1;
    }
    if end < code.len()
        && let Some(line) = code[start..end].rfind('\n').filter(|&i| i > 0)
    {
        end = start + line + 1;
    }
    let shown_to = offset + code[start..end].chars().count();
    let next = if shown_to < total {
        format!(" Read the rest with offset: {shown_to}.")
    } else {
        String::new()
    };
    // The marker right after the code keeps its trailing whitespace, which
    // the result would otherwise trim, so the pieces join back exactly.
    let end_mark = if shown_to < total {
        format!("⟨piece ends; offset {shown_to} continues⟩")
    } else {
        "⟨code ends⟩".to_owned()
    };
    Some(format!(
        "{}'s code is {total} characters, more than a result holds, so this is a piece of it, not HTML to write back. Showing characters {offset} to {shown_to}, up to the ⟨…⟩ mark.{next}\n{}{end_mark}",
        label(doc, id),
        &code[start..end]
    ))
}

/// The `<style>` elements in `board`, with their CSS.
fn sheets<'a>(doc: &'a Document, board: &str) -> Vec<(&'a str, String)> {
    doc.subtree(board)
        .into_iter()
        .filter(|n| n.tag().is_some_and(|t| t.eq_ignore_ascii_case("style")))
        .map(|n| {
            let css: String = doc
                .children(Some(&n.id))
                .iter()
                .filter_map(|c| c.text.as_deref())
                .collect();
            (n.id.as_str(), css)
        })
        .collect()
}

fn css_view(doc: &Document, ids: Option<&[NodeId]>) -> String {
    let Some(ids) = ids else {
        let tokens = listed(doc);
        let mut text = if doc.tokens().is_empty() {
            format!(
                "This design has no tokens. Add some with {}.",
                Kind::Tokens.example()
            )
        } else {
            format!(
                "Tokens (CSS variables every artboard can use as var(--name)), as a tokens op takes them:\n{}",
                serde_json::to_string_pretty(&tokens).expect("json values serialize")
            )
        };
        let mut blocks = Vec::new();
        for board in doc.artboards() {
            for (id, css) in sheets(doc, &board.id) {
                let rules = css::sheet_rules(&css).len();
                blocks.push(format!(
                    "  <style> #{id} in {:?} #{}: {rules} rule{}",
                    board.display_name(),
                    board.id,
                    if rules == 1 { "" } else { "s" }
                ));
            }
        }
        text.push_str("\n\n");
        if blocks.is_empty() {
            text.push_str("No <style> blocks.");
        } else {
            text.push_str("<style> blocks (read one with select and as: \"html\"):\n");
            text.push_str(&blocks.join("\n"));
        }
        return cut(
            text,
            "read with select and as: \"css\" shows one element's CSS.",
        );
    };
    let matcher = select::Matcher::new(doc, select::Scope::Design);
    // Each artboard's rules, with the elements each one matches.
    let mut by_board: HashMap<String, Vec<(String, css::SheetRule, Vec<NodeId>)>> = HashMap::new();
    let mut parts = Vec::new();
    for id in ids.iter().take(SHOWN) {
        let Some(node) = doc.get(id) else { continue };
        let mut lines = vec![line(doc, id)];
        let inline = html::style_string(&node.styles);
        lines.push(format!(
            "  inline: {}",
            if inline.is_empty() { "(none)" } else { &inline }
        ));
        // A <style> element shows the rules it holds.
        if node.tag().is_some_and(|t| t.eq_ignore_ascii_case("style")) {
            let css: String = doc
                .children(Some(id))
                .iter()
                .filter_map(|c| c.text.as_deref())
                .collect();
            for rule in css::sheet_rules(&css) {
                let mut context = rule.context.join(" ");
                if !context.is_empty() {
                    context.push(' ');
                }
                lines.push(format!("  rule: {context}{}", rule.text));
            }
            parts.push(lines.join("\n"));
            continue;
        }
        if let Some(board) = doc.artboard_of(id) {
            let rules = by_board.entry(board.id.clone()).or_insert_with(|| {
                sheets(doc, &board.id)
                    .into_iter()
                    .flat_map(|(sheet, css)| {
                        css::sheet_rules(&css)
                            .into_iter()
                            .map(move |rule| (sheet.to_owned(), rule))
                    })
                    .map(|(sheet, rule)| {
                        let hits = select::parse_loose(&rule.selector)
                            .map(|list| matcher.select(&list))
                            .unwrap_or_default();
                        (sheet, rule, hits)
                    })
                    .collect()
            });
            for (sheet, rule, hits) in rules.iter() {
                if hits.contains(id) {
                    let mut context = rule.context.join(" ");
                    if !context.is_empty() {
                        context.push(' ');
                    }
                    lines.push(format!("  <style> #{sheet}: {context}{}", rule.text));
                }
            }
        }
        if !node.styles.is_empty() {
            let names: Vec<&str> = node.styles.keys().map(String::as_str).collect();
            lines.push(format!(
                "  Inline styles beat sheet rules for: {}.",
                names.join(", ")
            ));
        }
        parts.push(lines.join("\n"));
    }
    let mut text = parts.join("\n\n");
    text.push_str(&more(ids));
    cut(text, "Narrow select for the rest.")
}

fn jsx_view(doc: &Document, ids: &[NodeId], tailwind: bool) -> String {
    const JSX_SHOWN: usize = 10;
    let options = jsx::Options { tailwind };
    let mut parts = Vec::new();
    for id in ids.iter().take(JSX_SHOWN) {
        let Some(converted) = jsx::convert(doc, id, &options, 0) else {
            continue;
        };
        if converted.jsx.len() > OUTPUT_LIMIT / ids.len().min(JSX_SHOWN) {
            parts.push(format!(
                "{}'s JSX is {} characters, more than a result holds. Read one of its children with select and as: \"jsx\":\n{}",
                label(doc, id),
                converted.jsx.len(),
                outline(doc, id, 1).trim_end()
            ));
            continue;
        }
        let mut text = converted.jsx;
        for d in &converted.diagnostics {
            text.push_str(&format!(
                "\nLeft out {} at #{}: {}.",
                d.what,
                d.node.as_deref().unwrap_or(""),
                d.reason
            ));
        }
        parts.push(text);
    }
    if ids.len() > JSX_SHOWN {
        parts.push(format!(
            "Showing {JSX_SHOWN} of {} matches. Narrow select.",
            ids.len()
        ));
    }
    if !doc.tokens().is_empty() {
        parts.push(format!(
            "This design also has {} tokens that its var(--…) values read; read with as: \"css\" lists them. Copy them too if you use this outside this design.",
            doc.tokens().len()
        ));
    }
    cut(parts.join("\n\n"), "Narrow select for the rest.")
}

fn contains(doc: &Document, needle: &str, ids: Option<&[NodeId]>, page: Option<&str>) -> String {
    let on_page: Vec<NodeId>;
    let scopes: Vec<Option<&str>> = match (ids, page) {
        (Some(ids), _) => ids.iter().map(|id| Some(id.as_str())).collect(),
        (None, Some(page)) => {
            on_page = doc
                .artboards_on(page)
                .iter()
                .map(|b| b.id.clone())
                .collect();
            on_page.iter().map(|id| Some(id.as_str())).collect()
        }
        (None, None) => vec![None],
    };
    let mut sections = Vec::new();
    let n = || Some(needle.to_owned());
    let queries = [
        (
            "styles (inline and <style> blocks)",
            Query {
                style: n(),
                ..Default::default()
            },
        ),
        (
            "text",
            Query {
                text: n(),
                ..Default::default()
            },
        ),
        (
            "attributes",
            Query {
                attribute: n(),
                ..Default::default()
            },
        ),
        (
            "layer names",
            Query {
                name: n(),
                ..Default::default()
            },
        ),
    ];
    for (what, query) in queries {
        let mut found = Vec::new();
        for scope in &scopes {
            found.extend(search::find(doc, *scope, &query));
        }
        if !found.is_empty() {
            sections.push(format!("In {what}: {}", found_text(doc, &found).trim_end()));
        }
    }
    let tokens = if ids.is_none() && page.is_none() {
        search::find_in_tokens(doc, needle)
    } else {
        Vec::new()
    };
    if !tokens.is_empty() {
        sections.push(format!("In tokens:\n  {}", tokens.join("\n  ")));
    }
    if sections.is_empty() {
        let (place, tokens) = match (ids, page) {
            (Some(_), _) => ("in the selection", ""),
            (None, Some(_)) => ("on that page", ""),
            (None, None) => ("in the design", " or tokens"),
        };
        return format!(
            "Nothing {place} contains {needle:?}: not in styles, <style> blocks, text, attributes, layer names{tokens}."
        );
    }
    cut(
        sections.join("\n\n"),
        "Narrow it with select, or a longer contains.",
    )
}

async fn export(
    mcp: &FiniteMcp,
    handle: &DesignHandle,
    design: &str,
    format: &str,
    ids: Option<&[NodeId]>,
) -> ToolResult {
    let boards: Vec<NodeId> = handle.read(|d| {
        let doc = d.view();
        let mut boards: Vec<NodeId> = Vec::new();
        for id in ids.unwrap_or_default() {
            if let Some(board) = doc.artboard_of(id)
                && !boards.contains(&board.id)
            {
                boards.push(board.id.clone());
            }
        }
        boards
    });
    if boards.len() > 1 {
        let shown = handle.read(|d| describe(d.view(), &boards));
        return fail(format!(
            "export takes the whole design, or one artboard; select is on {} artboards ({shown}). Pass one artboard, or no select.",
            boards.len()
        ));
    }
    if format.trim().eq_ignore_ascii_case("jsx") && boards.is_empty() {
        return fail("export \"jsx\" takes one artboard: pass select, like \"#k3x9a2bq\".");
    }
    mcp.export_design(Parameters(ExportParams {
        design_id: design.to_owned(),
        format: format.to_owned(),
        artboard_id: boards.first().cloned(),
    }))
    .await
}
