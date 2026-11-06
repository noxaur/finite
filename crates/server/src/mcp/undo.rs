//! The `undo` tool: step back through the calling agent's own edits.

use rmcp::schemars::{self, JsonSchema};
use serde::Deserialize;

use super::{
    notes::flow_note,
    result::{ToolResult, ok},
};
use crate::hub::{Actor, DesignHandle};

#[derive(Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct UndoParams {
    pub(super) design_id: String,
    /// How many of your edit calls to undo or redo (default 1).
    #[serde(default)]
    steps: Option<usize>,
    /// Redo edits you undid instead.
    #[serde(default)]
    redo: bool,
}

pub(super) fn undo(handle: &DesignHandle, actor: &Actor, p: UndoParams) -> ToolResult {
    let changes: Vec<_> = (0..p.steps.unwrap_or(1).max(1))
        .map_while(|_| {
            if p.redo {
                handle.redo(actor, None)
            } else {
                handle.undo(actor, None)
            }
        })
        .collect();
    let labels: Vec<&str> = changes.iter().map(|c| c.label.as_str()).collect();
    let (verb, nothing) = if p.redo {
        ("Redid", "Nothing to redo.")
    } else {
        ("Undid", "Nothing to undo.")
    };
    let mut text = match labels.len() {
        0 => return ok(nothing),
        1 => format!("{verb} your last edit ({}).", labels[0]),
        n => format!("{verb} your last {n} edits ({}).", labels.join(", ")),
    };
    // Undoing an artboard's creation can break the links to it.
    if let Some(note) = changes.iter().find_map(|c| flow_note(handle, c)) {
        text.push('\n');
        text.push_str(&note);
    }
    ok(text)
}
