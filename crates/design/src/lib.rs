//! The design document model, shared by every part of Finite that edits designs.
//!
//! - [`Node`] is one layer. A design is a flat map of nodes forming a DOM-like tree.
//! - [`Op`] is the unit of change. Applying one returns its inverse.
//! - [`Design`] owns a document plus each actor's undo and redo stacks.
//! - [`html`] converts between node trees and HTML.
//! - [`select`] matches CSS selectors against a document.
//! - [`comment`] holds the threads users pin to the canvas.
//! - [`tokens`] holds the design tokens every artboard can use.
//! - [`css`] merges a patch into a stylesheet, keeping what it doesn't touch.
//! - [`css_scan`] finds strings, comments, rules and URLs in CSS text.
//! - [`components`] expands instances of components and turns edits inside them into overrides.
//! - [`flow`] reads a prototype's routes and links, and finds broken links.
//! - [`user_edit`] plans the edits people make on the canvas, on the server and in the browser.
//!
//! This crate has no I/O, so the same rules run in the browser (via WASM),
//! which shows a person's edits before the server confirms them.

pub mod comment;
pub mod components;
pub mod css;
pub mod css_scan;
mod design;
mod document;
pub mod edit;
pub mod flow;
pub mod fractional;
mod history;
pub mod html;
pub mod import;
pub mod label;
mod node;
pub mod search;
pub mod select;
pub mod tokens;
pub mod user_edit;
pub mod version;

pub use design::{
    ActorId, Change, Design, DesignMeta, Kept, KeptNode, MIGRATION_ACTOR, Merged, Origin, Record,
    Snapshot, Transaction,
};
pub use document::{Applied, Document, FIRST_PAGE, MAX_DEPTH, MAX_PAGES, Op, Page, Rejected};
pub use history::{Entry, History};
pub use node::{Node, NodeId, NodeKind, PropError, PropKey};
