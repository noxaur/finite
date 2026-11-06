//! Artboards: where a new one goes, making one and copying one.

use std::collections::{BTreeMap, HashMap};

use crate::{
    Transaction,
    document::{Document, MAX_DEPTH, Op},
    fractional,
    html::Fragment,
    label,
    node::{Node, NodeId},
};

use super::duplicate;
use super::move_to_page;
use super::{Result, err, node, page, room_for};
use super::{WriteMode, adds, prepare_instances, write_fragments};
use super::{artboard_mode, set_artboard_mode};
use super::{detach_all, detached_count, instances_in};
use super::{longhands, normalize_styles, update_styles};
use super::{rename, set_position};

/// Space left between artboards placed automatically.
pub(crate) const ARTBOARD_GAP: f64 = 120.0;

/// Width and height of a node from its `width`/`height` styles, when they are plain pixels.
pub fn pixel_size(node: &Node) -> (Option<f64>, Option<f64>) {
    let px = |key: &str| {
        let value = node.styles.get(key)?.trim();
        value
            .strip_suffix("px")
            .unwrap_or(value)
            .trim()
            .parse::<f64>()
            .ok()
    };
    (px("width"), px("height"))
}

/// A free canvas position for a new artboard on `page`:
/// to the right of everything there, aligned with the top of its artboards.
pub(crate) fn find_placement(doc: &Document, page: &str) -> (f64, f64) {
    let boards = doc.artboards_on(page);
    if boards.is_empty() {
        return (0.0, 0.0);
    }
    let right = boards
        .iter()
        .map(|b| b.x.unwrap_or(0.0) + pixel_size(b).0.unwrap_or(0.0))
        .fold(f64::MIN, f64::max);
    let top = boards
        .iter()
        .map(|b| b.y.unwrap_or(0.0))
        .fold(f64::MAX, f64::min);
    (right + ARTBOARD_GAP, top)
}

/// Free canvas spots for artboards placed one after another, to the right
/// of what's on each page.
pub(super) struct Placer<'a> {
    doc: &'a Document,
    next: HashMap<String, (f64, f64)>,
}

impl<'a> Placer<'a> {
    pub(super) fn new(doc: &'a Document) -> Self {
        Self {
            doc,
            next: HashMap::new(),
        }
    }

    /// A spot on `page` for `board`, and moves the next spot past it.
    pub(super) fn place(&mut self, page: &str, board: &Node) -> (f64, f64) {
        let spot = self
            .next
            .entry(page.to_owned())
            .or_insert_with(|| find_placement(self.doc, page));
        let at = *spot;
        spot.0 += pixel_size(board).0.unwrap_or(400.0) + ARTBOARD_GAP;
        at
    }
}

#[derive(Default)]
pub struct NewArtboard {
    pub name: String,
    pub width: f64,
    /// Fixed height in pixels. `None` lets the artboard grow to fit its content.
    pub height: Option<f64>,
    pub position: Option<(f64, f64)>,
    /// The page to put it on. `None`: the first page.
    pub page: Option<String>,
    pub styles: BTreeMap<String, String>,
    /// The artboard's `class`, so its `<style>` rules can reach it.
    pub class: Option<String>,
    /// The mode it renders in, by the mode's name or id ([`artboard_mode`]).
    pub mode: Option<String>,
}

/// Styles every new artboard starts with. Agent-provided styles override them.
pub fn default_artboard_styles() -> BTreeMap<String, String> {
    [
        ("background-color", "#ffffff"),
        ("display", "flex"),
        ("flex-direction", "column"),
        ("overflow", "hidden"),
        ("position", "relative"),
    ]
    .into_iter()
    .map(|(k, v)| (k.to_owned(), v.to_owned()))
    .collect()
}

pub fn create_artboard(doc: &Document, id: NodeId, spec: NewArtboard) -> Result<Vec<Op>> {
    let positive = |n: f64| n > 0.0;
    if !positive(spec.width) || !spec.height.is_none_or(positive) {
        return err("artboard width and height must be positive");
    }
    if let Some(id) = &spec.page {
        page(doc, id)?;
    }
    let on = spec.page.as_deref().unwrap_or_else(|| doc.first_page());
    let (x, y) = spec.position.unwrap_or_else(|| find_placement(doc, on));
    let mut styles = default_artboard_styles();
    for (name, value) in normalize_styles(spec.styles) {
        for longhand in longhands(&name) {
            styles.remove(*longhand);
        }
        styles.insert(name, value);
    }
    styles.insert("width".into(), format!("{}px", spec.width));
    let height = spec
        .height
        .map_or_else(|| "auto".to_owned(), |h| format!("{h}px"));
    styles.insert("height".into(), height);
    let index = doc.insertion_indexes(None, None, 1).remove(0);
    let mode = match &spec.mode {
        Some(key) => artboard_mode(doc, key)?,
        None => None,
    };
    let mut node = Node {
        parent: None,
        index,
        name: Some(label::clip(&spec.name, label::LAYER_NAME)),
        x: Some(x),
        y: Some(y),
        page: spec.page,
        styles,
        mode,
        ..Node::element(id, "div")
    };
    if let Some(class) = spec
        .class
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
    {
        node.attrs.insert("class".into(), class.to_owned());
    }
    Ok(vec![Op::Create { node }])
}

/// [`create_artboard`], with `fragments` written into it, as one change.
/// Returns the ops and the ids of the content's root nodes.
pub fn create_artboard_with(
    doc: &Document,
    id: NodeId,
    spec: NewArtboard,
    fragments: Vec<Fragment>,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<(Vec<Op>, Vec<NodeId>)> {
    let mut ops = create_artboard(doc, id.clone(), spec)?;
    let height = fragments.iter().map(Fragment::height).max().unwrap_or(0);
    // The artboard is at depth 0, so its content starts at depth 1.
    if 1 + height > MAX_DEPTH {
        return err(format!(
            "that would nest {} levels deep; the limit is {MAX_DEPTH}",
            1 + height
        ));
    }
    let mut fragments = fragments;
    prepare_instances(doc, &mut fragments, None, &[], new_id)?;
    room_for(doc, 0, 1 + adds(doc, &fragments))?;
    let indexes = fractional::keys_between(None, None, fragments.len());
    let roots = fragments
        .into_iter()
        .zip(indexes)
        .map(|(fragment, index)| fragment.create_ops(Some(&id), index, None, new_id, &mut ops))
        .collect();
    Ok((ops, roots))
}

/// How a copy of an artboard differs from the original.
#[derive(Default)]
pub struct ArtboardCopy {
    pub name: Option<String>,
    /// Styles to set on the copy; `None` removes one.
    pub styles: BTreeMap<String, Option<String>>,
    /// The page to put the copy on.
    pub page: Option<String>,
    /// Where to put the copy; an axis left out keeps the copy's own.
    pub x: Option<f64>,
    pub y: Option<f64>,
    /// The mode it renders in, by name or id.
    pub mode: Option<String>,
    /// Turn the copy's instances into plain elements, so later edits to
    /// their components don't change it.
    pub detach: bool,
    /// Content to write into the copy, after the rest.
    pub fragments: Vec<Fragment>,
}

/// What [`copy_artboard`] made.
pub struct Copied {
    pub id: NodeId,
    /// Instances in the copy that still follow their components.
    pub following: usize,
    /// Instances that were detached in the copy.
    pub detached: usize,
}

/// Copies the artboard `src` and changes the copy as `copy` says, staging
/// each step in `tx` so the next sees it.
pub fn copy_artboard(
    tx: &mut Transaction<'_>,
    src: &str,
    copy: ArtboardCopy,
    new_id: &mut impl FnMut() -> NodeId,
) -> Result<Copied> {
    if !node(tx.view(), src)?.is_artboard() {
        return err(format!("node {src:?} isn't an artboard"));
    }
    let (ops, roots) = {
        let t = &*tx;
        duplicate(t.view(), &[src.to_owned()], &mut || t.new_id(&mut *new_id))?
    };
    tx.edit(ops, new_id)?;
    let Some(id) = roots.first().cloned() else {
        return err("the copy made nothing");
    };
    let ids = std::slice::from_ref(&id);
    let (mut following, mut detached) = (0, 0);
    if copy.detach {
        let ops = {
            let t = &*tx;
            detach_all(t.doc(), &roots, true, &mut || t.new_id(&mut *new_id))?
        };
        detached = detached_count(&ops);
        tx.edit(ops, new_id)?;
    } else {
        following = instances_in(tx.view(), &roots, true).len();
    }
    if let Some(name) = &copy.name {
        let ops = rename(tx.view(), &id, Some(name))?;
        tx.edit(ops, new_id)?;
    }
    if !copy.styles.is_empty() {
        let ops = update_styles(tx.view(), ids, &copy.styles)?;
        tx.edit(ops, new_id)?;
    }
    if let Some(page) = &copy.page {
        let ops = move_to_page(tx.view(), ids, page)?;
        tx.edit(ops, new_id)?;
    }
    if copy.x.is_some() || copy.y.is_some() {
        let own = node(tx.view(), &id)?;
        let (x, y) = (
            copy.x.or(own.x).unwrap_or(0.0),
            copy.y.or(own.y).unwrap_or(0.0),
        );
        let ops = set_position(tx.view(), &id, x, y)?;
        tx.edit(ops, new_id)?;
    }
    if let Some(mode) = &copy.mode {
        let ops = set_artboard_mode(tx.view(), ids, Some(mode))?;
        tx.edit(ops, new_id)?;
    }
    if !copy.fragments.is_empty() {
        let ops = {
            let t = &*tx;
            write_fragments(
                t.view(),
                &id,
                copy.fragments,
                WriteMode::Append,
                None,
                &mut || t.new_id(&mut *new_id),
            )?
            .0
        };
        tx.edit(ops, new_id)?;
    }
    Ok(Copied {
        id,
        following,
        detached,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::FIRST_PAGE;
    use crate::edit::{support::*, *};

    #[test]
    fn artboard_styles_are_normalized() {
        let mut doc = Document::default();
        let id = board(&mut doc);
        let node = doc.get(&id).unwrap();
        assert_eq!(node.styles["background-color"], "#000");
        assert_eq!(pixel_size(node), (Some(1440.0), Some(900.0)));
        assert_eq!(
            find_placement(&doc, FIRST_PAGE),
            (1440.0 + ARTBOARD_GAP, 0.0)
        );
    }

    #[test]
    fn artboard_without_height_is_auto() {
        let mut doc = Document::default();
        let spec = |height| NewArtboard {
            name: "B".into(),
            width: 320.0,
            height,
            position: None,
            page: None,
            styles: BTreeMap::new(),
            ..Default::default()
        };
        doc.apply_all(&create_artboard(&doc, "a".into(), spec(None)).unwrap());
        let board = doc.get("a").unwrap();
        assert_eq!(board.styles.get("height").map(String::as_str), Some("auto"));
        assert_eq!(pixel_size(board), (Some(320.0), None));

        doc.apply_all(&create_artboard(&doc, "b".into(), spec(Some(200.0))).unwrap());
        assert_eq!(
            pixel_size(doc.get("b").unwrap()),
            (Some(320.0), Some(200.0))
        );
        assert!(create_artboard(&doc, "c".into(), spec(Some(0.0))).is_err());
    }
}
