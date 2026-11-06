//! Reading the selectors agents send: a list, `@name` refs to what an earlier
//! op made, bare node ids, and pages.

use std::collections::HashMap;

use finite_design::{Document, NodeId, NodeKind, css_scan, id, select};
use rmcp::schemars::{self, JsonSchema};
use serde::Deserialize;
use serde_json::Value;

use super::format::outline;

/// A CSS selector, or a list of them.
#[derive(Deserialize, JsonSchema, Clone, Debug)]
#[serde(untagged)]
pub enum Select {
    One(String),
    Many(Vec<String>),
}

impl Select {
    pub(super) fn value(&self) -> Value {
        match self {
            Self::One(s) => s.clone().into(),
            Self::Many(list) => list.clone().into(),
        }
    }
}

/// An agent's `select` as one selector list: a list joins with commas,
/// `@name` refs become the `#id` an earlier op named, and a bare node id
/// like `k3x9a2bq` becomes `#k3x9a2bq`.
pub(super) fn selector_text(
    select: &Value,
    refs: &HashMap<String, NodeId>,
) -> Result<String, String> {
    let parts: Vec<String> = match select {
        Value::Array(items) => items.iter().map(plain).collect(),
        other => vec![plain(other)],
    };
    let joined = parts.join(", ");
    if joined.trim().is_empty() {
        return Err("select is empty".into());
    }
    let resolved = with_refs(&joined, refs, true)?;
    Ok(css_scan::split_top(&resolved, |b| b == b',')
        .into_iter()
        .filter(|p| !p.trim().is_empty())
        .map(|part| {
            let part = part.trim();
            if id::is_node_id(part) {
                format!("#{part}")
            } else {
                part.to_owned()
            }
        })
        .collect::<Vec<_>>()
        .join(", "))
}

/// A JSON value as text: a string as it is, anything else as JSON.
pub(super) fn plain(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// `text` with each `@name` outside quotes replaced by `#id`. With
/// `strict`, a name no earlier op gave is an error; otherwise it's left
/// alone, as in CSS, where `@media` is no ref.
pub(super) fn with_refs(
    text: &str,
    refs: &HashMap<String, NodeId>,
    strict: bool,
) -> Result<String, String> {
    let mut out = String::with_capacity(text.len());
    let mut quote = None;
    let mut chars = text.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match quote {
            Some(q) => {
                if c == '\\' {
                    out.push(c);
                    if let Some((_, next)) = chars.next() {
                        out.push(next);
                    }
                    continue;
                }
                if c == q {
                    quote = None;
                }
                out.push(c);
            }
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                out.push(c);
            }
            None if c == '@' => {
                let rest = &text[i + 1..];
                let len = rest
                    .find(|ch: char| !(ch.is_alphanumeric() || ch == '_' || ch == '-'))
                    .unwrap_or(rest.len());
                let name = &rest[..len];
                match refs.get(name) {
                    Some(id) if !name.is_empty() => {
                        out.push('#');
                        out.push_str(id);
                        for _ in 0..name.chars().count() {
                            chars.next();
                        }
                    }
                    _ if strict => {
                        return Err(format!(
                            "\"@{name}\" isn't defined. Give an earlier op in the same edit \"as\": \"{name}\"."
                        ));
                    }
                    _ => out.push(c),
                }
            }
            None => out.push(c),
        }
    }
    Ok(out)
}

/// The elements `selector` matches in document order, on `page` when given,
/// or the text nodes a bare `#id` list names. Empty when nothing matches.
pub(super) fn matched(
    doc: &Document,
    selector: &str,
    page: Option<&str>,
) -> Result<Vec<NodeId>, String> {
    let list = select::parse(selector).map_err(|e| e.to_string())?;
    let scope = match page {
        Some(page) => select::Scope::Page(page),
        None => select::Scope::Design,
    };
    let matcher = select::Matcher::new(doc, scope);
    let found = matcher.select(&list);
    if found.is_empty() {
        return Ok(matcher.text_nodes(&list));
    }
    Ok(found)
}

/// A node's outline line, like `button "CTA" #ab12cd34 "Sign up"`.
pub(super) fn line(doc: &Document, id: &str) -> String {
    outline(doc, id, 0)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_owned()
}

/// A node as a short label, like `button "CTA" #ab12cd34`.
pub(super) fn label(doc: &Document, id: &str) -> String {
    match doc.get(id) {
        Some(node) => match (&node.kind, &node.name) {
            (NodeKind::Text, _) => format!("text #{id}"),
            (NodeKind::Element { tag }, Some(name)) => format!("{tag} {name:?} #{id}"),
            (NodeKind::Element { tag }, None) => format!("{tag} #{id}"),
        },
        None => format!("#{id}"),
    }
}

/// The first few of `ids` as labels, and how many more there are.
pub(super) fn describe(doc: &Document, ids: &[NodeId]) -> String {
    const SHOWN: usize = 6;
    let mut text: Vec<String> = ids.iter().take(SHOWN).map(|id| label(doc, id)).collect();
    if ids.len() > SHOWN {
        text.push(format!("and {} more", ids.len() - SHOWN));
    }
    text.join(", ")
}

/// The id of the page `given` names: its id, its name in any case, or an
/// `@name` an earlier op gave.
pub(super) fn page_id(
    doc: &Document,
    given: &str,
    refs: &HashMap<String, NodeId>,
) -> Result<String, String> {
    let given = given.trim();
    if let Some(name) = given.strip_prefix('@')
        && let Some(id) = refs.get(name)
    {
        return Ok(id.clone());
    }
    let pages = doc.pages();
    if let Some((id, _)) = pages.iter().find(|(id, _)| *id == given).or_else(|| {
        pages
            .iter()
            .find(|(_, p)| p.name.eq_ignore_ascii_case(given))
    }) {
        return Ok((*id).to_owned());
    }
    let names: Vec<String> = pages.iter().map(|(_, p)| format!("{:?}", p.name)).collect();
    Err(format!(
        "there's no page {given:?}. Pages: {}. Add one with {{\"op\": \"page\", \"create\": {given:?}}}.",
        names.join(", ")
    ))
}

#[cfg(test)]
mod verification;
