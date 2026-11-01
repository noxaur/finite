//! Finding nodes by what they contain, and replacing a value everywhere it's
//! used. Agents asked for both: to recolor a design they read every
//! artboard's HTML and picked out each use of a color by eye, and nothing
//! told them whether they had found them all.

use crate::{
    Document, Node, NodeId, NodeKind, Op, PropKey,
    edit::{EditError, normalize_style_name},
    html,
};

/// What to look for. Every filter that's set must match.
#[derive(Clone, Debug, Default)]
pub struct Query {
    /// Text the element contains, ignoring case.
    pub text: Option<String>,
    /// Part of the layer name, ignoring case.
    pub name: Option<String>,
    /// The tag, like `button`.
    pub tag: Option<String>,
    /// Part of a style declaration, like `#3b82f6`, `border-radius` or
    /// `display: grid`, ignoring case. Also matches the CSS in `<style>` blocks.
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
/// document order. Text matches name the element holding the text.
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
                hits.extend(
                    css_lines(&own_text(doc, node))
                        .filter(|line| matches(line))
                        .map(|line| format!("css: {line}")),
                );
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
    /// The CSS in `<style>` blocks.
    pub css: bool,
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
/// notation (`#3B82F6`, `#3b82f6cc`, `rgb(59 130 246)`, `rgba(59, 130, 246,
/// 0.2)`), and keeps each use's transparency. Otherwise it matches the exact
/// text. Returns the ops and what they change.
pub fn replace(
    doc: &Document,
    within: Option<&str>,
    from: &str,
    to: &str,
    places: Places,
) -> Result<(Vec<Op>, Vec<Replaced>), EditError> {
    if from.is_empty() {
        return Err(EditError("find can't be empty".into()));
    }
    if let Some(id) = within
        && !doc.contains(id)
    {
        return Err(EditError(format!("node {id:?} not found")));
    }
    let colors = parse_color(from).zip(parse_color(to));
    let swap = |value: &str| -> (String, usize) {
        match colors {
            Some((from, to)) => replace_color(value, from, to),
            None => (value.replace(from, to), value.matches(from).count()),
        }
    };
    let mut ops = Vec::new();
    let mut report = Vec::new();
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
                            changes.push(format!("{key}=\"{value}\" → \"{new}\""));
                            ops.push(Op::Set {
                                id: node.id.clone(),
                                key: PropKey::Attr(key.clone()),
                                value: Some(new.into()),
                            });
                        }
                    }
                }
                if places.css && tag.eq_ignore_ascii_case("style") {
                    for child in doc.children(Some(&node.id)) {
                        let Some(code) = &child.text else { continue };
                        let (new, n) = swap(code);
                        if n > 0 && new != *code {
                            count += n;
                            let lines: Vec<String> = css_lines(code)
                                .filter(|line| swap(line).1 > 0)
                                .map(|line| format!("css: {line} → {}", swap(&line).0))
                                .collect();
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
                let in_code = node
                    .parent
                    .as_deref()
                    .and_then(|p| doc.get(p))
                    .is_some_and(|p| p.tag().is_some_and(is_raw_text));
                if let Some(text) = &node.text
                    && !in_code
                {
                    let (new, n) = swap(text);
                    if n > 0 && new != *text {
                        count += n;
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
    Ok((ops, report))
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

/// The text directly inside an element (not in its descendants' elements).
fn own_text(doc: &Document, node: &Node) -> String {
    doc.children(Some(&node.id))
        .iter()
        .filter_map(|c| c.text.as_deref())
        .collect()
}

/// A stylesheet's declarations and selectors, one per item, trimmed.
fn css_lines(css: &str) -> impl Iterator<Item = String> + '_ {
    css.split(['{', '}', ';'])
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
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
    let mut out = String::with_capacity(value.len());
    let mut count = 0;
    let mut i = 0;
    while i < value.len() {
        let starts_token = i == 0 || !value.as_bytes()[i - 1].is_ascii_alphanumeric();
        if starts_token
            && let Some(((rgb, alpha), len)) = color_at(value, i)
            && rgb == from.0
            // A color with alpha only matches a `from` that has the same alpha
            // or none, so replacing #3b82f6 also updates its tints.
            && (from.1.is_none() || from.1 == alpha)
        {
            out.push_str(&format_color(to.0, alpha.or(to.1)));
            count += 1;
            i += len;
            continue;
        }
        let ch = value[i..].chars().next().expect("in bounds");
        out.push(ch);
        i += ch.len_utf8();
    }
    (out, count)
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
                height: 400.0,
                position: None,
                styles: Default::default(),
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
        let (ops, report) = replace(&doc, Some(&board), "#3b82f6", "#f97316", places).unwrap();
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
