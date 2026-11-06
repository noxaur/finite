//! Finding nodes by what they contain, and replacing a value everywhere it's
//! used. Agents asked for both: to recolor a design they read every
//! artboard's HTML and picked out each use of a color by eye, and nothing
//! told them whether they had found them all.

use std::collections::BTreeMap;

use crate::{
    Document, Node, NodeId, NodeKind, Op, PropKey,
    edit::{EditError, normalize_style_name},
    html,
};

/// What to look for. Every filter that's set must match.
#[derive(Clone, Debug, Default)]
pub struct Query {
    /// Visible text the element contains, ignoring case. Text inside
    /// `<script>` and `<style>` (including an SVG `<style>`) is code, so it
    /// doesn't match; a style search still finds it.
    pub text: Option<String>,
    /// Part of the layer name, ignoring case.
    pub name: Option<String>,
    /// The tag, like `button`.
    pub tag: Option<String>,
    /// Part of a style declaration, like `#3b82f6`, `border-radius` or
    /// `display: grid`, ignoring case. Also matches the code in `<style>` and
    /// `<script>` blocks, including an SVG `<style>`.
    pub style: Option<String>,
    /// Part of an attribute, like `href` or `src="https://`, ignoring case.
    pub attribute: Option<String>,
}

/// A node that matched, and the declarations or attributes that did.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub id: NodeId,
    pub details: Vec<String>,
}

/// The nodes under `within` (or in every artboard) that match `query`, in
/// document order. A text match names the element holding the text. Text
/// inside `<script>` and `<style>` doesn't match.
pub fn find(doc: &Document, within: Option<&str>, query: &Query) -> Vec<Found> {
    let lower = |s: &Option<String>| s.as_ref().map(|s| s.to_lowercase());
    let (text, name, tag, style, attribute) = (
        lower(&query.text),
        lower(&query.name),
        lower(&query.tag),
        lower(&query.style),
        lower(&query.attribute),
    );
    let mut found = Vec::new();
    for node in scope(doc, within) {
        let NodeKind::Element { tag: node_tag } = &node.kind else {
            continue;
        };
        let mut details = Vec::new();
        if let Some(tag) = &tag
            && node_tag.to_lowercase() != *tag
        {
            continue;
        }
        if let Some(name) = &name
            && !node
                .name
                .as_deref()
                .unwrap_or("")
                .to_lowercase()
                .contains(name)
        {
            continue;
        }
        if let Some(text) = &text {
            // Script and style bodies are code, reached by a style search.
            if in_raw_text(doc, node) {
                continue;
            }
            let own = own_text(doc, node);
            if !own.to_lowercase().contains(text) {
                continue;
            }
        }
        if let Some(style) = &style {
            // A color matches in any notation, as in `replace`.
            let color = parse_color(style);
            let matches = |d: &str| match color {
                Some(c) => replace_color(d, c, c).1 > 0,
                None => d.to_lowercase().contains(style),
            };
            let mut hits: Vec<String> = node
                .styles
                .iter()
                .map(|(k, v)| format!("{k}: {v}"))
                .filter(|d| matches(d))
                .collect();
            if is_raw_text(node_tag) {
                let code = own_text(doc, node);
                let script = node_tag.eq_ignore_ascii_case("script");
                let before = hits.len();
                // A script is code, not CSS: match it literally, as a code
                // replace does, so `#abc` in `div#abc` is found.
                if !script {
                    hits.extend(
                        css_lines(&code)
                            .into_iter()
                            .filter(|(_, line)| matches(line))
                            .map(|(_, line)| format!("css: {line}")),
                    );
                }
                // A match that spans `;`, `{` or `}` is in no single line. A
                // color in CSS still needs a whole color, as in `replace`.
                if hits.len() == before && (script || color.is_none()) {
                    let label = if script { "script" } else { "css" };
                    hits.extend(
                        code_matches(&code, style).map(|snippet| format!("{label}: {snippet}")),
                    );
                }
            }
            if hits.is_empty() {
                continue;
            }
            details.extend(hits);
        }
        if let Some(attribute) = &attribute {
            let hits: Vec<String> = node
                .attrs
                .iter()
                .map(|(k, v)| format!("{k}=\"{v}\""))
                .filter(|a| a.to_lowercase().contains(attribute))
                .collect();
            if hits.is_empty() {
                continue;
            }
            details.extend(hits);
        }
        found.push(Found {
            id: node.id.clone(),
            details,
        });
    }
    found
}

/// Where [`replace`] looks.
#[derive(Clone, Copy, Debug)]
pub struct Places {
    pub styles: bool,
    pub attributes: bool,
    /// The code in `<style>` and `<script>` blocks, including an SVG `<style>`.
    pub css: bool,
    /// Visible text. Not the text inside `<script>` or `<style>`.
    pub text: bool,
}

/// One node [`replace`] changed, and how.
#[derive(Clone, Debug, PartialEq)]
pub struct Replaced {
    pub id: NodeId,
    /// Like `background: #3b82f6 → #f97316`.
    pub changes: Vec<String>,
    pub count: usize,
}

/// Replaces `from` with `to` in every place `places` allows, under `within`
/// or in every artboard. When `from` is a color, it matches the color in any
/// notation (`#3B82F6`, `rgb(59 130 246)`) and, when `to` is a color too, also
/// its tints (`#3b82f6cc`, `rgba(59, 130, 246, 0.2)`), keeping each use's
/// transparency; when `to` is text, tints are left alone. Otherwise it matches
/// the exact text, and always does in a `<script>`, where `rgb(59 130 246)` is code.
/// Text inside `<script>` and `<style>` (including an SVG `<style>`) is that code:
/// `places.text` skips it, and `places.css` is what reaches it. A match in a
/// `<script>`, or in a `<style>` when `from` isn't a color, is refused when
/// there's more than one match, unless `all` is set: `300ms` in one rule is
/// rarely meant to change in every rule. Returns the ops and what they change.
pub fn replace(
    doc: &Document,
    within: Option<&str>,
    from: &str,
    to: &str,
    places: Places,
    all: bool,
) -> Result<(Vec<Op>, Vec<Replaced>), EditError> {
    if from.is_empty() {
        return Err(EditError("find can't be empty".into()));
    }
    if let Some(id) = within
        && !doc.contains(id)
    {
        return Err(EditError(format!("node {id:?} not found")));
    }
    let swap = |value: &str| swap(value, from, to);
    let from_is_color = parse_color(from).is_some();
    // Matches the all-or-nothing rule applies to. Script code never counts as
    // color: `rgb(59 130 246)` or `'#abc'` there is code, so it's matched as
    // exact text.
    let mut guarded = 0;
    // How many matches landed in each kind of place, for the refusal.
    let mut kinds: BTreeMap<&str, usize> = BTreeMap::new();
    let mut report = Vec::new();
    let mut ops = Vec::new();
    for node in scope(doc, within) {
        let mut changes = Vec::new();
        let mut count = 0;
        match &node.kind {
            NodeKind::Element { tag } => {
                if places.styles {
                    for (key, value) in &node.styles {
                        let (new, n) = swap(value);
                        if n > 0 && new != *value {
                            count += n;
                            *kinds.entry("inline styles").or_default() += n;
                            changes.push(format!("{key}: {value} → {new}"));
                            ops.push(Op::Set {
                                id: node.id.clone(),
                                key: PropKey::Style(normalize_style_name(key)),
                                value: Some(new.into()),
                            });
                        }
                    }
                }
                if places.attributes {
                    for (key, value) in &node.attrs {
                        let (new, n) = swap(value);
                        if n > 0 && new != *value && html::is_safe_attr(key, &new) {
                            count += n;
                            *kinds.entry("attributes").or_default() += n;
                            changes.push(format!("{key}=\"{value}\" → \"{new}\""));
                            ops.push(Op::Set {
                                id: node.id.clone(),
                                key: PropKey::Attr(key.clone()),
                                value: Some(new.into()),
                            });
                        }
                    }
                }
                if places.css && is_raw_text(tag) {
                    let script = !tag.eq_ignore_ascii_case("style");
                    let label = if script { "script" } else { "css" };
                    let uses_in = |text: &str| {
                        if script {
                            exact_uses(text, from, to)
                        } else {
                            uses(text, from, to)
                        }
                    };
                    for child in doc.children(Some(&node.id)) {
                        let Some(code) = &child.text else { continue };
                        let found = uses_in(code);
                        let (new, n) = (apply(code, &found), found.len());
                        if n > 0 && new != *code {
                            count += n;
                            *kinds
                                .entry(if script {
                                    "<script> code"
                                } else {
                                    "<style> code"
                                })
                                .or_default() += n;
                            if script || !from_is_color {
                                guarded += n;
                            }
                            let mut lines = Vec::new();
                            for (path, line) in css_lines(code) {
                                let found = uses_in(&line);
                                if found.is_empty() {
                                    continue;
                                }
                                // A script's braces aren't rules.
                                let label = if script || path.is_empty() {
                                    label.to_owned()
                                } else {
                                    format!("{label} {path}")
                                };
                                lines.extend(change_lines(&label, &line, &found));
                            }
                            // A find that spans `;`, `{` or `}` isn't inside any
                            // one line, so show it with the code around it.
                            if lines.is_empty() {
                                lines = snippets(code, &uses_in(code))
                                    .map(|(before, after)| format!("{label}: {before} → {after}"))
                                    .collect();
                            }
                            changes.extend(lines);
                            ops.push(Op::Set {
                                id: child.id.clone(),
                                key: PropKey::Text,
                                value: Some(new.into()),
                            });
                        }
                    }
                }
            }
            NodeKind::Text if places.text => {
                if let Some(text) = &node.text
                    && !in_raw_text(doc, node)
                {
                    let (new, n) = swap(text);
                    if n > 0 && new != *text {
                        count += n;
                        *kinds.entry("text").or_default() += n;
                        changes.push(format!("text: {text:?} → {new:?}"));
                        ops.push(Op::Set {
                            id: node.id.clone(),
                            key: PropKey::Text,
                            value: Some(new.into()),
                        });
                    }
                }
            }
            NodeKind::Text => {}
        }
        if count > 0 {
            // Name the element a text change landed in.
            let id = match node.kind {
                NodeKind::Text => node.parent.clone().unwrap_or_else(|| node.id.clone()),
                NodeKind::Element { .. } => node.id.clone(),
            };
            report.push(Replaced { id, changes, count });
        }
    }
    let total: usize = report.iter().map(|r| r.count).sum();
    if guarded > 0 && total > 1 && !all {
        let kinds: Vec<String> = kinds.iter().map(|(k, n)| format!("{k} ×{n}")).collect();
        let nodes: Vec<String> = report
            .iter()
            .take(REFUSAL_NODES)
            .map(|r| {
                let tag = doc.get(&r.id).and_then(|n| n.tag()).unwrap_or("node");
                format!("{tag} #{}", r.id)
            })
            .collect();
        let more = report.len().saturating_sub(REFUSAL_NODES);
        // Copies of one stylesheet make the same change many times over.
        let mut lines: Vec<(&str, usize)> = Vec::new();
        for line in report.iter().flat_map(|r| r.changes.iter()) {
            match lines.iter_mut().find(|(seen, _)| *seen == line.as_str()) {
                Some((_, times)) => *times += 1,
                None => lines.push((line, 1)),
            }
        }
        let hidden = lines.len().saturating_sub(REFUSAL_LINES);
        let mut shown: Vec<String> = lines
            .iter()
            .take(REFUSAL_LINES)
            .map(|(line, times)| match times {
                1 => (*line).to_owned(),
                _ => format!("{line} (×{times})"),
            })
            .collect();
        if hidden > 0 {
            shown.push(format!("… and {hidden} more different changes"));
        }
        return Err(EditError(format!(
            "{from:?} matches {total} times, in {} (on {}{}), and not only in colors, so nothing changed. \
             Narrow it with within or a longer find, or pass all: true to replace every one. \
             It would change:\n  {}",
            kinds.join(", "),
            nodes.join(", "),
            if more > 0 {
                format!(", … +{more}")
            } else {
                String::new()
            },
            shown.join("\n  ")
        )));
    }
    Ok((ops, report))
}

/// `value` with `from` replaced by `to` the way [`replace`] replaces it in
/// styles, and how many uses it replaced. What `from` is decides whether a
/// match is a color, not what it becomes: `#3b82f6` is a brand color even
/// when `to` is `var(--brand)`, so it's matched in any notation and never
/// as a prefix of `#3b82f6cc`'s text.
fn swap(value: &str, from: &str, to: &str) -> (String, usize) {
    let uses = uses(value, from, to);
    (apply(value, &uses), uses.len())
}

/// One place [`replace`] changes text: the byte range in the text, and what
/// replaces it.
type Use = (std::ops::Range<usize>, String);

/// Where [`swap`] replaces `from` with `to` in `value`.
fn uses(value: &str, from: &str, to: &str) -> Vec<Use> {
    match (parse_color(from), parse_color(to)) {
        (Some(f), Some(t)) => color_uses(value, f, true, |alpha| format_color(t.0, alpha.or(t.1))),
        (Some(f), None) => color_uses(value, f, false, |_| to.to_owned()),
        _ => exact_uses(value, from, to),
    }
}

/// Where `from` is, as the exact text, to be replaced by `to`.
fn exact_uses(value: &str, from: &str, to: &str) -> Vec<Use> {
    value
        .match_indices(from)
        .map(|(at, _)| (at..at + from.len(), to.to_owned()))
        .collect()
}

/// `value` with each of `uses`, which are in order, replaced.
fn apply(value: &str, uses: &[Use]) -> String {
    let mut out = String::with_capacity(value.len());
    let mut rest = 0;
    for (range, with) in uses {
        out.push_str(&value[rest..range.start]);
        out.push_str(with);
        rest = range.end;
    }
    out.push_str(&value[rest..]);
    out
}

/// A token's name, with its mode's name when the design has more than one.
fn token_label(doc: &Document, name: &str, mode: &str) -> String {
    match doc.mode_map().get(mode) {
        Some(m) if doc.modes().len() > 1 => format!("{name} ({})", m.name),
        _ => name.to_owned(),
    }
}

/// Replaces `from` with `to` in the design's token values, as [`replace`]
/// does in styles: a color in any notation, keeping each use's alpha, and
/// other text exactly. Returns the ops and a line for each value changed,
/// like `--brand (Dark): #3b82f6 → #f97316`.
pub fn replace_in_tokens(
    doc: &Document,
    from: &str,
    to: &str,
) -> Result<(Vec<Op>, Vec<String>), EditError> {
    if from.is_empty() {
        return Err(EditError("find can't be empty".into()));
    }
    let mut ops = Vec::new();
    let mut lines = Vec::new();
    for (name, values) in doc.tokens() {
        for (mode, value) in values {
            let (new, n) = swap(value, from, to);
            if n == 0 || new == *value {
                continue;
            }
            let label = token_label(doc, name, mode);
            crate::tokens::check_value(new.trim())
                .map_err(|why| EditError(format!("{label}: {why}")))?;
            lines.push(format!("{label}: {value} → {new}"));
            ops.push(Op::Token {
                name: name.clone(),
                mode_id: mode.clone(),
                value: Some(new.trim().to_owned()),
            });
        }
    }
    Ok((ops, lines))
}

/// The token values that hold `needle`: a color in any notation, or text
/// in the token's name or value, ignoring case. One line for each, like
/// `--brand (Dark): #3b82f6`.
pub fn find_in_tokens(doc: &Document, needle: &str) -> Vec<String> {
    let lower = needle.to_lowercase();
    let color = parse_color(needle).is_some();
    let mut lines = Vec::new();
    for (name, values) in doc.tokens() {
        for (mode, value) in values {
            let hit = if color {
                swap(value, needle, needle).1 > 0
            } else {
                name.to_lowercase().contains(&lower) || value.to_lowercase().contains(&lower)
            };
            if hit {
                lines.push(format!("{}: {value}", token_label(doc, name, mode)));
            }
        }
    }
    lines
}

/// Every node under `within`, or in every artboard, in document order.
fn scope<'a>(doc: &'a Document, within: Option<&str>) -> Vec<&'a Node> {
    match within {
        Some(id) => doc.subtree(id),
        None => doc
            .artboards()
            .into_iter()
            .flat_map(|board| doc.subtree(&board.id))
            .collect(),
    }
}

fn is_raw_text(tag: &str) -> bool {
    tag.eq_ignore_ascii_case("style") || tag.eq_ignore_ascii_case("script")
}

/// Whether `node` is a `<script>` or `<style>`, or sits inside one. An SVG
/// `<style>` is a `<style>` too. Visible text stops at these elements; their
/// bodies are code.
fn in_raw_text(doc: &Document, node: &Node) -> bool {
    let mut current = Some(node);
    while let Some(at) = current {
        if at.tag().is_some_and(is_raw_text) {
            return true;
        }
        current = at.parent.as_deref().and_then(|id| doc.get(id));
    }
    false
}

/// The text directly inside an element (not in its descendants' elements).
fn own_text(doc: &Document, node: &Node) -> String {
    doc.children(Some(&node.id))
        .iter()
        .filter_map(|c| c.text.as_deref())
        .collect()
}

/// A stylesheet's declarations and selectors, one per item, trimmed, each
/// with the rules around it (`@media (min-width: 600px) .card`), empty at the
/// top level.
fn css_lines(css: &str) -> Vec<(String, String)> {
    let mut lines = Vec::new();
    let mut open: Vec<String> = Vec::new();
    let mut item = String::new();
    for ch in css.chars().chain(std::iter::once(';')) {
        if !matches!(ch, '{' | '}' | ';') {
            item.push(ch);
            continue;
        }
        let text = item.trim();
        if !text.is_empty() {
            let around: Vec<&str> = open
                .iter()
                .map(String::as_str)
                .filter(|s| !s.is_empty())
                .collect();
            lines.push((around.join(" "), text.to_owned()));
        }
        match ch {
            '{' => open.push(text.to_owned()),
            '}' => {
                open.pop();
            }
            _ => {}
        }
        item.clear();
    }
    lines
}

/// Each case-insensitive match of `needle` (already lowercase) in `code`, with
/// up to 30 characters of the original code on either side.
fn code_matches<'a>(code: &'a str, needle: &'a str) -> impl Iterator<Item = String> + 'a {
    if needle.is_empty() {
        return Vec::new().into_iter();
    }
    // Lowercase `code` as the query was (so a final `ς` matches), and record
    // where each lowercase byte came from, since lowercasing can change
    // lengths outside ASCII. A context-dependent lowercase keeps each char's
    // byte length, so the per-char lengths line up with `lower`.
    let lower = code.to_lowercase();
    let mut origin = Vec::with_capacity(lower.len());
    for (i, c) in code.char_indices() {
        let len: usize = c.to_lowercase().map(char::len_utf8).sum();
        origin.extend(std::iter::repeat_n(i, len));
    }
    if origin.len() != lower.len() {
        return Vec::new().into_iter();
    }
    let snippets: Vec<String> = lower
        .match_indices(needle)
        .map(|(at, _)| {
            // The match runs from the char its first byte came from through
            // the char its last byte came from.
            let from = origin[at];
            let last = origin[at + needle.len() - 1];
            let to = last + code[last..].chars().next().map_or(0, char::len_utf8);
            let start = code[..from]
                .char_indices()
                .rev()
                .nth(29)
                .map_or(0, |(i, _)| i);
            let end = code[to..]
                .char_indices()
                .nth(30)
                .map_or(code.len(), |(i, _)| to + i);
            code[start..end].to_owned()
        })
        .collect();
    snippets.into_iter()
}

/// How many nodes, and how many different changes, a refusal names.
const REFUSAL_NODES: usize = 3;
const REFUSAL_LINES: usize = 8;

/// How long a changed line of code can be before a preview shows just the
/// code around each match instead.
const LINE_SHOWN: usize = 90;

/// One changed line of code as `label: before → after`, or when the line is
/// long, one such line per use in `uses` with the code around it.
fn change_lines(label: &str, line: &str, uses: &[Use]) -> Vec<String> {
    if line.chars().count() <= LINE_SHOWN {
        return vec![format!("{label}: {line} → {}", apply(line, uses))];
    }
    snippets(line, uses)
        .map(|(before, after)| format!("{label}: {before} → {after}"))
        .collect()
}

/// Each of `uses` in `code` with up to 30 characters of code on either side,
/// as `(before, after)`. A side that was cut ends in `…`.
fn snippets<'a>(code: &'a str, uses: &'a [Use]) -> impl Iterator<Item = (String, String)> + 'a {
    const CONTEXT: usize = 30;
    uses.iter().map(move |(range, with)| {
        let start = code[..range.start]
            .char_indices()
            .rev()
            .nth(CONTEXT - 1)
            .map_or(0, |(i, _)| i);
        let end = code[range.end..]
            .char_indices()
            .nth(CONTEXT)
            .map_or(code.len(), |(i, _)| range.end + i);
        let head = format!(
            "{}{}",
            if start > 0 { "…" } else { "" },
            &code[start..range.start]
        );
        let tail = format!(
            "{}{}",
            &code[range.end..end],
            if end < code.len() { "…" } else { "" }
        );
        (
            format!("{head}{}{tail}", &code[range.clone()]),
            format!("{head}{with}{tail}"),
        )
    })
}

/// An sRGB color: red, green, blue, and alpha from 0 to 1 when it has one.
type Color = ([u8; 3], Option<f64>);

/// `text` as a color, if all of it is one.
pub fn parse_color(text: &str) -> Option<Color> {
    let text = text.trim();
    let (color, len) = color_at(text, 0)?;
    (len == text.len()).then_some(color)
}

/// The color starting at byte `at` of `s`, and its length in bytes.
fn color_at(s: &str, at: usize) -> Option<(Color, usize)> {
    let rest = &s[at..];
    if let Some(hex) = rest.strip_prefix('#') {
        let digits = hex.bytes().take_while(u8::is_ascii_hexdigit).count();
        let h = &hex[..digits];
        let byte = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).ok();
        let nibble = |i: usize| u8::from_str_radix(&h[i..i + 1], 16).ok().map(|v| v * 17);
        let color = match digits {
            3 => ([nibble(0)?, nibble(1)?, nibble(2)?], None),
            4 => (
                [nibble(0)?, nibble(1)?, nibble(2)?],
                Some(nibble(3)? as f64 / 255.0),
            ),
            6 => ([byte(0)?, byte(2)?, byte(4)?], None),
            8 => (
                [byte(0)?, byte(2)?, byte(4)?],
                Some(byte(6)? as f64 / 255.0),
            ),
            _ => return None,
        };
        return Some((color, 1 + digits));
    }
    let lower = rest
        .get(..5)
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let open = if lower.starts_with("rgba(") {
        5
    } else if lower.starts_with("rgb(") {
        4
    } else {
        return None;
    };
    let close = rest.find(')')?;
    let parts: Vec<&str> = rest[open..close]
        .split([',', ' ', '/'])
        .filter(|p| !p.is_empty())
        .collect();
    let channel = |p: &str| {
        p.trim()
            .parse::<f64>()
            .ok()
            .filter(|v| (0.0..=255.0).contains(v))
            .map(|v| v.round() as u8)
    };
    let alpha = |p: &str| match p.trim().strip_suffix('%') {
        Some(pct) => pct.parse::<f64>().ok().map(|v| v / 100.0),
        None => p.trim().parse::<f64>().ok(),
    };
    let color = match parts.as_slice() {
        [r, g, b] => ([channel(r)?, channel(g)?, channel(b)?], None),
        [r, g, b, a] => ([channel(r)?, channel(g)?, channel(b)?], Some(alpha(a)?)),
        _ => return None,
    };
    Some((color, close + 1))
}

/// `value` with every use of the color `from` replaced by `to`, and how many
/// there were. A use with its own alpha keeps it.
fn replace_color(value: &str, from: Color, to: Color) -> (String, usize) {
    replace_color_with(value, from, true, |alpha| {
        format_color(to.0, alpha.or(to.1))
    })
}

/// Like [`replace_color`], with each use rewritten by `render`, which gets
/// the alpha the use had. Without `tints`, a use only matches a `from` that
/// has its exact alpha, because `render` has nowhere to keep another one.
fn replace_color_with(
    value: &str,
    from: Color,
    tints: bool,
    render: impl Fn(Option<f64>) -> String,
) -> (String, usize) {
    let uses = color_uses(value, from, tints, render);
    (apply(value, &uses), uses.len())
}

/// Each use of the color `from` in `value`, in any notation, with what
/// `render` makes of it.
fn color_uses(
    value: &str,
    from: Color,
    tints: bool,
    render: impl Fn(Option<f64>) -> String,
) -> Vec<Use> {
    let mut found = Vec::new();
    let mut i = 0;
    while i < value.len() {
        let starts_token = i == 0 || !value.as_bytes()[i - 1].is_ascii_alphanumeric();
        if starts_token
            && let Some(((rgb, alpha), len)) = color_at(value, i)
            && rgb == from.0
            // A color with alpha only matches a `from` that has the same alpha
            // or none, so replacing #3b82f6 also updates its tints.
            && ((tints && from.1.is_none()) || from.1 == alpha)
        {
            found.push((i..i + len, render(alpha)));
            i += len;
            continue;
        }
        i += value[i..].chars().next().expect("in bounds").len_utf8();
    }
    found
}

fn format_color([r, g, b]: [u8; 3], alpha: Option<f64>) -> String {
    match alpha {
        Some(a) if a < 1.0 => format!("rgba({r}, {g}, {b}, {})", (a * 1000.0).round() / 1000.0),
        _ => format!("#{r:02x}{g:02x}{b:02x}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::{self, NewArtboard, WriteMode};

    fn design(html: &str) -> (Document, NodeId) {
        let mut doc = Document::default();
        let ops = edit::create_artboard(
            &doc,
            "b".into(),
            NewArtboard {
                name: "B".into(),
                width: 400.0,
                height: Some(400.0),
                position: None,
                page: None,
                styles: Default::default(),
                ..Default::default()
            },
        )
        .unwrap();
        doc.apply_all(&ops);
        let mut n = 0;
        let (ops, _) = edit::write_html(&doc, "b", html, WriteMode::Append, None, &mut || {
            n += 1;
            format!("n{n}")
        })
        .unwrap();
        doc.apply_all(&ops);
        (doc, "b".into())
    }

    #[test]
    fn colors_match_in_any_notation_and_keep_alpha() {
        let blue = parse_color("#3b82f6").unwrap();
        let orange = parse_color("#f97316").unwrap();
        let (out, n) = replace_color(
            "1px solid #3B82F6, rgba(59, 130, 246, 0.25), rgb(59 130 246), #3b82f6cc, #3b82f60",
            blue,
            orange,
        );
        assert_eq!(n, 4);
        assert_eq!(
            out,
            "1px solid #f97316, rgba(249, 115, 22, 0.25), #f97316, rgba(249, 115, 22, 0.8), #3b82f60"
        );
        // Not a color inside a longer word or id.
        assert_eq!(replace_color("a#3b82f6", blue, orange).1, 0);
    }

    #[test]
    fn replace_reaches_styles_attributes_and_style_blocks() {
        let (doc, board) = design(
            r##"<style>.a { color: #3b82f6 } .b { border: 1px solid #3b82f6 }</style>
<button style="background: #3b82f6; color: white">Go #3b82f6</button>
<svg><path fill="#3B82F6" d="M0 0"></path></svg>"##,
        );
        let places = Places {
            styles: true,
            attributes: true,
            css: true,
            text: false,
        };
        let (ops, report) =
            replace(&doc, Some(&board), "#3b82f6", "#f97316", places, false).unwrap();
        assert_eq!(ops.len(), 3, "{report:?}");
        assert_eq!(report.iter().map(|r| r.count).sum::<usize>(), 4);
        // Text is left alone unless asked for.
        assert!(
            report
                .iter()
                .all(|r| r.changes.iter().all(|c| !c.starts_with("text")))
        );
        let mut doc = doc;
        doc.apply_all(&ops);
        let html = html::export(&doc, &board, false).unwrap();
        assert!(!html.to_lowercase().contains("#3b82f6\""), "{html}");
        assert!(html.contains("Go #3b82f6"));
    }

    #[test]
    fn replace_reaches_scripts_and_refuses_ambiguous_code_matches() {
        let (doc, board) = design(
            r##"<style>.a { transition: opacity 300ms } .b { animation: spin 300ms }</style>
<div class="a">300ms</div>
<script>setTimeout(tick, 1500); setTimeout(done, 200)</script>"##,
        );
        let places = Places {
            styles: true,
            attributes: true,
            css: true,
            text: false,
        };
        let run =
            |from: &str, to: &str, all: bool| replace(&doc, Some(&board), from, to, places, all);
        // One match in a script is reached.
        let (ops, report) = run("1500", "3000", false).unwrap();
        assert_eq!(ops.len(), 1);
        assert_eq!(
            report[0].changes,
            ["script: setTimeout(tick, 1500) → setTimeout(tick, 3000)"]
        );
        // Two matches are refused, with the count and the lines.
        let err = run("300ms", "500ms", false).unwrap_err().0;
        assert!(
            err.contains("matches 2 times") && err.contains("css .a: transition: opacity 300ms"),
            "{err}"
        );
        // all, or a narrower find, goes through.
        assert_eq!(run("300ms", "500ms", true).unwrap().0.len(), 1);
        assert_eq!(
            run("opacity 300ms", "opacity 500ms", false)
                .unwrap()
                .0
                .len(),
            1
        );
    }

    #[test]
    fn replace_shows_the_code_around_a_match_in_a_long_line() {
        let font = "@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400&family=Roboto+Mono:wght@500&display=swap')";
        let (doc, board) = design(&format!("<style>{font};\n.a {{ color: red }}</style>"));
        let places = Places {
            styles: false,
            attributes: false,
            css: true,
            text: false,
        };
        let (_, report) =
            replace(&doc, Some(&board), "Roboto+Mono", "Fira+Code", places, true).unwrap();
        let [change] = report[0].changes.as_slice() else {
            panic!("{report:?}")
        };
        assert!(
            change.starts_with("css: …")
                && change.contains("Roboto+Mono")
                && change.contains("Fira+Code"),
            "{change}"
        );
        assert!(!change.contains("@import"), "{change}");
    }

    #[test]
    fn a_refusal_names_the_places_and_groups_identical_changes() {
        let sheet = "<style>.a { transition: opacity 300ms }</style>";
        let (doc, board) = design(&sheet.repeat(4));
        let places = Places {
            styles: true,
            attributes: true,
            css: true,
            text: false,
        };
        let err = replace(&doc, Some(&board), "300ms", "500ms", places, false)
            .unwrap_err()
            .0;
        assert!(
            err.contains("matches 4 times, in <style> code ×4")
                && err.contains("on style #")
                && err.contains(", … +1)"),
            "{err}"
        );
        // Four equal lines are one line with a count.
        assert_eq!(
            err.matches("transition: opacity 300ms →").count(),
            1,
            "{err}"
        );
        assert!(err.contains("(×4)"), "{err}");
    }

    #[test]
    fn replace_treats_color_shaped_script_code_as_code() {
        let (doc, board) = design(
            r##"<div id="abc"></div>
<style>.a { color: #abc } .b { color: #abc }</style>
<script>document.querySelector('#abc'); paint(rgb(59, 130, 246))</script>"##,
        );
        let places = Places {
            styles: true,
            attributes: true,
            css: true,
            text: false,
        };
        // A color in a script is a selector, and one match there needs `all`
        // as soon as there's a second match anywhere.
        let err = replace(&doc, Some(&board), "#abc", "#def", places, false)
            .unwrap_err()
            .0;
        assert!(err.contains("matches 3 times"), "{err}");
        let (ops, _) = replace(&doc, Some(&board), "#abc", "#def", places, true).unwrap();
        let mut doc = doc;
        doc.apply_all(&ops);
        let html = html::export(&doc, &board, false).unwrap();
        // The selector is rewritten as typed, while the CSS color is recolored.
        assert!(html.contains("querySelector('#def')"), "{html}");
        assert!(html.contains(".a { color: #ddeeff }"), "{html}");

        // A script's `rgb(...)` call isn't recolored by a color replace.
        let (doc, board) = design(r##"<script>paint(rgb(59, 130, 246))</script>"##);
        let (ops, report) = replace(
            &doc,
            Some(&board),
            "rgb(59, 130, 246)",
            "#f97316",
            places,
            false,
        )
        .unwrap();
        assert_eq!(ops.len(), 1, "{report:?}");
        let mut doc = doc;
        doc.apply_all(&ops);
        let html = html::export(&doc, &board, false).unwrap();
        assert!(html.contains("paint(#f97316)"), "{html}");
    }

    #[test]
    fn replace_calls_a_color_a_color_whatever_it_becomes() {
        let (doc, board) =
            design(r##"<style>.a { color: #abc } .b { border-color: #abc }</style>"##);
        let places = Places {
            styles: true,
            attributes: true,
            css: true,
            text: false,
        };
        let (ops, report) =
            replace(&doc, Some(&board), "#abc", "var(--brand)", places, false).unwrap();
        assert_eq!(ops.len(), 1, "{report:?}");
        assert_eq!(report[0].count, 2);
    }

    #[test]
    fn replace_color_with_text_matches_whole_colors_in_any_notation() {
        let (doc, board) =
            design(r##"<style>.a{color:#abc}.b{color:#abcc}.c{color:rgb(170 187 204)}</style>"##);
        let places = Places {
            styles: true,
            attributes: true,
            css: true,
            text: false,
        };
        let (ops, _) = replace(&doc, Some(&board), "#abc", "var(--brand)", places, false).unwrap();
        let mut doc = doc;
        doc.apply_all(&ops);
        let html = html::export(&doc, &board, false).unwrap();
        // The same color in another notation is replaced; a translucent tint
        // is left alone, since a variable can't keep its transparency; and
        // nothing is cut in half.
        assert!(
            html.contains(".a{color:var(--brand)}.b{color:#abcc}.c{color:var(--brand)}"),
            "{html}"
        );
    }

    #[test]
    fn replace_shows_a_find_that_spans_statements() {
        let (doc, board) = design(
            r##"<script>setInterval(next, 3000); other(); setInterval(next, 3000);</script>"##,
        );
        let places = Places {
            styles: false,
            attributes: false,
            css: true,
            text: false,
        };
        let find = "setInterval(next, 3000);";
        let err = replace(
            &doc,
            Some(&board),
            find,
            "setInterval(next, 5000);",
            places,
            false,
        )
        .unwrap_err()
        .0;
        assert!(
            err.contains("script: setInterval(next, 3000); other()")
                && err.contains("setInterval(next, 5000); other()"),
            "{err}"
        );
        let (_, report) = replace(
            &doc,
            Some(&board),
            "other(); setInterval(next, 3000);",
            "x",
            places,
            false,
        )
        .unwrap();
        assert!(!report[0].changes.is_empty(), "{report:?}");
    }

    #[test]
    fn text_scope_skips_script_and_style_code_scope_finds_them() {
        let (doc, board) = design(
            r##"<p>See Timepris</p>
<script>h('Timepris'); h('Timepris')</script>
<style>.a { content: "Timepris" } .b { content: "Timepris" }</style>
<svg><style>.z { content: "Timepris" }</style></svg>"##,
        );
        let text_only = Places {
            styles: false,
            attributes: false,
            css: false,
            text: true,
        };
        let (ops, report) = replace(
            &doc,
            Some(&board),
            "Timepris",
            "Timepris arbeid",
            text_only,
            false,
        )
        .unwrap();
        let mut changed = doc.clone();
        changed.apply_all(&ops);
        let html = html::export(&changed, &board, false).unwrap();
        assert!(
            html.contains("See Timepris arbeid") && html.contains("h('Timepris')"),
            "text scope rewrote code:\n{html}\n{report:?}"
        );
        assert!(
            html.contains(r#"content: "Timepris""#),
            "text scope rewrote style:\n{html}\n{report:?}"
        );
        assert_eq!(
            report.iter().map(|r| r.count).sum::<usize>(),
            1,
            "{report:?}"
        );

        let code_only = Places {
            styles: false,
            attributes: false,
            css: true,
            text: false,
        };
        let (ops, report) =
            replace(&doc, Some(&board), "Timepris", "Rate", code_only, true).unwrap();
        let mut changed = doc.clone();
        changed.apply_all(&ops);
        let html = html::export(&changed, &board, false).unwrap();
        assert!(
            html.contains("h('Rate')")
                && html.contains(r#"content: "Rate""#)
                && html.contains("See Timepris"),
            "code scope missed script or style:\n{html}\n{report:?}"
        );
        // The two style rules plus the svg style plus two script calls.
        assert!(
            report.iter().map(|r| r.count).sum::<usize>() >= 5,
            "{report:?}\n{html}"
        );

        let hits = find(
            &doc,
            Some(&board),
            &Query {
                text: Some("Timepris".into()),
                ..Default::default()
            },
        );
        let tags: Vec<_> = hits
            .iter()
            .filter_map(|h| doc.get(&h.id).and_then(|n| n.tag()))
            .collect();
        assert_eq!(tags, ["p"], "text search hit code: {tags:?} {hits:?}");
        // A style search is what still reaches the script and both styles.
        let code = find(
            &doc,
            Some(&board),
            &Query {
                style: Some("Timepris".into()),
                ..Default::default()
            },
        );
        let code_tags: Vec<_> = code
            .iter()
            .filter_map(|h| doc.get(&h.id).and_then(|n| n.tag()))
            .collect();
        assert_eq!(code_tags, ["script", "style", "style"], "{code:?}");
    }

    #[test]
    fn style_search_finds_code_across_statements_and_color_shaped_selectors() {
        let (doc, board) = design(
            r##"<script>first(); second(); document.querySelector('div#abc')</script>
<style>.a { color: #abcdef }</style>"##,
        );
        let tags = |style: &str| -> Vec<String> {
            find(
                &doc,
                Some(&board),
                &Query {
                    style: Some(style.into()),
                    ..Default::default()
                },
            )
            .iter()
            .filter_map(|h| doc.get(&h.id).and_then(|n| n.tag()).map(str::to_owned))
            .collect()
        };
        assert_eq!(tags("first(); second()"), ["script"]);
        assert_eq!(tags("div#abc"), ["script"]);
        // In a script `#abc` is code; in CSS it isn't the color #abcdef.
        assert_eq!(tags("#abc"), ["script"]);
        assert_eq!(tags("#ABCDEF"), ["style"]);
    }

    #[test]
    fn code_snippets_keep_the_original_case_next_to_non_ascii_text() {
        let snippets: Vec<_> =
            code_matches(r#"let x="Å"; RenderCard() İx"#, "rendercard").collect();
        assert_eq!(snippets, [r#"let x="Å"; RenderCard() İx"#]);
        // `İ` lowercases to two chars; a match on them maps back to `İ`.
        let snippets: Vec<_> = code_matches("aİb", "i\u{307}").collect();
        assert_eq!(snippets, ["aİb"]);
        // A final sigma lowercases as `ς`, as the query does.
        let snippets: Vec<_> = code_matches("const ΟΣ = 1;", &"ΟΣ".to_lowercase()).collect();
        assert_eq!(snippets, ["const ΟΣ = 1;"]);
    }

    #[test]
    fn find_matches_styles_css_text_and_names() {
        let (doc, _) = design(
            r##"<style>.card { color: #3b82f6 }</style>
<div data-name="Card" style="border-radius: 12px"><h3>Deploy now</h3></div>"##,
        );
        let q = |q: Query| find(&doc, None, &q);
        let blue = q(Query {
            style: Some("rgb(59, 130, 246)".into()),
            ..Default::default()
        });
        assert_eq!(blue.len(), 1);
        assert_eq!(blue[0].details, ["css: color: #3b82f6"]);
        let found = q(Query {
            style: Some("radius".into()),
            ..Default::default()
        });
        assert_eq!(found[0].details, ["border-radius: 12px"]);
        assert_eq!(
            q(Query {
                text: Some("deploy".into()),
                ..Default::default()
            })[0]
                .id,
            doc.children(Some(&found[0].id))[0].id
        );
        assert_eq!(
            q(Query {
                name: Some("card".into()),
                tag: Some("div".into()),
                ..Default::default()
            })
            .len(),
            1
        );
    }
}
