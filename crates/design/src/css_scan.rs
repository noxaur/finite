//! Finding your way through CSS text: where a string, a comment, a
//! statement, a rule or a `url(…)` ends. These are byte scanners for code
//! that rewrites a stylesheet and keeps every other byte as it was. Code
//! that needs the values of declarations parses with `cssparser` instead
//! (see [`crate::css`]).

/// The end of the quoted string that starts at `start`, past its closing quote.
pub fn string_end(css: &str, start: usize) -> usize {
    let bytes = css.as_bytes();
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            c if c == bytes[start] => return i + 1,
            _ => i += 1,
        }
    }
    bytes.len()
}

/// The end of the comment that starts at `start`, past its `*/`.
pub fn comment_end(css: &str, start: usize) -> usize {
    css[start + 2..]
        .find("*/")
        .map_or(css.len(), |end| start + 2 + end + 2)
}

/// How far `css` starts with whitespace and comments.
pub fn skip_trivia(css: &str) -> usize {
    let mut at = 0;
    loop {
        at = css.len() - css[at..].trim_start().len();
        if !css[at..].starts_with("/*") {
            return at;
        }
        at = comment_end(css, at);
    }
}

/// `css` without its comments. A `/*` inside a string or after a backslash
/// isn't one.
pub fn strip_comments(css: &str) -> String {
    let bytes = css.as_bytes();
    let mut out = String::with_capacity(css.len());
    let (mut copied, mut i) = (0, 0);
    while i < bytes.len() {
        match bytes[i] {
            b'"' | b'\'' => i = string_end(css, i),
            b'\\' => i += 2,
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                out.push_str(&css[copied..i]);
                i = comment_end(css, i);
                copied = i;
            }
            _ => i += 1,
        }
    }
    out.push_str(&css[copied.min(css.len())..]);
    out
}

/// The end of the statement `css` starts with, past its `;`. Semicolons in
/// strings, comments and parentheses, like a font URL's `wght@400;700`,
/// don't count.
pub fn statement_end(css: &str) -> usize {
    let bytes = css.as_bytes();
    let mut depth = 0usize;
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'"' | b'\'' => {
                i = string_end(css, i);
                continue;
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = comment_end(css, i);
                continue;
            }
            b'(' => depth += 1,
            b')' => depth = depth.saturating_sub(1),
            b';' if depth == 0 => return i + 1,
            _ => {}
        }
        i += 1;
    }
    bytes.len()
}

/// The end of the `url(…)` that `css` starts with, past its `)`. A quoted
/// URL can hold a `)`.
pub fn url_end(css: &str) -> usize {
    let bytes = css.as_bytes();
    let mut i = 4;
    while i < bytes.len() {
        match bytes[i] {
            b'"' | b'\'' => i = string_end(css, i),
            b'\\' => i += 2,
            b')' => return i + 1,
            _ => i += 1,
        }
    }
    bytes.len()
}

/// Whether `css` starts with `keyword`, in any case.
pub fn starts_with_ignore_case(css: &str, keyword: &str) -> bool {
    css.get(..keyword.len())
        .is_some_and(|s| s.eq_ignore_ascii_case(keyword))
}

/// The URL in the `url(…)` that `css` starts with, unquoted, and the end of
/// the token. `None` if `css` doesn't start with `url(`.
pub fn url_token(css: &str) -> Option<(&str, usize)> {
    if !starts_with_ignore_case(css, "url(") {
        return None;
    }
    let end = url_end(css);
    let inner = css[4..end].strip_suffix(')').unwrap_or(&css[4..end]).trim();
    Some((unquote(inner), end))
}

/// `value` without one pair of quotes around it.
pub fn unquote(value: &str) -> &str {
    let value = value.trim();
    for q in ['"', '\''] {
        if let Some(inner) = value.strip_prefix(q).and_then(|v| v.strip_suffix(q)) {
            return inner;
        }
    }
    value
}

/// The URLs in CSS: each `url(…)`, and each `@import "…"`. Strings and
/// comments are skipped.
pub fn urls(css: &str) -> Vec<String> {
    let bytes = css.as_bytes();
    let mut urls = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 2,
            b'"' | b'\'' => i = string_end(css, i),
            b'/' if bytes.get(i + 1) == Some(&b'*') => i = comment_end(css, i),
            b'u' | b'U' => match url_token(&css[i..]) {
                Some((url, len)) => {
                    urls.push(url.to_owned());
                    i += len;
                }
                None => i += 1,
            },
            b'@' if starts_with_ignore_case(&css[i..], "@import") => {
                i += "@import".len();
                let rest = &css[i..];
                let quoted = skip_trivia(rest);
                if let Some(quote) = rest[quoted..]
                    .chars()
                    .next()
                    .filter(|c| matches!(c, '"' | '\''))
                {
                    let len = string_end(rest, quoted);
                    let inner = rest[quoted + 1..len]
                        .strip_suffix(quote)
                        .unwrap_or(&rest[quoted + 1..len]);
                    urls.push(inner.trim().to_owned());
                    i += len;
                }
            }
            _ => i += 1,
        }
    }
    urls
}

/// Calls `f` with each byte outside strings and comments, its offset and
/// how deep it is in `()` and `[]`, until `f` returns false.
pub fn scan(s: &str, mut f: impl FnMut(usize, u8, usize) -> bool) {
    let bytes = s.as_bytes();
    let (mut i, mut depth) = (0, 0usize);
    while i < bytes.len() {
        match bytes[i] {
            b'"' | b'\'' => i = string_end(s, i),
            b'/' if bytes.get(i + 1) == Some(&b'*') => i = comment_end(s, i),
            b'\\' => i += 2,
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
                i += 1;
            }
        }
    }
}

/// `s` split at each top-level byte that `split` accepts.
pub fn split_top(s: &str, split: impl Fn(u8) -> bool) -> Vec<&str> {
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

/// Where the prelude that starts at `from` ends: at the first `{`, `;` or
/// `}` outside strings, comments and brackets, or at the end.
pub fn prelude_end(css: &str, from: usize) -> usize {
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

/// The offset of the `}` that closes the block opening at `open`, if there is one.
pub fn block_end(css: &str, open: usize) -> Option<usize> {
    let mut level = 0usize;
    let mut end = None;
    scan(&css[open..], |at, byte, _| {
        match byte {
            b'{' => level += 1,
            b'}' => {
                level -= 1;
                if level == 0 {
                    end = Some(open + at);
                    return false;
                }
            }
            _ => {}
        }
        true
    });
    end
}

/// At-rules whose block holds rules, so [`map_rules`] looks inside. Any
/// other at-rule's block, like `@keyframes` or `@font-face`, is copied.
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

/// What [`map_rules`] does with the block of a style rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Block {
    /// Copy it as it is.
    Copy,
    /// Look inside for nested rules.
    Rules,
}

/// The lowercase name of the at-rule that `prelude` starts, if it starts
/// one. A bare `@` has an empty name.
pub fn at_rule_name(prelude: &str) -> Option<String> {
    let comments = strip_comments(prelude);
    let at = comments.trim_start().strip_prefix('@')?;
    Some(
        at.chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '-')
            .collect::<String>()
            .to_ascii_lowercase(),
    )
}

/// `css` with the selector list of each style rule replaced by what `rule`
/// returns for it, along with whether to look inside its block for nested
/// rules. Rules inside grouping at-rules (`@media`, `@supports`, `@layer`
/// and the like) are found too; every other at-rule, declaration and
/// comment stays as it is.
pub fn map_rules(css: &str, mut rule: impl FnMut(&str) -> (String, Block)) -> String {
    let mut out = String::with_capacity(css.len() + 64);
    let mut i = 0;
    while i < css.len() {
        let end = prelude_end(css, i);
        let prelude = &css[i..end];
        match css.as_bytes().get(end) {
            Some(b'{') => {
                let after = || block_end(css, end).map_or(css.len(), |brace| brace + 1);
                match at_rule_name(prelude) {
                    Some(name) if GROUPING.contains(&name.as_str()) => {
                        out.push_str(&css[i..=end]);
                        i = end + 1;
                    }
                    Some(_) => {
                        let close = after();
                        out.push_str(&css[i..close]);
                        i = close;
                    }
                    None => {
                        let (selectors, block) = rule(prelude);
                        out.push_str(&selectors);
                        match block {
                            Block::Rules => {
                                out.push('{');
                                i = end + 1;
                            }
                            Block::Copy => {
                                let close = after();
                                out.push_str(&css[end..close]);
                                i = close;
                            }
                        }
                    }
                }
            }
            // A declaration, an at-rule statement or the end of a block.
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
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_are_found_outside_comments() {
        let css = r#"@import "a.css"; @import 'b.css'; .x { background: url( "c.png" ), URL(d.png) }
            /* url(e.png) */ .y { content: "url(f.png)"; background: url("g)h.png") }"#;
        assert_eq!(urls(css), ["a.css", "b.css", "c.png", "d.png", "g)h.png"]);
    }

    #[test]
    fn comments_inside_strings_stay() {
        assert_eq!(
            strip_comments(r#"a /* x */ "/* y */" \/* b"#),
            r#"a  "/* y */" \/* b"#
        );
    }
}
