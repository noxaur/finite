//! How an artboard actually rendered: each element's box and computed
//! styles, measured in a browser. CSS decides layout through the cascade,
//! classes and tokens, so an exporter to a format without CSS, like
//! Figma, reads the browser's answer instead of guessing from inline styles.
//!
//! A [`Scene`] is derived data. It's measured for one revision, used by one
//! export, and thrown away. Nothing writes it back into the design.

use std::collections::BTreeMap;

use finite_design::{Document, NodeId};

use crate::Error;

/// The computed styles a [`Resolved`] holds, as CSS property names. A
/// measurer must read every one of them.
pub const COMPUTED: &[&str] = &[
    "display",
    "position",
    "visibility",
    "opacity",
    "overflow",
    "box-sizing",
    "flex-direction",
    "flex-wrap",
    "flex-grow",
    "align-self",
    "justify-content",
    "align-items",
    "row-gap",
    "column-gap",
    "padding-top",
    "padding-right",
    "padding-bottom",
    "padding-left",
    "background-color",
    "background-image",
    "background-size",
    "color",
    "font-family",
    "font-size",
    "font-weight",
    "font-style",
    "line-height",
    "letter-spacing",
    "text-align",
    "text-decoration-line",
    "text-transform",
    "white-space",
    "border-top-width",
    "border-right-width",
    "border-bottom-width",
    "border-left-width",
    "border-top-color",
    "border-top-style",
    "border-top-left-radius",
    "border-top-right-radius",
    "border-bottom-right-radius",
    "border-bottom-left-radius",
    "box-shadow",
    "transform",
    "object-fit",
];

/// One artboard, measured.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Scene {
    /// Every element and text node that rendered, the artboard included.
    pub nodes: BTreeMap<NodeId, Resolved>,
}

/// Where a node rendered, in CSS pixels from the artboard's top left
/// corner, and its computed styles. A text node has its text's box and its
/// parent's styles.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Resolved {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    /// Each property in [`COMPUTED`], as `getComputedStyle` gave it.
    pub style: BTreeMap<String, String>,
}

impl Resolved {
    /// A computed style, or `""` when it wasn't measured.
    pub fn style(&self, name: &str) -> &str {
        self.style.get(name).map_or("", String::as_str)
    }
}

/// Measures artboards for an export. The server does it in headless Chrome.
pub trait Measure: Sync {
    fn scene(&self, doc: &Document, artboard: &str) -> Result<Scene, Error>;
}

/// For exports that don't need a browser.
pub struct NoMeasure;

impl Measure for NoMeasure {
    fn scene(&self, _doc: &Document, _artboard: &str) -> Result<Scene, Error> {
        Err(Error(
            "this export needs a browser to measure the layout".into(),
        ))
    }
}
