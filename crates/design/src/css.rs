//! Merging a patch into a stylesheet, so an agent can change part of a
//! `<style>` block without writing all of it again.
//!
//! [`merge_sheet`] parses both sheets with `cssparser` into a tree whose
//! pieces are the exact text they came from, so a rule the patch doesn't
//! touch prints back byte for byte, comments and spacing included.

use std::fmt;

use cssparser::{ParseError, Parser, Token};

use crate::NodeId;

/// Why a patch couldn't be merged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CssError(pub String);

impl fmt::Display for CssError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for CssError {}

/// One thing [`merge_sheet`] changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SheetChange {
    /// The at-rules around it, outermost first, like `@media (max-width: 600px)`.
    pub context: Vec<String>,
    /// The rule's selector, or the at-rule, like `@keyframes spin`.
    pub target: String,
    pub kind: SheetChangeKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SheetChangeKind {
    Added,
    Removed,
    /// An at-rule replaced whole, like `@keyframes` by name.
    Replaced,
    /// A rule that was there took the patch's declarations. Empty when it
    /// already had them.
    Declarations(Vec<DeclChange>),
}

/// A declaration's value before and after: `None` for one that wasn't
/// there, or was removed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeclChange {
    pub property: String,
    pub old: Option<String>,
    pub new: Option<String>,
}

impl fmt::Display for SheetChange {
    /// Like `.bar: color: red → blue, padding: 4px → removed, margin: 0 (new)`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut target = String::new();
        for at in &self.context {
            target.push_str(at);
            target.push(' ');
        }
        target.push_str(&self.target);
        let changes = match &self.kind {
            SheetChangeKind::Added => return write!(f, "added {target}"),
            SheetChangeKind::Removed => return write!(f, "removed {target}"),
            SheetChangeKind::Replaced => return write!(f, "replaced {target}"),
            SheetChangeKind::Declarations(changes) => changes,
        };
        if changes.is_empty() {
            return write!(f, "{target}: already had those values");
        }
        write!(f, "{target}: ")?;
        for (i, change) in changes.iter().enumerate() {
            if i > 0 {
                f.write_str(", ")?;
            }
            let property = &change.property;
            match (&change.old, &change.new) {
                (Some(old), Some(new)) => write!(f, "{property}: {old} → {new}")?,
                (Some(old), None) => write!(f, "{property}: {old} → removed")?,
                (None, Some(new)) => write!(f, "{property}: {new} (new)")?,
                (None, None) => {}
            }
        }
        Ok(())
    }
}

/// Merges `patch` into the stylesheet `existing`, and says what changed.
///
/// - A rule with the same selector (ignoring whitespace) in the same at-rules
///   takes the patch's declarations; `prop: unset` removes one.
/// - An empty rule, `.x {}`, removes the rule.
/// - A rule that isn't there is added at the end of its at-rule, without its
///   `unset`s.
/// - `@keyframes` replace the ones with the same name.
/// - Rule-holding at-rules (`@media`, `@supports`, `@layer`, `@container`,
///   `@scope`) merge recursively; other at-rules with declarations
///   (`@font-face`, `@page`, `@property`) merge like rules, and a
///   `@font-face` is the same one when its family, style and weight are.
/// - Statements like `@import` are added unless the sheet has them;
///   `@import`s go after the sheet's first ones, where they still count.
///
/// Rules the patch doesn't touch keep their exact text. `existing` is read
/// as browsers read it, never refused; a patch that isn't rules is.
pub fn merge_sheet(existing: &str, patch: &str) -> Result<(String, Vec<SheetChange>), CssError> {
    let patch = parse(patch, true)?;
    let mut sheet = parse(existing, false)?;
    let mut changes = Vec::new();
    merge_list(&mut sheet, patch.items, &mut Vec::new(), &mut changes);
    Ok((sheet.to_string(), changes))
}

/// A style rule in a patch, and the properties it sets.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PatchRule {
    /// The at-rules around it, outermost first.
    pub context: Vec<String>,
    pub selector: String,
    /// The properties it sets, lowercase, in order. Not those it unsets.
    pub properties: Vec<String>,
}

/// The style rules in `patch`, for matching their selectors.
pub fn patch_rules(patch: &str) -> Result<Vec<PatchRule>, CssError> {
    fn walk(list: &List, context: &mut Vec<String>, out: &mut Vec<PatchRule>) {
        for item in &list.items {
            match &item.body {
                Body::Decls(decls, _) if !item.prelude.starts_with('@') => {
                    let properties = decls
                        .set()
                        .filter(|d| !d.unsets())
                        .map(|d| d.name.to_ascii_lowercase())
                        .collect();
                    out.push(PatchRule {
                        context: context.clone(),
                        selector: collapse(&item.prelude),
                        properties,
                    });
                }
                Body::Rules(inner, _) => {
                    context.push(collapse(&item.prelude));
                    walk(inner, context, out);
                    context.pop();
                }
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(&parse(patch, true)?, &mut Vec::new(), &mut out);
    Ok(out)
}

/// A property a patch rule sets that inline styles override on some of
/// the elements it matches, since an inline style beats a stylesheet rule.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InlineConflict {
    pub selector: String,
    pub property: String,
    pub nodes: Vec<NodeId>,
}

/// Which of `rule`'s properties inline styles override. `matched` holds
/// each element the rule's selector matched, with the properties its
/// inline style sets. A shorthand and its longhands count as the same
/// property, so an inline `padding` beats `padding-top` and back.
pub fn inline_conflicts(
    rule: &PatchRule,
    matched: &[(NodeId, Vec<String>)],
) -> Vec<InlineConflict> {
    let overlaps =
        |a: &str, b: &str| a.eq_ignore_ascii_case(b) || longhand_of(a, b) || longhand_of(b, a);
    rule.properties
        .iter()
        .filter_map(|property| {
            let nodes: Vec<NodeId> = matched
                .iter()
                .filter(|(_, inline)| inline.iter().any(|p| overlaps(p, property)))
                .map(|(id, _)| id.clone())
                .collect();
            (!nodes.is_empty()).then(|| InlineConflict {
                selector: rule.selector.clone(),
                property: property.clone(),
                nodes,
            })
        })
        .collect()
}

/// Whether `long` is a longhand of `short`, like `padding-top` of `padding`.
fn longhand_of(long: &str, short: &str) -> bool {
    long.len() > short.len() + 1
        && long.as_bytes()[short.len()] == b'-'
        && long[..short.len()].eq_ignore_ascii_case(short)
}

/// Rules and at-rules, in order, then what follows the last of them.
#[derive(Clone, Debug, Default)]
struct List {
    items: Vec<Item>,
    /// Whitespace and comments after the last item.
    tail: String,
}

#[derive(Clone, Debug)]
struct Item {
    /// Whitespace and comments before it.
    lead: String,
    /// Everything up to its block's `{`, or the whole statement with its `;`.
    prelude: String,
    body: Body,
}

#[derive(Clone, Debug)]
enum Body {
    /// A statement, like `@import url(a.css);`.
    None,
    /// A block of rules, like `@media`'s, and its closing `}` (empty when
    /// the sheet ended first).
    Rules(List, String),
    /// A block of declarations, like a style rule's, and its closing `}`.
    Decls(Decls, String),
    /// A block kept as text, `{` to `}`, like `@keyframes`'.
    Raw(String),
}

#[derive(Clone, Debug, Default)]
struct Decls {
    items: Vec<Decl>,
    tail: String,
}

#[derive(Clone, Debug)]
struct Decl {
    lead: String,
    /// Its exact text, with its `;` if it had one.
    raw: String,
    /// Empty for anything that isn't a declaration, like a nested rule.
    name: String,
    /// Trimmed, with any `!important`.
    value: String,
}

impl Decls {
    /// The declarations, without nested rules or anything else.
    fn set(&self) -> impl Iterator<Item = &Decl> {
        self.items.iter().filter(|d| !d.name.is_empty())
    }
}

impl Decl {
    fn unsets(&self) -> bool {
        self.value.eq_ignore_ascii_case("unset")
    }

    fn is(&self, name: &str) -> bool {
        // Custom properties are case-sensitive; the rest aren't.
        if name.starts_with("--") {
            self.name == name
        } else {
            self.name.eq_ignore_ascii_case(name)
        }
    }
}

impl fmt::Display for List {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for item in &self.items {
            write!(f, "{}{}", item.lead, item.prelude)?;
            match &item.body {
                Body::None => {}
                Body::Rules(list, close) => write!(f, "{{{list}{close}")?,
                Body::Decls(decls, close) => {
                    f.write_str("{")?;
                    for decl in &decls.items {
                        write!(f, "{}{}", decl.lead, decl.raw)?;
                    }
                    write!(f, "{}{close}", decls.tail)?;
                }
                Body::Raw(raw) => f.write_str(raw)?,
            }
        }
        f.write_str(&self.tail)
    }
}

/// At-rules whose block holds rules rather than declarations.
const GROUPS: &[&str] = &[
    "media",
    "supports",
    "layer",
    "container",
    "scope",
    "starting-style",
    "document",
    "-moz-document",
];

/// Statements that only count before every other rule.
const LEADING: &[&str] = &["charset", "import", "namespace"];

fn parse(css: &str, strict: bool) -> Result<List, CssError> {
    let mut parser = Parser::new(css);
    parse_list(&mut parser, strict)
}

/// Whitespace and comments from here on.
fn skip_trivia(p: &mut Parser<'_>) {
    loop {
        let state = p.state();
        let trivia = matches!(
            p.next_including_whitespace_and_comments(),
            Ok(Token::WhiteSpace(_) | Token::Comment(_))
        );
        if !trivia {
            p.reset(&state);
            return;
        }
    }
}

fn parse_list(p: &mut Parser<'_>, strict: bool) -> Result<List, CssError> {
    let mut items = Vec::new();
    loop {
        let lead_start = p.position();
        skip_trivia(p);
        let start = p.position();
        let lead = p.slice(lead_start..start).to_owned();
        let state = p.state();
        let at = match p.next_including_whitespace_and_comments() {
            Err(_) => return Ok(List { items, tail: lead }),
            Ok(Token::AtKeyword(name)) => Some(name.to_ascii_lowercase()),
            Ok(Token::CloseCurlyBracket) => {
                if strict {
                    return Err(CssError("the CSS has a } that closes nothing.".into()));
                }
                items.push(Item {
                    lead,
                    prelude: "}".into(),
                    body: Body::None,
                });
                continue;
            }
            Ok(_) => {
                p.reset(&state);
                None
            }
        };
        // Up to the block, or the `;` that ends a statement.
        let block_start = loop {
            let before = p.position();
            match p.next_including_whitespace_and_comments() {
                Ok(Token::CurlyBracketBlock) => break Some(before),
                Ok(Token::Semicolon) | Err(_) => break None,
                Ok(token) if opens_block(token) => skip_block(p),
                Ok(_) => {}
            }
        };
        let Some(block_start) = block_start else {
            let prelude = p.slice_from(start).to_owned();
            if strict && at.is_none() {
                let text = prelude.trim().trim_end_matches(';');
                return Err(CssError(format!(
                    "`{text}` isn't a rule. Put declarations in one, like `.card {{ {text}; }}`."
                )));
            }
            items.push(Item {
                lead,
                prelude,
                body: Body::None,
            });
            continue;
        };
        let prelude = p.slice(start..block_start).to_owned();
        let body = match at.as_deref() {
            Some(name) if GROUPS.contains(&name) => {
                let (list, inner_end) = nested(p, |p| parse_list(p, strict))?;
                Body::Rules(list, p.slice(inner_end..p.position()).to_owned())
            }
            Some(name) if name.ends_with("keyframes") => {
                nested(p, |p| {
                    while p.next_including_whitespace_and_comments().is_ok() {}
                    Ok(())
                })?;
                Body::Raw(p.slice_from(block_start).to_owned())
            }
            _ => {
                let (decls, inner_end) = nested(p, |p| parse_decls(p, strict))?;
                Body::Decls(decls, p.slice(inner_end..p.position()).to_owned())
            }
        };
        items.push(Item {
            lead,
            prelude,
            body,
        });
    }
}

/// Whether `token` opens a block that ends at its closing bracket.
fn opens_block(token: &Token<'_>) -> bool {
    matches!(
        token,
        Token::Function(_) | Token::ParenthesisBlock | Token::SquareBracketBlock
    )
}

/// Steps past the rest of the block just opened, so the parser's position
/// is after its closing bracket. (It would skip it anyway, but only on the
/// next token.)
fn skip_block(p: &mut Parser<'_>) {
    let _: Result<(), ParseError<()>> = p.parse_nested_block(|p| {
        while p.next_including_whitespace_and_comments().is_ok() {}
        Ok(())
    });
}

/// Parses the block just opened with `parse`, and returns where its content
/// ended, before the `}`.
fn nested<'i, T>(
    p: &mut Parser<'i>,
    parse: impl FnOnce(&mut Parser<'i>) -> Result<T, CssError>,
) -> Result<(T, cssparser::SourcePosition), CssError> {
    let parsed: Result<_, ParseError<()>> = p.parse_nested_block(|p| {
        let parsed = parse(p);
        Ok(parsed.map(|parsed| (parsed, p.position())))
    });
    parsed.map_err(|_| CssError("the CSS nests too deeply.".into()))?
}

fn parse_decls(p: &mut Parser<'_>, strict: bool) -> Result<Decls, CssError> {
    let mut items = Vec::new();
    loop {
        let lead_start = p.position();
        skip_trivia(p);
        let start = p.position();
        let lead = p.slice(lead_start..start).to_owned();
        if p.is_exhausted() {
            return Ok(Decls { items, tail: lead });
        }
        // `name:` starts a declaration; anything else is kept as it is.
        let state = p.state();
        let mut name = match p.next_including_whitespace_and_comments() {
            Ok(Token::Ident(name)) => name.to_string(),
            _ => String::new(),
        };
        if !name.is_empty() {
            skip_trivia(p);
            if !matches!(p.next_including_whitespace_and_comments(), Ok(Token::Colon)) {
                name.clear();
            }
        }
        let value_start = p.position();
        if name.is_empty() {
            p.reset(&state);
        }
        // To the `;`, or the end of a nested rule's block, or of this block.
        let mut end = p.state();
        let mut nested_rule = false;
        let mut semicolon = false;
        loop {
            match p.next_including_whitespace_and_comments() {
                Ok(Token::Semicolon) => {
                    semicolon = true;
                    break;
                }
                Ok(Token::CurlyBracketBlock) => {
                    nested_rule = true;
                    skip_block(p);
                    end = p.state();
                    break;
                }
                Ok(Token::WhiteSpace(_) | Token::Comment(_)) => {}
                Ok(token) => {
                    if opens_block(token) {
                        skip_block(p);
                    }
                    end = p.state();
                }
                Err(_) => break,
            }
        }
        let value_end = end.position();
        if !semicolon {
            // What follows the declaration goes in the next one's lead.
            p.reset(&end);
        }
        let raw = p.slice(start..p.position()).to_owned();
        if nested_rule {
            name.clear();
        }
        if strict && name.is_empty() {
            let text = raw.trim();
            return Err(CssError(if nested_rule {
                format!("nested rules aren't merged: write `{text}` as a rule of its own.")
            } else {
                format!("`{text}` isn't a declaration, like `color: red`.")
            }));
        }
        let value = if name.is_empty() {
            String::new()
        } else {
            p.slice(value_start..value_end).trim().to_owned()
        };
        items.push(Decl {
            lead,
            raw,
            name,
            value,
        });
    }
}

/// Whitespace collapsed to single spaces, trimmed.
fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A selector for comparing: whitespace collapsed, and none around
/// combinators and commas.
fn normalize(selector: &str) -> String {
    let mut out = String::new();
    for c in collapse(selector).chars() {
        if matches!(c, '>' | '+' | '~' | ',') && out.ends_with(' ') {
            out.pop();
        }
        if c == ' ' && out.ends_with(['>', '+', '~', ',']) {
            continue;
        }
        out.push(c);
    }
    out
}

/// The at-rule's name, lowercase, if `prelude` starts one.
fn at_name(prelude: &str) -> Option<String> {
    let rest = prelude.trim_start().strip_prefix('@')?;
    let end = rest
        .find(|c: char| c.is_whitespace() || matches!(c, '{' | ';' | '(' | '"' | '\''))
        .unwrap_or(rest.len());
    Some(rest[..end].to_ascii_lowercase())
}

/// What makes two items the same, so the patch's replaces the sheet's.
fn key(item: &Item) -> String {
    let kind = match &item.body {
        Body::None => 'n',
        Body::Rules(..) => 'r',
        Body::Decls(..) => 'd',
        Body::Raw(_) => 'k',
    };
    let mut key = match (&item.body, at_name(&item.prelude).as_deref()) {
        (Body::Decls(decls, _), Some("font-face")) => {
            let mut key = "@font-face".to_owned();
            for name in ["font-family", "font-style", "font-weight"] {
                let value = decls.set().filter(|d| d.is(name)).last();
                key.push('|');
                key.push_str(&value.map_or(String::new(), |d| collapse(&d.value)));
            }
            key
        }
        (Body::None, _) => collapse(item.prelude.trim().trim_end_matches(';')),
        (_, Some(_)) => collapse(&item.prelude),
        (_, None) => normalize(&item.prelude),
    };
    key.insert(0, kind);
    key
}

/// Merges the patch's `from` into `into`, in order, as [`merge_sheet`] says.
fn merge_list(
    into: &mut List,
    from: Vec<Item>,
    context: &mut Vec<String>,
    changes: &mut Vec<SheetChange>,
) {
    for patch in from {
        let found = into.items.iter().position(|item| key(item) == key(&patch));
        let target = collapse(patch.prelude.trim().trim_end_matches(';'));
        let mut change = |kind| {
            changes.push(SheetChange {
                context: context.clone(),
                target: target.clone(),
                kind,
            })
        };
        match (patch.body, found) {
            (Body::Decls(decls, _), found) => {
                if decls.set().next().is_none() {
                    if let Some(at) = found {
                        into.items.remove(at);
                        change(SheetChangeKind::Removed);
                    }
                    continue;
                }
                let Some(at) = found else {
                    let mut decls = decls;
                    decls.items.retain(|d| d.name.is_empty() || !d.unsets());
                    if decls.set().next().is_some() {
                        let body = Body::Decls(decls, "}".into());
                        append(into, patch.prelude, body);
                        change(SheetChangeKind::Added);
                    }
                    continue;
                };
                let Body::Decls(existing, _) = &mut into.items[at].body else {
                    unreachable!("the key says it holds declarations")
                };
                change(SheetChangeKind::Declarations(merge_decls(existing, decls)));
            }
            (Body::Rules(list, _), Some(at)) => {
                let Body::Rules(existing, _) = &mut into.items[at].body else {
                    unreachable!("the key says it holds rules")
                };
                context.push(target.clone());
                merge_list(existing, list.items, context, changes);
                context.pop();
            }
            (Body::Raw(raw), Some(at)) => {
                into.items[at].prelude = patch.prelude;
                into.items[at].body = Body::Raw(raw);
                change(SheetChangeKind::Replaced);
            }
            (Body::None, Some(_)) => {}
            (body @ Body::None, None)
                if at_name(&patch.prelude).is_some_and(|n| LEADING.contains(&n.as_str())) =>
            {
                let leading = into
                    .items
                    .iter()
                    .take_while(|item| {
                        matches!(item.body, Body::None)
                            && at_name(&item.prelude).is_some_and(|n| LEADING.contains(&n.as_str()))
                    })
                    .count();
                let lead = if leading == 0 { "" } else { "\n" };
                let mut prelude = patch.prelude;
                if !prelude.trim_end().ends_with(';') {
                    prelude.push(';');
                }
                into.items.insert(
                    leading,
                    Item {
                        lead: lead.into(),
                        prelude,
                        body,
                    },
                );
                if leading == 0 && into.items.len() > 1 {
                    let next = &mut into.items[1];
                    if !next.lead.contains('\n') {
                        next.lead.insert(0, '\n');
                    }
                }
                change(SheetChangeKind::Added);
            }
            (body, None) => {
                let body = match body {
                    Body::Rules(list, _) => Body::Rules(list, "}".into()),
                    body => body,
                };
                let mut prelude = patch.prelude;
                if matches!(body, Body::None) && !prelude.trim_end().ends_with(';') {
                    prelude.push(';');
                }
                append(into, prelude, body);
                change(SheetChangeKind::Added);
            }
        }
    }
}

/// Adds an item at the end of `list`, on a line of its own.
fn append(list: &mut List, prelude: String, body: Body) {
    let lead = match list.items.last_mut() {
        None if list.tail.trim().is_empty() => String::new(),
        None => "\n".into(),
        Some(last) => {
            // A sheet can end inside a block; close it first.
            match &mut last.body {
                Body::Rules(_, close) | Body::Decls(_, close) if close.is_empty() => {
                    close.push('}');
                }
                _ => {}
            }
            if last.lead.contains('\n') {
                last.lead[last.lead.rfind('\n').unwrap()..].to_owned()
            } else {
                "\n".into()
            }
        }
    };
    list.items.push(Item {
        lead,
        prelude: prelude.trim().to_owned() + if matches!(body, Body::None) { "" } else { " " },
        body,
    });
}

/// Gives `into` the declarations in `patch`, and says what changed.
fn merge_decls(into: &mut Decls, patch: Decls) -> Vec<DeclChange> {
    let mut changes = Vec::new();
    for decl in patch.items.into_iter().filter(|d| !d.name.is_empty()) {
        let same: Vec<usize> = (0..into.items.len())
            .filter(|&i| into.items[i].is(&decl.name))
            .collect();
        let Some(&first) = same.first() else {
            if decl.unsets() {
                continue;
            }
            changes.push(DeclChange {
                property: decl.name.clone(),
                old: None,
                new: Some(decl.value.clone()),
            });
            let lead = match into.set().last() {
                Some(last) if last.lead.contains('\n') => {
                    last.lead[last.lead.rfind('\n').unwrap()..].to_owned()
                }
                _ => " ".into(),
            };
            // The declaration before it needs its `;` now.
            if let Some(last) = into.items.last_mut()
                && !last.name.is_empty()
                && !last.raw.ends_with(';')
            {
                last.raw.push(';');
            }
            into.items.push(Decl {
                lead,
                raw: format!("{}: {};", decl.name, decl.value),
                ..decl
            });
            continue;
        };
        let old = into.items[first].value.clone();
        let removing = same[usize::from(!decl.unsets())..].to_vec();
        if decl.unsets() {
            changes.push(DeclChange {
                property: decl.name.clone(),
                old: Some(old),
                new: None,
            });
        } else {
            if old != decl.value {
                changes.push(DeclChange {
                    property: decl.name.clone(),
                    old: Some(old),
                    new: Some(decl.value.clone()),
                });
            }
            let kept = &mut into.items[first];
            if kept.value != decl.value {
                kept.raw = format!("{}: {};", kept.name, decl.value);
                kept.value = decl.value;
            }
        }
        for i in removing.into_iter().rev() {
            into.items.remove(i);
        }
    }
    changes
}
