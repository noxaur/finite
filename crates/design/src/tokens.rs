//! Design tokens: named CSS values every artboard can use, like `--brand`.
//!
//! A token is a CSS custom property with one value per [`Mode`], such as
//! Light and Dark. Each artboard renders in one mode ([`Document::mode_of`]),
//! and [`style`] writes that mode's values as custom properties on the
//! artboard's root, so its HTML reads them with `var(--brand)`. A value can
//! use other tokens, as in `--button: var(--brand)`, and the browser
//! resolves it as it does any custom property.
//!
//! A token without a value for a mode falls back to its value in the first
//! mode, so a design can add a Dark mode and give it only the values that
//! change.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::document::Document;

/// A set of token values, like Light or Dark. Artboards pick one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Mode {
    pub name: String,
    /// Fractional index among modes (see [`crate::fractional`]).
    pub index: String,
}

/// A token's values by mode id.
pub type Values = BTreeMap<String, String>;

/// The id of a design's implicit first mode, before it names any modes.
pub const FIRST_MODE: &str = "mode-1";

/// The implicit first mode's name.
pub const FIRST_MODE_NAME: &str = "Default";

/// How many tokens a design can have. Every artboard carries all of them.
pub const MAX_TOKENS: usize = 2000;

/// How many modes a design can have.
pub const MAX_MODES: usize = 20;

/// The longest token name, `--` included.
pub const MAX_NAME: usize = 100;

/// The longest token value, enough for a long font stack or gradient.
pub const MAX_VALUE: usize = 2000;

/// The cascade layer the tokens go in. It comes after the base styles, so
/// an artboard's own `<style>` blocks and inline styles still override a
/// token with the same name.
pub const LAYER: &str = "finite-tokens";

/// Why a token name or value isn't allowed.
pub fn check_name(name: &str) -> Result<(), String> {
    let Some(rest) = name.strip_prefix("--") else {
        return Err(format!(
            "token names start with --, like --brand; {name:?} doesn't"
        ));
    };
    if rest.is_empty()
        || name.len() > MAX_NAME
        || !rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    {
        return Err(format!(
            "{name:?} isn't a token name: use --, then up to {} letters, digits, - or _",
            MAX_NAME - 2
        ));
    }
    Ok(())
}

/// Whether `value` can go in a custom property declaration as it is. It
/// can't end the declaration or its rule early (`;`, `{`, `}` and `!`
/// outside strings), leave a string, comment or bracket open, break a line,
/// or end the `<style>` element it's written in.
pub fn check_value(value: &str) -> Result<(), String> {
    let bad = |why: &str| Err(format!("the token value {value:?} {why}"));
    if value.trim().is_empty() {
        return bad("is empty; pass null to delete a token");
    }
    if value.len() > MAX_VALUE {
        return bad(&format!("is over {MAX_VALUE} characters"));
    }
    if value.to_ascii_lowercase().contains("</style") {
        return bad("can't contain </style");
    }
    // A line break ends a CSS string, so a quote across one wouldn't hold.
    if value.contains(['\n', '\r', '\x0c']) {
        return bad("can't contain a line break");
    }
    let bytes = value.as_bytes();
    let mut open = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' if i + 1 == bytes.len() => return bad("ends with a backslash"),
            b'\\' => i += 1,
            quote @ (b'"' | b'\'') => {
                i += 1;
                while i < bytes.len() && bytes[i] != quote {
                    if bytes[i] == b'\\' {
                        i += 1;
                    }
                    i += 1;
                }
                if i >= bytes.len() {
                    return bad("leaves a string open");
                }
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => match value[i + 2..].find("*/") {
                Some(end) => i += end + 3,
                None => return bad("leaves a comment open"),
            },
            b'(' => open.push(b')'),
            b'[' => open.push(b']'),
            close @ (b')' | b']') if open.pop() != Some(close) => {
                return bad(&format!("has an unmatched {}", close as char));
            }
            c @ (b';' | b'{' | b'}' | b'!') => {
                return bad(&format!("can't contain {} outside a string", c as char));
            }
            _ => {}
        }
        i += 1;
    }
    if !open.is_empty() {
        return bad("leaves a bracket open");
    }
    Ok(())
}

/// A token's value in `mode`, else in the first mode, else any value it has.
pub fn value<'a>(doc: &Document, values: &'a Values, mode: &str) -> Option<&'a str> {
    values
        .get(mode)
        .or_else(|| values.get(doc.first_mode()))
        .or_else(|| values.values().next())
        .map(String::as_str)
}

/// The tokens for an artboard in `mode`, as the text of a `<style>`
/// element. In a shadow root they go on `:host`, elsewhere on `:root`.
/// Empty when the design has no tokens.
pub fn style(doc: &Document, mode: &str, shadow: bool) -> String {
    if doc.tokens().is_empty() {
        return String::new();
    }
    let root = if shadow { ":host" } else { ":root" };
    let mut css = format!("@layer {LAYER} {{ {root} {{");
    for (name, values) in doc.tokens() {
        if let Some(value) = value(doc, values, mode) {
            css.push_str(&format!(" {name}: {value};"));
        }
    }
    css.push_str(" } }");
    css
}

/// Old shared CSS split for [`crate::Design::migrate_css`].
#[derive(Debug, Default, PartialEq)]
pub struct Migrated {
    /// The custom properties its top-level `:root` rules defined, in order.
    pub tokens: Vec<(String, String)>,
    /// Everything else, for each artboard's own `<style>`. `None` when
    /// nothing is left.
    pub rest: Option<String>,
}

/// Splits shared CSS into tokens and the rules that aren't tokens. A
/// custom property in a top-level `:root` rule becomes a token; any other
/// declaration there stays in a `:root` rule in `rest`, and so does a
/// property that isn't a valid token.
pub fn migrate(css: &str) -> Migrated {
    let mut tokens: Vec<(String, String)> = Vec::new();
    let mut rest: Vec<String> = Vec::new();
    let mut at = 0;
    while at < css.len() {
        let end = rule_end(css, at);
        let rule = &css[at..end];
        at = end;
        let root = rule.find('{').and_then(|open| {
            let selector = strip_comments(&rule[..open]);
            let selector = selector.trim();
            let body = rule[open + 1..].strip_suffix('}')?;
            selector.eq_ignore_ascii_case(":root").then_some(body)
        });
        let Some(body) = root else {
            if !rule.trim().is_empty() {
                rest.push(rule.trim().to_owned());
            }
            continue;
        };
        let mut kept = Vec::new();
        for declaration in split_declarations(body) {
            let token = declaration.split_once(':').and_then(|(name, value)| {
                let (name, value) = (name.trim(), value.trim());
                (check_name(name).is_ok() && check_value(value).is_ok())
                    .then(|| (name.to_owned(), value.to_owned()))
            });
            match token {
                Some((name, value)) => {
                    tokens.retain(|(n, _)| *n != name);
                    tokens.push((name, value));
                }
                None if !declaration.trim().is_empty() => kept.push(declaration.trim()),
                None => {}
            }
        }
        if !kept.is_empty() {
            rest.push(format!(":root {{ {}; }}", kept.join("; ")));
        }
    }
    Migrated {
        tokens,
        rest: (!rest.is_empty()).then(|| rest.join("\n")),
    }
}

/// `css` without its comments.
fn strip_comments(css: &str) -> String {
    let mut out = String::new();
    let mut rest = css;
    while let Some(at) = rest.find("/*") {
        out.push_str(&rest[..at]);
        rest = rest[at + 2..]
            .find("*/")
            .map_or("", |end| &rest[at + 2 + end + 2..]);
    }
    out.push_str(rest);
    out
}

/// The end of the top-level rule or statement at `start`: past the `}`
/// that closes its block, or past its `;`. Leading whitespace and comments
/// belong to it.
fn rule_end(css: &str, start: usize) -> usize {
    let bytes = css.as_bytes();
    let mut depth = 0usize;
    let mut i = start;
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 1,
            b'"' | b'\'' => i = string_end(css, i) - 1,
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = css[i + 2..].find("*/").map_or(css.len(), |end| i + end + 3);
            }
            b'{' => depth += 1,
            b'}' if depth <= 1 => return i + 1,
            b'}' => depth -= 1,
            b';' if depth == 0 => return i + 1,
            _ => {}
        }
        i += 1;
    }
    css.len()
}

/// The declarations in a rule's body, split at `;` outside strings,
/// comments and brackets.
fn split_declarations(body: &str) -> Vec<&str> {
    let bytes = body.as_bytes();
    let (mut parts, mut depth, mut from, mut i) = (Vec::new(), 0usize, 0, 0);
    while i < bytes.len() {
        match bytes[i] {
            b'\\' => i += 1,
            b'"' | b'\'' => i = string_end(body, i) - 1,
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                i = body[i + 2..]
                    .find("*/")
                    .map_or(body.len(), |end| i + end + 3);
            }
            b'(' | b'[' | b'{' => depth += 1,
            b')' | b']' | b'}' => depth = depth.saturating_sub(1),
            b';' if depth == 0 => {
                parts.push(&body[from..i]);
                from = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    parts.push(&body[from..]);
    parts
}

/// The end of the quoted string that starts at `start`, past its closing quote.
fn string_end(css: &str, start: usize) -> usize {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_custom_properties() {
        assert!(check_name("--brand").is_ok());
        assert!(check_name("--space_2-x").is_ok());
        assert!(check_name("brand").is_err());
        assert!(check_name("--").is_err());
        assert!(check_name("--a b").is_err());
        assert!(check_name("--a;").is_err());
        assert!(check_name(&format!("--{}", "a".repeat(MAX_NAME))).is_err());
    }

    #[test]
    fn values_cant_break_out_of_their_declaration() {
        for ok in [
            "#c2410c",
            "'Geist', system-ui, sans-serif",
            "var(--brand)",
            "linear-gradient(90deg, rgb(0 0 0 / 50%), transparent)",
            "\"a;b{c}\"",
            "url(\"x.png\") /* note; */",
        ] {
            assert_eq!(check_value(ok), Ok(()), "{ok}");
        }
        for bad in [
            "",
            "  ",
            "red; color: blue",
            "red } .x { color: blue",
            "red !important",
            "calc(1px",
            "a)",
            "'open",
            "/* open",
            "a\\",
            "x</style><script>",
            "\"\n; } } :root { color: red; } /*\"",
            "a\nb",
        ] {
            assert!(check_value(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn migrate_moves_root_variables_into_tokens() {
        let css = "@import url('https://fonts.example/a;b.css');\n\
                   /* colors */ :root{--ink:#111;--font:'A;B', serif;color:red}\n\
                   .btn{color:var(--ink)}\n\
                   :root { --ink: #222; --bad: red !important }";
        let migrated = migrate(css);
        assert_eq!(
            migrated.tokens,
            [
                ("--font".to_owned(), "'A;B', serif".to_owned()),
                ("--ink".to_owned(), "#222".to_owned()),
            ]
        );
        assert_eq!(
            migrated.rest.as_deref(),
            Some(
                "@import url('https://fonts.example/a;b.css');\n:root { color:red; }\n\
                 .btn{color:var(--ink)}\n\
                 :root { --bad: red !important; }"
            )
        );
        assert_eq!(
            migrate(":root { --a: 1px }").rest,
            None,
            "nothing is left when it was all tokens"
        );
    }
}
