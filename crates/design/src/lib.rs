//! The design document model, shared by every part of Finite that edits designs.
//!
//! - [`Node`] is one layer. A design is a flat map of nodes forming a DOM-like tree.
//! - [`Op`] is the unit of change. Applying one returns its inverse.
//! - [`Design`] owns a document plus each actor's undo and redo stacks.
//! - [`html`] converts between node trees and HTML.
//! - [`comment`] holds the threads users pin to the canvas.
//! - [`tokens`] holds the design tokens every artboard can use.
//! - [`components`] expands instances of components and turns edits inside them into overrides.
//!
//! This crate has no I/O, so the same rules can later run in a client (via WASM)
//! for optimistic local edits.

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
pub mod tokens;
pub mod version;

pub use design::{
    ActorId, Change, Design, DesignMeta, MIGRATION_ACTOR, Origin, Record, Snapshot, Transaction,
};
pub use document::{Applied, Document, FIRST_PAGE, MAX_DEPTH, MAX_PAGES, Op, Page, Rejected};
pub use history::{Entry, History};
pub use node::{Node, NodeId, NodeKind, PropError, PropKey};
