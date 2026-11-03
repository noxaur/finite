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
    mcp::{TokenValue, cut, kept_nodes_note, kept_note, left_out, outline, token_ops, transfer},
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
        let (text, made) = apply(tx, step, &refs).map_err(|e| failed(index, Some(kind), &e))?;
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
    let rewrite = matches!(place, Place::Inner | Place::Replace);
    if rewrite && ids.len() > 1 {
        return Err(format!(
            "{selector:?} matches {} elements; mode {} takes one: {}",
            ids.len(),
            place.name(),
            describe(tx.view(), &ids)
        ));
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
        let where_ = label(tx.view(), id);
        stage(tx, merged.ops)?;
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
        if many || place != Place::Append {
            text = format!("{} {where_}: {text}", place.name());
        }
        parts.push(text.trim_end().to_owned());
    }
    let mut text = parts.join("\n");
    text.push_str(&left_out(&parsed.dropped));
    Ok((text, first))
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
    // With rules, select limits them to inside its matches.
    let scope = match (&select, rules_given) {
        (Some(select), true) => Some(targets(tx.view(), select, refs, "select")?),
        _ => None,
    };
    let to = text(f, "to")
        .unwrap_or_else(|| "inline".into())
        .to_ascii_lowercase();
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
fn refuse_nesting(doc: &Document, selector: &str, ids: &[NodeId]) -> Result<()> {
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
        "{selector:?} matches {} elements nested inside each other, so it would remove {} with everything in {}. Narrow select to the elements you mean, like \":has(> h2:contains(\\\"…\\\"))\" for the element holding a heading",
        ids.len(),
        describe(doc, &outer),
        if outer.len() == 1 { "it" } else { "them" }
    ))
}

fn remove(tx: &mut Transaction<'_>, f: &Fields, refs: &Refs) -> Result<String> {
    let doc = tx.view();
    let (selector, ids) = selected(doc, Kind::Remove, f, refs)?;
    // A broad select, like a :has(...) that matched every ancestor of its
    // target, would delete far more than meant.
    refuse_nesting(doc, &selector, &ids)?;
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

fn replace(tx: &mut Transaction<'_>, f: &Fields, refs: &Refs) -> Result<String> {
    need(Kind::Replace, f, &["find", "replace"])?;
    let find = text(f, "find").unwrap_or_default();
    let to = text(f, "replace").unwrap_or_default();
    let places = Places {
        styles: true,
        attributes: true,
        css: true,
        text: flag(f, "includeText"),
    };
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
    if scope.is_none() {
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
        for r in &replaced {
            text.push_str("  ");
            text.push_str(&super::line(doc, &r.id));
            for change in &r.changes {
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
