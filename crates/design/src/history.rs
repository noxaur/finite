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
    /// When its actor was last active, in milliseconds since the Unix epoch,
    /// or 0 if unknown. The server sets it before saving, so a history
    /// expires on time even after its design leaves memory and comes back.
    #[serde(default, rename = "lastUsed", skip_serializing_if = "is_zero")]
    last_used: u64,
    #[serde(skip)]
    batch_depth: usize,
    #[serde(skip)]
    batch_open: bool,
}

impl History {
    /// Entries kept per stack. Older ones fall off the bottom.
    pub const LIMIT: usize = 200;
    /// About how many bytes of ops a stack keeps (see [`Op::size`]). Undoing
    /// a big delete recreates every node in it, so 200 such steps could hold
    /// millions of nodes, in memory and in every saved snapshot. Older entries
    /// fall off past this, but the newest is always kept.
    pub const BYTE_LIMIT: usize = 32 << 20;

    pub fn last_used(&self) -> u64 {
        self.last_used
    }

    pub fn set_last_used(&mut self, at: u64) {
        self.last_used = at;
    }

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

    /// Every op on both stacks.
    pub fn ops(&self) -> impl Iterator<Item = &Op> {
        self.undo
            .iter()
            .chain(&self.redo)
            .flat_map(|entry| &entry.ops)
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
            trim(&mut self.undo);
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
    trim(stack);
}

/// Drops the oldest entries until the stack fits in [`History::BYTE_LIMIT`],
/// keeping at least the newest.
fn trim(stack: &mut Vec<Entry>) {
    let mut total = 0;
    let mut keep = 0;
    for entry in stack.iter().rev() {
        total += entry.ops.iter().map(Op::size).sum::<usize>();
        if keep > 0 && total > History::BYTE_LIMIT {
            break;
        }
        keep += 1;
    }
    stack.drain(..stack.len() - keep);
}

fn is_zero(n: &u64) -> bool {
    *n == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Node;

    /// An entry whose ops carry `mb` megabytes of text.
    fn heavy(label: &str, mb: usize) -> (String, Vec<Op>) {
        let node = Node {
            text: Some("x".repeat(mb << 20)),
            ..Node::element(label, "p")
        };
        (label.to_owned(), vec![Op::Create { node }])
    }

    #[test]
    fn big_steps_push_old_ones_off_the_stack() {
        let mut history = History::default();
        for i in 0..10 {
            let (label, ops) = heavy(&format!("step {i}"), 5);
            history.record(label, ops);
        }
        // 32 MB holds six 5 MB steps, newest first.
        let labels: Vec<&str> = history.undo_labels().collect();
        assert_eq!(
            labels,
            ["step 9", "step 8", "step 7", "step 6", "step 5", "step 4"]
        );

        // One step over the limit on its own is still kept, so it can be undone.
        let (label, ops) = heavy("huge", 40);
        history.record(label, ops);
        assert_eq!(history.undo_labels().collect::<Vec<_>>(), ["huge"]);

        // Small steps don't count for much.
        let mut history = History::default();
        for i in 0..History::LIMIT {
            let (label, ops) = heavy(&format!("small {i}"), 0);
            history.record(label, ops);
        }
        assert_eq!(history.undo_labels().count(), History::LIMIT);
    }
}
