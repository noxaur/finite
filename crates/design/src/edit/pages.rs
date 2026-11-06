//! Pages.

use serde_json::Value;

use crate::{
    document::{Document, FIRST_PAGE, MAX_PAGES, Op, Page},
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
        ops.push(Op::Page {
            id: FIRST_PAGE.into(),
            page: Some(pages[0].1.clone()),
        });
    }
    let last = pages.last().map(|(_, p)| p.index.as_str());
    ops.push(Op::Page {
        id,
        page: Some(Page {
            name: label::clip(name.trim(), label::LAYER_NAME),
            index: fractional::key_between(last, None),
        }),
    });
    Ok(ops)
}

pub fn rename_page(doc: &Document, id: &str, name: &str) -> Result<Vec<Op>> {
    let index = page(doc, id)?.index.clone();
    if name.trim().is_empty() {
        return err("give the page a name");
    }
    Ok(vec![Op::Page {
        id: id.to_owned(),
        page: Some(Page {
            name: label::clip(name.trim(), label::LAYER_NAME),
            index,
        }),
    }])
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
