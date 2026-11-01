//! The design document model, shared by every part of Finite that edits designs.
//!
//! - [`Node`] is one layer. A design is a flat map of nodes forming a DOM-like tree.
//! - [`Op`] is the unit of change. Applying one returns its inverse.
//! - [`Design`] owns a document plus each actor's undo and redo stacks.
//! - [`html`] converts between node trees and HTML.
//! - [`comment`] holds the threads users pin to the canvas.
//!
//! This crate has no I/O, so the same rules can later run in a client (via WASM)
//! for optimistic local edits.

pub mod comment;
mod design;
mod document;
pub mod edit;
pub mod fractional;
mod history;
pub mod html;
pub mod label;
mod node;
pub mod search;

pub use design::{ActorId, Change, Design, DesignMeta, Origin, Record, Snapshot};
pub use document::{Document, Op};
pub use history::{Entry, History};
pub use node::{Node, NodeId, NodeKind, PropError, PropKey};
