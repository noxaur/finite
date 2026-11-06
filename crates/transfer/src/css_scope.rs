//! A stylesheet limited to one element's subtree. The app export puts every
//! screen of a route in the page at once and hides all but one, so a rule in
//! one screen's `<style>` would otherwise restyle the others.

use crate::html::page_css::{
    GROUPING, block_end, map_selector, prelude_end, split_top, strip_comments,
};

/// `css` with each style rule limited to elements inside the one with
/// `class`, at the specificity it had: `.title { … }` is
/// `:where(.screen) .title { … }`. `html`, `body` and `:root` are that
/// element, as they are the page in a document of its own: `body { … }` is
/// `:where(.screen) { … }`. Rules inside `@media`, `@supports`, `@layer` and
/// the like are limited too. `@keyframes`, `@font-face` and the rest stay as
/// they are, and so does a style rule's block, with any rules nested in it,
/// since nested selectors are relative to the rule already.
///
/// A selector that starts with `:is()` or `:where()` and names the page in
/// one alternative matches the element and what is inside it, see
/// [`map_selector`]. A page name anywhere else inside a pseudo-class, like
/// `.a:is(body, .b)`, is left as it was, and so doesn't match, since the page
/// is never inside the element.
pub(crate) fn scope(css: &str, class: &str) -> String {
    let mut out = String::with_capacity(css.len() + 32);
    rules(css, class, &mut out);
    out
}

fn rules(css: &str, class: &str, out: &mut String) {
    let mut i = 0;
    while i < css.len() {
        let end = prelude_end(css, i);
        let prelude = &css[i..end];
        match css.as_bytes().get(end) {
            Some(b'{') => {
                let close = block_end(css, end);
                let after = close.map_or(css.len(), |brace| brace + 1);
                let comments = strip_comments(prelude);
                if comments.trim_start().starts_with('@') {
                    if at_rule(&comments).is_some_and(|name| GROUPING.contains(&name.as_str())) {
                        out.push_str(&comments);
                        out.push('{');
                        rules(&css[end + 1..close.unwrap_or(css.len())], class, out);
                        if close.is_some() {
                            out.push('}');
                        }
                    } else {
                        out.push_str(&css[i..after]);
                    }
                } else {
                    let lead = comments.len() - comments.trim_start().len();
                    out.push_str(&comments[..lead]);
                    out.push_str(&selector_list(comments.trim_start(), class));
                    out.push_str(&css[end..after]);
                }
                i = after;
            }
            // An at-rule statement like `@import`, a declaration, or a stray `}`.
            Some(_) => {
                out.push_str(&css[i..=end]);
                i = end + 1;
            }
            None => {
                out.push_str(prelude);
                break;
            }
        }
    }
}

/// The lowercase name of the at-rule that `prelude` starts.
fn at_rule(prelude: &str) -> Option<String> {
    let name: String = prelude
        .trim_start()
        .strip_prefix('@')?
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
        .collect();
    (!name.is_empty()).then(|| name.to_ascii_lowercase())
}

fn selector_list(list: &str, class: &str) -> String {
    split_top(list, |b| b == b',')
        .into_iter()
        .map(|selector| {
            let lead = selector.len() - selector.trim_start().len();
            let trail = selector.trim_end().len();
            let core = &selector[lead..trail];
            let scoped =
                map_selector(core, class).unwrap_or_else(|| format!(":where(.{class}) {core}"));
            format!("{}{scoped}{}", &selector[..lead], &selector[trail..])
        })
        .collect::<Vec<_>>()
        .join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn css(source: &str) -> String {
        scope(source, "s")
    }

    #[test]
    fn rules_apply_inside_the_element_at_the_same_specificity() {
        assert_eq!(css(".a{color:red}"), ":where(.s) .a{color:red}");
        assert_eq!(
            css(".a, p > b:hover ,\n[x=\"a,b\"]{c:d}"),
            ":where(.s) .a, :where(.s) p > b:hover ,\n:where(.s) [x=\"a,b\"]{c:d}"
        );
        assert_eq!(css("*{a:b}"), ":where(.s) *{a:b}");
        assert_eq!(css("/* x, y */ .a{b:c}"), " :where(.s) .a{b:c}");
    }

    #[test]
    fn the_page_is_the_element() {
        assert_eq!(css("body{margin:0}"), ":where(.s){margin:0}");
        assert_eq!(
            css("html, body{margin:0}"),
            ":where(.s), :where(.s){margin:0}"
        );
        assert_eq!(css(":root{--a:1}"), ".s{--a:1}");
        assert_eq!(
            css("html.dark body > main{a:b}"),
            ":where(.s).dark > main{a:b}"
        );
        // Nothing in the element is a sibling of it.
        assert_eq!(css("html + p{a:b}"), ":where(.s) html + p{a:b}");
        assert_eq!(css("tbody td{a:b}"), ":where(.s) tbody td{a:b}");
    }

    #[test]
    fn conditions_and_layers_are_scoped_and_other_blocks_stay() {
        assert_eq!(
            css("@media (width > 600px){.a{b:c}@supports (x:y){.d{e:f}}}"),
            "@media (width > 600px){:where(.s) .a{b:c}@supports (x:y){:where(.s) .d{e:f}}}"
        );
        assert_eq!(
            css("@layer base{:root{--a:1}}@layer base;"),
            "@layer base{.s{--a:1}}@layer base;"
        );
        let kept = "@keyframes spin{from{a:b}50%{a:c}to{a:d}}@font-face{font-family:x;src:url(a.woff)}@page{margin:0}@import url(a.css);";
        assert_eq!(css(kept), kept);
    }

    #[test]
    fn a_rules_block_is_copied_with_what_is_nested_in_it() {
        assert_eq!(
            css(".a{color:red; .b{color:blue} &:hover{c:d} @media (x){e:f}}"),
            ":where(.s) .a{color:red; .b{color:blue} &:hover{c:d} @media (x){e:f}}"
        );
        assert_eq!(
            css(".a::after{content:\"} { .b\"}.c{d:e}"),
            ":where(.s) .a::after{content:\"} { .b\"}:where(.s) .c{d:e}"
        );
    }

    #[test]
    fn comment_marks_in_strings_are_not_comments() {
        assert_eq!(
            css("[data-x=\"/*\"] { color:red }"),
            ":where(.s) [data-x=\"/*\"] { color:red }"
        );
        assert_eq!(
            css("[data-x='/*'], .b { c:d } /* \"x */ .e { f:g }"),
            ":where(.s) [data-x='/*'], :where(.s) .b { c:d }  :where(.s) .e { f:g }"
        );
        // An escaped quote doesn't end the string, and an escaped slash doesn't start a comment.
        assert_eq!(
            css("[a=\"\\\"/*\"] .b { c:d } .c\\/* .d { e:f }"),
            ":where(.s) [a=\"\\\"/*\"] .b { c:d } :where(.s) .c\\/* .d { e:f }"
        );
        assert_eq!(
            css("@media (x) { [data-x=\"/*\"] { c:d } }"),
            "@media (x) { :where(.s) [data-x=\"/*\"] { c:d } }"
        );
    }

    #[test]
    fn pages_named_inside_pseudo_classes_are_the_element() {
        // The page alternative is the element, and the others are inside it.
        assert_eq!(
            css(":is(body, .x) .title{a:b}"),
            ":is(:where(.s), :where(.s) .x) .title{a:b}"
        );
        assert_eq!(
            css(":where( html , .x ) > .t{a:b}"),
            ":where( :where(.s) , :where(.s) .x ) > .t{a:b}"
        );
        assert_eq!(
            css(":is(:root, body .a, .b):hover{a:b}"),
            ":is(.s, :where(.s) .a, :where(.s) .b):hover{a:b}"
        );
        assert_eq!(
            css(":is(:is(body), .x) .t{a:b}"),
            ":is(:is(:where(.s)), :where(.s) .x) .t{a:b}"
        );
        // Without a page, it is limited as any selector is.
        assert_eq!(css(":is(.a, .b) .t{c:d}"), ":where(.s) :is(.a, .b) .t{c:d}");
        // Elsewhere a page can't be inside the element, and the selector stays.
        assert_eq!(css(".t:not(body){a:b}"), ":where(.s) .t:not(body){a:b}");
        assert_eq!(
            css(".a :is(body, .x){a:b}"),
            ":where(.s) .a :is(body, .x){a:b}"
        );
    }

    #[test]
    fn broken_css_is_still_limited() {
        assert_eq!(css(".a{color:red"), ":where(.s) .a{color:red");
        assert_eq!(css("@media (x){.a{b:c}"), "@media (x){:where(.s) .a{b:c}");
        assert_eq!(
            css(".a{b:c}}.d{e:f}"),
            ":where(.s) .a{b:c}}:where(.s) .d{e:f}"
        );
        assert_eq!(css(""), "");
    }
}
