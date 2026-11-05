//! Running an `edit` call's ops inside one transaction. Each op reads the
//! document as the ops before it left it (`tx.view()`), builds its ops with
//! the edit commands in `finite_design::edit`, and stages them with
//! `tx.edit`. An op that fails fails the whole call, and the transaction
//! puts everything back.

use std::collections::{BTreeMap, HashMap, HashSet};

use finite_design::{
    Document, NodeId, Op, Transaction, css,
    edit::{self, NewArtboard, WriteMode},
    search::{self, Places},
    select,
};
use serde_json::Value;

use super::{
    describe, label, matched,
    ops::{Fields, Kind, Step, failed, flag, need, number, object, select_of, text},
    page_id, plain, selector_text, with_refs,
};
use crate::{
    hub::random_id,
    mcp::{
        TokenValue, component_tools::classes_styled_outside, cut, kept_nodes_note, kept_note,
        left_out, outline, token_ops, transfer,
    },
};

type Refs = HashMap<String, NodeId>;
type Result<T> = std::result::Result<T, String>;

/// Runs `steps` in order against `tx`, and returns a numbered section for
/// each saying what it did. The first op that fails fails them all.
pub(super) fn run(tx: &mut Transaction<'_>, steps: Vec<Step>) -> Result<Vec<String>> {
    let mut refs = Refs::new();
    let mut sections = Vec::with_capacity(steps.len());
    for (index, step) in steps.into_iter().enumerate() {
        let kind = step.kind;
        let name = text(&step.fields, "as").map(|a| a.trim().trim_start_matches('@').to_owned());
        let (text, made) =
            apply(tx, step, &refs).map_err(|e| failed(index, Some(kind), &for_doc6(&e)))?;
        if let (Some(name), Some(id)) = (name.filter(|n| !n.is_empty()), made) {
            refs.insert(name, id);
        }
        sections.push(format!(
            "{}. {}: {}",
            index + 1,
            kind.name(),
            text.trim_end()
        ));
    }
    Ok(sections)
}

/// Design errors name the classic tools. This surface doesn't have them, so
/// say which op to use instead. `run` applies it to every error an op returns.
fn for_doc6(error: &str) -> String {
    let error = rewrite_style(error)
        .replace(
            "need the data-id get_html gave them",
            "need the data-id read with as: \"html\" gave them",
        )
        .replace(
            "use the ids get_html shows for it",
            "use the ids read with as: \"html\" shows for it",
        )
        .replace(
            "replace it with insert_instance",
            "write it as <div data-instance-of=\"…\"></div>",
        )
        .replace(
            "use mode \"replace-children\" instead",
            "use mode \"inner\" instead",
        );
    rewrite_detach(&rewrite_make_component(&error))
}

/// The whole design error for a `style` attribute, `#{id}: style isn't an
/// attribute; use update_styles to change inline styles`, or that sentence
/// alone. A value an agent sent can quote the phrase inside a different
/// error, and a substring rewrite would turn that value into css advice.
fn rewrite_style(error: &str) -> String {
    const SHORT: &str = "use update_styles to change inline styles";
    const FULL: &str = "style isn't an attribute; use update_styles to change inline styles";
    let advice = |prefix: &str, id: &str| {
        format!(
            "{prefix}style isn't an attribute; change inline styles with a css op, like {{\"op\": \"css\", \"select\": \"#{id}\", \"css\": \"color: red\"}}"
        )
    };
    if error == SHORT || error == FULL {
        return advice("", "id");
    }
    if let Some(head) = error.strip_suffix(FULL)
        && let Some(id) = node_id_before(head)
        && head == format!("#{id}: ")
    {
        return advice(head, id);
    }
    error.to_owned()
}

/// The node id in the last `#{id}` before `end`, when one is there.
/// A virtual id keeps its `/`, since that is the node a css op has to select.
fn node_id_before(text: &str) -> Option<&str> {
    let hash = text.rfind('#')?;
    let rest = &text[hash + 1..];
    let end = rest
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '/'))
        .unwrap_or(rest.len());
    let id = &rest[..end];
    (!id.is_empty()).then_some(id)
}

/// `#{id} isn't a component; make it one with create_component` names the
/// node, so the component op can select it.
fn rewrite_make_component(error: &str) -> String {
    const PHRASE: &str = "make it one with create_component";
    let Some(at) = error.find(PHRASE) else {
        return error.to_owned();
    };
    let id = error[..at].rfind('#').map(|hash| {
        let rest = &error[hash + 1..at];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == ';')
            .unwrap_or(rest.len());
        &rest[..end]
    });
    let advice = match id {
        Some(id) if !id.is_empty() => {
            format!("make it one with {{\"op\": \"component\", \"select\": \"#{id}\"}}")
        }
        _ => "make it one with a component op".to_owned(),
    };
    let mut out = String::with_capacity(error.len() + advice.len());
    out.push_str(&error[..at]);
    out.push_str(&advice);
    out.push_str(&error[at + PHRASE.len()..]);
    out
}

/// `detach_instance #id`, and a bare `detach #id`, become the component op
/// that detaches that instance.
fn rewrite_detach(error: &str) -> String {
    let mut error = error.to_owned();
    // The longer needle first, so `detach_instance #id` isn't read as `detach`.
    for needle in ["detach_instance #", "detach #"] {
        while let Some(start) = error.find(needle) {
            let rest = &error[start + needle.len()..];
            let id_len = rest
                .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
                .unwrap_or(rest.len());
            let id = &rest[..id_len];
            if id.is_empty() {
                break;
            }
            let op = format!("{{\"op\": \"component\", \"select\": \"#{id}\", \"detach\": true}}");
            let mut after = &rest[id_len..];
            if let Some(skipped) = after.strip_prefix(" first") {
                after = skipped;
            }
            let mut out = String::with_capacity(error.len() + op.len());
            out.push_str(&error[..start]);
            out.push_str(&op);
            out.push_str(after);
            error = out;
        }
    }
    error.replace(
        "detach_instance",
        "detach the instance with {\"op\": \"component\", \"select\": \"#instance\", \"detach\": true}",
    )
}

/// An edit's result: `head`, then each op's section.
pub(super) fn result(head: String, sections: Vec<String>) -> String {
    let mut text = head;
    for section in sections {
        text.push('\n');
        text.push_str(&section);
    }
    cut(
        text,
        "read with select and as: \"outline\" shows any part of it.",
    )
}

/// What one op did, and the node or page it made, for its `as`.
fn apply(tx: &mut Transaction<'_>, step: Step, refs: &Refs) -> Result<(String, Option<NodeId>)> {
    match step.kind {
        Kind::Artboard => artboard(tx, step, refs),
        Kind::Html => html_op(tx, step, refs),
        Kind::Css => css_op(tx, &step.fields, refs).map(|t| (t, None)),
        Kind::Attrs => attrs(tx, &step.fields, refs).map(|t| (t, None)),
        Kind::Move => move_op(tx, &step.fields, refs),
        Kind::Remove => remove(tx, &step.fields, refs).map(|t| (t, None)),
        Kind::Replace => replace(tx, &step.fields, refs).map(|t| (t, None)),
        Kind::Page => page(tx, &step.fields, refs),
        Kind::Tokens => tokens(tx, &step.fields).map(|t| (t, None)),
        Kind::Import => import(tx, step, refs),
        Kind::Component => component(tx, &step.fields, refs),
    }
}

fn make_id() -> NodeId {
    random_id(8)
}

/// An id no node has, counting the ones this transaction made.
fn fresh(tx: &Transaction<'_>) -> NodeId {
    tx.new_id(&mut make_id)
}

fn stage(tx: &mut Transaction<'_>, ops: Vec<Op>) -> Result<()> {
    tx.edit(ops, &mut make_id).map_err(|e| e.to_string())
}

/// The elements `select` matches, as a selector and ids. None is an error.
fn targets(
    doc: &Document,
    select: &Value,
    refs: &Refs,
    what: &str,
) -> Result<(String, Vec<NodeId>)> {
    let selector = selector_text(select, refs)?;
    let ids = matched(doc, &selector, None)?;
    if ids.is_empty() {
        return Err(format!(
            "{what} {selector:?} matches no element. read with contains, or with no select, lists what's there"
        ));
    }
    Ok((selector, ids))
}

/// The op's `select` (or `nodeIds`) matches, which `kind` needs.
fn selected(
    doc: &Document,
    kind: Kind,
    fields: &Fields,
    refs: &Refs,
) -> Result<(String, Vec<NodeId>)> {
    let Some(select) = select_of(fields) else {
        return Err(format!(
            "\"{}\" needs select, like {}",
            kind.name(),
            kind.example()
        ));
    };
    targets(doc, &select, refs, "select")
}

/// Declarations from a field: `"color: red; padding: 4px"`, or an object
/// like `{"color": "red"}` where null or `unset` removes one.
fn declarations(fields: &Fields, key: &str) -> Result<BTreeMap<String, Option<String>>> {
    let mut out = BTreeMap::new();
    match fields.get(key) {
        None | Some(Value::Null) => {}
        Some(Value::Object(map)) => {
            for (k, v) in map {
                let value = match v {
                    Value::Null => None,
                    v => Some(plain(v)).filter(|v| !v.trim().eq_ignore_ascii_case("unset")),
                };
                out.insert(k.clone(), value);
            }
        }
        Some(Value::String(text)) => {
            for decl in text.split(';') {
                if let Some((k, v)) = decl.split_once(':') {
                    let v = v.trim();
                    let value = (!v.eq_ignore_ascii_case("unset")).then(|| v.to_owned());
                    out.insert(k.trim().to_owned(), value);
                }
            }
        }
        Some(other) => return Err(format!("{key} should be declarations, not {other}")),
    }
    Ok(out)
}

/// The outline of each of `roots`, three levels deep.
fn outlines(doc: &Document, roots: &[NodeId], depth: usize) -> String {
    roots.iter().map(|r| outline(doc, r, depth)).collect()
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

/// Where an html op's HTML goes, or a move's nodes, relative to a match.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Place {
    Append,
    Prepend,
    Before,
    After,
    Inner,
    Replace,
}

impl Place {
    fn named(name: Option<&str>) -> Option<Place> {
        Some(
            match name.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
                None | Some("append" | "beforeend" | "") => Place::Append,
                Some("prepend" | "afterbegin") => Place::Prepend,
                Some("before" | "beforebegin") => Place::Before,
                Some("after" | "afterend") => Place::After,
                Some("inner" | "replace-children" | "replacechildren") => Place::Inner,
                Some("replace" | "outer") => Place::Replace,
                Some(_) => return None,
            },
        )
    }

    fn name(self) -> &'static str {
        match self {
            Place::Append => "append",
            Place::Prepend => "prepend",
            Place::Before => "before",
            Place::After => "after",
            Place::Inner => "inner",
            Place::Replace => "replace",
        }
    }
}

/// Where a node sits among its parent's children: the parent, and its index.
fn position(doc: &Document, id: &str) -> Result<(NodeId, usize)> {
    let node = doc
        .get(id)
        .ok_or_else(|| format!("node {id:?} not found"))?;
    let Some(parent) = node.parent.clone() else {
        return Err(format!(
            "{} is an artboard, so nothing goes next to it. Use an \"artboard\" op for a new screen",
            label(doc, id)
        ));
    };
    let index = doc
        .children(Some(&parent))
        .iter()
        .position(|c| c.id == id)
        .unwrap_or(0);
    Ok((parent, index))
}

fn artboard(tx: &mut Transaction<'_>, step: Step, refs: &Refs) -> Result<(String, Option<NodeId>)> {
    let f = &step.fields;
    let page = text(f, "page")
        .map(|p| page_id(tx.view(), &p, refs))
        .transpose()?;
    if let Some(from) = text(f, "from") {
        return copy_artboard(tx, step, refs, &from, page);
    }
    need(Kind::Artboard, f, &["name", "width"])?;
    let mut styles = declarations(f, "css")?;
    styles.extend(declarations(f, "styles")?);
    let (x, y) = (number(f, "x")?, number(f, "y")?);
    let spec = NewArtboard {
        name: text(f, "name").unwrap_or_default(),
        width: number(f, "width")?.unwrap_or(1440.0),
        height: number(f, "height")?,
        position: (x.is_some() || y.is_some()).then(|| (x.unwrap_or(0.0), y.unwrap_or(0.0))),
        page,
        styles: styles
            .into_iter()
            .filter_map(|(k, v)| Some((k, v?)))
            .collect(),
    };
    let class = text(f, "class").filter(|c| !c.trim().is_empty());
    let mode = text(f, "mode");
    let (fragments, dropped) = step
        .html
        .map(|parsed| (parsed.fragments, parsed.dropped))
        .unwrap_or_default();
    let (id, ops, roots) = {
        let t = &*tx;
        let doc = t.view();
        let id = fresh(t);
        let (mut ops, roots) =
            edit::create_artboard_with(doc, id.clone(), spec, fragments, &mut || fresh(t))
                .map_err(|e| e.to_string())?;
        if let Some(Op::Create { node }) = ops.first_mut() {
            if let Some(class) = &class {
                node.attrs.insert("class".into(), class.trim().to_owned());
            }
            if let Some(mode) = &mode {
                node.mode = edit::artboard_mode(doc, mode).map_err(|e| e.to_string())?;
            }
        }
        (id, ops, roots)
    };
    stage(tx, ops)?;
    let doc = tx.view();
    let Some(board) = doc.get(&id) else {
        return Ok((format!("Created artboard #{id}."), Some(id)));
    };
    let (w, h) = edit::pixel_size(board);
    let height = h.map_or_else(|| "auto height".to_owned(), |h| format!("{h}"));
    let mut text = format!(
        "Created artboard {} at x {}, y {}, {} × {height}.",
        label(doc, &id),
        board.x.unwrap_or(0.0),
        board.y.unwrap_or(0.0),
        w.unwrap_or(0.0),
    );
    if roots.is_empty() {
        text.push_str(&format!(
            " Next: html ops into it, like {{\"op\": \"html\", \"select\": \"#{id}\", \"html\": \"…\"}}."
        ));
    } else {
        text.push_str(&format!(
            " Wrote {} root node{}:\n",
            roots.len(),
            plural(roots.len())
        ));
        text.push_str(&outlines(doc, &roots, 3));
    }
    text.push_str(&left_out(&dropped));
    Ok((text, Some(id)))
}

/// An artboard op with `from`: a copy of that artboard, renamed, resized,
/// moved and filled as the op says.
fn copy_artboard(
    tx: &mut Transaction<'_>,
    step: Step,
    refs: &Refs,
    from: &str,
    page: Option<String>,
) -> Result<(String, Option<NodeId>)> {
    let f = &step.fields;
    let (selector, ids) = targets(tx.view(), &Value::String(from.into()), refs, "from")?;
    let doc = tx.view();
    let src = match ids.as_slice() {
        [one] if doc.get(one).is_some_and(|n| n.is_artboard()) => one.clone(),
        _ => {
            return Err(format!(
                "from takes one artboard, like \"from\": \"#k3x9a2bq\"; {selector:?} matches {}",
                if ids.len() > 1 {
                    format!("{} elements", ids.len())
                } else {
                    "an element inside one".to_owned()
                }
            ));
        }
    };
    let (ops, roots) = {
        let t = &*tx;
        edit::duplicate(t.view(), std::slice::from_ref(&src), &mut || fresh(t))
            .map_err(|e| e.to_string())?
    };
    stage(tx, ops)?;
    let id = roots.first().cloned().ok_or("the copy made nothing")?;
    if let Some(name) = text(f, "name") {
        let ops = edit::rename(tx.view(), &id, Some(&name)).map_err(|e| e.to_string())?;
        stage(tx, ops)?;
    }
    let mut styles = declarations(f, "css")?;
    styles.extend(declarations(f, "styles")?);
    for key in ["width", "height"] {
        if let Some(px) = number(f, key)? {
            styles.insert(key.into(), Some(format!("{px}px")));
        }
    }
    if !styles.is_empty() {
        let ops = edit::update_styles(tx.view(), std::slice::from_ref(&id), &styles)
            .map_err(|e| e.to_string())?;
        stage(tx, ops)?;
    }
    if let Some(page) = page {
        let ops = edit::move_to_page(tx.view(), std::slice::from_ref(&id), &page)
            .map_err(|e| e.to_string())?;
        stage(tx, ops)?;
    }
    let (x, y) = (number(f, "x")?, number(f, "y")?);
    if x.is_some() || y.is_some() {
        let node = tx.view().get(&id).ok_or("the copy is gone")?;
        let (x, y) = (x.or(node.x).unwrap_or(0.0), y.or(node.y).unwrap_or(0.0));
        let ops = edit::set_position(tx.view(), &id, x, y).map_err(|e| e.to_string())?;
        stage(tx, ops)?;
    }
    if let Some(mode) = text(f, "mode") {
        let ops = edit::set_artboard_mode(tx.view(), std::slice::from_ref(&id), Some(&mode))
            .map_err(|e| e.to_string())?;
        stage(tx, ops)?;
    }
    let mut dropped = Vec::new();
    if let Some(parsed) = step.html {
        dropped = parsed.dropped;
        let ops = {
            let t = &*tx;
            edit::write_fragments(
                t.view(),
                &id,
                parsed.fragments,
                WriteMode::Append,
                None,
                &mut || fresh(t),
            )
            .map_err(|e| e.to_string())?
            .0
        };
        stage(tx, ops)?;
    }
    let doc = tx.view();
    let mut text = format!(
        "Copied {} as #{id}:\n{}",
        label(doc, &src),
        outline(doc, &id, 2)
    );
    text.push_str(&left_out(&dropped));
    Ok((text, Some(id)))
}

fn html_op(tx: &mut Transaction<'_>, step: Step, refs: &Refs) -> Result<(String, Option<NodeId>)> {
    let f = &step.fields;
    let place = Place::named(text(f, "mode").as_deref()).ok_or_else(|| {
        format!(
            "mode {:?} isn't one of append, prepend, before, after, inner, replace",
            text(f, "mode").unwrap_or_default()
        )
    })?;
    let parsed = step.html.ok_or("\"html\" needs html")?;
    let (selector, ids) = selected(tx.view(), Kind::Html, f, refs)?;
    // Replacing an outer match deletes the match inside it. Append,
    // prepend, before and after leave both in place, so they can nest.
    if matches!(place, Place::Inner | Place::Replace) {
        refuse_nesting(tx.view(), &selector, &ids, "replace")?;
    }
    const MOST: usize = 100;
    if ids.len() > MOST {
        return Err(format!(
            "{selector:?} matches {} elements; an html op writes into at most {MOST}",
            ids.len()
        ));
    }
    let many = ids.len() > 1;
    let mut parts = Vec::new();
    let mut first = None;
    for id in &ids {
        let (merged, roots, mode) = {
            let t = &*tx;
            let doc = t.view();
            let (target, mode, index) = match place {
                Place::Append => (id.clone(), WriteMode::Append, None),
                Place::Prepend => (id.clone(), WriteMode::Append, Some(0)),
                Place::Before | Place::After => {
                    let (parent, index) = position(doc, id)?;
                    let index = index + usize::from(place == Place::After);
                    (parent, WriteMode::Append, Some(index))
                }
                Place::Inner => (id.clone(), WriteMode::ReplaceChildren, None),
                Place::Replace => (id.clone(), WriteMode::Replace, None),
            };
            let (ops, roots) = edit::write_fragments(
                doc,
                &target,
                parsed.fragments.clone(),
                mode,
                index,
                &mut || fresh(t),
            )
            .map_err(|e| e.to_string())?;
            // A rewrite of HTML that read gave keeps what others changed since.
            let merged = match parsed.read_at {
                Some(seq) if mode != WriteMode::Append => t.merge(seq, ops),
                _ => finite_design::Merged {
                    ops,
                    kept: Vec::new(),
                    kept_nodes: Vec::new(),
                    reached: true,
                },
            };
            (merged, roots, mode)
        };
        // The label before the write: a replace deletes this node.
        let where_ = label(tx.view(), id);
        if let Err(error) = stage(tx, merged.ops) {
            // Replacing the children deletes them. Inside an instance those
            // children belong to the component, and the refusal names the
            // child that was about to go, often a text node the agent never
            // selected.
            if place == Place::Inner && error.contains("can't be deleted on its own") {
                return Err(inner_keeps_instance_children(tx.view(), id));
            }
            return Err(error);
        }
        first = first.or_else(|| roots.first().cloned());
        let doc = tx.view();
        let mut text = if mode == WriteMode::Replace && roots == [id.as_str()] {
            "Rewrote it in place: elements that kept their data-id kept their ids, comments and history.\n".to_owned()
        } else {
            format!("Wrote {} root node{}:\n", roots.len(), plural(roots.len()))
        };
        text.push_str(&outlines(doc, &roots, 3));
        text.push_str(&kept_note(doc, &merged.kept));
        text.push_str(&kept_nodes_note(doc, &merged.kept_nodes));
        if !merged.reached {
            text.push_str(
                "\nNote: your data-read-at is older than the changes this server remembers, \
                 so values in your HTML replaced any that others changed since you read it, \
                 and elements others added since were removed.",
            );
        }
        parts.push((where_, text.trim_end().to_owned()));
    }
    let mut text = if many || place != Place::Append {
        collapse_repeats(place.name(), parts)
    } else {
        parts
            .into_iter()
            .map(|(_, text)| text)
            .collect::<Vec<_>>()
            .join("\n")
    };
    text.push_str(&left_out(&parsed.dropped));
    Ok((text, first))
}

/// How many nodes a repeated result names before it counts the rest.
const REPEATS_NAMED: usize = 3;

/// `text` with every `#` followed by an 8-character id as `#_`, so results
/// that differ only in the ids they made compare equal.
fn mask_ids(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('#') {
        out.push_str(&rest[..=at]);
        rest = &rest[at + 1..];
        let id = rest
            .bytes()
            .take_while(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            .count();
        if id == 8 {
            out.push('_');
            rest = &rest[id..];
        }
    }
    out.push_str(rest);
    out
}

/// What an html op did at each of its targets, one section per target. Targets
/// that got the same result apart from the ids they made are one section: it
/// says how many, names the first few, and shows the first one's result.
fn collapse_repeats(place: &str, parts: Vec<(String, String)>) -> String {
    let mut groups: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for (target, text) in parts {
        let key = mask_ids(&text);
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, members)) => members.push((target, text)),
            None => groups.push((key, vec![(target, text)])),
        }
    }
    let sections: Vec<String> = groups
        .into_iter()
        .map(|(_, members)| match members.as_slice() {
            [(target, text)] => format!("{place} {target}: {text}"),
            [(_, first), ..] => {
                let named: Vec<&str> = members
                    .iter()
                    .take(REPEATS_NAMED)
                    .map(|(target, _)| target.as_str())
                    .collect();
                let more = members.len().saturating_sub(REPEATS_NAMED);
                format!(
                    "{place} {} elements ({}{}) all got the same, with new ids of their own; the first got: {first}",
                    members.len(),
                    named.join(", "),
                    if more > 0 { format!(", … +{more}") } else { String::new() },
                )
            }
            [] => String::new(),
        })
        .collect();
    sections.join("\n")
}

/// `mode: "inner"` on a node an instance shows. Names that node, not the
/// child the replace would have deleted, and says how to change it.
/// Text replace skips `<style>` and `<script>` bodies, so those say code.
fn inner_keeps_instance_children(doc: &Document, id: &str) -> String {
    let code = doc
        .get(id)
        .and_then(|node| node.tag())
        .is_some_and(|tag| tag.eq_ignore_ascii_case("style") || tag.eq_ignore_ascii_case("script"));
    let place = if code { "code" } else { "text" };
    let replace = format!(
        "{{\"op\": \"replace\", \"select\": \"#{id}\", \"find\": \"…\", \"replace\": \"…\", \"in\": \"{place}\"}}"
    );
    let Some((instance, component)) = finite_design::components::instance_of(doc, id) else {
        return format!(
            "#{id}: mode inner replaces its children, and that was refused. \
             To change its {place}, use {replace}. \
             A css or attrs op changes its styles or attributes."
        );
    };
    let relation = if id == instance.id {
        format!("#{id} is an instance")
    } else {
        format!("#{id} is inside instance #{}", instance.id)
    };
    let of = match component {
        Some(c) => format!(" of component {:?} #{}", c.display_name(), c.id),
        None => String::new(),
    };
    let edit_component = match component {
        Some(c) => format!(
            " Edit component #{} to change every instance, or detach this instance",
            c.id
        ),
        None => " Detach this instance".to_owned(),
    };
    format!(
        "{relation}{of}, so mode inner replaces its children, and those come from the component. \
         To change only its {place}, use {replace}. \
         A css or attrs op on it changes only its styles or attributes.{edit_component} with {{\"op\": \"component\", \"select\": \"#{}\", \"detach\": true}}.",
        instance.id
    )
}

fn css_op(tx: &mut Transaction<'_>, f: &Fields, refs: &Refs) -> Result<String> {
    let select = select_of(f);
    let mut css = text(f, "css");
    if css.is_none() && f.contains_key("styles") {
        let declared = declarations(f, "styles")?;
        let body: Vec<String> = declared
            .iter()
            .map(|(k, v)| format!("{k}: {}", v.as_deref().unwrap_or("unset")))
            .collect();
        css = Some(body.join("; "));
    }
    let Some(css) = css.filter(|c| !c.trim().is_empty()) else {
        return Err(format!("\"css\" needs css, like {}", Kind::Css.example()));
    };
    let rules_given = css.contains('{');
    let css = if rules_given {
        with_refs(&css, refs, false)?
    } else {
        let Some(select) = &select else {
            return Err(
                "css takes rules, like \"#k3x9a2bq { height: 1712px }\", or select plus declarations, like {\"op\": \"css\", \"select\": \".btn\", \"css\": \"border-radius: 999px\"}".into(),
            );
        };
        format!("{} {{ {css} }}", selector_text(select, refs)?)
    };
    let to = text(f, "to")
        .unwrap_or_else(|| "inline".into())
        .to_ascii_lowercase();
    // A stylesheet rule can't name a part inside an instance. select plus
    // declarations (the default) becomes an override, so that form stays.
    if rules_given || matches!(to.trim(), "style" | "sheet" | "stylesheet") {
        refuse_instance_paths(tx.view(), &css)?;
    }
    // With rules, select limits them to inside its matches.
    let scope = match (&select, rules_given) {
        (Some(select), true) => Some(targets(tx.view(), select, refs, "select")?),
        _ => None,
    };
    match to.trim() {
        "inline" | "" => inline(tx, &css, scope.as_ref()),
        "style" | "sheet" | "stylesheet" => {
            let boards = match (&select, scope) {
                (_, Some((_, ids))) => Some(ids),
                (Some(select), None) => Some(targets(tx.view(), select, refs, "select")?.1),
                (None, None) => None,
            };
            style(tx, &css, boards)
        }
        "shared" | "tokens" => Err(format!(
            "there's no shared stylesheet. Put values every screen uses in tokens, like {}, and use them as var(--brand); put classes in each artboard's <style> with to: \"style\"",
            Kind::Tokens.example()
        )),
        other => Err(format!(
            "to {other:?} isn't one of inline (default) or style"
        )),
    }
}

fn ident_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b == b'-' || b == b'_'
}

/// `url(` at `i`, and not the tail of a longer name such as `noturl(`.
fn at_url(bytes: &[u8], i: usize) -> bool {
    if i > 0 && ident_byte(bytes[i - 1]) {
        return false;
    }
    let Some(head) = bytes.get(i..i + 4) else {
        return false;
    };
    head[3] == b'('
        && head[0].eq_ignore_ascii_case(&b'u')
        && head[1].eq_ignore_ascii_case(&b'r')
        && head[2].eq_ignore_ascii_case(&b'l')
}

/// The index just past the `url(...)` that starts at `start`.
fn skip_url(bytes: &[u8], start: usize) -> usize {
    let mut i = start + 4;
    while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
        i += 1;
    }
    if matches!(bytes.get(i), Some(b'"' | b'\'')) {
        let quote = bytes[i];
        i += 1;
        while i < bytes.len() {
            if bytes[i] == b'\\' {
                i += 2;
                continue;
            }
            if bytes[i] == quote {
                i += 1;
                break;
            }
            i += 1;
        }
        while bytes.get(i).is_some_and(u8::is_ascii_whitespace) {
            i += 1;
        }
        if bytes.get(i) == Some(&b')') {
            i += 1;
        }
        return i;
    }
    while i < bytes.len() {
        if bytes[i] == b'\\' {
            i += 2;
            continue;
        }
        if bytes[i] == b')' {
            return i + 1;
        }
        i += 1;
    }
    bytes.len()
}

/// The end of the attribute selector that opens at `i` (a `[`), past any
/// quoted value and escape inside it.
fn skip_attribute(bytes: &[u8], mut i: usize) -> usize {
    let mut quote = None;
    i += 1;
    while i < bytes.len() {
        let b = bytes[i];
        if b == b'\\' {
            i += 2;
            continue;
        }
        match quote {
            Some(q) if b == q => quote = None,
            Some(_) => {}
            None if b == b'"' || b == b'\'' => quote = Some(b),
            None if b == b']' => return i + 1,
            None => {}
        }
        i += 1;
    }
    bytes.len()
}

/// The character a CSS escape starting at `i` (a `\\`) stands for, and where
/// the escape ends: up to six hex digits and one whitespace, or one char.
fn css_escape(source: &str, i: usize) -> (char, usize) {
    let rest = &source[i + 1..];
    let hex: String = rest
        .chars()
        .take_while(char::is_ascii_hexdigit)
        .take(6)
        .collect();
    if hex.is_empty() {
        return match rest.chars().next() {
            Some(c) => (c, i + 1 + c.len_utf8()),
            None => ('\\', i + 1),
        };
    }
    let mut end = i + 1 + hex.len();
    if source[end..].starts_with(|c: char| c.is_ascii_whitespace()) {
        end += 1;
    }
    let ch = u32::from_str_radix(&hex, 16)
        .ok()
        .and_then(char::from_u32)
        .unwrap_or('\u{fffd}');
    (ch, end)
}

/// Ids named by `#` tokens in `source`, outside strings, comments and
/// `url(...)`. `\/` reads as `/`, so `#inst/part` and `#inst\/part` are one id.
fn hash_ids(source: &str) -> Vec<String> {
    let bytes = source.as_bytes();
    let mut out = Vec::new();
    let mut quote = None;
    let mut comment = false;
    let mut i = 0;
    while i < bytes.len() {
        let b = bytes[i];
        if comment {
            if b == b'*' && bytes.get(i + 1) == Some(&b'/') {
                comment = false;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if let Some(q) = quote {
            if b == b'\\' {
                i += 2;
                continue;
            }
            if b == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        // `url(https://cdn.example/*)` is a url token, not a comment. A
        // `/*` inside it must not swallow the rest of the sheet, and a `#`
        // in a url is a fragment, not a selector.
        if at_url(bytes, i) {
            i = skip_url(bytes, i);
            continue;
        }
        if b == b'/' && bytes.get(i + 1) == Some(&b'*') {
            comment = true;
            i += 2;
            continue;
        }
        if b == b'"' || b == b'\'' {
            quote = Some(b);
            i += 1;
            continue;
        }
        // `[href=\#a\/b]` matches an attribute's value, not an id.
        if b == b'[' {
            i = skip_attribute(bytes, i);
            continue;
        }
        if b != b'#' {
            i += 1;
            continue;
        }
        i += 1;
        let mut id = String::new();
        while i < bytes.len() {
            let c = bytes[i];
            if c == b'\\' {
                // `\/`, `\2f ` and `\00002F` all read as `/`.
                let (ch, next) = css_escape(source, i);
                id.push(ch);
                i = next;
                continue;
            }
            if ident_byte(c) {
                id.push(c as char);
                i += 1;
                continue;
            }
            // A slash continues the id only when another id character follows,
            // so `16px/1.5` and a trailing `/` stay out of it.
            if c == b'/' && bytes.get(i + 1).is_some_and(|n| ident_byte(*n)) {
                id.push('/');
                i += 1;
                continue;
            }
            break;
        }
        if !id.is_empty() {
            out.push(id);
        }
    }
    out
}

/// Refuses a stylesheet whose selector names a node inside an instance.
/// `#inst/part` and `#inst\/part` are the same id, and a rule written
/// either way never reaches the rendered part. Style it with `select`,
/// which becomes an override, or edit the component. A `/` in a value, a
/// `url(...)`, a string or a comment is not that selector, so it stays.
fn refuse_instance_paths(doc: &Document, css: &str) -> Result<()> {
    let rules = css::patch_rules(css).map_err(|e| e.to_string())?;
    for rule in &rules {
        for id in hash_ids(&rule.selector) {
            // A path starts at an instance. Any other id with a `/` is the
            // author's own, like `#account\/settings`.
            let in_instance = finite_design::components::split(&id)
                .and_then(|(root, _)| doc.get(root))
                .is_some_and(|root| root.instance_of.is_some());
            if in_instance {
                return Err(instance_path_message(doc, &id));
            }
        }
    }
    Ok(())
}

fn instance_path_message(doc: &Document, path: &str) -> String {
    let component = finite_design::components::instance_of(doc, path)
        .and_then(|(_, component)| component.map(|node| node.id.clone()));
    let component = match component {
        Some(id) => format!(" #{id}"),
        None => String::new(),
    };
    format!(
        "the rule can't reach a part inside an instance; style it with {{\"op\":\"css\",\"select\":\"#{path}\",\"css\":\"…\"}} (becomes an override), or edit the component{component}"
    )
}

/// A css op's rules as inline styles on the elements they match.
fn inline(
    tx: &mut Transaction<'_>,
    css: &str,
    scope: Option<&(String, Vec<NodeId>)>,
) -> Result<String> {
    let (rules, at_rules) = css::top_rules(css).map_err(|e| e.to_string())?;
    if let Some(at) = at_rules.first() {
        return Err(format!("inline styles can't hold {at}; use to: \"style\""));
    }
    if rules.is_empty() {
        return Err(format!(
            "the css has no rules, like {}",
            Kind::Css.example()
        ));
    }
    let mut lines = Vec::new();
    for rule in rules {
        let doc = tx.view();
        let mut ids = matched(doc, &rule.selector, None)?;
        if let Some((select, within)) = scope {
            ids.retain(|id| within.iter().any(|w| w == id || doc.is_ancestor(w, id)));
            if ids.is_empty() {
                return Err(format!(
                    "css rule {:?} matches no element inside select {select:?}",
                    rule.selector
                ));
            }
        }
        if ids.is_empty() {
            return Err(format!(
                "css rule {:?} matches no element. read with contains, or with no select, lists what's there",
                rule.selector
            ));
        }
        let styles: BTreeMap<String, Option<String>> = rule.declarations.into_iter().collect();
        let ops = edit::update_styles(doc, &ids, &styles).map_err(|e| e.to_string())?;
        let values = ops.len();
        let shown = describe(doc, &ids);
        stage(tx, ops)?;
        lines.push(format!(
            "{} matched {} element{} ({shown}): {}",
            rule.selector,
            ids.len(),
            plural(ids.len()),
            if values == 0 {
                "they already had those values".to_owned()
            } else {
                format!("{values} value{} changed", plural(values))
            }
        ));
    }
    Ok(lines.join("\n"))
}

/// A css op's rules merged into the `<style>` block of each artboard they
/// style: the artboards of `within` when given, otherwise of what the rules match.
fn style(tx: &mut Transaction<'_>, css: &str, within: Option<Vec<NodeId>>) -> Result<String> {
    let patch = css::patch_rules(css).map_err(|e| e.to_string())?;
    let mut boards: Vec<NodeId> = Vec::new();
    {
        let doc = tx.view();
        let mut add = |id: &str| {
            if let Some(board) = doc.artboard_of(id)
                && !boards.contains(&board.id)
            {
                boards.push(board.id.clone());
            }
        };
        match &within {
            Some(ids) => ids.iter().for_each(|id| add(id)),
            None => {
                let matcher = select::Matcher::new(doc, select::Scope::Design);
                for rule in &patch {
                    if let Ok(list) = select::parse_loose(&rule.selector) {
                        matcher.select(&list).iter().for_each(|id| add(id));
                    }
                }
            }
        }
        if boards.is_empty() {
            match doc.artboards().as_slice() {
                [one] => boards.push(one.id.clone()),
                [] => return Err("the design has no artboards yet, so there's no <style> to put these in. Add one with an \"artboard\" op first".into()),
                [first, ..] => {
                    return Err(format!(
                        "no element matches these rules yet, so it's unclear which artboard's <style> block they belong in. Pass select with the artboard, like \"select\": \"#{}\"",
                        first.id
                    ));
                }
            }
        }
    }
    let mut parts = Vec::new();
    for board in &boards {
        let (ops, text) = {
            let t = &*tx;
            let doc = t.view();
            let name = doc.get(board).map(|b| b.display_name()).unwrap_or_default();
            let sheet = doc
                .subtree(board)
                .into_iter()
                .find(|n| n.tag().is_some_and(|t| t.eq_ignore_ascii_case("style")))
                .map(|n| n.id.clone());
            match sheet {
                Some(sheet) => {
                    let existing: String = doc
                        .children(Some(&sheet))
                        .iter()
                        .filter_map(|c| c.text.as_deref())
                        .collect();
                    let (next, changes) =
                        css::merge_sheet(&existing, css).map_err(|e| e.to_string())?;
                    if next == existing {
                        (
                            Vec::new(),
                            format!("<style> #{sheet} in {name:?} already had that."),
                        )
                    } else {
                        let ops = edit::set_text(doc, &sheet, &next, &mut || fresh(t))
                            .map_err(|e| e.to_string())?;
                        let changes: Vec<String> =
                            changes.iter().map(ToString::to_string).collect();
                        (
                            ops,
                            format!("<style> #{sheet} in {name:?}: {}.", changes.join("; ")),
                        )
                    }
                }
                None => {
                    let (next, _) = css::merge_sheet("", css).map_err(|e| e.to_string())?;
                    let fragments = edit::parse_html(&format!("<style>{next}</style>"))
                        .map_err(|e| e.to_string())?;
                    let (ops, roots) = edit::write_fragments(
                        doc,
                        board,
                        fragments,
                        WriteMode::Append,
                        Some(0),
                        &mut || fresh(t),
                    )
                    .map_err(|e| e.to_string())?;
                    let id = roots.first().cloned().unwrap_or_default();
                    (ops, format!("New <style> block #{id} in {name:?}."))
                }
            }
        };
        stage(tx, ops)?;
        parts.push(text);
    }
    // Inline styles beat sheet rules, so say where a rule won't show.
    let doc = tx.view();
    let matcher = select::Matcher::new(doc, select::Scope::Design);
    for rule in &patch {
        let Ok(list) = select::parse_loose(&rule.selector) else {
            continue;
        };
        let matched: Vec<(NodeId, Vec<String>)> = matcher
            .select(&list)
            .into_iter()
            .filter(|id| doc.artboard_of(id).is_some_and(|b| boards.contains(&b.id)))
            .filter_map(|id| {
                let inline: Vec<String> = doc.get(&id)?.styles.keys().cloned().collect();
                Some((id, inline))
            })
            .collect();
        for conflict in css::inline_conflicts(rule, &matched) {
            let n = conflict.nodes.len();
            parts.push(format!(
                "{n} element{} {} {} inline, which beats {}: {}. Use to: \"inline\", or {{\"op\": \"css\", \"css\": \"{} {{ {}: unset }}\", \"to\": \"inline\"}} to drop the inline value.",
                plural(n),
                if n == 1 { "sets" } else { "set" },
                conflict.property,
                conflict.selector,
                describe(doc, &conflict.nodes),
                conflict.selector.replace('"', "\\\""),
                conflict.property,
            ));
        }
    }
    Ok(parts.join("\n"))
}

fn attrs(tx: &mut Transaction<'_>, f: &Fields, refs: &Refs) -> Result<String> {
    let set = match object(f, "set")? {
        Some(set) => set,
        None => match object(f, "attributes")?.or(object(f, "attrs")?) {
            Some(set) => set,
            None => {
                return Err(format!(
                    "\"attrs\" needs set, like {}",
                    Kind::Attrs.example()
                ));
            }
        },
    };
    let doc = tx.view();
    let (_, ids) = selected(doc, Kind::Attrs, f, refs)?;
    let attributes: BTreeMap<String, Option<String>> = set
        .into_iter()
        .map(|(k, v)| {
            let value = match v {
                Value::Null => None,
                v => Some(plain(&v)),
            };
            (k, value)
        })
        .collect();
    let ops = edit::update_attributes(doc, &ids, &attributes).map_err(|e| e.to_string())?;
    let values = ops.len();
    let shown = describe(doc, &ids);
    stage(tx, ops)?;
    let names: Vec<&str> = attributes.keys().map(String::as_str).collect();
    Ok(format!(
        "Set {} on {} element{} ({shown}): {}.",
        names.join(", "),
        ids.len(),
        plural(ids.len()),
        if values == 0 {
            "they already had those values".to_owned()
        } else {
            format!("{values} value{} changed", plural(values))
        }
    ))
}

fn move_op(tx: &mut Transaction<'_>, f: &Fields, refs: &Refs) -> Result<(String, Option<NodeId>)> {
    let (_, mut ids) = selected(tx.view(), Kind::Move, f, refs)?;
    let to = text(f, "to");
    let mut parts = Vec::new();
    let mut made = None;
    let not_boards = |doc: &Document, ids: &[NodeId]| -> Vec<NodeId> {
        ids.iter()
            .filter(|id| !doc.get(id).is_some_and(|n| n.is_artboard()))
            .cloned()
            .collect()
    };
    // Copy first, so mode, page and x and y place the copies, not the originals.
    let duplicate = text(f, "op").is_some_and(|o| o.eq_ignore_ascii_case("duplicate"));
    if flag(f, "copy") || flag(f, "duplicate") || duplicate {
        let (ops, roots) = {
            let t = &*tx;
            edit::duplicate(t.view(), &ids, &mut || fresh(t)).map_err(|e| e.to_string())?
        };
        stage(tx, ops)?;
        made = roots.first().cloned();
        parts.push(format!(
            "Copied {} node{}:\n{}",
            roots.len(),
            plural(roots.len()),
            outlines(tx.view(), &roots, 2).trim_end()
        ));
        ids = roots;
    }
    if f.contains_key("mode") && to.is_none() {
        let doc = tx.view();
        let wrong = not_boards(doc, &ids);
        if !wrong.is_empty() {
            return Err(format!(
                "mode is for artboards, and {} {}",
                describe(doc, &wrong),
                if wrong.len() == 1 {
                    "isn't one"
                } else {
                    "aren't"
                }
            ));
        }
        let mode = text(f, "mode");
        let ops = edit::set_artboard_mode(doc, &ids, mode.as_deref()).map_err(|e| e.to_string())?;
        let shown = describe(doc, &ids);
        stage(tx, ops)?;
        parts.push(match mode {
            Some(mode) => format!(
                "{shown} now render{} in mode {mode:?}.",
                if ids.len() == 1 { "s" } else { "" }
            ),
            None => format!(
                "{shown} now render{} in the first mode.",
                if ids.len() == 1 { "s" } else { "" }
            ),
        });
    }
    if let Some(page) = text(f, "page").filter(|_| to.is_none()) {
        let doc = tx.view();
        let wrong = not_boards(doc, &ids);
        if !wrong.is_empty() {
            return Err(format!(
                "page moves artboards, and {} {}. Select artboards, like \":root\" or \"#k3x9a2bq\"",
                describe(doc, &wrong),
                if wrong.len() == 1 {
                    "isn't one"
                } else {
                    "aren't"
                }
            ));
        }
        let page = page_id(doc, &page, refs)?;
        let ops = edit::move_to_page(doc, &ids, &page).map_err(|e| e.to_string())?;
        let name = doc.page(&page).map(|p| p.name.clone()).unwrap_or_default();
        let shown = describe(doc, &ids);
        stage(tx, ops)?;
        parts.push(format!("Moved {shown} to page {name:?}."));
    }
    let (x, y) = (number(f, "x")?, number(f, "y")?);
    if x.is_some() || y.is_some() {
        let doc = tx.view();
        let wrong = not_boards(doc, &ids);
        if !wrong.is_empty() {
            return Err(format!(
                "x and y place artboards, and {} {}. To move an element, use to",
                describe(doc, &wrong),
                if wrong.len() == 1 {
                    "isn't one"
                } else {
                    "aren't"
                }
            ));
        }
        let mut ops = Vec::new();
        for id in &ids {
            let node = doc
                .get(id)
                .ok_or_else(|| format!("node {id:?} not found"))?;
            let (x, y) = (x.or(node.x).unwrap_or(0.0), y.or(node.y).unwrap_or(0.0));
            ops.extend(edit::set_position(doc, id, x, y).map_err(|e| e.to_string())?);
        }
        let shown = describe(doc, &ids);
        stage(tx, ops)?;
        parts.push(format!("Placed {shown}."));
    }
    let Some(to) = to else {
        if parts.is_empty() {
            return Err(format!(
                "\"move\" needs to (a selector, or \"canvas\" to make artboards), or x and y for an artboard, like {}",
                Kind::Move.example()
            ));
        }
        return Ok((parts.join("\n"), made));
    };
    if to.trim().eq_ignore_ascii_case("canvas") {
        let doc = tx.view();
        let ops = edit::move_nodes(doc, &ids, None, None).map_err(|e| e.to_string())?;
        let shown = describe(doc, &ids);
        stage(tx, ops)?;
        parts.push(format!("Made {shown} into artboard{}.", plural(ids.len())));
        return Ok((parts.join("\n"), made));
    }
    let doc = tx.view();
    let (selector, found) = targets(doc, &Value::String(to), refs, "to")?;
    let [target] = found.as_slice() else {
        return Err(format!(
            "to {selector:?} matches {} elements; it takes one: {}",
            found.len(),
            describe(doc, &found)
        ));
    };
    let place = Place::named(text(f, "position").as_deref())
        .filter(|p| !matches!(p, Place::Inner | Place::Replace))
        .ok_or_else(|| {
            format!(
                "position {:?} isn't one of append, prepend, before, after",
                text(f, "position").unwrap_or_default()
            )
        })?;
    let ops = match place {
        Place::Append => {
            let index = number(f, "index")?.map(|i| i.max(0.0) as usize);
            edit::move_nodes(doc, &ids, Some(target), index)
        }
        Place::Prepend => {
            let first = doc.children(Some(target)).first().map(|c| c.id.clone());
            edit::move_before(doc, &ids, Some(target), first.as_deref())
        }
        Place::Before | Place::After => {
            let (parent, _) = position(doc, target)?;
            let before = match place {
                Place::Before => Some(target.clone()),
                _ => doc.next_sibling(target).map(|n| n.id.clone()),
            };
            edit::move_before(doc, &ids, Some(&parent), before.as_deref())
        }
        Place::Inner | Place::Replace => unreachable!("filtered out above"),
    }
    .map_err(|e| e.to_string())?;
    let text = format!(
        "Moved {} {} {}.",
        describe(doc, &ids),
        match place {
            Place::Append => "into the end of",
            Place::Prepend => "into the start of",
            Place::Before => "before",
            _ => "after",
        },
        label(doc, target)
    );
    stage(tx, ops)?;
    parts.push(text);
    Ok((parts.join("\n"), made))
}

/// Errors when `ids` nest inside each other, naming the outer ones.
/// `verb` is what the op would do to an outer match ("remove", "replace").
fn refuse_nesting(doc: &Document, selector: &str, ids: &[NodeId], verb: &str) -> Result<()> {
    let set: HashSet<&str> = ids.iter().map(String::as_str).collect();
    let mut outer: Vec<NodeId> = Vec::new();
    let mut seen = HashSet::new();
    for id in ids {
        let mut at = doc.get(id).and_then(|n| n.parent.as_deref());
        while let Some(parent) = at {
            if set.contains(parent) && seen.insert(parent.to_owned()) {
                outer.push(parent.to_owned());
            }
            at = doc.get(parent).and_then(|n| n.parent.as_deref());
        }
    }
    if outer.is_empty() {
        return Ok(());
    }
    // In document order, as the matches are.
    outer.sort_by_key(|o| ids.iter().position(|id| id == o));
    Err(format!(
        "{selector:?} matches {} elements nested inside each other, so it would {verb} {} with everything in {}. Narrow select to the elements you mean, like \":has(> h2:contains(\\\"…\\\"))\" for the element holding a heading",
        ids.len(),
        describe(doc, &outer),
        if outer.len() == 1 { "it" } else { "them" }
    ))
}

/// A component op: the first match (or the one that's already a component)
/// becomes the component, and the other matches become its instances in
/// place. With `detach`, every match that's an instance becomes a plain copy.
fn component(
    tx: &mut Transaction<'_>,
    f: &Fields,
    refs: &Refs,
) -> Result<(String, Option<NodeId>)> {
    let detach = flag(f, "detach")
        || text(f, "op").is_some_and(|op| op.to_ascii_lowercase().starts_with("detach"));
    let (selector, ids) = selected(tx.view(), Kind::Component, f, refs)?;
    if detach {
        let ops = {
            let t = &*tx;
            edit::detach_instances(t.view(), &ids, &mut || fresh(t)).map_err(|e| e.to_string())?
        };
        if ops.is_empty() {
            return Err(format!(
                "{selector:?} matches no instance: {}. An instance is an element with data-instance-of in read's html",
                describe(tx.view(), &ids)
            ));
        }
        stage(tx, ops)?;
        let doc = tx.view();
        let detached: Vec<NodeId> = ids.into_iter().filter(|id| doc.get(id).is_some()).collect();
        return Ok((
            format!(
                "Detached {} instance{}; they no longer follow a component:\n{}",
                detached.len(),
                plural(detached.len()),
                outlines(doc, &detached, 2)
            ),
            None,
        ));
    }
    let doc = tx.view();
    let id = ids
        .iter()
        .find(|id| doc.get(id).is_some_and(|n| n.component))
        .unwrap_or(&ids[0])
        .clone();
    // Instances of it already, and nodes they show, are what it'd make.
    let copies: Vec<NodeId> = ids
        .iter()
        .filter(|other| {
            **other != id
                && !finite_design::components::is_virtual(other)
                && doc.get(other).and_then(|n| n.instance_of.as_deref()) != Some(id.as_str())
        })
        .cloned()
        .collect();
    let name = text(f, "name");
    let ops =
        edit::create_component(doc, &id, name.as_deref(), &copies).map_err(|e| e.to_string())?;
    stage(tx, ops)?;
    let doc = tx.view();
    let mut text = format!(
        "{} is a component. Edit it, or anything inside it, to change every instance.",
        label(doc, &id)
    );
    if !copies.is_empty() {
        text.push_str(&format!(
            "\nReplaced {} cop{} with instances, keeping their ids:",
            copies.len(),
            if copies.len() == 1 { "y" } else { "ies" }
        ));
        for copy in &copies {
            let overrides = tx.doc().get(copy).map_or(0, |n| n.overrides.len());
            text.push_str(&format!(
                "\n  #{copy}: {overrides} override{}",
                plural(overrides)
            ));
        }
        text.push_str(&format!(
            "\nInside an instance, ids look like #{}/<id>: editing those changes only that instance.",
            copies[0]
        ));
    } else {
        text.push_str(&format!(
            " Add an instance with an html op: <div data-instance-of=\"{id}\"></div>."
        ));
    }
    let outside = classes_styled_outside(tx.doc(), &id);
    if !outside.is_empty() {
        text.push_str(&format!(
            "\nIts classes {} are styled by <style> blocks outside it. A <style> only styles its own artboard, so instances elsewhere don't follow changes to those rules. Move the rules into a <style> inside the component, or style it inline with tokens.",
            outside.iter().map(|c| format!(".{c}")).collect::<Vec<_>>().join(", ")
        ));
    }
    Ok((text, Some(id)))
}

fn remove(tx: &mut Transaction<'_>, f: &Fields, refs: &Refs) -> Result<String> {
    let doc = tx.view();
    let (selector, ids) = selected(doc, Kind::Remove, f, refs)?;
    // A broad select, like a :has(...) that matched every ancestor of its
    // target, would delete far more than meant.
    refuse_nesting(doc, &selector, &ids, "remove")?;
    let ops = edit::delete(doc, &ids).map_err(|e| e.to_string())?;
    let inside: usize = ops.iter().map(|op| doc.subtree(op.id()).len()).sum();
    let count = ops.len();
    let shown = describe(doc, &ids);
    stage(tx, ops)?;
    Ok(format!(
        "Deleted {count} node{} ({shown}), {inside} in all with everything inside them.",
        plural(count)
    ))
}

/// Where a replace op looks: `in`, one place or a list of them, or by
/// default everywhere but visible text, which `includeText` adds. Returns
/// the places in the document and whether token values count.
fn places_of(f: &Fields) -> Result<(Places, bool)> {
    const PLACES: &str = "text, styles, attributes, code and tokens";
    let Some(given) = f.get("in").filter(|v| !v.is_null()) else {
        return Ok((
            Places {
                styles: true,
                attributes: true,
                css: true,
                text: flag(f, "includeText"),
            },
            true,
        ));
    };
    let names: Vec<&Value> = match given {
        Value::Array(list) => list.iter().collect(),
        one => vec![one],
    };
    let mut places = Places {
        styles: false,
        attributes: false,
        css: false,
        text: false,
    };
    let mut tokens = false;
    for name in names {
        match name
            .as_str()
            .map(|n| n.trim().to_ascii_lowercase())
            .as_deref()
        {
            Some("text") => places.text = true,
            Some("styles" | "style") => places.styles = true,
            Some("attributes" | "attrs" | "attribute") => places.attributes = true,
            Some("code" | "css" | "script") => places.css = true,
            Some("tokens" | "token") => tokens = true,
            _ => {
                return Err(format!(
                    "in {name} isn't a place to replace in. The places are {PLACES}, like \"in\": \"text\" or \"in\": [\"styles\", \"tokens\"]"
                ));
            }
        }
    }
    if !(places.text || places.styles || places.attributes || places.css || tokens) {
        return Err(format!("in is empty: name one or more of {PLACES}"));
    }
    Ok((places, tokens))
}

fn replace(tx: &mut Transaction<'_>, f: &Fields, refs: &Refs) -> Result<String> {
    need(Kind::Replace, f, &["find", "replace"])?;
    let find = text(f, "find").unwrap_or_default();
    let to = text(f, "replace").unwrap_or_default();
    let (places, in_tokens) = places_of(f)?;
    let all = flag(f, "all");
    let scope = match select_of(f).or_else(|| f.get("within").filter(|v| !v.is_null()).cloned()) {
        Some(select) => {
            let doc = tx.view();
            let (_, ids) = targets(doc, &select, refs, "select")?;
            // Inside one match counts once, even when another match holds it.
            let set: HashSet<&str> = ids.iter().map(String::as_str).collect();
            let top: Vec<NodeId> = ids
                .iter()
                .filter(|id| {
                    let mut at = doc.get(id).and_then(|n| n.parent.as_deref());
                    while let Some(p) = at {
                        if set.contains(p) {
                            return false;
                        }
                        at = doc.get(p).and_then(|n| n.parent.as_deref());
                    }
                    true
                })
                .cloned()
                .collect();
            Some(top)
        }
        None => None,
    };
    let mut replaced = Vec::new();
    match &scope {
        Some(ids) => {
            for id in ids {
                let (ops, found) = search::replace(tx.view(), Some(id), &find, &to, places, all)
                    .map_err(|e| e.to_string())?;
                stage(tx, ops)?;
                replaced.extend(found);
            }
        }
        None => {
            let (ops, found) = search::replace(tx.view(), None, &find, &to, places, all)
                .map_err(|e| e.to_string())?;
            stage(tx, ops)?;
            replaced = found;
        }
    }
    let mut tokens = Vec::new();
    if scope.is_none() && in_tokens {
        let (ops, lines) =
            search::replace_in_tokens(tx.view(), &find, &to).map_err(|e| e.to_string())?;
        stage(tx, ops)?;
        tokens = lines;
    }
    if replaced.is_empty() && tokens.is_empty() {
        return Ok(format!(
            "Found no {find:?} to replace{}.",
            if scope.is_some() {
                " in the selection"
            } else {
                ""
            }
        ));
    }
    let doc = tx.view();
    let mut text = String::new();
    if !replaced.is_empty() {
        let total: usize = replaced.iter().map(|r| r.count).sum();
        text.push_str(&format!(
            "Replaced {total} use{} on {} node{}:\n",
            plural(total),
            replaced.len(),
            plural(replaced.len())
        ));
        // A style or script's text is code, and its changes show the part
        // that matched, not the start, so it's named without its text.
        let named = |id: &str| match doc.get(id).and_then(|n| n.tag()) {
            Some(tag)
                if tag.eq_ignore_ascii_case("style") || tag.eq_ignore_ascii_case("script") =>
            {
                label(doc, id)
            }
            _ => super::line(doc, id),
        };
        // Copies of one stylesheet change the same way: say so once. Only a
        // style or script with the same code is a copy: other code can change
        // alike in a different rule.
        let code = |id: &str| -> String {
            match doc.get(id).and_then(|n| n.tag()) {
                Some(tag)
                    if tag.eq_ignore_ascii_case("style") || tag.eq_ignore_ascii_case("script") =>
                {
                    doc.children(Some(id))
                        .iter()
                        .filter_map(|c| c.text.as_deref())
                        .collect()
                }
                _ => String::new(),
            }
        };
        let mut groups: Vec<(String, Vec<&NodeId>, &Vec<String>)> = Vec::new();
        for r in &replaced {
            let key = format!(
                "{}\n{}\n{}",
                mask_ids(&named(&r.id)),
                code(&r.id),
                r.changes.join("\n")
            );
            match groups.iter_mut().find(|(k, ..)| *k == key) {
                Some((_, ids, _)) => ids.push(&r.id),
                None => groups.push((key, vec![&r.id], &r.changes)),
            }
        }
        for (_, ids, changes) in groups {
            text.push_str("  ");
            match ids.as_slice() {
                [only] => text.push_str(&named(only)),
                _ => {
                    let tag = doc.get(ids[0]).and_then(|n| n.tag()).unwrap_or("node");
                    text.push_str(&format!(
                        "{} identical <{tag}> copies: {}",
                        ids.len(),
                        crate::mcp::format::some_ids(&ids, REPEATS_NAMED)
                    ));
                }
            }
            for change in changes {
                text.push_str(&format!("\n      {change}"));
            }
            text.push('\n');
        }
    }
    if !tokens.is_empty() {
        text.push_str("Replaced in tokens:\n");
        for line in &tokens {
            text.push_str(&format!("  {line}\n"));
        }
    }
    Ok(text)
}

fn tokens(tx: &mut Transaction<'_>, f: &Fields) -> Result<String> {
    let set = match object(f, "set")? {
        Some(set) => Some(set),
        None => object(f, "tokens")?,
    };
    let modes: Option<Vec<String>> = match f.get("modes") {
        None | Some(Value::Null) => None,
        Some(Value::Array(items)) => Some(items.iter().map(plain).collect()),
        Some(Value::String(s)) => Some(match serde_json::from_str::<Vec<String>>(s) {
            Ok(list) => list,
            Err(_) => s.split(',').map(|m| m.trim().to_owned()).collect(),
        }),
        Some(other) => return Err(format!("modes should be a list of names, not {other}")),
    };
    if set.is_none() && modes.is_none() {
        return Err(format!(
            "\"tokens\" needs set (and maybe modes), like {}",
            Kind::Tokens.example()
        ));
    }
    let set = set.unwrap_or_default();
    let count = set.len();
    let tokens: BTreeMap<String, Option<TokenValue>> = serde_json::from_value(Value::Object(set))
        .map_err(|_| {
        format!(
            "each token is a value, a value per mode, or null, like {}",
            Kind::Tokens.example()
        )
    })?;
    let ops = token_ops(tx.view(), modes.as_deref(), &tokens).map_err(|e| e.to_string())?;
    if ops.is_empty() {
        return Ok("Nothing changed: the tokens already were that.".into());
    }
    stage(tx, ops)?;
    let doc = tx.view();
    let modes: Vec<String> = edit::mode_list(doc).into_iter().map(|(_, n)| n).collect();
    Ok(format!(
        "Saved {count} token{}. The design has {} tokens, in modes {}. Use them as var(--name) in any artboard.",
        plural(count),
        doc.tokens().len(),
        modes.join(", ")
    ))
}

fn page(tx: &mut Transaction<'_>, f: &Fields, refs: &Refs) -> Result<(String, Option<NodeId>)> {
    let create = text(f, "create").or_else(|| {
        (f.get("rename").is_none() && f.get("remove").is_none())
            .then(|| text(f, "name"))
            .flatten()
    });
    if let Some(name) = create {
        let doc = tx.view();
        let id = loop {
            let id = random_id(8);
            if doc.page(&id).is_none() {
                break id;
            }
        };
        let ops = edit::create_page(doc, id.clone(), &name).map_err(|e| e.to_string())?;
        stage(tx, ops)?;
        return Ok((
            format!(
                "Created page {name:?} (pageId {id:?}). Put artboards on it with an artboard op's page, or {{\"op\": \"move\", \"select\": \"#k3x9a2bq\", \"page\": {name:?}}}."
            ),
            Some(id),
        ));
    }
    if let Some(old) = text(f, "rename") {
        let Some(name) = text(f, "name") else {
            return Err("rename needs name, like {\"op\": \"page\", \"rename\": \"Drafts\", \"name\": \"Archive\"}".into());
        };
        let doc = tx.view();
        let id = page_id(doc, &old, refs)?;
        let ops = edit::rename_page(doc, &id, &name).map_err(|e| e.to_string())?;
        stage(tx, ops)?;
        return Ok((format!("Renamed page {old:?} to {name:?}."), Some(id)));
    }
    if let Some(gone) = text(f, "remove").or_else(|| text(f, "delete")) {
        let doc = tx.view();
        let id = page_id(doc, &gone, refs)?;
        let boards = doc.artboards_on(&id).len();
        let ops = edit::delete_page(doc, &id).map_err(|e| e.to_string())?;
        stage(tx, ops)?;
        return Ok((
            format!(
                "Deleted page {gone:?} and its {boards} artboard{}.",
                plural(boards)
            ),
            None,
        ));
    }
    Err(format!(
        "\"page\" takes create, rename (with name) or remove, like {}, {{\"op\": \"page\", \"rename\": \"Drafts\", \"name\": \"Archive\"}} or {{\"op\": \"page\", \"remove\": \"Drafts\"}}",
        Kind::Page.example()
    ))
}

fn import(tx: &mut Transaction<'_>, step: Step, refs: &Refs) -> Result<(String, Option<NodeId>)> {
    let prepared = step.import.ok_or("\"import\" needs content")?;
    let page = text(&step.fields, "page")
        .map(|p| page_id(tx.view(), &p, refs))
        .transpose()?;
    let result = prepared.place(tx, page).map_err(|e| e.0)?;
    let doc = tx.view();
    let mut text = format!(
        "Imported {} artboard{}:\n",
        result.artboards.len(),
        plural(result.artboards.len())
    );
    for id in &result.artboards {
        let Some(board) = doc.get(id) else { continue };
        let page = doc.page(doc.page_of(board)).map_or("", |p| p.name.as_str());
        text.push_str(&format!(
            "  #{id} {:?} on page {page:?}\n",
            board.display_name()
        ));
    }
    transfer::diagnostics(&mut text, &result.diagnostics, None);
    text.push_str(&format!(
        "Import #{}. Finite keeps the original file's bytes.",
        result.import.id
    ));
    Ok((text, result.artboards.first().cloned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use finite_design::{Document, Node, Op};

    /// A component `comp0001` with part `part0001`, and instance `inst0001`.
    fn instance() -> Document {
        let mut doc = Document::default();
        let mut component = Node::element("comp0001", "header");
        component.component = true;
        let part = Node {
            parent: Some("comp0001".into()),
            index: "a".into(),
            ..Node::element("part0001", "h1")
        };
        let instance = Node {
            instance_of: Some("comp0001".into()),
            ..Node::element("inst0001", "header")
        };
        for node in [component, part, instance] {
            assert!(doc.apply(&Op::Create { node }).is_some());
        }
        doc
    }

    #[test]
    fn a_path_selector_is_refused_and_a_url_is_not_a_selector() {
        let doc = instance();
        let values = "h1 { font: 16px/1.5 sans-serif; background: url(https://cdn.example/*); color: #112233 }";
        assert!(refuse_instance_paths(&doc, values).is_ok(), "{values}");

        // A `/*` inside an unquoted url does not hide the path selector after it.
        let raw = "h1 { background: url(https://cdn.example/*) } #inst0001/part0001 { color: red }";
        let err = refuse_instance_paths(&doc, raw).unwrap_err();
        let told = r##"{"op":"css","select":"#inst0001/part0001","css":"…"}"##;
        assert!(
            err.contains(told)
                && err.contains("can't reach a part inside an instance")
                && err.contains("or edit the component #comp0001"),
            "{err}"
        );
        let escaped = r"#inst0001\/part0001 { color: blue }";
        let err = refuse_instance_paths(&doc, escaped).unwrap_err();
        assert!(err.contains(told) && err.contains("#comp0001"), "{err}");

        // A slash in a value, a fragment, a quoted url and a comment stay.
        let kept = r##"h1 { font: 16px/1.5 sans-serif; background: url( https://cdn.example/* ) } p { background: url(https://cdn.example/a#inst0001/part0001) } b { background: url("https://cdn.example/*") } /* #inst0001/part0001 */ h1 { content: "#inst0001/part0001" }"##;
        assert!(refuse_instance_paths(&doc, kept).is_ok(), "{kept}");
        // The same `#` inside a selector's string or comment is not the id.
        assert!(
            refuse_instance_paths(&doc, r##"a[href="#inst0001/part0001"] { color: red }"##).is_ok()
        );
        assert!(refuse_instance_paths(&doc, "h1 /* #inst0001/part0001 */ { color: red }").is_ok());
        // An author's own id with a slash, outside any instance, is kept.
        assert!(refuse_instance_paths(&doc, r"#account\/settings { color: red }").is_ok());
        assert!(refuse_instance_paths(&doc, r"[href=\#inst0001\/part0001] { color: red }").is_ok());
        // A hex escape for `/` names the same path, inside :is() too.
        let hex = refuse_instance_paths(&doc, r":is(#inst0001\2f part0001) { color: red }");
        assert!(hex.unwrap_err().contains(told));
    }

    #[test]
    fn ids_are_masked_only_when_they_are_eight_characters() {
        assert_eq!(
            mask_ids("i #jd1ikl6e \"x\" in #ab12 and #4f06485a/x9"),
            "i #_ \"x\" in #ab12 and #_/x9"
        );
    }

    #[test]
    fn targets_with_the_same_result_are_one_section() {
        let part = |id: &str, new: &str| {
            (
                format!("span #{id}"),
                format!("Wrote 1 root node:\ni #{new} \"x\""),
            )
        };
        let text = collapse_repeats(
            "before",
            vec![
                part("aaaaaaa1", "nnnnnnn1"),
                part("aaaaaaa2", "nnnnnnn2"),
                part("aaaaaaa3", "nnnnnnn3"),
                part("aaaaaaa4", "nnnnnnn4"),
                (
                    "div #bbbbbbb1".into(),
                    "Wrote 1 root node:\nb #nnnnnnn5".into(),
                ),
            ],
        );
        assert_eq!(
            text,
            "before 4 elements (span #aaaaaaa1, span #aaaaaaa2, span #aaaaaaa3, … +1) \
             all got the same, with new ids of their own; the first got: \
             Wrote 1 root node:\ni #nnnnnnn1 \"x\"\n\
             before div #bbbbbbb1: Wrote 1 root node:\nb #nnnnnnn5"
        );
    }

    #[test]
    fn doc6_errors_name_doc6_ops() {
        let style = for_doc6("use update_styles to change inline styles");
        assert!(style.contains("\"op\": \"css\""), "{style}");
        assert!(style.contains("\"select\": \"#id\""), "{style}");
        assert!(style.contains("style isn't an attribute"), "{style}");

        let named =
            for_doc6("#h1abc: style isn't an attribute; use update_styles to change inline styles");
        assert!(named.contains("\"select\": \"#h1abc\""), "{named}");
        assert!(named.starts_with("#h1abc:"), "{named}");

        // The node inside an instance, not just the instance, is what the css op selects.
        let inside = for_doc6(
            "#k2n0d9xa/9qd2h0ce: style isn't an attribute; use update_styles to change inline styles",
        );
        assert!(
            inside.contains("\"select\": \"#k2n0d9xa/9qd2h0ce\""),
            "{inside}"
        );
        assert!(inside.starts_with("#k2n0d9xa/9qd2h0ce:"), "{inside}");

        let detach = for_doc6(
            "#i/new2 is inside instance #i of component \"Bar\", so it can't be deleted on its own. \
             Edit the component #new1 to change every instance, or detach_instance #i first.",
        );
        assert!(
            detach.contains("{\"op\": \"component\", \"select\": \"#i\", \"detach\": true}"),
            "{detach}"
        );
        assert!(detach.ends_with('.'), "{detach}");

        let made = for_doc6(
            "#i/new2 is inside an instance; make a component from the component's own nodes, or detach_instance #i first",
        );
        assert!(
            made.contains("{\"op\": \"component\", \"select\": \"#i\", \"detach\": true}"),
            "{made}"
        );

        let component = for_doc6("#box isn't a component; make it one with create_component");
        assert!(
            component.contains("{\"op\": \"component\", \"select\": \"#box\"}"),
            "{component}"
        );

        let html = for_doc6(
            "elements inside it need the data-id get_html gave them. Add new content to the component",
        );
        assert!(html.contains("read with as: \"html\""), "{html}");

        let copy = for_doc6("leave it out and replace it with insert_instance.");
        assert!(
            copy.contains("<div data-instance-of=\"…\"></div>"),
            "{copy}"
        );

        let bare = for_doc6(
            "#i/new2 is inside instance #i; detach #i, or the nested instance from the component it's in",
        );
        assert!(
            bare.contains("{\"op\": \"component\", \"select\": \"#i\", \"detach\": true}"),
            "{bare}"
        );
        assert!(!bare.contains("detach #"), "{bare}");

        // The phrase is the value the agent set, inside a different error.
        // Rewriting by substring turns that value into css advice.
        let quoted = for_doc6(
            "srcdoc=\"use update_styles to change inline styles\" isn't allowed: no srcdoc, and no javascript: or vbscript: URLs",
        );
        assert!(
            quoted.contains("srcdoc=\"use update_styles to change inline styles\""),
            "{quoted}"
        );
        assert!(!quoted.contains("\"op\": \"css\""), "{quoted}");

        let mode = for_doc6("can't replace an artboard; use mode \"replace-children\" instead");
        assert!(mode.contains("mode \"inner\""), "{mode}");
        assert!(!mode.contains("replace-children"), "{mode}");

        for error in [
            &style, &named, &inside, &detach, &made, &component, &html, &copy, &bare, &mode,
        ] {
            for name in [
                "update_styles",
                "write_html",
                "set_attributes",
                "replace_values",
                "detach_instance",
                "set_text_content",
                "move_nodes",
                "delete_nodes",
                "get_html",
                "get_screenshot",
                "create_component",
                "insert_instance",
            ] {
                assert!(!error.contains(name), "{name} in {error}");
            }
        }
    }
}
