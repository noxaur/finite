//! Design tokens and modes, and moving old shared CSS into them.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::{
    document::{Document, Op},
    fractional,
    html::{self},
    id, label,
    node::{NodeId, NodeKind, PropKey},
    tokens::{self, MAX_MODES, Mode, Values},
};

use super::{EditError, Result, err, node};
use super::{WriteMode, write_html};

/// How one token changes in [`set_tokens`]. As JSON, a string is `All`, an
/// object is `Modes` and null is `Delete`.
#[derive(Clone, Debug, PartialEq, serde::Deserialize)]
#[serde(untagged)]
pub enum TokenChange {
    /// One value in every mode.
    All(String),
    /// Values by mode name or id. `None` removes that mode's value, so it
    /// falls back to the first mode's.
    Modes(BTreeMap<String, Option<String>>),
    /// Deletes the token.
    Delete,
}

/// A design's modes as `(id, name)`, in order.
pub(crate) type ModeList = Vec<(String, String)>;

/// A design's modes as `(id, name)`, in order, for [`set_tokens`].
pub fn mode_list(doc: &Document) -> ModeList {
    doc.modes()
        .into_iter()
        .map(|(id, mode)| (id.to_owned(), mode.name.clone()))
        .collect()
}

/// Names the design's modes in order. The first name renames the first
/// mode, and so on, and names past the last mode add modes. It never
/// deletes a mode. Returns the ops and the modes as they'll be, as
/// [`mode_list`] gives them.
pub fn set_modes(
    doc: &Document,
    names: &[String],
    new_id: &mut impl FnMut() -> String,
) -> Result<(Vec<Op>, ModeList)> {
    let existing = doc.modes();
    if names.len() < existing.len() {
        return err(format!(
            "the design has {} modes ({}); name each of them, in order. Modes aren't deleted here.",
            existing.len(),
            existing
                .iter()
                .map(|(_, m)| m.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if names.len() > MAX_MODES {
        return err(format!("a design can have at most {MAX_MODES} modes"));
    }
    let mut seen = std::collections::HashSet::new();
    let mut ops = Vec::new();
    let mut list = Vec::new();
    let mut last = None;
    for (at, name) in names.iter().enumerate() {
        let name = label::clip(name.trim(), label::LAYER_NAME);
        if name.is_empty() {
            return err("give every mode a name");
        }
        if !seen.insert(name.to_lowercase()) {
            return err(format!("two modes are named {name:?}"));
        }
        let (id, index) = match existing.get(at) {
            Some((id, mode)) => ((*id).to_owned(), mode.index.clone()),
            None => (new_id(), fractional::key_between(last.as_deref(), None)),
        };
        last = Some(index.clone());
        ops.push(Op::Mode {
            id: id.clone(),
            mode: Some(Mode {
                name: name.clone(),
                index,
            }),
        });
        list.push((id, name));
    }
    Ok((ops, list))
}

/// Deletes a mode and every token value in it. Artboards in it fall back
/// to the first mode. A design keeps at least one mode.
pub fn delete_mode(doc: &Document, id: &str) -> Result<Vec<Op>> {
    let modes = doc.modes();
    if !modes.iter().any(|(mode, _)| *mode == id) {
        return err(format!("mode {id:?} not found"));
    }
    if modes.len() == 1 {
        return err("that's the design's only mode, and a design keeps at least one");
    }
    let mut ops: Vec<Op> = doc
        .tokens()
        .iter()
        .filter(|(_, values)| values.contains_key(id))
        .map(|(name, _)| Op::Token {
            name: name.clone(),
            mode_id: id.to_owned(),
            value: None,
        })
        .collect();
    ops.push(Op::Mode {
        id: id.to_owned(),
        mode: None,
    });
    Ok(ops)
}

/// Sets, changes or deletes tokens. `modes` is the design's modes as they
/// are, or as [`set_modes`] leaves them in the same edit. A mode key is a
/// mode's name, in any case, or its id.
pub fn set_tokens(
    doc: &Document,
    modes: &[(String, String)],
    changes: &[(String, TokenChange)],
) -> Result<Vec<Op>> {
    let first = &modes.first().expect("a design has a mode").0;
    let mode_id = |key: &str| {
        modes
            .iter()
            .find(|(id, name)| id == key || name.eq_ignore_ascii_case(key))
            .map(|(id, _)| id.clone())
            .ok_or_else(|| {
                let names: Vec<&str> = modes.iter().map(|(_, n)| n.as_str()).collect();
                EditError(format!(
                    "the design has no mode {key:?}; its modes are {}. Pass modes to add one.",
                    names.join(", ")
                ))
            })
    };
    let check = |name: &str, value: &str| {
        tokens::check_value(value.trim()).map_err(|why| EditError(format!("{name}: {why}")))
    };
    // What each token holds after the changes so far, so a name that comes
    // twice builds on its first change.
    let mut planned: BTreeMap<&str, Option<Values>> = BTreeMap::new();
    for (name, change) in changes {
        tokens::check_name(name).map_err(EditError)?;
        let existing = match planned.get(name.as_str()) {
            Some(values) => values.clone(),
            None => doc.tokens().get(name).cloned(),
        };
        let values = match change {
            TokenChange::Delete => None,
            TokenChange::All(value) => {
                check(name, value)?;
                Some(Values::from([(first.clone(), value.trim().to_owned())]))
            }
            TokenChange::Modes(by_mode) => {
                let mut values = existing.clone().unwrap_or_default();
                for (key, value) in by_mode {
                    let id = mode_id(key)?;
                    match value {
                        Some(value) => {
                            check(name, value)?;
                            values.insert(id, value.trim().to_owned());
                        }
                        None => {
                            values.remove(&id);
                        }
                    }
                }
                (!values.is_empty()).then_some(values)
            }
        };
        planned.insert(name, values);
    }
    // One op per mode that ends up different, so undo reverses only those.
    // Removals go first, so a token deleted in the same edit frees its
    // place before a new one takes it.
    let none = Values::new();
    let mut ops = Vec::new();
    for (name, values) in &planned {
        let old = doc.tokens().get(*name).unwrap_or(&none);
        let new = values.as_ref().unwrap_or(&none);
        let modes: std::collections::BTreeSet<&String> = old.keys().chain(new.keys()).collect();
        for mode in modes {
            if old.get(mode) != new.get(mode) {
                ops.push(Op::Token {
                    name: (*name).to_owned(),
                    mode_id: mode.clone(),
                    value: new.get(mode).cloned(),
                });
            }
        }
    }
    ops.sort_by_key(|op| matches!(op, Op::Token { value: Some(_), .. }));
    let added = planned
        .iter()
        .filter(|(name, values)| values.is_some() && !doc.tokens().contains_key(**name))
        .count();
    if doc.tokens().len() + added > tokens::MAX_TOKENS {
        return err(format!(
            "a design can have at most {} tokens",
            tokens::MAX_TOKENS
        ));
    }
    Ok(ops)
}

/// What an artboard's `mode` should hold for the mode named `key` (or
/// with that id): its id, or `None` for a design without saved modes,
/// which keeps every artboard in its implicit one.
pub fn artboard_mode(doc: &Document, key: &str) -> Result<Option<String>> {
    let id = doc
        .modes()
        .into_iter()
        .find(|(id, m)| *id == key || m.name.eq_ignore_ascii_case(key))
        .map(|(id, _)| id.to_owned())
        .ok_or_else(|| {
            let names: Vec<String> = mode_list(doc).into_iter().map(|(_, n)| n).collect();
            EditError(format!(
                "the design has no mode {key:?}; its modes are {}",
                names.join(", ")
            ))
        })?;
    Ok((!doc.mode_map().is_empty()).then_some(id))
}

/// Sets the mode artboards render in, by the mode's name or id, or puts
/// them back in the first mode when `mode` is `None`.
pub fn set_artboard_mode(doc: &Document, ids: &[NodeId], mode: Option<&str>) -> Result<Vec<Op>> {
    let mode = match mode {
        Some(key) => artboard_mode(doc, key)?,
        None => None,
    };
    let mut ops = Vec::new();
    for id in ids {
        if !node(doc, id)?.is_artboard() {
            return err(format!(
                "node {id:?} isn't an artboard; modes are set on artboards"
            ));
        }
        ops.push(Op::Set {
            id: id.clone(),
            key: PropKey::Mode,
            value: mode.clone().map(Value::from),
        });
    }
    Ok(ops)
}

/// Moves a design's old shared CSS into tokens (see [`tokens::migrate`]).
/// What isn't a token goes in a `<style>` at the start of every artboard,
/// in the cascade layer the shared CSS had, so each artboard looks as it
/// did, and so do custom properties past [`tokens::MAX_TOKENS`]. Then the
/// old stylesheet is cleared.
pub fn migrate_css(doc: &Document, new_id: &mut impl FnMut() -> NodeId) -> Result<Vec<Op>> {
    let Some(css) = doc.css() else {
        return Ok(Vec::new());
    };
    let room = tokens::MAX_TOKENS.saturating_sub(doc.tokens().len());
    let migrated = tokens::migrate(css, room);
    let first = doc.first_mode().to_owned();
    let mut ops: Vec<Op> = migrated
        .tokens
        .into_iter()
        .map(|(name, value)| Op::Token {
            name,
            mode_id: first.clone(),
            value: Some(value),
        })
        .collect();
    if let Some(rest) = migrated.rest {
        let style = format!("<style>{}</style>", html::layered_style(&rest));
        for board in doc.artboards() {
            if board.is_instance() || board.kind == NodeKind::Text {
                continue;
            }
            let (written, _) =
                write_html(doc, &board.id, &style, WriteMode::Append, Some(0), new_id)?;
            ops.extend(written);
        }
    }
    ops.push(Op::Css { css: None });
    Ok(ops)
}

/// The ops for naming the design's modes and setting tokens in one edit,
/// as the viewer's token panel and an agent's `tokens` op do: `modes` names
/// the modes in order ([`set_modes`]), then each token is set, changed or
/// deleted ([`set_tokens`]). `new_id` makes ids for added modes.
pub fn edit_tokens(
    doc: &Document,
    modes: Option<&[String]>,
    tokens: &BTreeMap<String, TokenChange>,
    new_id: &mut impl FnMut() -> String,
) -> Result<Vec<Op>> {
    let (mut ops, list) = match modes {
        Some(names) => {
            let mut mode_id = || {
                id::fresh(&mut || format!("mode-{}", new_id()), |id| {
                    doc.mode_map().contains_key(id)
                })
            };
            set_modes(doc, names, &mut mode_id)?
        }
        None => (Vec::new(), mode_list(doc)),
    };
    let changes: Vec<(String, TokenChange)> = tokens
        .iter()
        .map(|(name, change)| (name.clone(), change.clone()))
        .collect();
    ops.extend(set_tokens(doc, &list, &changes)?);
    Ok(ops)
}

#[cfg(test)]
mod tests {
    use crate::{
        edit::{support::*, *},
        html,
    };

    #[test]
    fn write_modes() {
        let mut doc = Document::default();
        let board = board(&mut doc);
        let mut new_id = ids();
        let (ops, roots) = write_html(
            &doc,
            &board,
            "<p>a</p><p>c</p>",
            WriteMode::Append,
            None,
            &mut new_id,
        )
        .unwrap();
        doc.apply_all(&ops);
        assert_eq!(roots.len(), 2);
        let (ops, _) = write_html(
            &doc,
            &board,
            "<p>b</p>",
            WriteMode::Append,
            Some(1),
            &mut new_id,
        )
        .unwrap();
        doc.apply_all(&ops);
        let html = html::export(&doc, &board, false).unwrap();
        assert!(html.contains("<p>a</p>\n  <p>b</p>\n  <p>c</p>"), "{html}");

        let (ops, _) = write_html(
            &doc,
            &roots[0],
            "<h1>A</h1>",
            WriteMode::Replace,
            None,
            &mut new_id,
        )
        .unwrap();
        doc.apply_all(&ops);
        let html = html::export(&doc, &board, false).unwrap();
        assert!(html.contains("<h1>A</h1>\n  <p>b</p>"), "{html}");

        let (ops, _) = write_html(
            &doc,
            &board,
            "<span>x</span>",
            WriteMode::ReplaceChildren,
            None,
            &mut new_id,
        )
        .unwrap();
        doc.apply_all(&ops);
        assert_eq!(doc.children(Some(&board)).len(), 1);
    }
}
