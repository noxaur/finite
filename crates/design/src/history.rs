use serde::{Deserialize, Serialize};

use crate::document::Op;

/// One undoable step: the ops that reverse it, plus a label for display.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub label: String,
    pub ops: Vec<Op>,
}

/// One actor's undo and redo stacks for one design.
///
/// Each actor (an agent session, or later a user's tab) owns its own history,
/// so undo only ever reverses that actor's changes. While a batch is open
/// (Liveblocks calls this pausing history), commits merge into one entry, so a
/// drag or a multi-step tool call undoes in one step.
///
/// Histories are saved with full snapshots (see [`crate::Design::snapshot_to_save`]),
/// so a named agent can still undo after a clean restart, and rebuilt from the
/// journal after a crash (see [`crate::Design::replay`]). An open batch isn't saved.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct History {
    #[serde(default)]
    undo: Vec<Entry>,
    #[serde(default)]
    redo: Vec<Entry>,
    #[serde(skip)]
    batch_depth: usize,
    #[serde(skip)]
    batch_open: bool,
}

impl History {
    /// Entries kept per stack. Older ones fall off the bottom.
    pub const LIMIT: usize = 200;

    pub fn can_undo(&self) -> bool {
        !self.undo.is_empty()
    }

    pub fn can_redo(&self) -> bool {
        !self.redo.is_empty()
    }

    pub fn undo_labels(&self) -> impl Iterator<Item = &str> {
        self.undo.iter().rev().map(|e| e.label.as_str())
    }

    pub fn redo_labels(&self) -> impl Iterator<Item = &str> {
        self.redo.iter().rev().map(|e| e.label.as_str())
    }

    pub fn begin_batch(&mut self) {
        self.batch_depth += 1;
    }

    pub fn end_batch(&mut self) {
        self.batch_depth = self.batch_depth.saturating_sub(1);
        if self.batch_depth == 0 {
            self.batch_open = false;
        }
    }

    /// Records a fresh change. Clears the redo stack, as in every editor.
    pub fn record(&mut self, label: String, inverse: Vec<Op>) {
        if inverse.is_empty() {
            return;
        }
        self.redo.clear();
        if self.batch_open
            && let Some(top) = self.undo.last_mut()
        {
            // The newest change must be reversed first.
            let older = std::mem::take(&mut top.ops);
            top.ops = inverse;
            top.ops.extend(older);
            return;
        }
        push(
            &mut self.undo,
            Entry {
                label,
                ops: inverse,
            },
        );
        self.batch_open = self.batch_depth > 0;
    }

    pub fn pop_undo(&mut self) -> Option<Entry> {
        self.undo.pop()
    }

    pub fn pop_redo(&mut self) -> Option<Entry> {
        self.redo.pop()
    }

    pub fn push_undo(&mut self, entry: Entry) {
        push(&mut self.undo, entry);
    }

    pub fn push_redo(&mut self, entry: Entry) {
        push(&mut self.redo, entry);
    }
}

fn push(stack: &mut Vec<Entry>, entry: Entry) {
    if stack.len() == History::LIMIT {
        stack.remove(0);
    }
    stack.push(entry);
}
