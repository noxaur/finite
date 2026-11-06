//! Edit commands: validate a request against the current document and turn it
//! into ops. Nothing here mutates; the caller commits the ops through
//! [`crate::Design::commit`] so they land on the right actor's history.

use std::fmt;

use crate::{
    document::{Document, MAX_NODES, Page},
    node::{Node, NodeKind},
};

mod artboard;
mod attrs;
mod instances;
mod pages;
mod style;
mod theme;
mod tree;
mod write;

pub use artboard::*;
pub use attrs::*;
pub use instances::*;
pub use pages::*;
pub use style::*;
pub use theme::*;
pub use tree::*;
pub use write::*;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditError(pub String);

impl fmt::Display for EditError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for EditError {}

impl From<crate::Rejected> for EditError {
    fn from(rejected: crate::Rejected) -> Self {
        Self(rejected.to_string())
    }
}

pub type Result<T> = std::result::Result<T, EditError>;

fn err<T>(message: impl Into<String>) -> Result<T> {
    Err(EditError(message.into()))
}

fn node<'a>(doc: &'a Document, id: &str) -> Result<&'a Node> {
    doc.get(id)
        .ok_or_else(|| EditError(format!("node {id:?} not found")))
}

fn element<'a>(doc: &'a Document, id: &str) -> Result<&'a Node> {
    let node = node(doc, id)?;
    match node.kind {
        NodeKind::Element { .. } => Ok(node),
        NodeKind::Text => err(format!(
            "node {id:?} is a text node and can't have children"
        )),
    }
}

fn page<'a>(doc: &'a Document, id: &str) -> Result<&'a Page> {
    doc.page(id).ok_or_else(|| {
        EditError(format!(
            "page {id:?} not found. read with no select lists the pages."
        ))
    })
}

/// Refuses an edit that would leave the design with more than [`MAX_NODES`].
fn room_for(doc: &Document, removed: usize, added: usize) -> Result<()> {
    let total = doc.len().saturating_sub(removed) + added;
    if total > MAX_NODES {
        return err(format!(
            "that would make the design {total} nodes; the limit is {MAX_NODES}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod support {
    use std::collections::BTreeMap;

    use super::*;
    use crate::NodeId;

    pub(super) fn ids() -> impl FnMut() -> NodeId {
        let mut n = 0;
        move || {
            n += 1;
            format!("n{n}")
        }
    }

    pub(super) fn board(doc: &mut Document) -> NodeId {
        let ops = create_artboard(
            doc,
            "board".into(),
            NewArtboard {
                name: "Home".into(),
                width: 1440.0,
                height: Some(900.0),
                position: None,
                page: None,
                styles: BTreeMap::from([("backgroundColor".into(), "#000".into())]),
                ..Default::default()
            },
        )
        .unwrap();
        doc.apply_all(&ops);
        "board".into()
    }

    pub(super) fn nested(levels: usize) -> String {
        format!("{}x{}", "<div>".repeat(levels), "</div>".repeat(levels))
    }

    /// Runs `f` on a thread with a Tokio worker's 2 MiB stack.
    pub(super) fn on_small_stack<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
        std::thread::Builder::new()
            .stack_size(2 << 20)
            .spawn(f)
            .unwrap()
            .join()
            .unwrap()
    }
}
