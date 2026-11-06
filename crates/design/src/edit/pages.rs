//! Pages.

use serde_json::Value;

use crate::{
    document::{Document, MAX_PAGES, Op, Page},
    fractional, label,
    node::{NodeId, PropKey},
};

use super::Placer;
use super::{Result, err, node, page};

/// Adds a page named `name` after the others, with the id `id`. A design
/// without pages first gets its implicit first page as a real one.
pub fn create_page(doc: &Document, id: String, name: &str) -> Result<Vec<Op>> {
    let pages = doc.pages();
    if pages.len() >= MAX_PAGES {
        return err(format!("a design can have at most {MAX_PAGES} pages"));
    }
    if name.trim().is_empty() {
        return err("give the page a name");
    }
    let mut ops = Vec::new();
    if doc.page_map().is_empty() {
        ops.push(Op::FirstPage { explicit: true });
    }
    let last = pages.last().map(|(_, p)| p.index.as_str());
    ops.push(Op::Page {
        id,
        page: Some(Page {
            name: label::clip(name.trim(), label::LAYER_NAME),
            index: fractional::key_between(last, None),
            background: None,
        }),
    });
    Ok(ops)
}

/// Whether `value` reads as one CSS color: a hex or `rgb()` color, a
/// keyword, or one color function, `var()` and `color-mix()` among them,
/// with nothing after it. Only the browser can say whether a function's
/// arguments make a color; this keeps out anything that isn't one value.
fn is_canvas_color(value: &str) -> bool {
    const FUNCTIONS: [&str; 12] = [
        "var(--",
        "color-mix(",
        "rgb(",
        "rgba(",
        "hsl(",
        "hsla(",
        "hwb(",
        "lab(",
        "lch(",
        "oklab(",
        "oklch(",
        "color(",
    ];
    if crate::search::parse_color(value).is_some() {
        return true;
    }
    if value.is_empty() || value.len() > 200 || value.contains([';', '{', '}', '<', '>']) {
        return false;
    }
    if value.bytes().all(|b| b.is_ascii_alphabetic()) {
        return true;
    }
    let lower = value.to_ascii_lowercase();
    // The function's own `)` is the last character: its brackets close
    // there and nowhere before.
    let open = value.find('(').unwrap_or(0);
    let mut depth = 0_i32;
    let closes_at_end = value[open..].char_indices().all(|(i, c)| {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            _ => {}
        }
        depth > 0 || open + i == value.len() - 1
    }) && depth == 0;
    FUNCTIONS.iter().any(|f| lower.starts_with(f))
        && closes_at_end
        && crate::tokens::check_value(value).is_ok()
}

pub fn rename_page(doc: &Document, id: &str, name: &str) -> Result<Vec<Op>> {
    page(doc, id)?;
    if name.trim().is_empty() {
        return err("give the page a name");
    }
    Ok(explicit_first_page(doc)
        .into_iter()
        .chain([Op::PageName {
            id: id.to_owned(),
            name: label::clip(name.trim(), label::LAYER_NAME),
        }])
        .collect())
}

/// Sets the color of the canvas behind a page's artboards, or clears it
/// when `background` is `None`, so the viewer's own color shows. It takes
/// any CSS color the color fields write: a hex, a keyword, a color
/// function like `rgb()` or `oklch()`, a token as `var(--name)`, or a
/// `color-mix()` that gives one opacity.
pub fn set_page_background(doc: &Document, id: &str, background: Option<&str>) -> Result<Vec<Op>> {
    page(doc, id)?;
    let background = background.map(str::trim);
    if let Some(color) = background
        && !is_canvas_color(color)
    {
        return err(format!(
            "{color:?} isn't a color. Use a hex color like \"#e8eef0\", rgb(232 238 240), a token like var(--bg), or null for the viewer's own"
        ));
    }
    Ok(explicit_first_page(doc)
        .into_iter()
        .chain([Op::PageBackground {
            id: id.to_owned(),
            background: background.map(str::to_owned),
        }])
        .collect())
}

/// The op that puts the implicit first page in the page map, so a field op
/// can change it, for a design without pages.
fn explicit_first_page(doc: &Document) -> Option<Op> {
    doc.page_map()
        .is_empty()
        .then_some(Op::FirstPage { explicit: true })
}

/// Deletes a page and every artboard on it. A design keeps at least one page.
pub fn delete_page(doc: &Document, id: &str) -> Result<Vec<Op>> {
    page(doc, id)?;
    if doc.pages().len() == 1 {
        return err("that's the design's only page, and a design keeps at least one");
    }
    let mut ops: Vec<Op> = doc
        .artboards_on(id)
        .into_iter()
        .map(|board| Op::Delete {
            id: board.id.clone(),
        })
        .collect();
    ops.push(Op::Page {
        id: id.to_owned(),
        page: None,
    });
    Ok(ops)
}

/// Moves artboards to page `to`, into free space to the right of what's
/// there. Artboards already on it stay where they are.
pub fn move_to_page(doc: &Document, ids: &[NodeId], to: &str) -> Result<Vec<Op>> {
    page(doc, to)?;
    let mut placer = Placer::new(doc);
    let mut ops = Vec::new();
    for id in ids {
        let board = node(doc, id)?;
        if !board.is_artboard() {
            return err(format!(
                "node {id:?} isn't an artboard; only artboards are on pages"
            ));
        }
        if doc.page_of(board) == to {
            continue;
        }
        let (x, y) = placer.place(to, board);
        for (key, value) in [
            (PropKey::Page, Value::from(to)),
            (PropKey::X, Value::from(x)),
            (PropKey::Y, Value::from(y)),
        ] {
            ops.push(Op::Set {
                id: id.clone(),
                key,
                value: Some(value),
            });
        }
    }
    Ok(ops)
}
