//! Converts between HTML and node trees. Agents write designs as HTML with
//! inline styles, `<style>` blocks and `<script>`s, and read them back the same way.
//!
//! Styles and scripts are scoped to their artboard by the renderer: each
//! artboard is a shadow root, or a sandboxed iframe once it has a script.

use std::{collections::BTreeMap, fmt::Write};

use scraper::{Html, node::Node as HtmlNode};

use crate::{
    document::{Document, MAX_DEPTH, Op},
    label,
    node::{Node, NodeId, NodeKind},
};

/// A detached subtree, not yet in a document: parsed HTML, or a copy of existing nodes.
#[derive(Clone, Debug, PartialEq)]
pub struct Fragment {
    pub kind: NodeKind,
    pub name: Option<String>,
    pub text: Option<String>,
    pub styles: BTreeMap<String, String>,
    pub attrs: BTreeMap<String, String>,
    pub children: Vec<Fragment>,
}

/// Elements dropped with their whole subtree: anything that loads other
/// documents or changes the page outside the artboard.
const BLOCKED_TAGS: &[&str] = &[
    "link", "meta", "base", "title", "head", "iframe", "frame", "frameset", "object", "embed",
    "noscript", "template", "slot",
];

/// Elements whose text is code, written without HTML escaping.
const RAW_TEXT_TAGS: &[&str] = &["script", "style"];

/// HTML elements that never have children or a closing tag.
const VOID_TAGS: &[&str] = &[
    "area", "br", "col", "hr", "img", "input", "source", "track", "wbr",
];

/// Base styles for rendering an artboard. Screenshots and the web viewer both
/// use them; the viewer reads them through WebAssembly.
pub const BASE_CSS: &str = "*, *::before, *::after { box-sizing: border-box; }";

/// The content policy for artboards that run scripts: inline code, remote
/// images, fonts and stylesheets, and no network access from scripts.
/// Shared by screenshots and the viewer's sandboxed iframes.
pub const CSP: &str = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; img-src https: http: data: blob:; font-src https: data:; media-src https: data: blob:";

/// Names a node when written as an attribute (`<div data-name="Header">`).
pub const NAME_ATTR: &str = "data-name";
/// Identifies a node in exported HTML.
pub const ID_ATTR: &str = "data-id";

/// Parses an HTML fragment into detached subtrees.
///
/// Inline `style` attributes become styles, `data-name` becomes the layer
/// name, and anything that could run code is dropped. Whitespace-only text
/// containing a newline is treated as source indentation and dropped.
///
/// Fails if elements nest more than [`MAX_DEPTH`] levels deep. Converting
/// is recursive, so it stops there rather than overflow the stack.
pub fn parse(html: &str) -> Result<Vec<Fragment>, TooDeep> {
    // html5ever's tree builder takes time quadratic in the nesting depth:
    // 100,000 levels took 10 seconds in a release build. So refuse HTML that
    // can't possibly fit before handing it over.
    if nesting_bound(html) > MAX_DEPTH * 16 {
        return Err(TooDeep);
    }
    let doc = Html::parse_fragment(html);
    convert_children(doc.root_element().children(), 0)
}

/// How deeply `html` could nest, at most, counted in one pass: start tags
/// minus end tags, skipping void and self-closing ones. Tags the parser
/// closes by itself, like a `<p>` before another `<p>`, count as open, so
/// this can overestimate but never underestimates.
fn nesting_bound(html: &str) -> usize {
    let bytes = html.as_bytes();
    let (mut depth, mut deepest, mut i) = (0usize, 0usize, 0);
    while let Some(offset) = bytes[i..].iter().position(|&b| b == b'<') {
        let start = i + offset + 1;
        let end = bytes[start..]
            .iter()
            .position(|&b| b == b'>')
            .map_or(bytes.len(), |e| start + e);
        let tag = &bytes[start..end];
        if !tag
            .first()
            .is_some_and(|b| *b == b'/' || b.is_ascii_alphabetic())
        {
            // Not a tag, like the `<` in `x < y`. Look again right after it.
            i = start;
            continue;
        }
        if tag.first() == Some(&b'/') {
            depth = depth.saturating_sub(1);
        } else if tag.last() != Some(&b'/') {
            let name_len = tag
                .iter()
                .position(|b| !b.is_ascii_alphanumeric())
                .unwrap_or(tag.len());
            let name = std::str::from_utf8(&tag[..name_len]).unwrap_or("");
            if !VOID_TAGS.iter().any(|v| v.eq_ignore_ascii_case(name)) {
                depth += 1;
                deepest = deepest.max(depth);
            }
        }
        i = end.min(bytes.len());
    }
    deepest
}

/// HTML that nests deeper than [`MAX_DEPTH`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TooDeep;

impl std::fmt::Display for TooDeep {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "the HTML nests more than {MAX_DEPTH} levels deep")
    }
}

fn convert_children<'a>(
    children: impl Iterator<Item = ego_tree::NodeRef<'a, HtmlNode>>,
    depth: usize,
) -> Result<Vec<Fragment>, TooDeep> {
    if depth > MAX_DEPTH {
        return Err(TooDeep);
    }
    let mut out = Vec::new();
    for child in children {
        if let Some(fragment) = convert(child, depth)? {
            out.push(fragment);
        }
    }
    Ok(out)
}

fn convert(
    node: ego_tree::NodeRef<'_, HtmlNode>,
    depth: usize,
) -> Result<Option<Fragment>, TooDeep> {
    Ok(match node.value() {
        HtmlNode::Text(text) => {
            let text: &str = text;
            if text.trim().is_empty() && text.contains('\n') {
                return Ok(None);
            }
            Some(Fragment {
                text: Some(text.to_owned()),
                ..Fragment::empty(NodeKind::Text)
            })
        }
        HtmlNode::Element(el) => {
            let tag = el.name();
            if BLOCKED_TAGS.contains(&tag.to_ascii_lowercase().as_str()) {
                return Ok(None);
            }
            let mut fragment = Fragment::empty(NodeKind::Element {
                tag: tag.to_owned(),
            });
            let is_script = tag.eq_ignore_ascii_case("script");
            for (name, value) in el.attrs() {
                match name {
                    "style" => fragment.styles.extend(parse_style(value)),
                    NAME_ATTR => fragment.name = Some(label::clip(value, label::LAYER_NAME)),
                    // Node ids come from the document. Scripts must be inline:
                    // the sandbox doesn't load anything that runs.
                    ID_ATTR => {}
                    "src" if is_script => {}
                    _ if is_safe_attr(name, value) => {
                        fragment.attrs.insert(name.to_owned(), value.to_owned());
                    }
                    _ => {}
                }
            }
            fragment.children = convert_children(node.children(), depth + 1)?;
            Some(fragment)
        }
        _ => None,
    })
}

/// Whether `name` can be written as an attribute name. Exports write names
/// as they are, so anything else could break out of the tag. Allows SVG's
/// `viewBox` and namespaced names like `xlink:href`.
pub fn is_attr_name(name: &str) -> bool {
    let mut chars = name.chars();
    chars
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == ':')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | ':' | '.' | '-'))
}

/// Whether an attribute is allowed on a node: no event handlers, no
/// `srcdoc`, no `javascript:` or `vbscript:` URLs. `write_html` drops the
/// ones that fail, and `set_attributes` refuses them.
///
/// A script URL is refused anywhere in the value, not just at the start:
/// SVG animation can set an `href` at runtime from a list such as
/// `<animate attributeName="href" values="0;javascript:…">`. Browsers ignore
/// whitespace and control characters inside a URL scheme, so they're
/// ignored here too. The web viewer checks attributes again before it sets
/// them, by calling this function through WebAssembly.
pub fn is_safe_attr(name: &str, value: &str) -> bool {
    let name = name.to_ascii_lowercase();
    let value: String = value
        .chars()
        .filter(|c| !c.is_whitespace() && !c.is_control())
        .collect::<String>()
        .to_ascii_lowercase();
    !name.starts_with("on")
        && name != "srcdoc"
        && !value.contains("javascript:")
        && !value.contains("vbscript:")
}

/// Splits a `style` attribute into `(property, value)` pairs, respecting
/// quotes and parentheses (`url(data:image/png;base64,...)` contains `;`).
pub fn parse_style(style: &str) -> Vec<(String, String)> {
    let mut declarations = Vec::new();
    let (mut depth, mut quote, mut start) = (0usize, None::<char>, 0);
    let mut push = |decl: &str| {
        if let Some((prop, value)) = decl.split_once(':') {
            let prop = prop.trim().to_ascii_lowercase();
            let value = value.trim();
            let valid =
                !prop.is_empty() && prop.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
            if valid && !value.is_empty() {
                declarations.push((prop, value.to_owned()));
            }
        }
    };
    for (i, c) in style.char_indices() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '(') => depth += 1,
            (None, ')') => depth = depth.saturating_sub(1),
            (None, ';') if depth == 0 => {
                push(&style[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    push(&style[start..]);
    declarations
}

impl Fragment {
    fn empty(kind: NodeKind) -> Self {
        Self {
            kind,
            name: None,
            text: None,
            styles: BTreeMap::new(),
            attrs: BTreeMap::new(),
            children: Vec::new(),
        }
    }

    /// Copies the subtree rooted at `id`.
    pub fn from_document(doc: &Document, id: &str) -> Option<Self> {
        let node = doc.get(id)?;
        Some(Self {
            kind: node.kind.clone(),
            name: node.name.clone(),
            text: node.text.clone(),
            styles: node.styles.clone(),
            attrs: node.attrs.clone(),
            children: doc
                .children(Some(id))
                .iter()
                .filter_map(|c| Self::from_document(doc, &c.id))
                .collect(),
        })
    }

    /// How many levels this subtree spans below its root: 0 for a leaf.
    pub fn height(&self) -> usize {
        self.children
            .iter()
            .map(|c| c.height() + 1)
            .max()
            .unwrap_or(0)
    }

    pub fn count(&self) -> usize {
        1 + self.children.iter().map(Self::count).sum::<usize>()
    }

    /// Emits `Create` ops for this subtree, parents first. Returns the root's id.
    pub fn create_ops(
        self,
        parent: Option<&str>,
        index: String,
        position: Option<(f64, f64)>,
        new_id: &mut impl FnMut() -> NodeId,
        ops: &mut Vec<Op>,
    ) -> NodeId {
        let id = new_id();
        let indexes = crate::fractional::keys_between(None, None, self.children.len());
        ops.push(Op::Create {
            node: Node {
                id: id.clone(),
                parent: parent.map(Into::into),
                index,
                kind: self.kind,
                name: self.name,
                text: self.text,
                x: position.map(|p| p.0),
                y: position.map(|p| p.1),
                styles: self.styles,
                attrs: self.attrs,
            },
        });
        for (child, index) in self.children.into_iter().zip(indexes) {
            child.create_ops(Some(&id), index, None, new_id, ops);
        }
        id
    }
}

/// Serializes the subtree at `id` as HTML with inline styles. With `ids`, every
/// element carries `data-id` so agents can target it in later calls.
pub fn export(doc: &Document, id: &str, ids: bool) -> Option<String> {
    let node = doc.get(id)?;
    let mut out = String::new();
    write_node(doc, node, ids, 0, &mut out);
    Some(out)
}

fn write_node(doc: &Document, node: &Node, ids: bool, depth: usize, out: &mut String) {
    let pad = "  ".repeat(depth);
    let tag = match &node.kind {
        NodeKind::Text => {
            let _ = writeln!(
                out,
                "{pad}{}",
                escape(node.text.as_deref().unwrap_or(""), false)
            );
            return;
        }
        NodeKind::Element { tag } => tag,
    };
    let _ = write!(out, "{pad}<{tag}");
    if ids {
        let _ = write!(out, " {ID_ATTR}=\"{}\"", escape(&node.id, true));
    }
    if let Some(name) = &node.name {
        let _ = write!(out, " {NAME_ATTR}=\"{}\"", escape(name, true));
    }
    for (name, value) in &node.attrs {
        let _ = write!(out, " {name}=\"{}\"", escape(value, true));
    }
    if !node.styles.is_empty() {
        let _ = write!(
            out,
            " style=\"{}\"",
            escape(&style_string(&node.styles), true)
        );
    }
    if VOID_TAGS.contains(&tag.as_str()) {
        out.push_str(" />\n");
        return;
    }
    let children = doc.children(Some(&node.id));
    if RAW_TEXT_TAGS.contains(&tag.to_ascii_lowercase().as_str()) {
        let code: String = children.iter().filter_map(|c| c.text.as_deref()).collect();
        let _ = writeln!(out, ">{}</{tag}>", raw_text(&code, tag));
        return;
    }
    match children.as_slice() {
        [] => {
            let _ = writeln!(out, "></{tag}>");
        }
        [only] if only.kind == NodeKind::Text => {
            let text = escape(only.text.as_deref().unwrap_or(""), false);
            let _ = writeln!(out, ">{text}</{tag}>");
        }
        children => {
            out.push_str(">\n");
            for child in children {
                write_node(doc, child, ids, depth + 1, out);
            }
            let _ = writeln!(out, "{pad}</{tag}>");
        }
    }
}

/// The subtree at `id` exactly as the document holds it: no added whitespace,
/// no layer names. This is what renders, so screenshots use it. The indented
/// [`export`] would add whitespace text between siblings, which shows up as a
/// space between inline elements.
pub fn export_compact(doc: &Document, id: &str) -> Option<String> {
    let mut out = String::new();
    write_compact(doc, doc.get(id)?, false, &mut out);
    Some(out)
}

/// Marks each element with its node id in the HTML the web viewer renders
/// in a sandboxed iframe, so a comment can point at an element inside it.
pub const VIEWER_ID_ATTR: &str = "data-finite-id";

/// [`export_compact`] with every element's node id in [`VIEWER_ID_ATTR`].
/// The web viewer renders artboards that run scripts from this, through
/// WebAssembly, so they match screenshots.
pub fn export_for_viewer(doc: &Document, id: &str) -> Option<String> {
    let mut out = String::new();
    write_compact(doc, doc.get(id)?, true, &mut out);
    Some(out)
}

fn write_compact(doc: &Document, node: &Node, ids: bool, out: &mut String) {
    let tag = match &node.kind {
        NodeKind::Text => {
            out.push_str(&escape(node.text.as_deref().unwrap_or(""), false));
            return;
        }
        NodeKind::Element { tag } => tag,
    };
    let _ = write!(out, "<{tag}");
    if ids {
        let _ = write!(out, " {VIEWER_ID_ATTR}=\"{}\"", escape(&node.id, true));
    }
    for (name, value) in &node.attrs {
        let _ = write!(out, " {name}=\"{}\"", escape(value, true));
    }
    if !node.styles.is_empty() {
        let _ = write!(
            out,
            " style=\"{}\"",
            escape(&style_string(&node.styles), true)
        );
    }
    if VOID_TAGS.contains(&tag.as_str()) {
        out.push_str(" />");
        return;
    }
    out.push('>');
    let children = doc.children(Some(&node.id));
    if RAW_TEXT_TAGS.contains(&tag.to_ascii_lowercase().as_str()) {
        let code: String = children.iter().filter_map(|c| c.text.as_deref()).collect();
        out.push_str(&raw_text(&code, tag));
    } else {
        for child in children {
            write_compact(doc, child, ids, out);
        }
    }
    let _ = write!(out, "</{tag}>");
}

pub fn style_string(styles: &BTreeMap<String, String>) -> String {
    styles
        .iter()
        .map(|(k, v)| format!("{k}: {v}"))
        .collect::<Vec<_>>()
        .join("; ")
}

/// Script and style text goes out unescaped, except that a closing tag inside
/// it is broken up so it can't end the element early.
fn raw_text(code: &str, tag: &str) -> String {
    let closing = format!("</{}", tag.to_ascii_lowercase());
    let mut out = String::with_capacity(code.len());
    let mut rest = code;
    while let Some(pos) = rest.to_ascii_lowercase().find(&closing) {
        out.push_str(&rest[..pos]);
        out.push_str("<\\/");
        rest = &rest[pos + 2..];
    }
    out.push_str(rest);
    out
}

fn escape(s: &str, attr: bool) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' if attr => out.push_str("&quot;"),
            c => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(html: &str) -> Vec<Fragment> {
        super::parse(html).unwrap()
    }

    #[test]
    fn the_nesting_bound_never_underestimates() {
        let cases = [
            ("<div><span>a</span><br><img src=x></div>", 2),
            ("<svg><path d=\"M0 0\"/><g><rect/></g></svg>", 2),
            // The parser closes each <p> at the next, but the bound counts them open.
            ("<p>a<p>b<p>c", 3),
            ("x < y and <b>bold</b>", 1),
        ];
        for (html, bound) in cases {
            assert_eq!(nesting_bound(html), bound, "{html}");
        }
    }

    #[test]
    fn parses_styles_names_and_text() {
        let nodes = parse(
            r#"<div data-name="Card" style="display: flex; background: url(data:image/png;base64,AA==)">
                 <p style="color:red">Hello <b>world</b></p>
               </div>"#,
        );
        assert_eq!(nodes.len(), 1);
        let card = &nodes[0];
        assert_eq!(card.name.as_deref(), Some("Card"));
        assert_eq!(card.styles["background"], "url(data:image/png;base64,AA==)");
        assert_eq!(card.children.len(), 1, "indentation whitespace is dropped");
        let p = &card.children[0];
        assert_eq!(p.children[0].text.as_deref(), Some("Hello "));
    }

    #[test]
    fn strips_handlers_and_frames() {
        let nodes = parse(
            r#"<div onclick="x()" class="card"><iframe src="x"></iframe><a href="javascript:x()">a</a><img src="a.png"><script src="https://x/y.js">go()</script></div>"#,
        );
        let div = &nodes[0];
        assert_eq!(div.attrs, BTreeMap::from([("class".into(), "card".into())]));
        assert_eq!(div.children.len(), 3);
        assert!(div.children[0].attrs.is_empty());
        assert_eq!(div.children[1].attrs["src"], "a.png");
        assert!(
            div.children[2].attrs.is_empty(),
            "external scripts are dropped"
        );
    }

    #[test]
    fn style_and_script_text_round_trips_unescaped() {
        let source = r#"<div><style>.a > b { color: red }</style><script>if (a < b && c) go()</script></div>"#;
        let mut ops = Vec::new();
        let mut n = 0;
        let root = parse(source).remove(0).create_ops(
            None,
            "V".into(),
            None,
            &mut || {
                n += 1;
                format!("n{n}")
            },
            &mut ops,
        );
        let mut doc = Document::default();
        doc.apply_all(&ops);
        let html = export(&doc, &root, false).unwrap();
        assert!(
            html.contains("<style>.a > b { color: red }</style>"),
            "{html}"
        );
        assert!(
            html.contains("<script>if (a < b && c) go()</script>"),
            "{html}"
        );
        assert_eq!(
            parse(&html)[0],
            Fragment::from_document(&doc, &root).unwrap()
        );

        // A closing tag inside the code can't end the element early.
        let script_text = &doc.children(Some(&doc.children(Some(&root))[1].id))[0]
            .id
            .clone();
        doc.apply(&Op::Set {
            id: script_text.clone(),
            key: crate::node::PropKey::Text,
            value: Some(serde_json::json!("go('</SCRIPT>')")),
        });
        let html = export(&doc, &root, false).unwrap();
        assert!(
            html.contains("<script>go('<\\/SCRIPT>')</script>"),
            "{html}"
        );
    }

    #[test]
    fn keeps_svg_case() {
        let nodes =
            parse(r#"<svg viewBox="0 0 10 10"><linearGradient id="g"/><path d="M0 0"/></svg>"#);
        assert_eq!(nodes[0].attrs["viewBox"], "0 0 10 10");
        assert_eq!(
            nodes[0].children[0].kind,
            NodeKind::Element {
                tag: "linearGradient".into()
            }
        );
    }

    #[test]
    fn export_round_trips() {
        let mut ops = Vec::new();
        let mut n = 0;
        let fragment = parse(r#"<div data-name="Box" style="padding: 8px"><span>Hi &amp; bye</span><img src="x.png"></div>"#)
            .remove(0);
        let root = fragment.create_ops(
            None,
            "V".into(),
            Some((0.0, 0.0)),
            &mut || {
                n += 1;
                format!("n{n}")
            },
            &mut ops,
        );
        let mut doc = Document::default();
        doc.apply_all(&ops);
        let html = export(&doc, &root, false).unwrap();
        assert_eq!(
            html,
            "<div data-name=\"Box\" style=\"padding: 8px\">\n  <span>Hi &amp; bye</span>\n  <img src=\"x.png\" />\n</div>\n"
        );
        assert_eq!(
            parse(&html)[0],
            Fragment::from_document(&doc, &root).unwrap()
        );
    }

    #[test]
    fn the_viewer_export_marks_every_element_with_its_id() {
        let mut ops = Vec::new();
        let mut n = 0;
        let fragment = parse(r#"<div class="box"><b>Hi</b></div>"#).remove(0);
        let root = fragment.create_ops(
            None,
            "V".into(),
            None,
            &mut || {
                n += 1;
                format!("n{n}")
            },
            &mut ops,
        );
        let mut doc = Document::default();
        doc.apply_all(&ops);
        assert_eq!(
            export_for_viewer(&doc, &root).unwrap(),
            r#"<div data-finite-id="n1" class="box"><b data-finite-id="n2">Hi</b></div>"#
        );
        assert_eq!(
            export_compact(&doc, &root).unwrap(),
            r#"<div class="box"><b>Hi</b></div>"#
        );
    }
}
