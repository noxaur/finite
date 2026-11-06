//! A page's `<html>` and `<body>` become one artboard, so the page's rules
//! for `html`, `body` and `:root` would match nothing. These functions write
//! those selectors as selectors for the artboard, which carries [`CLASS`].
//! The app export writes them for a screen's wrapper instead, through
//! [`map_selector`].

use finite_design::css_scan::{Block, map_rules, scan, split_top, strip_comments};

/// The class an imported page's artboard carries.
pub(super) const CLASS: &str = "finite-root";

/// The cascade layer that holds the artboard's default look on an imported
/// page, so the page's own rules, layered or not, override it.
pub(super) const LAYER: &str = "finite-artboard";

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
    let mut out = Rewritten::default();
    // Nested rules can name the page too, so look inside style rules.
    let css = map_rules(css, |selectors| {
        (selector_list(selectors, CLASS, &mut out), Block::Rules)
    });
    Rewritten { css, ..out }
}

fn mentions_page(s: &str) -> bool {
    let lower = s.to_ascii_lowercase();
    lower.contains("html") || lower.contains("body") || lower.contains(":root")
}

/// A comma-separated selector list, rewritten.
fn selector_list(list: &str, class: &str, out: &mut Rewritten) -> String {
    if !mentions_page(list) {
        return list.to_owned();
    }
    let list = strip_comments(list);
    split_top(&list, |b| b == b',')
        .into_iter()
        .map(|selector| {
            if selector.trim().is_empty() {
                return selector.to_owned();
            }
            let lead = selector.len() - selector.trim_start().len();
            let trail = selector.trim_end().len();
            let core = &selector[lead..trail];
            let rewritten = match complex(core, class, out) {
                Some((rewritten, _)) => rewritten,
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

/// One complex selector, like `html.dark body > main`, rewritten, or `None`
/// if it names the page in a way that doesn't map onto the artboard. The
/// flag says whether it starts with the artboard, because it named the page.
fn complex(selector: &str, class: &str, out: &mut Rewritten) -> Option<(String, bool)> {
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
                Compound::parse(&arguments(text, class, out)),
            )
        })
        .collect();
    let Some(last_page) = parts.iter().rposition(|(_, c)| c.is_page()) else {
        return Some((join(&parts), false));
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
        format!(".{class}")
    } else {
        format!(":where(.{class})")
    };
    for (_, c) in &parts[..=last_page] {
        head.push_str(&c.rest);
    }
    out.mapped += 1;
    let tail = parts.split_off(last_page + 1);
    Some((format!("{head}{}", join(&tail)), true))
}

/// `selector` with its `html`, `body` and `:root` written for the element
/// with `class`, if it starts with one of them: `html.dark body > main` is
/// `:where(.screen).dark > main`. `None` if it doesn't, or names them in a
/// way that doesn't map onto one element, like `html + p`.
///
/// A selector that starts with `:is()` or `:where()` can name the page in one
/// of its alternatives, and then matches the element itself or what is inside
/// it: `:is(body, .x) .title` is `:is(:where(.screen), :where(.screen) .x)
/// .title`. Page names anywhere else in a pseudo-class, like `:not(body)` or
/// `.a:is(body, .b)`, map when the selector starts with the page and
/// otherwise stay as they were, which is how a page name that can't be
/// inside the element already behaves.
pub(crate) fn map_selector(selector: &str, class: &str) -> Option<String> {
    match complex(selector, class, &mut Rewritten::default()) {
        Some((mapped, true)) => Some(mapped),
        Some((_, false)) => anchored_alternatives(selector, class),
        None => None,
    }
}

/// `selector` when its first compound is `:is(…)` or `:where(…)` and one
/// of the alternatives names the page: each alternative is written for the
/// element, or limited to inside it, so the compound still matches only the
/// element and what is in it.
fn anchored_alternatives(selector: &str, class: &str) -> Option<String> {
    let (mut open, mut close, mut end) = (None, None, selector.len());
    scan(selector, |at, byte, depth| {
        match byte {
            b'(' if depth == 0 && open.is_none() => open = Some(at),
            b')' if depth == 0 && close.is_none() && open.is_some() => close = Some(at),
            b if depth == 0 && (b.is_ascii_whitespace() || matches!(b, b'>' | b'+' | b'~')) => {
                end = at;
                return false;
            }
            _ => {}
        }
        true
    });
    let (open, close) = (open?, close.filter(|&close| close < end)?);
    let name = selector.strip_prefix(':')?.get(..open - 1)?;
    if !["is", "where", "matches"]
        .iter()
        .any(|pseudo| name.eq_ignore_ascii_case(pseudo))
    {
        return None;
    }
    let mut names_page = false;
    let alternatives: Vec<String> = split_top(&selector[open + 1..close], |b| b == b',')
        .into_iter()
        .map(|alternative| {
            // A forgiving list drops an empty alternative, so it stays empty.
            if alternative.trim().is_empty() {
                return alternative.to_owned();
            }
            let lead = alternative.len() - alternative.trim_start().len();
            let trail = alternative.trim_end().len();
            let core = &alternative[lead..trail];
            let mapped = map_selector(core, class);
            names_page |= mapped.is_some();
            let mapped = mapped.unwrap_or_else(|| format!(":where(.{class}) {core}"));
            format!("{}{mapped}{}", &alternative[..lead], &alternative[trail..])
        })
        .collect();
    names_page.then(|| {
        format!(
            "{}{}{}",
            &selector[..=open],
            alternatives.join(","),
            &selector[close..]
        )
    })
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
fn arguments(compound: &str, class: &str, out: &mut Rewritten) -> String {
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
                    result.push_str(&selector_list(&compound[start..at], class, out));
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
    fn comment_marks_in_strings_stay() {
        assert_eq!(
            css("[data-x=\"/*\"] body, /* body */ [a='\\'/*'] {}"),
            ":where(.finite-root)[data-x=\"/*\"],  [a='\\'/*'] {}"
        );
        assert_eq!(css(":root{--a:\"/*\"}"), ".finite-root{--a:\"/*\"}");
    }

    #[test]
    fn an_empty_selector_stays_empty() {
        assert_eq!(css("body, {a:b}"), ":where(.finite-root), {a:b}");
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
