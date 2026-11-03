//! A page's `<html>` and `<body>` become one artboard, so the page's rules
//! for `html`, `body` and `:root` would match nothing. These functions write
//! those selectors as selectors for the artboard, which carries [`CLASS`].

/// The class an imported page's artboard carries.
pub(super) const CLASS: &str = "finite-root";

/// The cascade layer that holds the artboard's default look on an imported
/// page, so the page's own rules, layered or not, override it.
pub(super) const LAYER: &str = "finite-artboard";

/// At-rules whose block holds rules, so their selectors are rewritten too.
/// Any other at-rule's block, like `@keyframes` or `@font-face`, is copied.
const GROUPING: [&str; 8] = [
    "media",
    "supports",
    "layer",
    "container",
    "scope",
    "document",
    "-moz-document",
    "starting-style",
];

/// Pseudo-classes that take selectors, which are rewritten too.
const TAKES_SELECTORS: [&str; 5] = ["is", "where", "not", "has", "matches"];

/// What [`rewrite`] did to one stylesheet.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Rewritten {
    pub css: String,
    /// Selectors now written for the artboard.
    pub mapped: usize,
    /// Selectors that name `html`, `body` or `:root` in a way that doesn't
    /// map onto one element, like `html + p`. They're left as they were.
    pub unmapped: usize,
}

/// `css` with each selector of `html`, `body` or `:root` written for the
/// artboard. A chain of them, like `html.dark body > main`, becomes one
/// compound for the artboard, since both elements are the artboard:
/// `:where(.finite-root).dark > main`. `html` and `body` keep their low
/// specificity inside `:where()`; `:root` keeps a class's. Strings,
/// comments, declarations and at-rule preludes stay as they are.
pub(super) fn rewrite(css: &str) -> Rewritten {
    let mut out = Rewritten {
        css: String::with_capacity(css.len() + 64),
        ..Rewritten::default()
    };
    let bytes = css.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let end = prelude_end(css, i);
        let prelude = &css[i..end];
        match bytes.get(end) {
            Some(b'{') => {
                if let Some(at) = prelude.trim_start().strip_prefix('@') {
                    let name: String = at
                        .chars()
                        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
                        .collect::<String>()
                        .to_ascii_lowercase();
                    if GROUPING.contains(&name.as_str()) {
                        out.css.push_str(&css[i..=end]);
                        i = end + 1;
                    } else {
                        let close = block_end(css, end);
                        out.css.push_str(&css[i..close]);
                        i = close;
                    }
                } else {
                    let selectors = selector_list(prelude, &mut out);
                    out.css.push_str(&selectors);
                    out.css.push('{');
                    i = end + 1;
                }
            }
            // A declaration, an at-rule statement or the end of a block.
            Some(_) => {
                out.css.push_str(&css[i..=end]);
                i = end + 1;
            }
            None => {
                out.css.push_str(prelude);
                break;
            }
        }
    }
    out
}

/// Where the prelude that starts at `from` ends: at the first `{`, `;` or
/// `}` outside strings, comments and brackets, or at the end.
fn prelude_end(css: &str, from: usize) -> usize {
    let mut end = css.len();
    scan(&css[from..], |at, byte, depth| {
        if depth == 0 && matches!(byte, b'{' | b';' | b'}') {
            end = from + at;
            return false;
        }
        true
    });
    end
}

/// Past the `}` that closes the block opening at `open`.
fn block_end(css: &str, open: usize) -> usize {
    let mut level = 0usize;
    let mut end = css.len();
    scan(&css[open..], |at, byte, _| {
        match byte {
            b'{' => level += 1,
            b'}' => {
                level -= 1;
                if level == 0 {
                    end = open + at + 1;
                    return false;
                }
            }
            _ => {}
        }
        true
    });
    end
}

/// Calls `f` with each byte outside strings and comments, its offset and
/// how deep it is in `()` and `[]`, until `f` returns false.
fn scan(s: &str, mut f: impl FnMut(usize, u8, usize) -> bool) {
    let bytes = s.as_bytes();
    let (mut i, mut depth) = (0, 0usize);
    while i < bytes.len() {
        match bytes[i] {
            quote @ (b'"' | b'\'') => {
                i += 1;
                while i < bytes.len() && bytes[i] != quote {
                    i += if bytes[i] == b'\\' { 2 } else { 1 };
                }
                i += 1;
                continue;
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = s[i + 2..].find("*/").map_or(s.len(), |end| i + 2 + end + 2);
                continue;
            }
            b'\\' => {
                i += 2;
                continue;
            }
            byte => {
                if matches!(byte, b')' | b']') {
                    depth = depth.saturating_sub(1);
                }
                if !f(i, byte, depth) {
                    return;
                }
                if matches!(byte, b'(' | b'[') {
                    depth += 1;
                }
            }
        }
        i += 1;
    }
}

/// `s` split at each top-level byte that `split` accepts.
fn split_top(s: &str, split: impl Fn(u8) -> bool) -> Vec<&str> {
    let mut pieces = Vec::new();
    let mut start = 0;
    scan(s, |at, byte, depth| {
        if depth == 0 && split(byte) {
            pieces.push(&s[start..at]);
            start = at + 1;
        }
        true
    });
    pieces.push(&s[start..]);
    pieces
}

fn mentions_page(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    lower.contains("html") || lower.contains("body") || lower.contains(":root")
}

/// A comma-separated selector list, rewritten.
fn selector_list(list: &str, out: &mut Rewritten) -> String {
    if !mentions_page(list) {
        return list.to_owned();
    }
    let list = strip_comments(list);
    split_top(&list, |b| b == b',')
        .into_iter()
        .map(|selector| {
            let lead = selector.len() - selector.trim_start().len();
            let trail = selector.trim_end().len();
            let core = &selector[lead..trail];
            let rewritten = match complex(core, out) {
                Some(rewritten) => rewritten,
                None => {
                    out.unmapped += 1;
                    core.to_owned()
                }
            };
            format!("{}{rewritten}{}", &selector[..lead], &selector[trail..])
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn strip_comments(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(start) = rest.find("/*") {
        out.push_str(&rest[..start]);
        rest = rest[start + 2..]
            .find("*/")
            .map_or("", |end| &rest[start + 2 + end + 2..]);
    }
    out.push_str(rest);
    out
}

/// One complex selector, like `html.dark body > main`, rewritten, or `None`
/// if it names the page in a way that doesn't map onto the artboard.
fn complex(selector: &str, out: &mut Rewritten) -> Option<String> {
    // Compounds, each with the combinator before it ("" for the first).
    let mut separators = vec![false; selector.len()];
    scan(selector, |at, byte, depth| {
        separators[at] =
            depth == 0 && (byte.is_ascii_whitespace() || matches!(byte, b'>' | b'+' | b'~'));
        true
    });
    let mut parts = Vec::new();
    let mut i = 0;
    while i < selector.len() {
        let start = i;
        while i < selector.len() && separators[i] {
            i += 1;
        }
        let middle = i;
        while i < selector.len() && !separators[i] {
            i += 1;
        }
        parts.push((&selector[start..middle], &selector[middle..i]));
    }
    let mut parts: Vec<(String, Compound)> = parts
        .into_iter()
        .map(|(combinator, text)| {
            (
                combinator.to_owned(),
                Compound::parse(&arguments(text, out)),
            )
        })
        .collect();
    let Some(last_page) = parts.iter().rposition(|(_, c)| c.is_page()) else {
        return Some(join(&parts));
    };
    // Everything up to the last `html` or `body` must be them too, joined by
    // descendant or child combinators, since both are now one element.
    let joins = parts[..=last_page]
        .iter()
        .enumerate()
        .all(|(i, (combinator, c))| {
            c.mergeable() && (i == 0 || matches!(combinator.trim(), "" | ">"))
        });
    // Nothing else shares the artboard's parent, so a sibling of it can't map.
    let sibling = parts
        .get(last_page + 1)
        .is_some_and(|(combinator, _)| matches!(combinator.trim(), "+" | "~"));
    if !joins || sibling {
        return None;
    }
    let root = parts[..=last_page].iter().any(|(_, c)| c.root);
    let mut head = if root {
        format!(".{CLASS}")
    } else {
        format!(":where(.{CLASS})")
    };
    for (_, c) in &parts[..=last_page] {
        head.push_str(&c.rest);
    }
    out.mapped += 1;
    let tail = parts.split_off(last_page + 1);
    Some(format!("{head}{}", join(&tail)))
}

fn join(parts: &[(String, Compound)]) -> String {
    parts
        .iter()
        .map(|(combinator, c)| format!("{combinator}{}", c.text))
        .collect()
}

/// A compound selector, split into its type and the rest.
struct Compound {
    text: String,
    /// The type selector, lowercased, if it has one.
    tag: Option<String>,
    /// Whether it has `:root`.
    root: bool,
    /// The text without the type selector and `:root`.
    rest: String,
}

impl Compound {
    fn parse(text: &str) -> Compound {
        let tag_len = text
            .bytes()
            .take_while(|&b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'*')
            .count();
        let tag = (tag_len > 0).then(|| text[..tag_len].to_ascii_lowercase());
        let mut rest = String::new();
        let mut root = false;
        let mut copied = tag_len;
        let bytes = text.as_bytes();
        scan(&text[tag_len..], |at, byte, depth| {
            let at = at + tag_len;
            let is_root = depth == 0
                && byte == b':'
                && (at == 0 || bytes[at - 1] != b':')
                && text
                    .get(at + 1..at + 5)
                    .is_some_and(|s| s.eq_ignore_ascii_case("root"))
                && !bytes.get(at + 5).is_some_and(|&c| {
                    c.is_ascii_alphanumeric() || c == b'-' || c == b'_' || c == b'('
                });
            if is_root {
                rest.push_str(&text[copied..at]);
                copied = at + 5;
                root = true;
            }
            true
        });
        rest.push_str(&text[copied..]);
        Compound {
            text: text.to_owned(),
            tag,
            root,
            rest,
        }
    }

    fn is_page(&self) -> bool {
        self.root || matches!(self.tag.as_deref(), Some("html" | "body"))
    }

    /// Whether it can fold into the artboard's compound: it has no type
    /// selector other than `html`, `body` or `*`.
    fn mergeable(&self) -> bool {
        matches!(self.tag.as_deref(), None | Some("html" | "body" | "*"))
            && !self.rest.starts_with('|')
    }
}

/// `compound` with the selectors inside `:is()`, `:not()` and the like rewritten.
fn arguments(compound: &str, out: &mut Rewritten) -> String {
    if !compound.contains('(') || !mentions_page(compound) {
        return compound.to_owned();
    }
    let bytes = compound.as_bytes();
    let mut result = String::with_capacity(compound.len());
    let mut copied = 0;
    let mut open: Option<usize> = None;
    scan(compound, |at, byte, depth| {
        match (byte, depth) {
            (b'(', 0) => {
                let name_start = compound[..at]
                    .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '-'))
                    .map_or(0, |i| i + 1);
                let name = compound[name_start..at].to_ascii_lowercase();
                let is_pseudo = name_start > 0 && bytes[name_start - 1] == b':';
                if is_pseudo && TAKES_SELECTORS.contains(&name.as_str()) {
                    open = Some(at + 1);
                }
            }
            (b')', 0) => {
                if let Some(start) = open.take() {
                    result.push_str(&compound[copied..start]);
                    result.push_str(&selector_list(&compound[start..at], out));
                    copied = at;
                }
            }
            _ => {}
        }
        true
    });
    result.push_str(&compound[copied..]);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn css(source: &str) -> String {
        rewrite(source).css
    }

    #[test]
    fn page_selectors_select_the_artboard() {
        assert_eq!(
            css("body { color: red }"),
            ":where(.finite-root) { color: red }"
        );
        assert_eq!(css(":root{--x:1}"), ".finite-root{--x:1}");
        assert_eq!(
            css("html, body, div { margin: 0 }"),
            ":where(.finite-root), :where(.finite-root), div { margin: 0 }"
        );
        assert_eq!(css("BODY>main{}"), ":where(.finite-root)>main{}");
    }

    #[test]
    fn a_chain_of_page_elements_becomes_one_compound() {
        assert_eq!(
            css("html.dark body > main {}"),
            ":where(.finite-root).dark > main {}"
        );
        assert_eq!(
            css(":root[data-theme=\"dark\"] .a {}"),
            ".finite-root[data-theme=\"dark\"] .a {}"
        );
        assert_eq!(css("html > body {}"), ":where(.finite-root) {}");
        // `.client-js` can only have been on <html>, which is the artboard now.
        assert_eq!(
            css(".client-js body.skin .x {}"),
            ":where(.finite-root).client-js.skin .x {}"
        );
        assert_eq!(
            css("html:has(.menu) body {}"),
            ":where(.finite-root):has(.menu) {}"
        );
    }

    #[test]
    fn selectors_inside_pseudo_classes_are_rewritten() {
        assert_eq!(
            css(":is(html[data-theme=\"dark\"] .sun, html:not(.js) .moon) { display: block }"),
            ":is(:where(.finite-root)[data-theme=\"dark\"] .sun, :where(.finite-root):not(.js) .moon) { display: block }"
        );
    }

    #[test]
    fn nested_rules_are_rewritten_and_other_blocks_copied() {
        let source = "@media (min-width: 600px) { :root { --pad: 8px } }\n@keyframes body { from { opacity: 0 } }\n@font-face { font-family: html }";
        let expected = "@media (min-width: 600px) { .finite-root { --pad: 8px } }\n@keyframes body { from { opacity: 0 } }\n@font-face { font-family: html }";
        assert_eq!(css(source), expected);
    }

    #[test]
    fn other_words_strings_and_values_stay() {
        for source in [
            ".body, .html, #body, [data-x=body], htmlx, tbody, my-body { a: b }",
            ".a::after { content: \"html body :root\" }",
            ".a { font-family: body; --x: html }",
            "/* body */ .a { b: c }",
        ] {
            let rewritten = rewrite(source);
            assert_eq!(rewritten.mapped, 0, "{source}");
            assert_eq!(rewritten.unmapped, 0, "{source}");
        }
        assert_eq!(css("tbody td {}"), "tbody td {}");
        assert_eq!(
            css(".a { content: 'body' } body {}"),
            ".a { content: 'body' } :where(.finite-root) {}"
        );
    }

    #[test]
    fn what_cant_map_is_counted_and_left_alone() {
        let rewritten = rewrite("html + p {} div body {} body {}");
        assert_eq!(
            rewritten.css,
            "html + p {} div body {} :where(.finite-root) {}"
        );
        assert_eq!((rewritten.mapped, rewritten.unmapped), (1, 2));
    }
}
