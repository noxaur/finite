//! Reading an `edit` call's ops: which kind each one is, the fields it
//! needs, and the work that doesn't need the design's lock, done before
//! taking it: parsing HTML, and reading and storing an import's file.

use std::sync::Arc;

use base64::Engine;
use finite_design::{edit, html};
use serde_json::{Map, Value};

use super::EditParams;
use crate::mcp::selector::plain;
use crate::{hub::Hub, transfer};

pub(super) type Fields = Map<String, Value>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::mcp) enum Kind {
    Artboard,
    Html,
    Css,
    Attrs,
    Move,
    Remove,
    Replace,
    Page,
    Tokens,
    Import,
    Component,
}

impl Kind {
    const ALL: [Kind; 11] = [
        Kind::Artboard,
        Kind::Html,
        Kind::Css,
        Kind::Attrs,
        Kind::Move,
        Kind::Remove,
        Kind::Replace,
        Kind::Page,
        Kind::Tokens,
        Kind::Import,
        Kind::Component,
    ];

    pub(super) fn name(self) -> &'static str {
        match self {
            Kind::Artboard => "artboard",
            Kind::Html => "html",
            Kind::Css => "css",
            Kind::Attrs => "attrs",
            Kind::Move => "move",
            Kind::Remove => "remove",
            Kind::Replace => "replace",
            Kind::Page => "page",
            Kind::Tokens => "tokens",
            Kind::Import => "import",
            Kind::Component => "component",
        }
    }

    /// One op of this kind, for error messages.
    pub(in crate::mcp) fn example(self) -> &'static str {
        match self {
            Kind::Artboard => {
                r#"{"op": "artboard", "name": "Home — mobile", "width": 390, "height": 844, "html": "<header data-name=\"Nav\">…</header>", "as": "m"}"#
            }
            Kind::Html => {
                r#"{"op": "html", "select": "@m", "html": "<section data-name=\"Features\">…</section>", "mode": "append"}"#
            }
            Kind::Css => {
                r##"{"op": "css", "css": "#k3x9a2bq { height: 1712px } .btn { border-radius: 999px }", "to": "inline"}"##
            }
            Kind::Attrs => {
                r#"{"op": "attrs", "select": ".cta", "set": {"href": "/start", "data-name": "CTA"}}"#
            }
            Kind::Move => {
                r##"{"op": "move", "select": "#a1b2c3d4", "to": "#list", "position": "prepend"}"##
            }
            Kind::Remove => r#"{"op": "remove", "select": "[data-name=Banner]"}"#,
            Kind::Replace => r##"{"op": "replace", "find": "#3b82f6", "replace": "#f97316"}"##,
            Kind::Page => r#"{"op": "page", "create": "Drafts", "as": "d"}"#,
            Kind::Tokens => {
                r##"{"op": "tokens", "set": {"--brand": "#f97316", "--bg": {"Light": "#ffffff", "Dark": "#0b0b0b"}}, "modes": ["Light", "Dark"]}"##
            }
            Kind::Import => {
                r#"{"op": "import", "name": "landing.html", "content": "<!doctype html>…", "page": "Inbox"}"#
            }
            Kind::Component => {
                r#"{"op": "component", "select": "[data-name=Nav]", "name": "Top bar"}"#
            }
        }
    }

    fn named(name: &str) -> Option<Kind> {
        let name = name.trim().to_ascii_lowercase();
        let alias = match name.as_str() {
            "create_artboard" => "artboard",
            "write_html" => "html",
            "styles" | "update_styles" | "style" => "css",
            "attributes" | "set_attributes" | "attr" => "attrs",
            "delete" | "delete_nodes" => "remove",
            "move_nodes" | "duplicate" => "move",
            "replace_values" => "replace",
            "pages" | "create_page" => "page",
            "set_tokens" | "token" => "tokens",
            "import_design" => "import",
            "create_component" | "components" | "detach" | "detach_instance" => "component",
            other => other,
        };
        Kind::ALL.into_iter().find(|k| k.name() == alias)
    }
}

/// One op, read and checked, with what was prepared for it.
pub(super) struct Step {
    pub kind: Kind,
    pub fields: Fields,
    /// The parsed `html` of an html or artboard op.
    pub html: Option<html::Parsed>,
    /// An import's file, read and stored.
    pub import: Option<transfer::Prepared>,
}

/// The kinds, for messages.
fn kinds() -> String {
    Kind::ALL.map(Kind::name).join(", ")
}

/// A field as text: a string as it is, a number or boolean as JSON. `None`
/// when it's missing or null.
pub(super) fn text(fields: &Fields, key: &str) -> Option<String> {
    match fields.get(key)? {
        Value::Null => None,
        value => Some(plain(value)),
    }
}

/// A field as a number, also from a numeric string like `"390"` or `"390px"`.
pub(super) fn number(fields: &Fields, key: &str) -> Result<Option<f64>, String> {
    match fields.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Number(n)) => Ok(n.as_f64()),
        Some(Value::String(s)) => s
            .trim()
            .trim_end_matches("px")
            .trim()
            .parse()
            .map(Some)
            .map_err(|_| format!("{key} is {s:?}, not a number")),
        Some(other) => Err(format!("{key} is {other}, not a number")),
    }
}

/// A field as a boolean: true, or "true".
pub(super) fn flag(fields: &Fields, key: &str) -> bool {
    match fields.get(key) {
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.eq_ignore_ascii_case("true"),
        _ => false,
    }
}

/// What an op selects: `select`, or old habits, `nodeIds`, `nodeId` or
/// `targetId`, read as `#id` selectors.
pub(super) fn select_of(fields: &Fields) -> Option<Value> {
    if let Some(select) = fields.get("select").filter(|v| !v.is_null()) {
        return Some(select.clone());
    }
    let ids = ["nodeIds", "nodeId", "targetId", "target"]
        .iter()
        .find_map(|k| fields.get(*k).filter(|v| !v.is_null()))?;
    let list: Vec<Value> = match ids {
        Value::Array(items) => items.clone(),
        one => vec![one.clone()],
    };
    let selectors: Vec<String> = list
        .iter()
        .map(plain)
        .map(|id| {
            if id.starts_with('#') || id.starts_with('@') {
                id
            } else {
                format!("#{id}")
            }
        })
        .collect();
    Some(selectors.join(", ").into())
}

/// A field that's an object, also from a JSON string.
pub(super) fn object(fields: &Fields, key: &str) -> Result<Option<Fields>, String> {
    match fields.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::Object(map)) => Ok(Some(map.clone())),
        Some(Value::String(s)) => match serde_json::from_str(s) {
            Ok(Value::Object(map)) => Ok(Some(map)),
            _ => Err(format!(
                "{key} should be an object, like {{\"href\": \"/start\"}}"
            )),
        },
        Some(other) => Err(format!("{key} should be an object, not {other}")),
    }
}

/// Errors unless `fields` has each of `keys`, saying what one looks like.
pub(super) fn need(kind: Kind, fields: &Fields, keys: &[&str]) -> Result<(), String> {
    let missing: Vec<&str> = keys
        .iter()
        .copied()
        .filter(|k| match fields.get(*k) {
            None | Some(Value::Null) => true,
            Some(Value::String(s)) => s.is_empty() && *k != "replace",
            _ => false,
        })
        .collect();
    if missing.is_empty() {
        return Ok(());
    }
    Err(format!(
        "\"{}\" needs {}, like {}",
        kind.name(),
        missing.join(" and "),
        kind.example()
    ))
}

/// The op's kind, from "op" or, when it's left out, from its fields.
fn kind_of(fields: &Fields) -> Result<Kind, String> {
    let given = ["op", "type", "kind", "action"]
        .iter()
        .find_map(|k| fields.get(*k).and_then(Value::as_str));
    if let Some(given) = given {
        return Kind::named(given)
            .ok_or_else(|| format!("there's no {given:?} op. Ops are {}", kinds()));
    }
    let has = |k: &str| fields.get(k).is_some_and(|v| !v.is_null());
    Ok(if (has("width") || has("from")) && has("name") {
        Kind::Artboard
    } else if has("detach") && !has("copy") {
        Kind::Component
    } else if has("content") || has("contentBase64") {
        Kind::Import
    } else if has("set") && !has("select") {
        Kind::Tokens
    } else if has("create") || has("rename") {
        Kind::Page
    } else if has("find") {
        Kind::Replace
    } else if has("css") || has("styles") {
        Kind::Css
    } else if has("html") {
        Kind::Html
    } else if has("set") || has("attributes") {
        Kind::Attrs
    } else if has("to") || has("x") || has("copy") {
        Kind::Move
    } else {
        return Err(format!(
            "say which op this is with \"op\": one of {}",
            kinds()
        ));
    })
}

/// The ops of an edit call: ops (a list, one op or a JSON string), or one
/// op passed flat.
fn ops_of(p: &EditParams) -> Result<Vec<Value>, String> {
    let example = Kind::Replace.example();
    match &p.ops {
        Some(Value::Array(ops)) => Ok(ops.clone()),
        Some(Value::String(text)) => match serde_json::from_str(text) {
            Ok(Value::Array(ops)) => Ok(ops),
            Ok(op @ Value::Object(_)) => Ok(vec![op]),
            _ => Err(format!(
                "ops isn't valid JSON. Pass a list of ops, like {{\"ops\": [{example}]}}."
            )),
        },
        Some(op @ Value::Object(_)) => Ok(vec![op.clone()]),
        Some(Value::Null) | None if p.flat.is_empty() => {
            if p.status.is_some() {
                return Ok(Vec::new());
            }
            Err(format!(
                "pass ops, or one op flat, like {{\"designId\": \"…\", {}.",
                &example[1..]
            ))
        }
        Some(Value::Null) | None => Ok(vec![Value::Object(p.flat.clone())]),
        Some(other) => Err(format!(
            "ops should be a list of ops, like {{\"ops\": [{example}]}}, not {other}."
        )),
    }
}

/// `error` from op `index` (0-based), worded as every failed edit is.
pub(super) fn failed(index: usize, kind: Option<Kind>, error: &str) -> String {
    let error = error.trim_end();
    let stop = if error.ends_with(['.', '?', '!']) {
        ""
    } else {
        "."
    };
    match kind {
        Some(kind) => format!(
            "op {} ({}): {error}{stop} Nothing was changed.",
            index + 1,
            kind.name()
        ),
        None => format!("op {}: {error}{stop} Nothing was changed.", index + 1),
    }
}

/// Reads and checks every op of an edit call, parses its HTML and stores
/// its imports' files, without the design's lock. The first op that's
/// wrong fails the call.
pub(super) async fn prepare(hub: &Arc<Hub>, p: &EditParams) -> Result<Vec<Step>, String> {
    let raw = ops_of(p)?;
    let mut steps = Vec::with_capacity(raw.len());
    for (index, value) in raw.into_iter().enumerate() {
        let Value::Object(fields) = value else {
            return Err(failed(
                index,
                None,
                &format!("each op is an object, like {}", Kind::Css.example()),
            ));
        };
        let kind = kind_of(&fields).map_err(|e| failed(index, None, &e))?;
        let fail = |e: String| failed(index, Some(kind), &e);
        let mut step = Step {
            kind,
            fields,
            html: None,
            import: None,
        };
        match kind {
            Kind::Html | Kind::Artboard => {
                if kind == Kind::Html {
                    let select = select_of(&step.fields).unwrap_or(Value::Null);
                    let mut check = step.fields.clone();
                    check.insert("select".into(), select);
                    need(kind, &check, &["select", "html"]).map_err(fail)?;
                }
                if let Some(source) = text(&step.fields, "html") {
                    // For a few MB of HTML, parsing is most of the work.
                    let parsed =
                        tokio::task::spawn_blocking(move || edit::parse_html_reporting(&source))
                            .await
                            .map_err(|e| fail(e.to_string()))?
                            .map_err(|e| fail(e.to_string()))?;
                    step.html = Some(parsed);
                }
            }
            Kind::Import => {
                step.import = Some(
                    import(hub, &p.design_id, &step.fields)
                        .await
                        .map_err(fail)?,
                )
            }
            _ => {}
        }
        steps.push(step);
    }
    Ok(steps)
}

/// Reads and stores an import op's file.
async fn import(
    hub: &Arc<Hub>,
    design: &str,
    fields: &Fields,
) -> Result<transfer::Prepared, String> {
    let bytes = match (text(fields, "content"), text(fields, "contentBase64")) {
        (Some(text), None) => text.into_bytes(),
        (None, Some(encoded)) => base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .map_err(|e| format!("contentBase64 isn't base64: {e}"))?,
        (Some(_), Some(_)) => return Err("pass content or contentBase64, not both".into()),
        (None, None) => {
            return Err(format!(
                "\"import\" needs the file as content (text) or contentBase64 (bytes), like {}. Finite can't read files on your machine, so read the file and pass its text",
                Kind::Import.example()
            ));
        }
    };
    let name = ["name", "file", "fileName", "path"]
        .iter()
        .find_map(|k| text(fields, k))
        .map(|n| n.rsplit(['/', '\\']).next().unwrap_or(&n).to_owned());
    let format = match text(fields, "format") {
        Some(format) => format,
        None => format_of(name.as_deref().unwrap_or("")).to_owned(),
    };
    let format = transfer::format_named(&format).map_err(|e| e.to_string())?;
    let strict: Vec<String> = match fields.get("strict") {
        Some(Value::Array(items)) => items.iter().map(plain).collect(),
        Some(Value::String(s)) => vec![s.clone()],
        _ => Vec::new(),
    };
    let strict =
        transfer::strict_named(strict.iter().map(String::as_str)).map_err(|e| e.to_string())?;
    transfer::prepare(hub, design, format, bytes, name, &strict)
        .await
        .map_err(|e| e.to_string())
}

/// The format a file's name implies, as the web app's Import button reads it.
/// A `.tar` is a repo, including `<design>-app.tar`: app is export only.
fn format_of(name: &str) -> &'static str {
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".figma.json") {
        "figma"
    } else if lower.ends_with(".finite") {
        "finite"
    } else if lower.ends_with(".tar") {
        "repo"
    } else {
        "html"
    }
}

/// A one-line label for an edit that has no status, about
/// [`finite_design::label::SUMMARY`] characters: `Replace #3b82f6 → #f97316, CSS on .btn`.
/// Selectors show as `#a, #b`, or `N elements` when there are more than two
/// or the pair is long. The same phrase twice in one edit is listed once.
pub(super) fn summary(steps: &[Step]) -> String {
    const SHOWN: usize = 3;
    let mut parts = Vec::new();
    for step in steps {
        let part = step_phrase(step);
        if !parts.contains(&part) {
            parts.push(part);
        }
    }
    let extra = parts.len().saturating_sub(SHOWN);
    let mut label = parts.into_iter().take(SHOWN).collect::<Vec<_>>().join(", ");
    if extra > 0 {
        label.push_str(&format!(" and {extra} more"));
    }
    let label = one_line(&label);
    let label = if label.is_empty() {
        "Edit".to_owned()
    } else {
        label
    };
    finite_design::label::clip(&label, finite_design::label::SUMMARY)
}

/// One op, with its name capitalized the same way every time.
fn step_phrase(step: &Step) -> String {
    let f = &step.fields;
    let target = || selector_label(&select_of(f).unwrap_or(Value::Null));
    match step.kind {
        Kind::Artboard => match text(f, "from") {
            Some(from) => format!("Artboard from {}", one_line(&from)),
            None => format!(
                "Artboard {:?}",
                one_line(&text(f, "name").unwrap_or_default())
            ),
        },
        Kind::Html => on("HTML", &target()),
        Kind::Css => on("CSS", &css_target(f)),
        Kind::Attrs => on("Attrs", &target()),
        Kind::Move => targeting("Move", &target()),
        Kind::Remove => targeting("Remove", &target()),
        Kind::Replace => format!(
            "Replace {} → {}",
            bit(&text(f, "find").unwrap_or_default()),
            bit(&text(f, "replace").unwrap_or_default())
        ),
        Kind::Page => {
            let name = ["create", "rename", "remove", "name"]
                .iter()
                .find_map(|k| text(f, k))
                .unwrap_or_default();
            format!("Page {:?}", one_line(&name))
        }
        Kind::Tokens => {
            let names: Vec<String> = object(f, "set")
                .ok()
                .flatten()
                .map(|m| m.keys().take(3).cloned().collect())
                .unwrap_or_default();
            let names = names.join(", ");
            if names.is_empty() {
                "Tokens".to_owned()
            } else {
                format!("Tokens {names}")
            }
        }
        Kind::Component if flag(f, "detach") => targeting("Detach", &target()),
        Kind::Component => match text(f, "name") {
            Some(name) => format!("Component {:?}", one_line(&name)),
            None => targeting("Component", &target()),
        },
        Kind::Import => match step.import.as_ref() {
            Some(import) => {
                let rest = one_line(import.label().trim_start_matches("Import "));
                if rest.is_empty() {
                    "Import".to_owned()
                } else {
                    format!("Import {rest}")
                }
            }
            None => "Import".into(),
        },
    }
}

/// `Op on target`, or just `Op` when nothing was selected.
fn on(op: &str, target: &str) -> String {
    if target.is_empty() {
        op.to_owned()
    } else {
        format!("{op} on {target}")
    }
}

/// `Op target`, or just `Op` when nothing was selected.
fn targeting(op: &str, target: &str) -> String {
    if target.is_empty() {
        op.to_owned()
    } else {
        format!("{op} {target}")
    }
}

/// Selectors for a label. An array is `#a, #b`, not JSON. More than two,
/// or two that would crowd the label, become `N elements`.
fn selector_label(value: &Value) -> String {
    let items: Vec<String> = match value {
        Value::Array(items) => items.iter().filter_map(selector_text).collect(),
        other => selector_text(other).into_iter().collect(),
    };
    list_label(&items)
}

fn selector_text(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(s) => s.clone(),
        Value::Null => return None,
        other => other.to_string(),
    };
    let text = one_line(&text);
    (!text.is_empty()).then_some(text)
}

/// The selectors a css op names: its `select`, or the rules in `css`.
fn css_target(fields: &Fields) -> String {
    if let Some(select) = select_of(fields) {
        return selector_label(&select);
    }
    let css = text(fields, "css").unwrap_or_default();
    let selectors: Vec<String> = finite_design::css::patch_rules(&css)
        .unwrap_or_default()
        .into_iter()
        .map(|rule| one_line(&rule.selector))
        .filter(|selector| !selector.is_empty())
        .collect();
    list_label(&selectors)
}

/// `#a, #b` for one or two short selectors, otherwise `N elements`.
fn list_label(items: &[String]) -> String {
    /// Two selectors longer than this crowd a 60-character label.
    const PAIR: usize = 40;
    let mut unique = Vec::new();
    for item in items {
        if !unique.contains(item) {
            unique.push(item.clone());
        }
    }
    match unique.len() {
        0 => String::new(),
        1 => unique[0].clone(),
        2 => {
            let joined = format!("{}, {}", unique[0], unique[1]);
            if joined.chars().count() <= PAIR {
                joined
            } else {
                "2 elements".to_owned()
            }
        }
        n => format!("{n} elements"),
    }
}

/// `text` as one line, cut so a find and a replace both fit in the label.
fn bit(text: &str) -> String {
    finite_design::label::clip(&one_line(text), 24)
}

/// `text` with surrounding whitespace and line breaks collapsed.
fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn step(kind: Kind, fields: serde_json::Value) -> Step {
        Step {
            kind,
            fields: serde_json::from_value(fields).unwrap(),
            html: None,
            import: None,
        }
    }

    #[test]
    fn labels_are_one_line_with_selectors_not_json() {
        let attrs = summary(&[step(
            Kind::Attrs,
            json!({ "select": ["#rg3abcde", "#ab12cd34"], "set": { "title": "Hi" } }),
        )]);
        assert_eq!(attrs, "Attrs on #rg3abcde, #ab12cd34");

        let many = summary(&[step(Kind::Move, json!({ "select": ["#a", "#b", "#c"] }))]);
        assert_eq!(many, "Move 3 elements");

        let repeated = summary(&[step(
            Kind::Css,
            json!({ "select": ["#a", "#a"], "css": "color: red" }),
        )]);
        assert_eq!(repeated, "CSS on #a");

        let pair = summary(&[step(
            Kind::Css,
            json!({
                "select": ["div.card ".repeat(6), "section.panel ".repeat(4)],
                "css": "color: red",
            }),
        )]);
        assert_eq!(pair, "CSS on 2 elements");

        let twice = summary(&[
            step(
                Kind::Html,
                json!({ "select": "#355ttrw2", "html": "<p>a</p>" }),
            ),
            step(
                Kind::Html,
                json!({ "select": "#355ttrw2", "html": "<p>b</p>" }),
            ),
        ]);
        assert_eq!(twice, "HTML on #355ttrw2");

        let mixed = summary(&[
            step(Kind::Html, json!({ "select": "#a", "html": "<p>a</p>" })),
            step(Kind::Css, json!({ "select": ".card", "css": "margin: 0" })),
        ]);
        assert_eq!(mixed, "HTML on #a, CSS on .card");

        let css = summary(&[step(
            Kind::Css,
            json!({ "css": ".a { color: red } .b { color: blue } .c { color: green }" }),
        )]);
        assert_eq!(css, "CSS on 3 elements");

        let replaced = summary(&[step(
            Kind::Replace,
            json!({
                "find": ".al svg path {\n  stroke-width: 1.6\n}",
                "replace": ".ins svg path {\n  stroke-width: 2\n}",
            }),
        )]);
        assert!(!replaced.contains('\n'), "{replaced}");
        assert!(replaced.starts_with("Replace .al svg path"), "{replaced}");
        assert!(replaced.contains('→'), "{replaced}");
        assert!(
            replaced.chars().count() <= finite_design::label::SUMMARY,
            "{replaced}"
        );

        assert_eq!(summary(&[]), "Edit");
    }
}
