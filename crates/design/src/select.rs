//! Matching CSS selectors against a document, so agents can address elements
//! the way they would in a stylesheet: `.card:has(> h2)`, `nav a:first-child`,
//! `button:contains("Sign up")`.
//!
//! [`parse`] reads a selector list and [`Matcher::select`] returns the
//! elements it matches, in document order across artboards. The `selectors`
//! crate (Servo's matcher, which `scraper` uses too) does the matching:
//! [`Matcher`] lays the document out as a flat index of elements and
//! implements its [`Element`] trait over that index.
//!
//! Selectors see the document the way an agent reads its HTML:
//!
//! - Each artboard is a root. `:root` matches artboards, and no selector
//!   reaches across from one artboard to another.
//! - `#id` matches a node's id, then its `id` attribute. Ids may start with a
//!   digit, which CSS doesn't allow, so `#4kx92mab` is escaped before parsing.
//!   A node inside an instance is `#instance/part/leaf`; `#instance\/part\/leaf`
//!   is the same id.
//! - `[data-id]`, `[data-name]`, `[data-instance-of]`, `[data-component]` and
//!   `[style]` read the node's id, layer name, the component an instance
//!   shows, a component root's name and its inline styles, as `read`
//!   writes them.
//! - Text nodes are never matched. [`Matcher::text_nodes`] resolves a bare
//!   `#id` list that names them.
//! - `:contains("text")` matches an element whose visible text, including its
//!   descendants', contains `text`, ignoring case and runs of whitespace. Text
//!   in `<style>`, `<script>` and `<template>` isn't visible.
//!
//! A selector that picks elements can't name a state (`:hover`) or a
//! pseudo-element (`::before`), since no element is in that state. [`parse`]
//! refuses them. [`parse_loose`] reads them as matching their element, to find
//! which elements a stylesheet rule like `.btn:hover` styles.

use std::{borrow::Cow, collections::HashMap, fmt};

use cssparser::{BasicParseErrorKind, CowRcStr, ParseError, ParseErrorKind, ToCss};
use precomputed_hash::PrecomputedHash;
use selectors::{
    Element, OpaqueElement,
    attr::{AttrSelectorOperation, CaseSensitivity, NamespaceConstraint},
    bloom::BloomFilter,
    matching::{
        ElementSelectorFlags, MatchingContext, MatchingForInvalidation, MatchingMode,
        NeedsSelectorFlags, QuirksMode, SelectorCaches, matches_selector,
    },
    parser::{Component, ParseRelative, SelectorParseErrorKind},
};

use crate::{
    Document, Node, NodeId, NodeKind,
    html::{COMPONENT_ATTR, ID_ATTR, INSTANCE_ATTR, NAME_ATTR, style_string},
};

/// A parsed selector list, like `.card, nav > a`.
#[derive(Clone, Debug)]
pub struct SelectorList {
    list: selectors::SelectorList<Impl>,
    source: String,
    /// The ids, when the list is only `#id` selectors.
    ids: Option<Vec<String>>,
}

impl SelectorList {
    /// The selector as it was written.
    pub fn as_str(&self) -> &str {
        &self.source
    }

    /// The ids of a list made only of `#id` selectors, like `#a1, #b2`.
    pub fn ids(&self) -> Option<&[String]> {
        self.ids.as_deref()
    }
}

/// Why a selector can't be read, worded for an agent.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectError(pub String);

impl fmt::Display for SelectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SelectError {}

/// Which elements a selector can match.
#[derive(Clone, Copy, Debug)]
pub enum Scope<'a> {
    /// Every artboard.
    Design,
    /// The artboards on one page.
    Page(&'a str),
    /// The descendants of these nodes, not the nodes themselves, as
    /// `querySelectorAll` on an element does. The rest of the artboard still
    /// counts: within a card, `.card > h2` matches the card's heading.
    Within(&'a [NodeId]),
}

/// Reads a selector list that picks elements. States and pseudo-elements are
/// errors.
pub fn parse(source: &str) -> Result<SelectorList, SelectError> {
    parse_with(source, false)
}

/// Reads a selector list from a stylesheet rule, where states and
/// pseudo-elements (`.btn:hover`, `p::first-line`) and pseudo-classes this
/// module doesn't know match the element they describe.
pub fn parse_loose(source: &str) -> Result<SelectorList, SelectError> {
    parse_with(source, true)
}

/// The elements `list` matches in `scope`, in document order.
pub fn matches(doc: &Document, list: &SelectorList, scope: Scope) -> Vec<NodeId> {
    Matcher::new(doc, scope).select(list)
}

/// State pseudo-classes: they describe what a person is doing with an
/// element, so no element matches them in a design.
const STATES: &[&str] = &[
    "hover",
    "focus",
    "focus-within",
    "focus-visible",
    "active",
    "visited",
    "link",
    "any-link",
    "checked",
    "disabled",
    "enabled",
    "target",
    "placeholder-shown",
    "invalid",
    "valid",
    "required",
    "optional",
    "autofill",
    "default",
    "indeterminate",
    "in-range",
    "out-of-range",
    "read-only",
    "read-write",
    "user-invalid",
    "user-valid",
    "open",
    "popover-open",
    "modal",
    "fullscreen",
    "playing",
    "paused",
];

/// Tags whose text isn't shown.
const HIDDEN_TEXT: &[&str] = &["style", "script", "template"];

fn parse_with(source: &str, loose: bool) -> Result<SelectorList, SelectError> {
    if source.trim().is_empty() {
        return Err(SelectError("the selector is empty".into()));
    }
    let parser = Parser { loose };
    let list = parse_list(&parser, source).map_err(|e| error(&parser, source, e))?;
    let ids = list
        .slice()
        .iter()
        .map(|selector| {
            let mut parts = selector.iter_raw_match_order();
            match (parts.next(), parts.next()) {
                (Some(Component::ID(id)), None) => Some(id.0.clone()),
                _ => None,
            }
        })
        .collect();
    Ok(SelectorList {
        list,
        source: source.to_owned(),
        ids,
    })
}

fn parse_list(
    parser: &Parser,
    source: &str,
) -> Result<selectors::SelectorList<Impl>, ParseError<Bad>> {
    let css = escape_ids(source);
    let mut input = cssparser::Parser::new(&css);
    selectors::SelectorList::parse(parser, &mut input, ParseRelative::No)
}

/// Escapes the digit after a `#` outside strings: CSS reads `#4kx92mab` as a
/// hash that isn't an id, since an identifier can't start with a digit, and
/// node ids often do. It escapes the `/` in a virtual id too, so
/// `#k2n0d9xa/9qd2h0ce` names a node inside an instance. A slash already
/// written `\/` stays inside that id, so the escaped spelling and a mix of
/// the two name the same node.
fn escape_ids(source: &str) -> Cow<'_, str> {
    let bytes = source.as_bytes();
    let mut out = String::new();
    let mut copied = 0;
    let mut quote = None;
    let mut hash = false;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        let ident = |b: &u8| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_';
        // `\/` is a slash an agent already escaped. It is still part of the
        // path id, and a later raw `/` in that same id still needs escaping.
        let escaped_slash = b == b'\\' && bytes.get(i + 1) == Some(&b'/');
        if hash && !(ident(&b) || b == b'/' || escaped_slash) {
            hash = false;
        }
        match (quote, b) {
            (_, b'\\') => i += 1,
            (Some(q), b) if b == q => quote = None,
            (None, b'"' | b'\'') => quote = Some(b),
            (None, b'#') => {
                hash = true;
                if bytes.get(i + 1).is_some_and(u8::is_ascii_digit) {
                    out.push_str(&source[copied..=i]);
                    out.push_str("\\3");
                    out.push(bytes[i + 1] as char);
                    out.push(' ');
                    copied = i + 2;
                    i += 1;
                }
            }
            (None, b'/') if hash && bytes.get(i + 1).is_some_and(ident) => {
                out.push_str(&source[copied..i]);
                out.push_str("\\/");
                copied = i + 1;
            }
            _ => {}
        }
        i += 1;
    }
    if copied == 0 {
        return Cow::Borrowed(source);
    }
    out.push_str(&source[copied..]);
    Cow::Owned(out)
}

/// Whether `:has(` appears inside another `:has(`.
fn nested_has(source: &str) -> bool {
    let lower = source.to_ascii_lowercase();
    let mut open: Vec<bool> = Vec::new();
    let bytes = lower.as_bytes();
    for (i, &b) in bytes.iter().enumerate() {
        match b {
            b'(' => {
                let has = lower[..i].ends_with(":has");
                if has && open.iter().any(|&h| h) {
                    return true;
                }
                open.push(has);
            }
            b')' => {
                open.pop();
            }
            _ => {}
        }
    }
    false
}

fn error(parser: &Parser, source: &str, e: ParseError<Bad>) -> SelectError {
    let message = match e.kind {
        ParseErrorKind::Custom(Bad::State(name)) => format!(
            "\":{name}\" describes a state, not elements. To style that state, use a css op with to: \"style\"."
        ),
        ParseErrorKind::Custom(Bad::PseudoElement(name)) => format!(
            "\"::{name}\" is a pseudo-element, not an element. To style it, use a css op with to: \"style\"."
        ),
        ParseErrorKind::Custom(Bad::Unsupported(name)) => {
            format!("\":{name}\" isn't supported in a selector (in \"{source}\")")
        }
        // CSS doesn't allow :has() inside :has(), which selectors rejects
        // without saying why.
        _ if nested_has(source) => format!(
            "can't read \"{source}\" as a CSS selector: :has() can't hold another :has(). Use one :has() with a longer selector inside, like :has(> div > #k3x9a2bq)."
        ),
        _ => match mistake(parser, source) {
            Some(at) => format!(
                "can't read \"{source}\" as a CSS selector (at \"{}\")",
                source[at..].trim_end()
            ),
            None => format!("can't read \"{source}\" as a CSS selector (it ends too soon)"),
        },
    };
    SelectError(message)
}

/// Where a selector that doesn't parse goes wrong. The parser doesn't say,
/// so this reads ever longer prefixes until one fails for a reason more
/// text couldn't fix, and returns where that prefix's last character
/// starts. `None` when every prefix could still go on. It only runs when
/// parsing fails, on a selector an agent wrote, so the quadratic cost is
/// small.
fn mistake(parser: &Parser, source: &str) -> Option<usize> {
    source.char_indices().find_map(|(at, c)| {
        let prefix = &source[..at + c.len_utf8()];
        // A lone `#` is a stray character until a name follows it.
        let unfinished = c == '#'
            || match parse_list(parser, prefix).err()?.kind {
                ParseErrorKind::Basic(BasicParseErrorKind::EndOfInput) => true,
                ParseErrorKind::Custom(Bad::Syntax(SelectorParseErrorKind::DanglingCombinator)) => {
                    c.is_whitespace() || matches!(c, '>' | '+' | '~')
                }
                ParseErrorKind::Custom(Bad::Syntax(SelectorParseErrorKind::EmptySelector)) => {
                    c.is_whitespace() || c == ','
                }
                _ => false,
            };
        (!unfinished).then_some(at)
    })
}

/// Lowercases `text` and collapses its whitespace, the way `:contains`
/// compares text.
fn fold(text: &str, out: &mut String) {
    for word in text.split_whitespace() {
        if !out.is_empty() && !out.ends_with(' ') {
            out.push(' ');
        }
        out.extend(word.chars().flat_map(char::to_lowercase));
    }
}

// ---------------------------------------------------------------- parsing

#[derive(Clone, Debug, PartialEq, Eq)]
struct Impl;

impl selectors::SelectorImpl for Impl {
    type ExtraMatchingData<'a> = ();
    type AttrValue = Value;
    type Identifier = Ident;
    type LocalName = Ident;
    type NamespaceUrl = Ident;
    type NamespacePrefix = Ident;
    type BorrowedNamespaceUrl = str;
    type BorrowedLocalName = str;
    type NonTSPseudoClass = PseudoClass;
    type PseudoElement = PseudoElement;
}

/// A name in a selector: a tag, class, id or attribute name.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
struct Ident(String);

impl From<&str> for Ident {
    fn from(s: &str) -> Self {
        Self(s.to_owned())
    }
}

impl std::borrow::Borrow<str> for Ident {
    fn borrow(&self) -> &str {
        &self.0
    }
}

impl ToCss for Ident {
    fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
        cssparser::serialize_identifier(&self.0, dest)
    }
}

/// Only feeds the bloom filter, which matching here doesn't use.
impl PrecomputedHash for Ident {
    fn precomputed_hash(&self) -> u32 {
        self.0
            .bytes()
            .fold(0x811c_9dc5, |h, b| (h ^ b as u32).wrapping_mul(0x0100_0193))
    }
}

/// An attribute value in a selector, as in `[href^="https"]`.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Value(String);

impl From<&str> for Value {
    fn from(s: &str) -> Self {
        Self(s.to_owned())
    }
}

impl AsRef<str> for Value {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl ToCss for Value {
    fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
        cssparser::serialize_string(&self.0, dest)
    }
}

/// The pseudo-classes the `selectors` crate leaves to its user.
#[derive(Clone, Debug, PartialEq, Eq)]
enum PseudoClass {
    /// `:contains("text")`, holding the text folded as [`fold`] does.
    Contains(String),
    /// A state or unknown pseudo-class, read by [`parse_loose`]. It matches.
    Loose(String),
}

impl selectors::parser::NonTSPseudoClass for PseudoClass {
    fn is_active_or_hover(&self) -> bool {
        matches!(self, Self::Loose(name) if name == "hover" || name == "active")
    }

    fn is_user_action_state(&self) -> bool {
        matches!(self, Self::Loose(_))
    }
}

impl ToCss for PseudoClass {
    fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
        match self {
            Self::Contains(text) => {
                dest.write_str(":contains(")?;
                cssparser::serialize_string(text, dest)?;
                dest.write_str(")")
            }
            Self::Loose(name) => write!(dest, ":{name}"),
        }
    }
}

/// A pseudo-element, read only by [`parse_loose`]. It matches its element.
#[derive(Clone, Debug, PartialEq, Eq)]
struct PseudoElement(String);

impl selectors::parser::PseudoElement for PseudoElement {
    fn accepts_state_pseudo_classes(&self) -> bool {
        true
    }
}

impl ToCss for PseudoElement {
    fn to_css<W: fmt::Write>(&self, dest: &mut W) -> fmt::Result {
        write!(dest, "::{}", self.0)
    }
}

/// Why parsing stopped, beyond the `selectors` crate's own reasons.
#[derive(Debug)]
enum Bad {
    Syntax(SelectorParseErrorKind),
    State(String),
    PseudoElement(String),
    Unsupported(String),
}

impl From<SelectorParseErrorKind> for Bad {
    fn from(kind: SelectorParseErrorKind) -> Self {
        Self::Syntax(kind)
    }
}

struct Parser {
    loose: bool,
}

impl Parser {
    fn refuse(&self, name: &str) -> Bad {
        if STATES.contains(&name) {
            Bad::State(name.to_owned())
        } else {
            Bad::Unsupported(name.to_owned())
        }
    }
}

impl<'i> selectors::parser::Parser<'i> for Parser {
    type Impl = Impl;
    type Error = Bad;

    fn parse_is_and_where(&self) -> bool {
        true
    }

    fn parse_has(&self) -> bool {
        true
    }

    fn parse_nth_child_of(&self) -> bool {
        true
    }

    /// Forgiving lists drop what they can't read, so `:is(:hover)` would
    /// match nothing instead of saying why.
    fn allow_forgiving_selectors(&self) -> bool {
        false
    }

    fn parse_non_ts_pseudo_class(
        &self,
        name: CowRcStr<'i>,
    ) -> Result<PseudoClass, ParseError<Bad>> {
        let name = name.to_ascii_lowercase();
        if self.loose {
            return Ok(PseudoClass::Loose(name));
        }
        Err(ParseError::custom(self.refuse(&name)))
    }

    fn parse_non_ts_functional_pseudo_class(
        &self,
        name: CowRcStr<'i>,
        input: &mut cssparser::Parser<'i>,
        _after_part: bool,
    ) -> Result<PseudoClass, ParseError<Bad>> {
        let name = name.to_ascii_lowercase();
        if name == "contains" {
            // A string, or bare words as the mock and jQuery take them.
            let text = match input.try_parse(|i| i.expect_string_cloned()) {
                Ok(text) => {
                    input.expect_exhausted()?;
                    text.to_string()
                }
                Err(_) => {
                    let start = input.position();
                    while input.next().is_ok() {}
                    input.slice_from(start).to_owned()
                }
            };
            let mut folded = String::new();
            fold(&text, &mut folded);
            return Ok(PseudoClass::Contains(folded));
        }
        if self.loose {
            while input.next().is_ok() {}
            return Ok(PseudoClass::Loose(name));
        }
        Err(ParseError::custom(self.refuse(&name)))
    }

    fn parse_pseudo_element(&self, name: CowRcStr<'i>) -> Result<PseudoElement, ParseError<Bad>> {
        let name = name.to_ascii_lowercase();
        if self.loose {
            return Ok(PseudoElement(name));
        }
        Err(ParseError::custom(Bad::PseudoElement(name)))
    }

    fn parse_functional_pseudo_element(
        &self,
        name: CowRcStr<'i>,
        input: &mut cssparser::Parser<'i>,
    ) -> Result<PseudoElement, ParseError<Bad>> {
        while input.next().is_ok() {}
        self.parse_pseudo_element(name)
    }
}

// ---------------------------------------------------------------- matching

const NONE: u32 = u32::MAX;

/// One element of the index, with its neighbours as indexes into it.
struct Entry<'a> {
    node: &'a Node,
    tag: &'a str,
    parent: u32,
    prev: u32,
    next: u32,
    first_child: u32,
    /// One past the last entry in this element's subtree: entries are in
    /// document order, so the subtree is `self..end`.
    end: u32,
    /// Whether a child is a text node with more than whitespace.
    has_text: bool,
    /// This element's visible text, as a range of [`Matcher::text`].
    text: (u32, u32),
}

/// The artboards in a scope, laid out for matching. Build one to match
/// several selectors against the same document, such as every rule in an
/// artboard's stylesheets.
pub struct Matcher<'a> {
    doc: &'a Document,
    entries: Vec<Entry<'a>>,
    by_id: HashMap<&'a str, u32>,
    /// Every element's visible text, folded, in document order.
    text: String,
    /// The subtrees whose descendants are in scope, for [`Scope::Within`].
    within: Option<Vec<(u32, u32)>>,
}

impl<'a> Matcher<'a> {
    pub fn new(doc: &'a Document, scope: Scope) -> Self {
        let artboards = doc.artboards();
        let artboards = match scope {
            Scope::Design => artboards,
            Scope::Page(page) => artboards
                .into_iter()
                .filter(|board| doc.page_of(board) == page)
                .collect(),
            Scope::Within(ids) => {
                let holding: Vec<&str> = ids
                    .iter()
                    .filter_map(|id| doc.artboard_of(id))
                    .map(|board| board.id.as_str())
                    .collect();
                artboards
                    .into_iter()
                    .filter(|board| holding.contains(&board.id.as_str()))
                    .collect()
            }
        };
        let mut matcher = Matcher {
            doc,
            entries: Vec::new(),
            by_id: HashMap::new(),
            text: String::new(),
            within: None,
        };
        for board in artboards {
            if board.tag().is_some() {
                matcher.add(board, NONE, false);
            }
        }
        if let Scope::Within(ids) = scope {
            let mut ranges: Vec<(u32, u32)> = ids
                .iter()
                .filter_map(|id| matcher.by_id.get(id.as_str()))
                .map(|&i| (i + 1, matcher.entries[i as usize].end))
                .collect();
            ranges.sort_unstable();
            // Subtrees nest or don't touch: keep the outermost.
            let mut outer: Vec<(u32, u32)> = Vec::new();
            for (start, end) in ranges {
                if outer.last().is_none_or(|&(_, last)| start >= last) {
                    outer.push((start, end));
                }
            }
            matcher.within = Some(outer);
        }
        matcher
    }

    /// Adds `node` and its subtree, returning its index.
    fn add(&mut self, node: &'a Node, parent: u32, hidden: bool) -> u32 {
        let me = self.entries.len() as u32;
        let tag = node.tag().unwrap_or_default();
        self.entries.push(Entry {
            node,
            tag,
            parent,
            prev: NONE,
            next: NONE,
            first_child: NONE,
            end: NONE,
            has_text: false,
            text: (0, 0),
        });
        self.by_id.insert(&node.id, me);
        let start = self.text.len() as u32;
        let hidden = hidden
            || HIDDEN_TEXT
                .iter()
                .any(|hide| tag.eq_ignore_ascii_case(hide));
        let mut prev = NONE;
        for child in self.doc.children(Some(&node.id)) {
            match &child.kind {
                NodeKind::Text => {
                    let text = child.text.as_deref().unwrap_or_default();
                    if !text.trim().is_empty() {
                        self.entries[me as usize].has_text = true;
                        if !hidden {
                            fold(text, &mut self.text);
                        }
                    }
                }
                NodeKind::Element { .. } => {
                    let child = self.add(child, me, hidden);
                    if prev == NONE {
                        self.entries[me as usize].first_child = child;
                    } else {
                        self.entries[prev as usize].next = child;
                        self.entries[child as usize].prev = prev;
                    }
                    prev = child;
                }
            }
        }
        let end = self.entries.len() as u32;
        let entry = &mut self.entries[me as usize];
        entry.end = end;
        entry.text = (start, self.text.len() as u32);
        me
    }

    /// The elements `list` matches in this matcher's scope, in document order.
    pub fn select(&self, list: &SelectorList) -> Vec<NodeId> {
        let mut caches = SelectorCaches::default();
        let mut context = MatchingContext::new(
            MatchingMode::Normal,
            None,
            &mut caches,
            QuirksMode::NoQuirks,
            NeedsSelectorFlags::No,
            MatchingForInvalidation::No,
        );
        let all = [(0, self.entries.len() as u32)];
        let ranges = self.within.as_deref().unwrap_or(&all);
        let mut out = Vec::new();
        for &(start, end) in ranges {
            for i in start..end {
                let el = El { matcher: self, i };
                if list
                    .list
                    .slice()
                    .iter()
                    .any(|s| matches_selector(s, 0, None, &el, &mut context))
                {
                    out.push(self.entries[i as usize].node.id.clone());
                }
            }
        }
        out
    }

    /// The text nodes a bare `#id` list names, in the list's order. Empty
    /// unless every selector in the list is a bare `#id`. Selectors never
    /// match text nodes, but an agent that read a text node's id can still
    /// name it.
    pub fn text_nodes(&self, list: &SelectorList) -> Vec<NodeId> {
        let Some(ids) = list.ids() else {
            return Vec::new();
        };
        ids.iter()
            .filter(|id| {
                let Some(node) = self.doc.get(id) else {
                    return false;
                };
                let parent = node.parent.as_deref().and_then(|p| self.by_id.get(p));
                match (&node.kind, parent, &self.within) {
                    (NodeKind::Text, Some(_), None) => true,
                    (NodeKind::Text, Some(&p), Some(ranges)) => {
                        ranges.iter().any(|&(start, end)| p + 1 >= start && p < end)
                    }
                    _ => false,
                }
            })
            .cloned()
            .collect()
    }

    fn entry(&self, i: u32) -> &Entry<'a> {
        &self.entries[i as usize]
    }

    /// An attribute as `read` writes it. `data-instance-of` and
    /// `data-component` are node fields, not entries in `attrs`. The values
    /// are the component id and the component root's display name: what the
    /// writer puts in the attribute, before it escapes the HTML source.
    fn attr(&self, i: u32, name: &str) -> Option<Cow<'a, str>> {
        let node = self.entry(i).node;
        match name {
            ID_ATTR => Some(Cow::Borrowed(&node.id)),
            NAME_ATTR => node.name.as_deref().map(Cow::Borrowed),
            INSTANCE_ATTR => node
                .instance_of
                .as_deref()
                .map(Cow::Borrowed)
                .or_else(|| stored_attr(node, name)),
            COMPONENT_ATTR if node.component => Some(written_component_name(node)),
            "style" if !node.styles.is_empty() => Some(Cow::Owned(style_string(&node.styles))),
            _ => stored_attr(node, name),
        }
    }
}

/// An attribute stored on the node, including SVG names like `viewBox`
/// when the selector's name has been lowercased.
fn stored_attr<'a>(node: &'a Node, name: &str) -> Option<Cow<'a, str>> {
    node.attrs
        .get(name)
        .or_else(|| {
            node.attrs
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(name))
                .map(|(_, v)| v)
        })
        .map(|v| Cow::Borrowed(v.as_str()))
}

/// `data-component`'s value, the same string [`Node::display_name`] returns
/// for an element: the layer name, or else the tag. Borrows either, so a
/// component match does not allocate. A text node, which a component root
/// isn't, is the only case that allocates.
fn written_component_name(node: &Node) -> Cow<'_, str> {
    match node.name.as_deref().or_else(|| node.tag()) {
        Some(name) => Cow::Borrowed(name),
        None => Cow::Owned(node.display_name()),
    }
}

/// One element, as the `selectors` crate sees it.
#[derive(Clone, Copy)]
struct El<'m, 'a> {
    matcher: &'m Matcher<'a>,
    i: u32,
}

impl fmt::Debug for El<'_, '_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let entry = self.entry();
        write!(f, "<{} #{}>", entry.tag, entry.node.id)
    }
}

impl<'m, 'a> El<'m, 'a> {
    fn entry(&self) -> &'m Entry<'a> {
        self.matcher.entry(self.i)
    }

    fn at(&self, i: u32) -> Option<Self> {
        (i != NONE).then_some(El {
            matcher: self.matcher,
            i,
        })
    }
}

impl Element for El<'_, '_> {
    type Impl = Impl;

    fn opaque(&self) -> OpaqueElement {
        OpaqueElement::new(self.entry())
    }

    fn parent_element(&self) -> Option<Self> {
        self.at(self.entry().parent)
    }

    fn parent_node_is_shadow_root(&self) -> bool {
        false
    }

    fn containing_shadow_host(&self) -> Option<Self> {
        None
    }

    /// A pseudo-element, read by [`parse_loose`], stands for its element.
    fn pseudo_element_originating_element(&self) -> Option<Self> {
        Some(*self)
    }

    fn is_pseudo_element(&self) -> bool {
        false
    }

    fn prev_sibling_element(&self) -> Option<Self> {
        self.at(self.entry().prev)
    }

    fn next_sibling_element(&self) -> Option<Self> {
        self.at(self.entry().next)
    }

    fn first_element_child(&self) -> Option<Self> {
        self.at(self.entry().first_child)
    }

    fn is_html_element_in_html_document(&self) -> bool {
        true
    }

    fn has_local_name(&self, name: &str) -> bool {
        self.entry().tag.eq_ignore_ascii_case(name)
    }

    fn has_namespace(&self, ns: &str) -> bool {
        ns.is_empty()
    }

    fn is_same_type(&self, other: &Self) -> bool {
        self.entry().tag.eq_ignore_ascii_case(other.entry().tag)
    }

    fn attr_matches(
        &self,
        _ns: &NamespaceConstraint<&Ident>,
        name: &Ident,
        operation: &AttrSelectorOperation<&Value>,
    ) -> bool {
        self.matcher
            .attr(self.i, &name.0)
            .is_some_and(|value| operation.eval_str(&value))
    }

    fn match_non_ts_pseudo_class(
        &self,
        pc: &PseudoClass,
        _context: &mut MatchingContext<Impl>,
    ) -> bool {
        match pc {
            PseudoClass::Contains(needle) => {
                let (start, end) = self.entry().text;
                self.matcher.text[start as usize..end as usize].contains(needle.as_str())
            }
            PseudoClass::Loose(_) => true,
        }
    }

    fn match_pseudo_element(
        &self,
        _pe: &PseudoElement,
        _context: &mut MatchingContext<Impl>,
    ) -> bool {
        true
    }

    fn apply_selector_flags(&self, _flags: ElementSelectorFlags) {}

    fn is_link(&self) -> bool {
        false
    }

    fn is_html_slot_element(&self) -> bool {
        false
    }

    fn has_id(&self, id: &Ident, case: CaseSensitivity) -> bool {
        let node = self.entry().node;
        case.eq(node.id.as_bytes(), id.0.as_bytes())
            || node
                .attrs
                .get("id")
                .is_some_and(|own| case.eq(own.as_bytes(), id.0.as_bytes()))
    }

    fn has_class(&self, name: &Ident, case: CaseSensitivity) -> bool {
        self.entry().node.attrs.get("class").is_some_and(|classes| {
            classes
                .split_ascii_whitespace()
                .any(|class| case.eq(class.as_bytes(), name.0.as_bytes()))
        })
    }

    fn has_custom_state(&self, _name: &Ident) -> bool {
        false
    }

    fn imported_part(&self, _name: &Ident) -> Option<Ident> {
        None
    }

    fn is_part(&self, _name: &Ident) -> bool {
        false
    }

    fn is_empty(&self) -> bool {
        let entry = self.entry();
        entry.first_child == NONE && !entry.has_text
    }

    /// Each artboard is a root.
    fn is_root(&self) -> bool {
        self.entry().parent == NONE
    }

    fn add_element_unique_hashes(&self, _filter: &mut BloomFilter) -> bool {
        false
    }
}
