//! The design document model, shared by every part of Finite that edits designs.
//!
//! - [`Node`] is one layer. A design is a flat map of nodes forming a DOM-like tree.
//! - [`Op`] is the unit of change. Applying one returns its inverse.
//! - [`Design`] owns a document plus each actor's undo and redo stacks.
//! - [`html`] converts between node trees and HTML.
//! - [`comment`] holds the threads users pin to the canvas.
//! - [`components`] expands instances of components and turns edits inside them into overrides.
//! - [`user_edit`] plans the edits people make on the canvas, on the server and in the browser.
//!
//! This crate has no I/O, so the same rules run in the browser (via WASM),
//! which shows a person's edits before the server confirms them.

pub mod comment;
pub mod components;
mod design;
mod document;
pub mod edit;
pub mod fractional;
mod history;
pub mod html;
pub mod import;
pub mod label;
mod node;
pub mod search;
pub mod user_edit;
pub mod version;

pub use design::{ActorId, Change, Design, DesignMeta, Origin, Record, Snapshot, Transaction};
pub use document::{Applied, Document, FIRST_PAGE, MAX_DEPTH, MAX_PAGES, Op, Page, Rejected};
pub use history::{Entry, History};
pub use node::{Node, NodeId, NodeKind, PropError, PropKey};
