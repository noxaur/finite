//! Inline styles, and merging CSS rules into an artboard's `<style>`.

use std::collections::BTreeMap;

use serde_json::Value;

use crate::{
    components::{self},
    css,
    document::{Document, Op},
    node::{NodeId, PropKey},
};

use super::set_text;
use super::{EditError, Result, element};
use super::{WriteMode, parse_html, write_fragments};

/// Accepts `backgroundColor` as well as `background-color`, and keeps `--custom` properties as is.
pub(crate) fn normalize_style_name(name: &str) -> String {
    let name = name.trim();
    if name.starts_with("--") {
        return name.to_owned();
    }
    let mut out = String::with_capacity(name.len() + 4);
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            out.push('-');
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
    }
    out
}

/// Longhand properties a shorthand resets. Styles are a map, not an ordered
/// declaration list, so setting a shorthand must clear these explicitly or the
/// longhand would keep winning.
pub(crate) fn longhands(shorthand: &str) -> &'static [&'static str] {
    match shorthand {
        "background" => &[
            "background-color",
            "background-image",
            "background-position",
            "background-size",
            "background-repeat",
            "background-attachment",
            "background-origin",
            "background-clip",
        ],
        "border" => &[
            "border-width",
            "border-style",
            "border-color",
            "border-top",
            "border-right",
            "border-bottom",
            "border-left",
        ],
        "border-radius" => &[
            "border-top-left-radius",
            "border-top-right-radius",
            "border-bottom-right-radius",
            "border-bottom-left-radius",
        ],
        "padding" => &[
            "padding-top",
            "padding-right",
            "padding-bottom",
            "padding-left",
        ],
        "margin" => &["margin-top", "margin-right", "margin-bottom", "margin-left"],
        "inset" => &["top", "right", "bottom", "left"],
        "gap" => &["row-gap", "column-gap"],
        "flex" => &["flex-grow", "flex-shrink", "flex-basis"],
        "font" => &[
            "font-family",
            "font-size",
            "font-weight",
            "font-style",
            "line-height",
            "font-variant",
            "font-stretch",
        ],
        _ => &[],
    }
}

pub(super) fn normalize_styles(styles: BTreeMap<String, String>) -> BTreeMap<String, String> {
    styles
        .into_iter()
        .map(|(k, v)| (normalize_style_name(&k), v.trim().to_owned()))
        .collect()
}

/// Sets styles on several nodes. A `None` value removes that style.
pub fn update_styles(
    doc: &Document,
    ids: &[NodeId],
    styles: &BTreeMap<String, Option<String>>,
) -> Result<Vec<Op>> {
    let styles: BTreeMap<String, Option<String>> = styles
        .iter()
        .map(|(k, v)| {
            (
                normalize_style_name(k),
                v.as_ref().map(|v| v.trim().to_owned()),
            )
        })
        .collect();
    let mut ops = Vec::new();
    for id in ids {
        let node = element(doc, id)?;
        for (name, value) in &styles {
            if value.is_some() {
                for longhand in longhands(name) {
                    if node.styles.contains_key(*longhand) && !styles.contains_key(*longhand) {
                        ops.push(Op::Set {
                            id: id.clone(),
                            key: PropKey::Style((*longhand).to_owned()),
                            value: None,
                        });
                    }
                }
            }
            ops.push(Op::Set {
                id: id.clone(),
                key: PropKey::Style(name.clone()),
                value: value.clone().map(Value::String),
            });
        }
    }
    Ok(ops)
}

/// The first id in the selectors of `css`'s rules that names a part inside
/// an instance, like `#inst/part` or `#inst\/part`. A stylesheet rule never
/// reaches such a part, since the part only exists in the instance's
/// expansion. A `/` in a value, a `url(...)`, a string or a comment is not
/// that selector. An id with a `/` outside any instance is the author's own.
pub fn instance_path_in_rules(doc: &Document, css: &str) -> Result<Option<NodeId>> {
    let rules = css::patch_rules(css).map_err(|e| EditError(e.to_string()))?;
    for rule in &rules {
        for id in css::selector_ids(&rule.selector) {
            let in_instance = components::split(&id)
                .and_then(|(root, _)| doc.get(root))
                .is_some_and(|root| root.instance_of.is_some());
            if in_instance {
                return Ok(Some(id));
            }
        }
    }
    Ok(None)
}

/// A `css` patch merged into an artboard's `<style>`.
pub struct StyleMerge {
    pub ops: Vec<Op>,
    /// The `<style>` element that holds the rules afterwards.
    pub sheet: NodeId,
    /// Whether the artboard had no `<style>`, so `ops` add one.
    pub created: bool,
    /// What changed in an existing sheet. `ops` is empty and `created` false
    /// when it already had the rules.
    pub changes: Vec<css::SheetChange>,
}

/// Merges the rules of `patch` into the first `<style>` under `board`,
/// keeping what the patch doesn't touch, or adds a `<style>` at the start of
/// the artboard when it has none.
pub fn merge_style(
    doc: &Document,
    board: &str,
    patch: &str,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<StyleMerge> {
    let css_err = |e: css::CssError| EditError(e.to_string());
    let sheet = doc
        .subtree(board)
        .into_iter()
        .find(|n| n.tag().is_some_and(|t| t.eq_ignore_ascii_case("style")))
        .map(|n| n.id.clone());
    let Some(sheet) = sheet else {
        let (next, _) = css::merge_sheet("", patch).map_err(css_err)?;
        let fragments = parse_html(&format!("<style>{next}</style>"))?;
        let (ops, roots) =
            write_fragments(doc, board, fragments, WriteMode::Append, Some(0), new_id)?;
        return Ok(StyleMerge {
            ops,
            sheet: roots.first().cloned().unwrap_or_default(),
            created: true,
            changes: Vec::new(),
        });
    };
    let existing: String = doc
        .children(Some(&sheet))
        .iter()
        .filter_map(|c| c.text.as_deref())
        .collect();
    let (next, changes) = css::merge_sheet(&existing, patch).map_err(css_err)?;
    let ops = if next == existing {
        Vec::new()
    } else {
        set_text(doc, &sheet, &next, new_id)?
    };
    Ok(StyleMerge {
        ops,
        sheet,
        created: false,
        changes,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::edit::*;

    #[test]
    fn shorthands_reset_longhands() {
        let mut doc = Document::default();
        let ops = create_artboard(
            &doc,
            "b".into(),
            NewArtboard {
                name: "B".into(),
                width: 10.0,
                height: Some(10.0),
                position: None,
                page: None,
                styles: BTreeMap::from([("background".into(), "#fef3c7".into())]),
                ..Default::default()
            },
        )
        .unwrap();
        doc.apply_all(&ops);
        assert!(
            !doc.get("b")
                .unwrap()
                .styles
                .contains_key("background-color")
        );

        let set = |k: &str, v: &str| BTreeMap::from([(k.to_owned(), Some(v.to_owned()))]);
        doc.apply_all(&update_styles(&doc, &["b".into()], &set("paddingTop", "4px")).unwrap());
        doc.apply_all(&update_styles(&doc, &["b".into()], &set("padding", "8px")).unwrap());
        let styles = &doc.get("b").unwrap().styles;
        assert_eq!(styles.get("padding").map(String::as_str), Some("8px"));
        assert!(!styles.contains_key("padding-top"));
    }
}
